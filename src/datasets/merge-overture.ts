import type { Pool, PoolClient } from 'pg';
import { DEFAULT_NEAREST_CITY_KM, loadCityResolver } from '../cleaning/city';
import { normalizePlaceFields, type NormalizedPlaceFields } from '../cleaning/normalize-place';
import { isGenericLocalPart, isOwnDomain, pickPrimaryIndex } from '../enrich/classify';
import { isDisposableDomain, rejectReason } from '../enrich/filters';
import { MxChecker } from '../enrich/mx';
import { emailDomain, hashEmail, normalizeEmail } from '../lib/email';
import { SEARCH_SETTINGS_KEY, searchSettingsSchema } from '../services/settings';
import { classifyOverture, loadOvertureRules } from './category-map';

/**
 * Step 4.4: brings the imported Overture places (stg_overture_places) into the main tables
 * with the same rules Google results follow (spec §6.2, §11):
 *  - non-businesses (rules with a reason) are skipped;
 *  - a place is upserted by overture_id; on a place that came from Google, Google's
 *    values win and Overture only fills empty fields (precedence Google > Overture);
 *  - an Overture id that was merged into another place updates that place instead;
 *  - Overture's emails go through the crawler's checks (junk filter, suppression, MX,
 *    generic/personal, own domain) and the database's UNIQUE rule (never stored twice);
 *  - places with an own website but no email are left for the crawler (worker) as usual.
 * De-duplication against Google places happens in the lead pipeline afterwards.
 */

export interface MergeStats {
  stagingPlaces: number;
  skippedNotBusiness: number;
  withoutCategory: number;
  placesInserted: number;
  placesUpdated: number;
  /** Overture ids that already live on a merged place (that place was updated). */
  placesLinkedToMerged: number;
  emailsInserted: number;
  emailsAlreadyKnown: number;
  emailsSuppressed: number;
  emailsRejected: number;
  emailsNoMailServer: number;
  primariesSet: number;
  /** Own website, no email yet: the worker will crawl these. */
  websitesForCrawler: number;
}

interface StagingRow {
  id: string;
  name: string;
  lat: number;
  lng: number;
  taxonomy_primary: string | null;
  taxonomy_hierarchy: string[];
  basic_category: string | null;
  operating_status: string | null;
  websites: string[];
  phones: string[];
  emails: string[];
  address: string | null;
  locality: string | null;
}

export interface PreparedEmail {
  original: string;
  normalized: string;
  domain: string;
  emailType: 'GENERIC' | 'PERSONAL';
  isOwnDomain: boolean;
  isDisposable: boolean;
  mxValid: boolean | null;
}

interface PreparedPlace {
  row: StagingRow;
  subcategoryId: number | null;
  fields: NormalizedPlaceFields;
  emails: PreparedEmail[];
}

/** Runs async work over items with at most `limit` running at once. */
async function inParallel<T>(items: T[], limit: number, work: (item: T) => Promise<void>) {
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next] as T;
      next += 1;
      await work(item);
    }
  });
  await Promise.all(runners);
}

/** Cleans one place's Overture emails; junk is counted and dropped. */
export function prepareEmails(
  raw: string[],
  websiteDomain: string | null,
): { emails: Omit<PreparedEmail, 'mxValid'>[]; rejected: number } {
  const out: Omit<PreparedEmail, 'mxValid'>[] = [];
  const seen = new Set<string>();
  let rejected = 0;
  for (const value of raw) {
    const normalized = normalizeEmail(value);
    if (!normalized || rejectReason(normalized)) {
      rejected += 1;
      continue;
    }
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    const domain = emailDomain(normalized);
    out.push({
      original: value.trim(),
      normalized,
      domain,
      emailType: isGenericLocalPart(normalized) ? 'GENERIC' : 'PERSONAL',
      isOwnDomain: isOwnDomain(domain, websiteDomain),
      isDisposable: isDisposableDomain(domain),
    });
  }
  return { emails: out, rejected };
}

async function suppressedEmails(client: PoolClient, emails: PreparedEmail[]): Promise<Set<string>> {
  if (emails.length === 0) return new Set();
  const { rows } = await client.query<{ email_hash: string | null; domain: string | null }>(
    `SELECT email_hash, domain FROM suppression
     WHERE email_hash = ANY($1::text[]) OR (email_hash IS NULL AND domain = ANY($2::text[]))`,
    [emails.map((e) => hashEmail(e.normalized)), [...new Set(emails.map((e) => e.domain))]],
  );
  const hashes = new Set(rows.map((r) => r.email_hash).filter((h): h is string => h !== null));
  const domains = new Set(rows.filter((r) => r.email_hash === null).map((r) => r.domain));
  return new Set(
    emails
      .filter((e) => hashes.has(hashEmail(e.normalized)) || domains.has(e.domain))
      .map((e) => e.normalized),
  );
}

/** Writes one batch in ONE transaction. */
async function writeBatch(
  db: Pool,
  batch: PreparedPlace[],
  countryCode: string,
  stats: MergeStats,
) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');

    // 1. Overture ids that were merged into another place: update that place.
    const merged = await client.query<{ oid: string; place_id: number }>(
      `SELECT s.source_record_id AS oid, s.place_id
       FROM place_sources s JOIN places p ON p.id = s.place_id
       WHERE s.source = 'OVERTURE' AND s.source_record_id = ANY($1::text[])
         AND p.overture_id IS DISTINCT FROM s.source_record_id`,
      [batch.map((b) => b.row.id)],
    );
    const mergedInto = new Map(merged.rows.map((r) => [r.oid, r.place_id]));
    stats.placesLinkedToMerged += mergedInto.size;
    const direct = batch.filter((b) => !mergedInto.has(b.row.id));

    // 2. Upsert by overture_id. Google's values win on places that came from Google.
    const placeIdOf = new Map<string, number>(mergedInto);
    if (direct.length > 0) {
      const saved = await client.query<{ id: number; overture_id: string; inserted: boolean }>(
        `INSERT INTO places (
           overture_id, name, name_normalized, country_code, city_id, city_name, address, lat, lng,
           website, website_domain, phone_raw, phone_e164, phone_valid, business_status,
           last_seen_at, updated_at
         )
         SELECT u.oid, u.name, u.name_normalized, $1, u.city_id, u.city_name, u.address, u.lat, u.lng,
                u.website, u.website_domain, u.phone_raw, u.phone_e164, u.phone_valid,
                u.business_status::business_status, now(), now()
         FROM unnest($2::text[], $3::text[], $4::text[], $5::int[], $6::text[], $7::text[],
                     $8::float8[], $9::float8[], $10::text[], $11::text[], $12::text[], $13::text[],
                     $14::bool[], $15::text[])
           AS u(oid, name, name_normalized, city_id, city_name, address, lat, lng, website,
                website_domain, phone_raw, phone_e164, phone_valid, business_status)
         ON CONFLICT (overture_id) DO UPDATE SET
           name = CASE WHEN places.google_place_id IS NULL THEN EXCLUDED.name ELSE places.name END,
           name_normalized = CASE WHEN places.google_place_id IS NULL
                                  THEN EXCLUDED.name_normalized ELSE places.name_normalized END,
           address = COALESCE(CASE WHEN places.google_place_id IS NULL THEN EXCLUDED.address END, places.address, EXCLUDED.address),
           lat = COALESCE(places.lat, EXCLUDED.lat),
           lng = COALESCE(places.lng, EXCLUDED.lng),
           city_id = COALESCE(places.city_id, EXCLUDED.city_id),
           city_name = COALESCE(places.city_name, EXCLUDED.city_name),
           website = COALESCE(places.website, EXCLUDED.website),
           website_domain = CASE WHEN places.website IS NULL THEN EXCLUDED.website_domain
                                 ELSE places.website_domain END,
           phone_raw = COALESCE(places.phone_raw, EXCLUDED.phone_raw),
           phone_e164 = CASE WHEN places.phone_raw IS NULL THEN EXCLUDED.phone_e164
                             ELSE places.phone_e164 END,
           phone_valid = CASE WHEN places.phone_raw IS NULL THEN EXCLUDED.phone_valid
                              ELSE places.phone_valid END,
           last_seen_at = now(),
           updated_at = now()
         RETURNING id, overture_id, (xmax = 0) AS inserted`,
        [
          countryCode,
          direct.map((b) => b.row.id),
          direct.map((b) => b.fields.name),
          direct.map((b) => b.fields.nameNormalized),
          direct.map((b) => b.fields.city?.cityId ?? null),
          direct.map((b) => b.fields.city?.cityName ?? b.row.locality),
          direct.map((b) => b.row.address),
          direct.map((b) => b.row.lat),
          direct.map((b) => b.row.lng),
          direct.map((b) => b.fields.website),
          direct.map((b) => b.fields.websiteDomain),
          direct.map((b) => b.fields.phoneRaw),
          direct.map((b) => b.fields.phoneE164),
          direct.map((b) => b.fields.phoneValid),
          direct.map((b) => (b.row.operating_status === 'open' ? 'OPERATIONAL' : 'UNKNOWN')),
        ],
      );
      for (const r of saved.rows) {
        placeIdOf.set(r.overture_id, r.id);
        if (r.inserted) stats.placesInserted += 1;
        else stats.placesUpdated += 1;
      }
    }
    if (mergedInto.size > 0) {
      await client.query('UPDATE places SET last_seen_at = now() WHERE id = ANY($1::int[])', [
        [...new Set(mergedInto.values())],
      ]);
    }

    const pid = (b: PreparedPlace) => placeIdOf.get(b.row.id) as number;
    // 3. Provenance and categories.
    await client.query(
      `INSERT INTO place_sources (place_id, source, source_record_id, fetched_at)
       SELECT u.place_id, 'OVERTURE', u.oid, now() FROM unnest($1::int[], $2::text[]) AS u(place_id, oid)
       ON CONFLICT (source, source_record_id) DO UPDATE SET fetched_at = now()`,
      [batch.map(pid), batch.map((b) => b.row.id)],
    );
    const categorized = batch.filter((b) => b.subcategoryId !== null);
    if (categorized.length > 0) {
      await client.query(
        `INSERT INTO place_subcategories (place_id, subcategory_id, matched_keyword, source, is_primary)
         SELECT u.place_id, u.sub, u.kw, 'OVERTURE', false
         FROM unnest($1::int[], $2::int[], $3::text[]) AS u(place_id, sub, kw)
         ON CONFLICT (place_id, subcategory_id) DO NOTHING`,
        [
          categorized.map(pid),
          categorized.map((b) => b.subcategoryId),
          categorized.map((b) => b.row.taxonomy_primary ?? b.row.basic_category),
        ],
      );
    }

    // 4. Emails: one row per address in this batch (ON CONFLICT may touch a row once).
    const owner = new Map<string, { email: PreparedEmail; placeId: number }>();
    for (const b of batch) {
      for (const e of b.emails) {
        if (!owner.has(e.normalized)) owner.set(e.normalized, { email: e, placeId: pid(b) });
      }
    }
    const candidates = [...owner.values()];
    const suppressed = await suppressedEmails(
      client,
      candidates.map((c) => c.email),
    );
    stats.emailsSuppressed += suppressed.size;
    const toStore = candidates.filter((c) => !suppressed.has(c.email.normalized));
    if (toStore.length > 0) {
      const saved = await client.query<{
        id: number;
        place_id: number;
        email_normalized: string;
        inserted: boolean;
      }>(
        `INSERT INTO emails (
           email, email_normalized, domain, place_id, lead_type, is_primary, email_type,
           is_own_domain, syntax_valid, mx_valid, is_disposable, source, lawful_basis, updated_at
         )
         SELECT u.email, u.normalized, u.domain, p.id, p.lead_type, false, u.email_type::email_type,
                u.own, true, u.mx, u.disposable, 'overture',
                CASE WHEN p.lead_type = 'VENDOR' THEN 'LEGITIMATE_INTEREST_B2B'::lawful_basis
                     ELSE 'UNKNOWN'::lawful_basis END,
                now()
         FROM unnest($1::int[], $2::text[], $3::text[], $4::text[], $5::text[], $6::bool[],
                     $7::bool[], $8::bool[])
           AS u(place_id, email, normalized, domain, email_type, own, mx, disposable)
         JOIN places p ON p.id = u.place_id
         ON CONFLICT (email_normalized) DO UPDATE SET
           seen_count = emails.seen_count + 1, last_seen_at = now(), updated_at = now()
         RETURNING id, place_id, email_normalized, (xmax = 0) AS inserted`,
        [
          toStore.map((c) => c.placeId),
          toStore.map((c) => c.email.original),
          toStore.map((c) => c.email.normalized),
          toStore.map((c) => c.email.domain),
          toStore.map((c) => c.email.emailType),
          toStore.map((c) => c.email.isOwnDomain),
          toStore.map((c) => c.email.mxValid),
          toStore.map((c) => c.email.isDisposable),
        ],
      );
      const fresh = saved.rows.filter((r) => r.inserted);
      stats.emailsInserted += fresh.length;
      stats.emailsAlreadyKnown += saved.rows.length - fresh.length;

      // 5. A place without a primary email gets the best of its new ones.
      const freshPlaces = [...new Set(fresh.map((r) => r.place_id))];
      if (freshPlaces.length > 0) {
        const hasPrimary = await client.query<{ place_id: number }>(
          'SELECT place_id FROM emails WHERE place_id = ANY($1::int[]) AND is_primary',
          [freshPlaces],
        );
        const done = new Set(hasPrimary.rows.map((r) => r.place_id));
        const info = new Map(toStore.map((c) => [c.email.normalized, c.email]));
        const best: number[] = [];
        for (const placeId of freshPlaces) {
          if (done.has(placeId)) continue;
          const mine = fresh.filter((r) => r.place_id === placeId);
          const ranked = mine.map((r) => {
            const e = info.get(r.email_normalized) as PreparedEmail;
            return { ...e, mxValid: e.isDisposable ? false : e.mxValid };
          });
          const chosen = mine[pickPrimaryIndex(ranked)];
          if (chosen) best.push(chosen.id);
        }
        if (best.length > 0) {
          await client.query(
            'UPDATE emails SET is_primary = true, updated_at = now() WHERE id = ANY($1::int[])',
            [best],
          );
          stats.primariesSet += best.length;
        }
      }
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

export interface MergeOptions {
  /** Plan and count only; nothing is written (MX lookups still happen). */
  dryRun?: boolean;
  batchSize?: number;
  mx?: MxChecker;
  onProgress?: (line: string) => void;
  /** Only staged places inside this box (a job's search area). */
  bbox?: { south: number; west: number; north: number; east: number };
  /** Skip places that are already in the main tables (a job only brings in what is missing). */
  onlyNew?: boolean;
}

export async function mergeOverturePlaces(
  db: Pool,
  countryCode: string,
  options: MergeOptions = {},
): Promise<MergeStats> {
  const say = options.onProgress ?? (() => undefined);
  const batchSize = options.batchSize ?? 500;
  const mx = options.mx ?? new MxChecker();
  const stats: MergeStats = {
    stagingPlaces: 0,
    skippedNotBusiness: 0,
    withoutCategory: 0,
    placesInserted: 0,
    placesUpdated: 0,
    placesLinkedToMerged: 0,
    emailsInserted: 0,
    emailsAlreadyKnown: 0,
    emailsSuppressed: 0,
    emailsRejected: 0,
    emailsNoMailServer: 0,
    primariesSet: 0,
    websitesForCrawler: 0,
  };

  const rules = await loadOvertureRules(db);
  if (rules.length === 0)
    throw new Error('No Overture category rules. Run: npm run overture:map -- --seed');
  const params: unknown[] = [countryCode];
  let where = 's.country_code = $1';
  if (options.bbox) {
    const b = options.bbox;
    params.push(b.south, b.north, b.west, b.east);
    where += ' AND s.lat BETWEEN $2 AND $3 AND s.lng BETWEEN $4 AND $5';
  }
  if (options.onlyNew) {
    where += ` AND NOT EXISTS (SELECT 1 FROM places p WHERE p.overture_id = s.id)
       AND NOT EXISTS (SELECT 1 FROM place_sources ps
                       WHERE ps.source = 'OVERTURE' AND ps.source_record_id = s.id)`;
  }
  const { rows } = await db.query<StagingRow>(
    `SELECT s.id, s.name, s.lat, s.lng, s.taxonomy_primary, s.taxonomy_hierarchy, s.basic_category,
            s.operating_status, s.websites, s.phones, s.emails, s.address, s.locality
     FROM stg_overture_places s WHERE ${where} ORDER BY s.id`,
    params,
  );
  stats.stagingPlaces = rows.length;
  // A filtered run (one area, only new places) may simply have nothing to do.
  if (rows.length === 0 && (options.bbox || options.onlyNew)) return stats;
  if (rows.length === 0) {
    throw new Error(
      `No Overture places for ${countryCode}. Run: npm run import:overture -- --country ${countryCode}`,
    );
  }

  const searchRow = await db.query<{ value: unknown }>(
    'SELECT value FROM settings WHERE key = $1',
    [SEARCH_SETTINGS_KEY],
  );
  const search = searchSettingsSchema.parse(searchRow.rows[0]?.value ?? {});
  const cities = await loadCityResolver(db, countryCode, {
    minCityPopulation: search.minCityPopulation,
    maxNearestKm: DEFAULT_NEAREST_CITY_KM,
  });

  const prepared: PreparedPlace[] = [];
  for (const row of rows) {
    const c = classifyOverture(
      {
        taxonomyHierarchy: row.taxonomy_hierarchy,
        basicCategory: row.basic_category,
        taxonomyPrimary: row.taxonomy_primary,
      },
      rules,
    );
    if (c.kind === 'excluded') {
      stats.skippedNotBusiness += 1;
      continue;
    }
    if (c.kind === 'unmapped') stats.withoutCategory += 1;
    const fields = normalizePlaceFields(
      {
        name: row.name,
        website: row.websites[0] ?? null,
        phone: row.phones[0] ?? null,
        lat: row.lat,
        lng: row.lng,
      },
      { countryCode, cities, fallbackCityId: null },
    );
    const { emails, rejected } = prepareEmails(row.emails, fields.websiteDomain);
    stats.emailsRejected += rejected;
    if (emails.length === 0 && fields.websiteDomain) stats.websitesForCrawler += 1;
    prepared.push({
      row,
      subcategoryId: c.kind === 'mapped' ? c.subcategoryId : null,
      fields,
      emails: emails.map((e) => ({ ...e, mxValid: null })),
    });
  }
  say(
    `${prepared.length} businesses to bring in (${stats.skippedNotBusiness} left out as not a business)`,
  );

  // Mail server check, once per domain, 20 at a time.
  const domains = [...new Set(prepared.flatMap((p) => p.emails.map((e) => e.domain)))];
  say(`Checking mail servers of ${domains.length} email domains...`);
  const mxOf = new Map<string, boolean | null>();
  let checked = 0;
  await inParallel(domains, 20, async (d) => {
    mxOf.set(d, await mx.check(d));
    checked += 1;
    if (checked % 1000 === 0) say(`  ${checked}/${domains.length} domains checked`);
  });
  for (const p of prepared) {
    for (const e of p.emails) {
      e.mxValid = mxOf.get(e.domain) ?? null;
      if (e.mxValid === false) stats.emailsNoMailServer += 1;
    }
  }

  if (options.dryRun) return stats;
  for (let start = 0; start < prepared.length; start += batchSize) {
    await writeBatch(db, prepared.slice(start, start + batchSize), countryCode, stats);
    const done = Math.min(start + batchSize, prepared.length);
    if (done % (batchSize * 10) === 0 || done === prepared.length) {
      say(`  ${done}/${prepared.length} businesses saved`);
    }
  }
  return stats;
}
