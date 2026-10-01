import type { Pool } from 'pg';
import { z } from 'zod';
import { AppError } from '../lib/errors';

export const PLACE_STATUSES = [
  'NEW',
  'EXPORTED',
  'CONTACTED',
  'REPLIED',
  'ONBOARDED',
  'PRODUCT_ADDED',
  'REJECTED',
] as const;
export type PlaceStatus = (typeof PLACE_STATUSES)[number];

const yesNo = z.enum(['yes', 'no']).optional();

/** Filters of GET /leads (spec §14); all optional, query-string friendly. */
export const leadFiltersSchema = z.object({
  country: z
    .string()
    .regex(/^[A-Za-z]{2}$/)
    .default('CY')
    .transform((c) => c.toUpperCase()),
  city: z.string().trim().min(1).optional(),
  category: z.string().trim().min(1).optional(),
  subcategory: z.string().trim().min(1).optional(),
  status: z.enum(PLACE_STATUSES).optional(),
  emailType: z.enum(['GENERIC', 'PERSONAL']).optional(),
  minScore: z.coerce.number().int().optional(),
  needsReview: yesNo,
  /** new = not exported yet; exported = already in a CSV. */
  exported: z.enum(['new', 'exported']).optional(),
  chain: yesNo,
  /** Default "yes": the leads list shows businesses with an email; "any" shows all places. */
  hasEmail: z.enum(['yes', 'no', 'any']).default('yes'),
  /** Searches the name, email and website. */
  q: z.string().trim().min(1).max(100).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(10).max(200).default(50),
});
export type LeadFilters = z.infer<typeof leadFiltersSchema>;

export interface LeadRow {
  id: number;
  name: string;
  email: string | null;
  emailType: string | null;
  emailOwnDomain: boolean | null;
  extraEmails: number;
  phone: string | null;
  website: string | null;
  city: string | null;
  category: string | null;
  score: number;
  status: string;
  needsReview: boolean;
  reviewReasons: string[];
  isChain: boolean;
  exportedAt: Date | null;
}

export interface LeadPage {
  items: LeadRow[];
  total: number;
  page: number;
  pageSize: number;
}

export interface LeadDetail {
  id: number;
  name: string;
  status: string;
  score: number;
  needsReview: boolean;
  reviewReasons: string[];
  isChain: boolean;
  businessStatus: string;
  address: string | null;
  city: string | null;
  countryCode: string;
  lat: number | null;
  lng: number | null;
  website: string | null;
  websiteDomain: string | null;
  phone: string | null;
  phoneValid: boolean;
  rating: number | null;
  ratingCount: number | null;
  firstSeenAt: Date;
  lastSeenAt: Date;
  lastCrawledAt: Date | null;
  emails: {
    id: number;
    email: string;
    isPrimary: boolean;
    emailType: string;
    isOwnDomain: boolean;
    mxValid: boolean | null;
    source: string;
    sourceUrl: string | null;
    status: string;
    exportedAt: Date | null;
    exportBatchId: number | null;
  }[];
  subcategories: { name: string; category: string; isPrimary: boolean; keyword: string | null }[];
  sources: { source: string; recordId: string; fetchedAt: Date }[];
  /** Newest first: merges, exports, status changes, erasure. */
  history: { at: Date; action: string; details: unknown }[];
}

export interface LeadFacets {
  cities: { name: string; count: number }[];
}

export interface EraseResult {
  placeId: number;
  emailsErased: number;
}

/** What the API routes need (a fake is used in tests). */
export interface LeadService {
  list(filters: LeadFilters): Promise<LeadPage>;
  facets(country: string): Promise<LeadFacets>;
  get(id: number): Promise<LeadDetail | null>;
  setStatus(id: number, status: PlaceStatus, adminId: number | null): Promise<LeadDetail>;
  bulkReject(ids: number[], adminId: number | null): Promise<{ rejected: number }>;
  erase(id: number, adminId: number | null): Promise<EraseResult>;
}

const SUPPRESSED_HASH = `encode(sha256(convert_to(e.email_normalized, 'UTF8')), 'hex')`;

/** WHERE clause + parameters for the filters ($1 = country). */
function whereSql(f: LeadFilters): { sql: string; params: unknown[] } {
  const parts = ['p.country_code = $1'];
  const params: unknown[] = [f.country];
  const add = (cond: (n: string) => string, value: unknown): void => {
    params.push(value);
    parts.push(cond(`$${params.length}`));
  };
  if (f.hasEmail === 'yes') parts.push('e.id IS NOT NULL');
  if (f.hasEmail === 'no') parts.push('e.id IS NULL');
  if (f.city) add((n) => `lower(p.city_name) = lower(${n})`, f.city);
  if (f.category)
    add(
      (
        n,
      ) => `EXISTS (SELECT 1 FROM place_subcategories ps JOIN subcategories s ON s.id = ps.subcategory_id
        JOIN categories c ON c.id = s.category_id WHERE ps.place_id = p.id AND c.slug = ${n})`,
      f.category,
    );
  if (f.subcategory)
    add(
      (
        n,
      ) => `EXISTS (SELECT 1 FROM place_subcategories ps JOIN subcategories s ON s.id = ps.subcategory_id
        WHERE ps.place_id = p.id AND s.slug = ${n})`,
      f.subcategory,
    );
  if (f.status) add((n) => `p.status = ${n}::place_status`, f.status);
  if (f.emailType) add((n) => `e.email_type = ${n}::email_type`, f.emailType);
  if (f.minScore !== undefined) add((n) => `p.score >= ${n}`, f.minScore);
  if (f.needsReview) parts.push(f.needsReview === 'yes' ? 'p.needs_review' : 'NOT p.needs_review');
  if (f.chain) parts.push(f.chain === 'yes' ? 'p.is_chain' : 'NOT p.is_chain');
  if (f.exported === 'new') parts.push('e.exported_at IS NULL');
  if (f.exported === 'exported') parts.push('e.exported_at IS NOT NULL');
  if (f.q)
    add(
      (n) =>
        `(p.name ILIKE ${n} OR p.website_domain ILIKE ${n} OR EXISTS (SELECT 1 FROM emails x WHERE x.place_id = p.id AND x.email_normalized ILIKE ${n}))`,
      `%${f.q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`,
    );
  return { sql: parts.join(' AND '), params };
}

const FROM = `FROM places p LEFT JOIN emails e ON e.place_id = p.id AND e.is_primary`;

export function createLeadService(db: Pool): LeadService {
  async function audit(
    adminId: number | null,
    action: string,
    placeId: number,
    details: unknown,
  ): Promise<void> {
    await db.query(
      `INSERT INTO audit_log (actor_id, action, entity_type, entity_id, details)
       VALUES ($1, $2, 'place', $3, $4)`,
      [adminId, action, String(placeId), JSON.stringify(details)],
    );
  }

  const service: LeadService = {
    async list(f) {
      const where = whereSql(f);
      const total = await db.query<{ n: string }>(
        `SELECT count(*) AS n ${FROM} WHERE ${where.sql}`,
        where.params,
      );
      const offset = (f.page - 1) * f.pageSize;
      const { rows } = await db.query<{
        id: number;
        name: string;
        email: string | null;
        email_type: string | null;
        is_own_domain: boolean | null;
        extra_emails: string;
        phone_e164: string | null;
        website: string | null;
        city_name: string | null;
        category: string | null;
        score: number;
        status: string;
        needs_review: boolean;
        review_reasons: string[];
        is_chain: boolean;
        exported_at: Date | null;
      }>(
        `SELECT p.id, p.name, e.email_normalized AS email, e.email_type, e.is_own_domain,
                (SELECT count(*) FROM emails x WHERE x.place_id = p.id AND NOT x.is_primary) AS extra_emails,
                p.phone_e164, p.website, p.city_name, p.score, p.status, p.needs_review,
                p.review_reasons, p.is_chain, e.exported_at,
                (SELECT c.display_name FROM place_subcategories ps JOIN subcategories s ON s.id = ps.subcategory_id
                   JOIN categories c ON c.id = s.category_id WHERE ps.place_id = p.id
                   ORDER BY ps.is_primary DESC, ps.created_at LIMIT 1) AS category
         ${FROM} WHERE ${where.sql}
         ORDER BY p.score DESC, p.name, p.id
         LIMIT ${f.pageSize} OFFSET ${offset}`,
        where.params,
      );
      return {
        items: rows.map((r) => ({
          id: r.id,
          name: r.name,
          email: r.email,
          emailType: r.email_type,
          emailOwnDomain: r.is_own_domain,
          extraEmails: Number(r.extra_emails),
          phone: r.phone_e164,
          website: r.website,
          city: r.city_name,
          category: r.category,
          score: r.score,
          status: r.status,
          needsReview: r.needs_review,
          reviewReasons: r.review_reasons,
          isChain: r.is_chain,
          exportedAt: r.exported_at,
        })),
        total: Number(total.rows[0]?.n ?? 0),
        page: f.page,
        pageSize: f.pageSize,
      };
    },

    async facets(country) {
      const { rows } = await db.query<{ name: string; n: string }>(
        `SELECT p.city_name AS name, count(*) AS n FROM places p
         WHERE p.country_code = $1 AND p.city_name IS NOT NULL
         GROUP BY p.city_name ORDER BY count(*) DESC, p.city_name`,
        [country.toUpperCase()],
      );
      return { cities: rows.map((r) => ({ name: r.name, count: Number(r.n) })) };
    },

    async get(id) {
      const place = await db.query<Record<string, unknown>>(
        `SELECT id, name, status, score, needs_review, review_reasons, is_chain, business_status,
                address, city_name, country_code, lat, lng, website, website_domain, phone_e164,
                phone_raw, phone_valid, rating, rating_count, first_seen_at, last_seen_at, last_crawled_at
         FROM places WHERE id = $1`,
        [id],
      );
      const p = place.rows[0];
      if (!p) return null;
      const emails = await db.query<{
        id: number;
        email_normalized: string;
        is_primary: boolean;
        email_type: string;
        is_own_domain: boolean;
        mx_valid: boolean | null;
        source: string;
        source_url: string | null;
        status: string;
        exported_at: Date | null;
        export_batch_id: number | null;
      }>(
        `SELECT id, email_normalized, is_primary, email_type, is_own_domain, mx_valid, source,
                source_url, status, exported_at, export_batch_id
         FROM emails WHERE place_id = $1 ORDER BY is_primary DESC, id`,
        [id],
      );
      const subs = await db.query<{
        name: string;
        category: string;
        is_primary: boolean;
        matched_keyword: string | null;
      }>(
        `SELECT s.display_name AS name, c.display_name AS category, ps.is_primary, ps.matched_keyword
         FROM place_subcategories ps JOIN subcategories s ON s.id = ps.subcategory_id
         JOIN categories c ON c.id = s.category_id
         WHERE ps.place_id = $1 ORDER BY ps.is_primary DESC, ps.created_at`,
        [id],
      );
      const sources = await db.query<{
        source: string;
        source_record_id: string;
        fetched_at: Date;
      }>(
        `SELECT lower(source::text) AS source, source_record_id, fetched_at FROM place_sources
         WHERE place_id = $1 ORDER BY fetched_at DESC`,
        [id],
      );
      const history = await db.query<{ at: Date; action: string; details: unknown }>(
        `SELECT created_at AS at, action, details FROM audit_log
         WHERE entity_type = 'place' AND entity_id = $1
         UNION ALL
         SELECT b.created_at, 'export.create', json_build_object('batchId', b.id, 'file', b.filename,
                'undone', b.status = 'UNDONE')::jsonb
         FROM export_batch_items i JOIN export_batches b ON b.id = i.batch_id WHERE i.place_id = $1::int
         ORDER BY at DESC LIMIT 50`,
        [String(id)],
      );
      return {
        id: p.id as number,
        name: p.name as string,
        status: p.status as string,
        score: p.score as number,
        needsReview: p.needs_review as boolean,
        reviewReasons: p.review_reasons as string[],
        isChain: p.is_chain as boolean,
        businessStatus: p.business_status as string,
        address: p.address as string | null,
        city: p.city_name as string | null,
        countryCode: p.country_code as string,
        lat: p.lat as number | null,
        lng: p.lng as number | null,
        website: p.website as string | null,
        websiteDomain: p.website_domain as string | null,
        phone: (p.phone_e164 ?? p.phone_raw) as string | null,
        phoneValid: p.phone_valid as boolean,
        rating: p.rating as number | null,
        ratingCount: p.rating_count as number | null,
        firstSeenAt: p.first_seen_at as Date,
        lastSeenAt: p.last_seen_at as Date,
        lastCrawledAt: p.last_crawled_at as Date | null,
        emails: emails.rows.map((e) => ({
          id: e.id,
          email: e.email_normalized,
          isPrimary: e.is_primary,
          emailType: e.email_type,
          isOwnDomain: e.is_own_domain,
          mxValid: e.mx_valid,
          source: e.source,
          sourceUrl: e.source_url,
          status: e.status,
          exportedAt: e.exported_at,
          exportBatchId: e.export_batch_id,
        })),
        subcategories: subs.rows.map((s) => ({
          name: s.name,
          category: s.category,
          isPrimary: s.is_primary,
          keyword: s.matched_keyword,
        })),
        sources: sources.rows.map((s) => ({
          source: s.source,
          recordId: s.source_record_id,
          fetchedAt: s.fetched_at,
        })),
        history: history.rows,
      };
    },

    async setStatus(id, status, adminId) {
      const current = await db.query<{ status: string }>(
        'SELECT status FROM places WHERE id = $1',
        [id],
      );
      const old = current.rows[0]?.status;
      if (!old) throw new AppError(404, 'LEAD_NOT_FOUND', `Lead ${id} not found`);
      if (old !== status) {
        await db.query(
          `UPDATE places SET status = $2::place_status, updated_at = now() WHERE id = $1`,
          [id, status],
        );
        await audit(adminId, 'lead.status', id, { from: old, to: status });
      }
      const detail = await service.get(id);
      if (!detail) throw new AppError(404, 'LEAD_NOT_FOUND', `Lead ${id} not found`);
      return detail;
    },

    async bulkReject(ids, adminId) {
      const { rows } = await db.query<{ id: number }>(
        `UPDATE places SET status = 'REJECTED', updated_at = now()
         WHERE id = ANY($1::int[]) AND status <> 'REJECTED' RETURNING id`,
        [ids],
      );
      for (const r of rows)
        await audit(adminId, 'lead.status', r.id, { to: 'REJECTED', bulk: true });
      return { rejected: rows.length };
    },

    async erase(id, adminId) {
      const client = await db.connect();
      try {
        await client.query('BEGIN');
        const place = await client.query('SELECT id FROM places WHERE id = $1 FOR UPDATE', [id]);
        if (place.rowCount === 0) throw new AppError(404, 'LEAD_NOT_FOUND', `Lead ${id} not found`);
        // Keep only a hash of each address so it is never collected again (spec §11).
        const erased = await client.query<{ n: string }>(
          `WITH gone AS (DELETE FROM emails e WHERE e.place_id = $1
                         RETURNING ${SUPPRESSED_HASH} AS hash, e.domain),
                kept AS (INSERT INTO suppression (email_hash, domain, reason, source_file)
                         SELECT hash, domain, 'ERASED', 'erasure' FROM gone
                         ON CONFLICT (email_hash) DO NOTHING)
           SELECT count(*) AS n FROM gone`,
          [id],
        );
        const emailsErased = Number(erased.rows[0]?.n ?? 0);
        await client.query(
          `UPDATE places SET phone_raw = NULL, phone_e164 = NULL, phone_valid = false,
                  status = 'REJECTED', needs_review = false, review_reasons = '{}', updated_at = now()
           WHERE id = $1`,
          [id],
        );
        await client.query(
          `INSERT INTO audit_log (actor_id, action, entity_type, entity_id, details)
           VALUES ($1, 'lead.erase', 'place', $2, $3)`,
          [adminId, String(id), JSON.stringify({ emailsErased })],
        );
        await client.query('COMMIT');
        return { placeId: id, emailsErased };
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw err;
      } finally {
        client.release();
      }
    },
  };
  return service;
}
