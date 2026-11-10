import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { normalizePhone } from '../cleaning/phone';
import { analyzeWebsite } from '../cleaning/website';
import { isRoleAddress } from '../enrich/classify';
import { toCsv } from '../export/csv';
import { AppError } from '../lib/errors';
import {
  buildPageRecord,
  pageCsvRow,
  PAGE_CSV_HEADER,
  type FoursquareRow,
  type OvertureRow,
  type PageRecord,
} from './page-record';
import {
  areaOfName,
  loadPageTypes,
  typeOfOvertureCategory,
  type PageTypesConfig,
} from './page-types';

/**
 * Claimable ainoviro pages (step 7.6, Marketplace Plan). The Lead Collector provides the
 * page data (open data only, sources per field), keeps a removal list, and stores what the
 * platform reports back (published / claimed / removed). Reading never marks anything as
 * exported, so it does not interfere with the vendor export.
 */
const list = (v: unknown) =>
  typeof v === 'string' && v.trim() !== ''
    ? v
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean)
    : undefined;

export const pageFiltersSchema = z.object({
  country: z
    .string()
    .length(2)
    .transform((s) => s.toUpperCase())
    .default('CY'),
  /** Area keys from page-types.json; default: all launch areas. */
  areas: z.preprocess(list, z.array(z.string()).optional()),
  /** Type keys from page-types.json; default: all launch types. */
  types: z.preprocess(list, z.array(z.string()).optional()),
  /** unpublished = no page yet (default); all = also published and claimed ones. */
  pageStatus: z.enum(['unpublished', 'published', 'claimed', 'all']).default('unpublished'),
  minCompleteness: z.coerce.number().int().min(0).max(100).default(0),
  includeChains: z.enum(['yes', 'no']).default('no'),
  limit: z.coerce.number().int().min(1).max(5000).default(5000),
});
export type PageFilters = z.infer<typeof pageFiltersSchema>;

export const pageExportSchema = pageFiltersSchema.extend({
  format: z.enum(['json', 'csv']).default('json'),
});

export const pageRemovalSchema = z
  .object({
    collectorId: z.number().int().positive().optional(),
    phone: z.string().max(40).optional(),
    website: z.string().max(300).optional(),
    name: z.string().max(200).optional(),
    reason: z.string().max(500).optional(),
    /** Who or what asked: "whatsapp", "email", "phone", "platform", "web". */
    via: z.string().max(40).optional(),
  })
  .refine((v) => v.collectorId || v.phone || v.website, {
    message: 'Give collectorId, phone or website',
  });
export type PageRemovalInput = z.infer<typeof pageRemovalSchema>;

export const pageStatusSchema = z.object({
  items: z
    .array(
      z.object({
        collectorId: z.number().int().positive(),
        status: z.enum(['PUBLISHED', 'CLAIMED', 'REMOVED']),
        pageUrl: z.string().url().max(500).optional(),
        claimedAt: z.string().datetime().optional(),
      }),
    )
    .min(1)
    .max(1000),
});
export type PageStatusInput = z.infer<typeof pageStatusSchema>;

export interface PagePreview {
  country: string;
  /** Counts by type and area (pages that could be made now, by the filters' page status). */
  byType: { type: string; label: string; areas: Record<string, number>; total: number }[];
  areas: { key: string; label: string }[];
  total: number;
  withPhone: number;
  withEmail: number;
  withWebsiteOrSocial: number;
  usesBookingPlatform: Record<string, number>;
  pages: { published: number; claimed: number; removed: number };
  removalRequests: number;
}

export interface PageRemovalResult {
  removalId: number;
  /** Places matched now (by id, phone or website). */
  placesMatched: number;
  /** Their emails added to the suppression list (never contacted again). */
  emailsSuppressed: number;
}

export interface PageService {
  config(): PageTypesConfig;
  records(filters: PageFilters): Promise<PageRecord[]>;
  preview(filters: PageFilters): Promise<PagePreview>;
  exportFile(
    filters: PageFilters,
    format: 'json' | 'csv',
  ): Promise<{ filename: string; contentType: string; body: string; count: number }>;
  requestRemoval(input: PageRemovalInput): Promise<PageRemovalResult>;
  listRemovals(limit: number): Promise<
    {
      id: number;
      collectorId: number | null;
      name: string | null;
      phone: string | null;
      website: string | null;
      reason: string | null;
      via: string | null;
      createdAt: string;
    }[]
  >;
  setStatuses(input: PageStatusInput): Promise<{ updated: number; unknown: number[] }>;
}

interface CandidateRow {
  id: number;
  country_code: string;
  city_name: string | null;
  google_place_id: string | null;
  region_name: string | null;
  city_loc_name: string | null;
  ovt: OvertureRow;
  fsq: FoursquareRow | null;
  email: string | null;
  email_source: string | null;
  email_found_at: Date | null;
  sells_online: boolean | null;
  page_status: 'PUBLISHED' | 'CLAIMED' | null;
  page_url: string | null;
  claimed_at: Date | null;
}

/** A removal request matches a place by id, Overture id, phone or own website domain. */
const NOT_REMOVED = `
  NOT EXISTS (
    SELECT 1 FROM page_removals pr
    WHERE pr.place_id = p.id
       OR (pr.overture_id IS NOT NULL AND pr.overture_id = p.overture_id)
       OR (pr.phone_e164 IS NOT NULL AND pr.phone_e164 = p.phone_e164)
       OR (pr.website_domain IS NOT NULL AND pr.website_domain = p.website_domain))`;

export function createPageService(
  db: Pool,
  config: PageTypesConfig = loadPageTypes(),
): PageService {
  const resolveTypes = (keys?: string[]) => {
    const chosen = keys ? config.types.filter((t) => keys.includes(t.key)) : config.types;
    if (keys && chosen.length !== keys.length)
      throw new AppError(400, 'UNKNOWN_PAGE_TYPE', `Unknown page type in: ${keys.join(', ')}`);
    return chosen;
  };
  const resolveAreas = (keys?: string[]) => {
    const chosen = keys ? config.areas.filter((a) => keys.includes(a.key)) : config.areas;
    if (keys && chosen.length !== keys.length)
      throw new AppError(400, 'UNKNOWN_PAGE_AREA', `Unknown area in: ${keys.join(', ')}`);
    return chosen;
  };

  async function candidates(filters: PageFilters): Promise<CandidateRow[]> {
    const types = resolveTypes(filters.types);
    const codes = types.flatMap((t) => t.overture);
    const statusWhere =
      filters.pageStatus === 'unpublished'
        ? 'bp.place_id IS NULL'
        : filters.pageStatus === 'published'
          ? `bp.status = 'PUBLISHED'`
          : filters.pageStatus === 'claimed'
            ? `bp.status = 'CLAIMED'`
            : `(bp.status IS NULL OR bp.status <> 'REMOVED')`;
    const { rows } = await db.query<CandidateRow>(
      `SELECT p.id, p.country_code, p.city_name, p.google_place_id,
              r.name AS region_name, l.name AS city_loc_name,
              to_jsonb(o.*) AS ovt,
              CASE WHEN f.id IS NULL THEN NULL ELSE to_jsonb(f.*) END AS fsq,
              e.email_normalized AS email, e.source AS email_source, e.first_seen_at AS email_found_at,
              s.sells_online,
              CASE WHEN bp.status IN ('PUBLISHED', 'CLAIMED') THEN bp.status::text END AS page_status,
              bp.page_url, bp.claimed_at
       FROM places p
       JOIN stg_overture_places o ON o.id = p.overture_id
       LEFT JOIN stg_fsq_places f ON f.id = p.fsq_id
       LEFT JOIN locations l ON l.id = p.city_id
       LEFT JOIN locations r ON r.id = l.parent_id
       LEFT JOIN LATERAL (
         SELECT em.email_normalized, em.source, em.first_seen_at
         FROM emails em
         WHERE em.place_id = p.id AND em.is_primary AND em.status IN ('NEW', 'EXPORTED')
           AND em.mx_valid IS DISTINCT FROM false AND NOT em.is_disposable
           AND NOT EXISTS (SELECT 1 FROM suppression sp
                           WHERE sp.email_hash = encode(sha256(convert_to(em.email_normalized, 'UTF8')), 'hex'))
         LIMIT 1
       ) e ON true
       LEFT JOIN domain_shop_checks s ON s.domain = p.website_domain
       LEFT JOIN business_pages bp ON bp.place_id = p.id
       WHERE p.country_code = $1
         AND o.taxonomy_primary = ANY($2::text[])
         AND p.business_status <> 'CLOSED_PERMANENTLY'
         AND ($3::boolean OR NOT p.is_chain)
         AND ${statusWhere}
         AND ${NOT_REMOVED}
       ORDER BY p.id`,
      [filters.country, codes, filters.includeChains === 'yes'],
    );
    return rows;
  }

  async function records(filters: PageFilters): Promise<PageRecord[]> {
    const areas = resolveAreas(filters.areas);
    const out: PageRecord[] = [];
    for (const row of await candidates(filters)) {
      const type = typeOfOvertureCategory(config, row.ovt.taxonomy_primary);
      const area = areaOfName(
        { ...config, areas },
        row.region_name,
        row.city_loc_name,
        row.city_name,
        row.ovt.locality,
      );
      if (!type || !area) continue;
      const email =
        row.email && !isRoleAddress(row.email)
          ? { email: row.email, source: row.email_source ?? 'website', foundAt: row.email_found_at }
          : null;
      const record = buildPageRecord({
        place: {
          id: row.id,
          countryCode: row.country_code,
          cityName: row.city_loc_name ?? row.city_name,
          googlePlaceId: row.google_place_id,
          primaryEmail: email,
          sellsOnline: row.sells_online,
          page: row.page_status
            ? { status: row.page_status, url: row.page_url, claimedAt: row.claimed_at }
            : null,
        },
        overture: row.ovt,
        foursquare: row.fsq,
        type,
        area,
      });
      if (record && record.completeness.score >= filters.minCompleteness) out.push(record);
      if (out.length >= filters.limit) break;
    }
    return out;
  }

  async function suppressPlaceEmails(client: PoolClient, placeIds: number[]): Promise<number> {
    if (placeIds.length === 0) return 0;
    const r = await client.query(
      `INSERT INTO suppression (email_hash, email_normalized, domain, reason, source_file, note)
       SELECT encode(sha256(convert_to(e.email_normalized, 'UTF8')), 'hex'), e.email_normalized,
              e.domain, 'UNSUBSCRIBED', 'page removal', 'Asked to remove their ainoviro page'
       FROM emails e WHERE e.place_id = ANY($1::int[])
       ON CONFLICT (email_hash) DO NOTHING`,
      [placeIds],
    );
    await client.query(
      `UPDATE emails SET status = 'UNSUBSCRIBED', updated_at = now()
       WHERE place_id = ANY($1::int[]) AND status IN ('NEW', 'EXPORTED')`,
      [placeIds],
    );
    return r.rowCount ?? 0;
  }

  return {
    config: () => config,
    records,

    async preview(filters) {
      const all = await records({ ...filters, limit: 5000, minCompleteness: 0 });
      const areas = resolveAreas(filters.areas);
      const byType = resolveTypes(filters.types).map((t) => {
        const of = all.filter((r) => r.type.key === t.key);
        return {
          type: t.key,
          label: t.label,
          areas: Object.fromEntries(
            areas.map((a) => [a.key, of.filter((r) => r.area.key === a.key).length]),
          ),
          total: of.length,
        };
      });
      const booking: Record<string, number> = {};
      for (const r of all)
        if (r.bookingPlatform) booking[r.bookingPlatform] = (booking[r.bookingPlatform] ?? 0) + 1;
      const [pages, removals] = await Promise.all([
        db.query<{ status: string; n: string }>(
          `SELECT bp.status::text AS status, count(*) AS n FROM business_pages bp
           JOIN places p ON p.id = bp.place_id WHERE p.country_code = $1 GROUP BY 1`,
          [filters.country],
        ),
        db.query<{ n: string }>('SELECT count(*) AS n FROM page_removals'),
      ]);
      const pageCount = (s: string) => Number(pages.rows.find((r) => r.status === s)?.n ?? 0);
      return {
        country: filters.country,
        byType,
        areas: areas.map((a) => ({ key: a.key, label: a.label })),
        total: all.length,
        withPhone: all.filter((r) => r.phone).length,
        withEmail: all.filter((r) => r.email).length,
        withWebsiteOrSocial: all.filter((r) => r.website || Object.keys(r.socials).length > 0)
          .length,
        usesBookingPlatform: booking,
        pages: {
          published: pageCount('PUBLISHED'),
          claimed: pageCount('CLAIMED'),
          removed: pageCount('REMOVED'),
        },
        removalRequests: Number(removals.rows[0]?.n ?? 0),
      };
    },

    async exportFile(filters, format) {
      const recs = await records(filters);
      const stamp = new Date().toISOString().slice(0, 10);
      const base = `ainoviro-pages-${filters.country.toLowerCase()}-${stamp}`;
      if (format === 'csv') {
        return {
          filename: `${base}.csv`,
          contentType: 'text/csv; charset=utf-8',
          body: toCsv(PAGE_CSV_HEADER, recs.map(pageCsvRow)),
          count: recs.length,
        };
      }
      const attribution = [...new Set(recs.flatMap((r) => r.attribution))];
      return {
        filename: `${base}.json`,
        contentType: 'application/json; charset=utf-8',
        body: JSON.stringify(
          {
            generatedAt: new Date().toISOString(),
            country: filters.country,
            count: recs.length,
            attribution,
            records: recs,
          },
          null,
          2,
        ),
        count: recs.length,
      };
    },

    async requestRemoval(input) {
      const phone = input.phone ? normalizePhone(input.phone, 'CY').e164 : null;
      const domain = input.website ? analyzeWebsite(input.website).domain : null;
      if (input.phone && !phone)
        throw new AppError(400, 'INVALID_PHONE', `"${input.phone}" is not a valid phone number.`);
      if (input.website && !domain)
        throw new AppError(400, 'INVALID_WEBSITE', `"${input.website}" is not a business website.`);
      const client = await db.connect();
      try {
        await client.query('BEGIN');
        const matched = await client.query<{
          id: number;
          overture_id: string | null;
          name: string;
        }>(
          `SELECT id, overture_id, name FROM places
           WHERE ($1::int IS NOT NULL AND id = $1)
              OR ($2::text IS NOT NULL AND phone_e164 = $2)
              OR ($3::text IS NOT NULL AND website_domain = $3)`,
          [input.collectorId ?? null, phone, domain],
        );
        if (input.collectorId && !matched.rows.some((r) => r.id === input.collectorId))
          throw new AppError(
            404,
            'PLACE_NOT_FOUND',
            `No business with collectorId ${input.collectorId}.`,
          );
        const first = matched.rows[0];
        const ins = await client.query<{ id: number }>(
          `INSERT INTO page_removals (place_id, overture_id, phone_e164, website_domain, name, reason, requested_via)
           VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
          [
            input.collectorId ?? first?.id ?? null,
            first?.overture_id ?? null,
            phone,
            domain,
            input.name ?? first?.name ?? null,
            input.reason ?? null,
            input.via ?? null,
          ],
        );
        const ids = matched.rows.map((r) => r.id);
        // Every matched place: page removed, emails never contacted again.
        for (const r of matched.rows) {
          await client.query(
            `INSERT INTO business_pages (place_id, status, note) VALUES ($1, 'REMOVED', 'removal request')
             ON CONFLICT (place_id) DO UPDATE SET status = 'REMOVED', updated_at = now()`,
            [r.id],
          );
          if (r.overture_id && r.overture_id !== first?.overture_id)
            await client.query(
              `INSERT INTO page_removals (place_id, overture_id, requested_via, reason)
               VALUES ($1, $2, $3, 'same business, matched by phone or website')`,
              [r.id, r.overture_id, input.via ?? null],
            );
        }
        const emailsSuppressed = await suppressPlaceEmails(client, ids);
        await client.query(
          `INSERT INTO audit_log (action, entity_type, entity_id, details)
           VALUES ('page.removal_requested', 'page_removal', $1, $2::jsonb)`,
          [String(ins.rows[0]!.id), JSON.stringify({ placesMatched: ids, via: input.via ?? null })],
        );
        await client.query('COMMIT');
        return { removalId: ins.rows[0]!.id, placesMatched: ids.length, emailsSuppressed };
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    },

    async listRemovals(limit) {
      const { rows } = await db.query<{
        id: number;
        place_id: number | null;
        name: string | null;
        phone_e164: string | null;
        website_domain: string | null;
        reason: string | null;
        requested_via: string | null;
        created_at: Date;
      }>(
        `SELECT id, place_id, name, phone_e164, website_domain, reason, requested_via, created_at
         FROM page_removals ORDER BY id DESC LIMIT $1`,
        [limit],
      );
      return rows.map((r) => ({
        id: r.id,
        collectorId: r.place_id,
        name: r.name,
        phone: r.phone_e164,
        website: r.website_domain,
        reason: r.reason,
        via: r.requested_via,
        createdAt: new Date(r.created_at).toISOString(),
      }));
    },

    async setStatuses(input) {
      const ids = input.items.map((i) => i.collectorId);
      const known = await db.query<{ id: number }>(
        'SELECT id FROM places WHERE id = ANY($1::int[])',
        [ids],
      );
      const knownIds = new Set(known.rows.map((r) => r.id));
      let updated = 0;
      const client = await db.connect();
      try {
        await client.query('BEGIN');
        for (const item of input.items) {
          if (!knownIds.has(item.collectorId)) continue;
          if (item.status === 'REMOVED') {
            // Removal through the platform: same effect as a removal request.
            await client.query(
              `INSERT INTO page_removals (place_id, overture_id, phone_e164, website_domain, name, requested_via, reason)
               SELECT id, overture_id, phone_e164, website_domain, name, 'platform', 'removed on the platform'
               FROM places WHERE id = $1`,
              [item.collectorId],
            );
            await suppressPlaceEmails(client, [item.collectorId]);
          }
          // A removed page never comes back through a status update.
          const r = await client.query(
            `INSERT INTO business_pages (place_id, status, page_url, claimed_at)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (place_id) DO UPDATE SET
               status = EXCLUDED.status,
               page_url = COALESCE(EXCLUDED.page_url, business_pages.page_url),
               claimed_at = COALESCE(EXCLUDED.claimed_at, business_pages.claimed_at),
               updated_at = now()
             WHERE business_pages.status <> 'REMOVED'`,
            [
              item.collectorId,
              item.status,
              item.pageUrl ?? null,
              item.claimedAt ?? (item.status === 'CLAIMED' ? new Date().toISOString() : null),
            ],
          );
          updated += r.rowCount ?? 0;
        }
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
      return { updated, unknown: ids.filter((id) => !knownIds.has(id)) };
    },
  };
}
