import type { Pool } from 'pg';
import type { GooglePlace } from '../adapters/google-places';
import { normalizeName, websiteDomainOf } from './keys';

export interface PlaceWriteContext {
  countryCode: string;
  cityId: number | null;
  subcategoryId: number;
  keyword: string;
}

export interface PlaceWriteResult {
  inserted: number;
  updated: number;
  skippedClosed: number;
}

/**
 * Saves one search's results in ONE transaction with three bulk statements:
 * places (upsert by google_place_id), place_sources (provenance) and
 * place_subcategories (why it was found). Permanently closed places are skipped.
 */
export async function writeGooglePlaces(
  db: Pool,
  results: GooglePlace[],
  ctx: PlaceWriteContext,
): Promise<PlaceWriteResult> {
  const open = results.filter((p) => p.businessStatus !== 'CLOSED_PERMANENTLY');
  // The same place twice in one statement would break ON CONFLICT DO UPDATE.
  const unique = [...new Map(open.map((p) => [p.googlePlaceId, p])).values()];
  const result: PlaceWriteResult = { inserted: 0, updated: 0, skippedClosed: results.length - open.length };
  if (unique.length === 0) return result;

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const saved = await client.query<{ id: number; google_place_id: string; inserted: boolean }>(
      `INSERT INTO places (
         google_place_id, name, name_normalized, country_code, city_id, address, lat, lng,
         website, website_domain, phone_raw, business_status, rating, rating_count,
         google_fetched_at, last_seen_at, updated_at
       )
       SELECT u.gid, u.name, u.name_normalized, u.country_code, u.city_id, u.address, u.lat, u.lng,
              u.website, u.website_domain, u.phone, u.business_status::business_status, u.rating, u.rating_count,
              now(), now(), now()
       FROM unnest(
         $1::text[], $2::text[], $3::text[], $4::text[], $5::int[], $6::text[], $7::float8[], $8::float8[],
         $9::text[], $10::text[], $11::text[], $12::text[], $13::float8[], $14::int[]
       ) AS u(gid, name, name_normalized, country_code, city_id, address, lat, lng,
              website, website_domain, phone, business_status, rating, rating_count)
       ON CONFLICT (google_place_id) DO UPDATE SET
         name = EXCLUDED.name,
         name_normalized = EXCLUDED.name_normalized,
         address = EXCLUDED.address,
         lat = EXCLUDED.lat,
         lng = EXCLUDED.lng,
         city_id = COALESCE(places.city_id, EXCLUDED.city_id),
         website = COALESCE(EXCLUDED.website, places.website),
         website_domain = COALESCE(EXCLUDED.website_domain, places.website_domain),
         phone_raw = COALESCE(EXCLUDED.phone_raw, places.phone_raw),
         business_status = EXCLUDED.business_status,
         rating = EXCLUDED.rating,
         rating_count = EXCLUDED.rating_count,
         google_fetched_at = now(),
         last_seen_at = now(),
         updated_at = now()
       RETURNING id, google_place_id, (xmax = 0) AS inserted`,
      [
        unique.map((p) => p.googlePlaceId),
        unique.map((p) => p.name || 'Unnamed'),
        unique.map((p) => normalizeName(p.name || 'Unnamed')),
        unique.map(() => ctx.countryCode),
        unique.map(() => ctx.cityId),
        unique.map((p) => p.address),
        unique.map((p) => p.lat),
        unique.map((p) => p.lng),
        unique.map((p) => p.website),
        unique.map((p) => websiteDomainOf(p.website)),
        unique.map((p) => p.phoneInternational ?? p.phoneNational),
        unique.map((p) => p.businessStatus),
        unique.map((p) => p.rating),
        unique.map((p) => p.ratingCount),
      ],
    );

    const placeIds = saved.rows.map((r) => r.id);
    for (const row of saved.rows) {
      if (row.inserted) result.inserted += 1;
      else result.updated += 1;
    }

    await client.query(
      `INSERT INTO place_sources (place_id, source, source_record_id, fetched_at)
       SELECT u.place_id, 'GOOGLE_PLACES', u.gid, now()
       FROM unnest($1::int[], $2::text[]) AS u(place_id, gid)
       ON CONFLICT (source, source_record_id) DO UPDATE SET fetched_at = now()`,
      [placeIds, saved.rows.map((r) => r.google_place_id)],
    );

    await client.query(
      `INSERT INTO place_subcategories (place_id, subcategory_id, matched_keyword, source, is_primary)
       SELECT u.place_id, $2, $3, 'GOOGLE_PLACES', false
       FROM unnest($1::int[]) AS u(place_id)
       ON CONFLICT (place_id, subcategory_id) DO NOTHING`,
      [placeIds, ctx.subcategoryId, ctx.keyword],
    );

    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}