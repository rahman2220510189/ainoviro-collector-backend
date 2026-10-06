import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { AppError } from '../lib/errors';
import { isExportEnabled } from '../services/country-service';
import { runLeadPipeline, withPipelineLock } from '../leads/process';
import { loadLeadRules } from '../leads/rules';
import { toCsv } from './csv';
import {
  EXPORT_PROFILES,
  PROFILE_NAMES,
  exportFilename,
  renderRows,
  type ExportLead,
} from './profiles';

/** Filters shared by preview and export (query-string friendly). */
export const exportFiltersSchema = z.object({
  country: z
    .string()
    .regex(/^[A-Za-z]{2}$/, 'country must be 2 letters, e.g. "CY"')
    .default('CY')
    .transform((c) => c.toUpperCase()),
  city: z.string().trim().min(1).optional(),
  /** Category slug (one of the 16). */
  category: z.string().trim().min(1).optional(),
  /** Subcategory slug (one of the 65). */
  subcategory: z.string().trim().min(1).optional(),
  minScore: z.coerce.number().int().optional(),
  /** Only businesses that already sell online ("yes"). */
  sellsOnline: z.enum(['yes', 'no']).optional(),
  /** At most this many rows (best scores first). */
  limit: z.coerce.number().int().min(1).max(100_000).optional(),
});
export type ExportFilters = z.infer<typeof exportFiltersSchema>;

export const exportRequestSchema = exportFiltersSchema.extend({
  profile: z.enum(PROFILE_NAMES).default('mailer_v1'),
  /** new = not exported yet (default); all = also rows exported before. */
  scope: z.enum(['new', 'all']).default('new'),
});
export type ExportRequest = z.infer<typeof exportRequestSchema>;

export interface ExportFile {
  filename: string;
  csv: string;
  rowCount: number;
  /** Batch created by this export; null when nothing new was exported. */
  batchId: number | null;
}

export interface ExportPreview {
  /** Rows a "new only" export would contain now. */
  newRows: number;
  /** Businesses with an email that the quality gate holds back. */
  needsReview: number;
}

export interface BatchSummary {
  id: number;
  profile: string;
  scope: string;
  filename: string;
  rowCount: number;
  status: string;
  createdAt: Date;
  undoneAt: Date | null;
  createdBy: string | null;
}

export interface UndoResult {
  batchId: number;
  /** Rows returned to "new": they will be in the next export again. */
  returned: number;
  /** Rows whose status changed after the export (contacted, bounced ...): left alone. */
  kept: number;
}

/** What the API routes need (a fake is used in tests). */
export interface ExportService {
  preview(filters: ExportFilters): Promise<ExportPreview>;
  exportCsv(request: ExportRequest, adminId: number | null): Promise<ExportFile>;
  listBatches(limit: number): Promise<BatchSummary[]>;
  download(batchId: number): Promise<ExportFile | null>;
  undo(batchId: number, adminId: number | null): Promise<UndoResult>;
}

/** Only one export at a time may mark rows, so two clicks never export the same row twice. */
const EXPORT_LOCK = 'SELECT pg_advisory_xact_lock(hashtext($1))';

const SUPPRESSED = `EXISTS (
  SELECT 1 FROM suppression s
  WHERE s.email_hash = encode(sha256(convert_to(e.email_normalized, 'UTF8')), 'hex')
     OR (s.email_hash IS NULL AND s.domain = e.domain))`;

/** The primary email of each business: the normal source of export rows. */
const PRIMARY_ROWS = 'FROM places p JOIN emails e ON e.place_id = p.id AND e.is_primary';

/** The rows of one earlier batch ($1 = batch id), whatever changed since. */
const BATCH_ROWS = `FROM export_batch_items i JOIN emails e ON e.id = i.email_id
  JOIN places p ON p.id = i.place_id`;

/**
 * Every column an export can use, one row per business. Extra conditions are appended
 * by the callers.
 */
const leadSelect = (from: string): string => `
  SELECT p.id AS place_id, e.id AS email_id, p.name AS business_name,
         e.email_normalized AS email, e.email_type, e.is_own_domain,
         p.phone_e164 AS phone, p.website, p.address, p.city_name AS city, p.country_code,
         p.lat, p.lng, p.rating, p.rating_count, p.score, p.status, p.first_seen_at,
         cat.display_name AS category,
         COALESCE(subs.names, '{}') AS subcategories,
         COALESCE(src.names, '{}') AS sources,
         COALESCE(extra.emails, '{}') AS extra_emails
  ${from}
  LEFT JOIN LATERAL (
    SELECT c.display_name FROM place_subcategories ps
    JOIN subcategories s ON s.id = ps.subcategory_id
    JOIN categories c ON c.id = s.category_id
    WHERE ps.place_id = p.id ORDER BY ps.is_primary DESC, ps.created_at, ps.subcategory_id LIMIT 1
  ) cat ON true
  LEFT JOIN LATERAL (
    SELECT array_agg(s.display_name ORDER BY ps.is_primary DESC, ps.created_at, s.id) AS names
    FROM place_subcategories ps JOIN subcategories s ON s.id = ps.subcategory_id
    WHERE ps.place_id = p.id
  ) subs ON true
  LEFT JOIN LATERAL (
    SELECT array_agg(DISTINCT lower(x.source::text)) AS names FROM place_sources x WHERE x.place_id = p.id
  ) src ON true
  LEFT JOIN LATERAL (
    SELECT array_agg(o.email_normalized ORDER BY o.id) AS emails FROM emails o
    WHERE o.place_id = p.id AND o.id <> e.id AND o.status IN ('NEW', 'EXPORTED')
      AND NOT EXISTS (
        SELECT 1 FROM suppression s
        WHERE s.email_hash = encode(sha256(convert_to(o.email_normalized, 'UTF8')), 'hex')
           OR (s.email_hash IS NULL AND s.domain = o.domain))
  ) extra ON true`;

interface LeadRow {
  place_id: number;
  email_id: number;
  business_name: string;
  email: string;
  email_type: string;
  is_own_domain: boolean;
  phone: string | null;
  website: string | null;
  address: string | null;
  city: string | null;
  country_code: string;
  lat: number | null;
  lng: number | null;
  rating: number | null;
  rating_count: number | null;
  score: number;
  status: string;
  first_seen_at: Date;
  category: string | null;
  subcategories: string[];
  sources: string[];
  extra_emails: string[];
}

function toLead(r: LeadRow): ExportLead {
  return {
    placeId: r.place_id,
    emailId: r.email_id,
    businessName: r.business_name,
    email: r.email,
    extraEmails: r.extra_emails,
    emailType: r.email_type,
    emailOwnDomain: r.is_own_domain,
    phone: r.phone,
    website: r.website,
    address: r.address,
    city: r.city,
    countryCode: r.country_code,
    lat: r.lat,
    lng: r.lng,
    category: r.category,
    subcategories: r.subcategories,
    sources: r.sources,
    rating: r.rating,
    ratingCount: r.rating_count,
    score: r.score,
    status: r.status,
    firstSeenAt: r.first_seen_at,
  };
}

/** WHERE conditions for the filters; parameters start at $2 ($1 = country). */
function filterSql(filters: ExportFilters): { sql: string; params: unknown[] } {
  const parts: string[] = [];
  const params: unknown[] = [];
  const add = (condition: (n: number) => string, value: unknown): void => {
    params.push(value);
    parts.push(condition(params.length + 1));
  };
  if (filters.city) add((n) => `lower(p.city_name) = lower($${n})`, filters.city);
  if (filters.category)
    add(
      (
        n,
      ) => `EXISTS (SELECT 1 FROM place_subcategories ps JOIN subcategories s ON s.id = ps.subcategory_id
                      JOIN categories c ON c.id = s.category_id
                      WHERE ps.place_id = p.id AND c.slug = $${n})`,
      filters.category,
    );
  if (filters.subcategory)
    add(
      (
        n,
      ) => `EXISTS (SELECT 1 FROM place_subcategories ps JOIN subcategories s ON s.id = ps.subcategory_id
                      WHERE ps.place_id = p.id AND s.slug = $${n})`,
      filters.subcategory,
    );
  if (filters.minScore !== undefined) add((n) => `p.score >= $${n}`, filters.minScore);
  if (filters.sellsOnline)
    parts.push(
      filters.sellsOnline === 'yes'
        ? 'EXISTS (SELECT 1 FROM domain_shop_checks sc WHERE sc.domain = p.website_domain AND sc.sells_online)'
        : 'NOT EXISTS (SELECT 1 FROM domain_shop_checks sc WHERE sc.domain = p.website_domain AND sc.sells_online)',
    );
  return { sql: parts.map((p) => ` AND ${p}`).join(''), params };
}

/**
 * Exportable rows (spec §12 scope): passes the quality gate, not a chain, not closed,
 * email not suppressed, not bounced/unsubscribed. "new" = never exported;
 * "all" = also rows exported before (still only NEW / EXPORTED businesses).
 */
export function scopeSql(scope: 'new' | 'all'): string {
  const base = `p.country_code = $1 AND NOT p.needs_review AND NOT p.is_chain
    AND p.business_status NOT IN ('CLOSED_TEMPORARILY', 'CLOSED_PERMANENTLY')
    AND NOT ${SUPPRESSED}`;
  return scope === 'new'
    ? `${base} AND p.status = 'NEW' AND e.status = 'NEW' AND e.exported_at IS NULL`
    : `${base} AND p.status IN ('NEW', 'EXPORTED') AND e.status IN ('NEW', 'EXPORTED')`;
}

async function selectLeads(
  db: Pool | PoolClient,
  request: ExportFilters & { scope: 'new' | 'all' },
): Promise<ExportLead[]> {
  const f = filterSql(request);
  const limit = request.limit ? ` LIMIT ${Number(request.limit)}` : '';
  const { rows } = await db.query<LeadRow>(
    `${leadSelect(PRIMARY_ROWS)} WHERE ${scopeSql(request.scope)}${f.sql}
     ORDER BY p.score DESC, p.name, p.id${limit}`,
    [request.country, ...f.params],
  );
  return rows.map(toLead);
}

function buildFile(profileName: string, leads: ExportLead[], countryCode: string, date: Date) {
  const profile = EXPORT_PROFILES[profileName] ?? EXPORT_PROFILES.mailer_v1;
  if (!profile) throw new Error('No export profile configured');
  const { header, rows } = renderRows(profile, leads);
  return { csv: toCsv(header, rows), filename: exportFilename(date, countryCode, leads.length) };
}

export function createExportService(db: Pool): ExportService {
  return {
    async preview(filters) {
      const f = filterSql(filters);
      const ready = await db.query<{ n: string }>(
        `SELECT count(*) AS n FROM places p JOIN emails e ON e.place_id = p.id AND e.is_primary
         WHERE ${scopeSql('new')}${f.sql}`,
        [filters.country, ...f.params],
      );
      const review = await db.query<{ n: string }>(
        `SELECT count(*) AS n FROM places p JOIN emails e ON e.place_id = p.id AND e.is_primary
         WHERE p.country_code = $1 AND p.needs_review AND p.status = 'NEW'${f.sql}`,
        [filters.country, ...f.params],
      );
      const newRows = Number(ready.rows[0]?.n ?? 0);
      return {
        newRows: filters.limit ? Math.min(newRows, filters.limit) : newRows,
        needsReview: Number(review.rows[0]?.n ?? 0),
      };
    },

    async exportCsv(request, adminId) {
      // Safety switch per country (Settings, Countries): only approved countries export.
      if (!(await isExportEnabled(db, request.country))) {
        throw new AppError(
          409,
          'COUNTRY_EXPORT_DISABLED',
          `CSV export for ${request.country} is switched off. Turn it on in Settings, Countries.`,
        );
      }
      // Fresh de-duplication, chains, quality gate and scores before anything is exported.
      const rules = await loadLeadRules(db);
      await withPipelineLock(db, () => runLeadPipeline(db, request.country, rules, false));

      const client = await db.connect();
      try {
        await client.query('BEGIN');
        await client.query(EXPORT_LOCK, ['ainoviro-export']);
        const leads = await selectLeads(client, request);
        const now = new Date();
        const file = buildFile(request.profile, leads, request.country, now);
        // Rows exported for the first time: these are marked and belong to the batch.
        const fresh = leads
          .map((lead, i) => ({ lead, row: i + 1 }))
          .filter(({ lead }) => lead.status === 'NEW');

        let batchId: number | null = null;
        if (fresh.length > 0) {
          const { profile, scope, ...filters } = request;
          const batch = await client.query<{ id: number }>(
            `INSERT INTO export_batches (profile, scope, filters, row_count, filename, created_by_id)
             VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
            [profile, scope, JSON.stringify(filters), leads.length, file.filename, adminId],
          );
          batchId = batch.rows[0]?.id ?? null;
          await client.query(
            `INSERT INTO export_batch_items (batch_id, email_id, place_id, row_number)
             SELECT $1, u.email_id, u.place_id, u.row_number
             FROM unnest($2::int[], $3::int[], $4::int[]) AS u(email_id, place_id, row_number)`,
            [
              batchId,
              fresh.map((f) => f.lead.emailId),
              fresh.map((f) => f.lead.placeId),
              fresh.map((f) => f.row),
            ],
          );
          await client.query(
            `UPDATE emails SET status = 'EXPORTED', exported_at = $2, export_batch_id = $3, updated_at = now()
             WHERE id = ANY($1::int[]) AND exported_at IS NULL`,
            [fresh.map((f) => f.lead.emailId), now, batchId],
          );
          await client.query(
            `UPDATE places SET status = 'EXPORTED', updated_at = now()
             WHERE id = ANY($1::int[]) AND status = 'NEW'`,
            [fresh.map((f) => f.lead.placeId)],
          );
          await client.query(
            `INSERT INTO audit_log (actor_id, action, entity_type, entity_id, details)
             VALUES ($1, 'export.create', 'export_batch', $2, $3)`,
            [
              adminId,
              String(batchId),
              JSON.stringify({
                rows: leads.length,
                newRows: fresh.length,
                profile,
                scope,
                filters,
              }),
            ],
          );
        }
        await client.query('COMMIT');
        return { ...file, rowCount: leads.length, batchId };
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw err;
      } finally {
        client.release();
      }
    },

    async listBatches(limit) {
      const { rows } = await db.query<{
        id: number;
        profile: string;
        scope: string;
        filename: string;
        row_count: number;
        status: string;
        created_at: Date;
        undone_at: Date | null;
        created_by: string | null;
      }>(
        `SELECT b.id, b.profile, b.scope, b.filename, b.row_count, b.status, b.created_at, b.undone_at,
                a.email AS created_by
         FROM export_batches b LEFT JOIN admin_users a ON a.id = b.created_by_id
         ORDER BY b.id DESC LIMIT $1`,
        [limit],
      );
      return rows.map((r) => ({
        id: r.id,
        profile: r.profile,
        scope: r.scope,
        filename: r.filename,
        rowCount: r.row_count,
        status: r.status,
        createdAt: r.created_at,
        undoneAt: r.undone_at,
        createdBy: r.created_by,
      }));
    },

    async download(batchId) {
      const batch = await db.query<{
        profile: string;
        filters: { country?: string };
        created_at: Date;
      }>('SELECT profile, filters, created_at FROM export_batches WHERE id = $1', [batchId]);
      const b = batch.rows[0];
      if (!b) return null;
      // The rows of that batch, in the original order, with today's data.
      const { rows } = await db.query<LeadRow>(
        `${leadSelect(BATCH_ROWS)} WHERE i.batch_id = $1 ORDER BY i.row_number`,
        [batchId],
      );
      const leads = rows.map(toLead);
      const file = buildFile(b.profile, leads, b.filters.country ?? 'XX', b.created_at);
      return { ...file, rowCount: leads.length, batchId };
    },

    async undo(batchId, adminId) {
      const client = await db.connect();
      try {
        await client.query('BEGIN');
        await client.query(EXPORT_LOCK, ['ainoviro-export']);
        const batch = await client.query<{ status: string }>(
          'SELECT status FROM export_batches WHERE id = $1 FOR UPDATE',
          [batchId],
        );
        const status = batch.rows[0]?.status;
        if (!status)
          throw new AppError(404, 'BATCH_NOT_FOUND', `Export batch ${batchId} not found`);
        if (status === 'UNDONE')
          throw new AppError(
            409,
            'BATCH_ALREADY_UNDONE',
            `Export batch ${batchId} was already undone`,
          );

        // Only rows still exactly as this export left them go back to "new".
        const back = await client.query<{ email_id: number; place_id: number }>(
          `SELECT i.email_id, i.place_id FROM export_batch_items i
           JOIN emails e ON e.id = i.email_id JOIN places p ON p.id = i.place_id
           WHERE i.batch_id = $1 AND e.export_batch_id = $1 AND e.status = 'EXPORTED'
             AND p.status = 'EXPORTED'`,
          [batchId],
        );
        const total = await client.query<{ n: string }>(
          'SELECT count(*) AS n FROM export_batch_items WHERE batch_id = $1',
          [batchId],
        );
        const emailIds = back.rows.map((r) => r.email_id);
        const placeIds = back.rows.map((r) => r.place_id);
        await client.query(
          `UPDATE emails SET status = 'NEW', exported_at = NULL, export_batch_id = NULL, updated_at = now()
           WHERE id = ANY($1::int[])`,
          [emailIds],
        );
        await client.query(
          `UPDATE places SET status = 'NEW', updated_at = now() WHERE id = ANY($1::int[])`,
          [placeIds],
        );
        await client.query(
          `UPDATE export_batches SET status = 'UNDONE', undone_at = now() WHERE id = $1`,
          [batchId],
        );
        const result: UndoResult = {
          batchId,
          returned: emailIds.length,
          kept: Number(total.rows[0]?.n ?? 0) - emailIds.length,
        };
        await client.query(
          `INSERT INTO audit_log (actor_id, action, entity_type, entity_id, details)
           VALUES ($1, 'export.undo', 'export_batch', $2, $3)`,
          [adminId, String(batchId), JSON.stringify(result)],
        );
        await client.query('COMMIT');
        return result;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw err;
      } finally {
        client.release();
      }
    },
  };
}
