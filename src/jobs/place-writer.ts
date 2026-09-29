import type { Pool } from 'pg';
import type { GooglePlace } from '../adapters/google-places';
import type { CityResolver } from '../cleaning/city';
import { normalizePlaceFields, type NormalizedPlaceFields } from '../cleaning/normalize-place';

export interface PlaceWriteContext {
  countryCode: string;
  /** City of the search area (null for rural areas); fallback when coordinates give no city. */
  cityId: number | null;
  subcategoryId: number;
  keyword: string;
  /** Decides the real city from coordinates. Without it the area's city is used. */
  cities?: CityResolver | null;
}

export interface PlaceWriteResult {
  inserted: number;
  updated: number;
  skippedClosed: number;
}

export interface PreparedPlace {
  place: GooglePlace;
  fields: NormalizedPlaceFields;
}

/**
 * Drops permanently closed places and duplicates inside one result list, and
 * cleans every place (website, own domain, phone E.164, matching name, city).
 */
export function prepareGooglePlaces(
  results: GooglePlace[],
  ctx: PlaceWriteContext,
): { prepared: PreparedPlace[]; skippedClosed: number } {
  const open = results.filter((p) => p.businessStatus !== 'CLOSED_PERMANENTLY');
  // The same place twice in one statement would break ON CONFLICT DO UPDATE.
  const unique = [...new Map(open.map((p) => [p.googlePlaceId, p])).values()];
  const prepared = unique.map((place) => {
    const fields = normalizePlaceFields(
      {
        name: place.name,
        website: place.website,
        phone: place.phoneInternational ?? place.phoneNational,
        lat: place.lat,
        lng: place.lng,
      },
      { countryCode: ctx.countryCode, cities: ctx.cities ?? null, fallbackCityId: ctx.cityId },
    );
    return { place, fields };
  });
  return { prepared, skippedClosed: results.length - open.length };
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
  const { prepared: all, skippedClosed } = prepareGooglePlaces(results, ctx);
  const result: PlaceWriteResult = { inserted: 0, updated: 0, skippedClosed };
  if (all.length === 0) return result;

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    // Source ids first (spec §11): a Google id that was merged into another place lives
    // on in place_sources only. Such results update that place instead of creating the
    // duplicate again.
    const merged = await client.query<{ gid: string; place_id: number }>(
      `SELECT s.source_record_id AS gid, s.place_id
       FROM place_sources s JOIN places p ON p.id = s.place_id
       WHERE s.source = 'GOOGLE_PLACES' AND s.source_record_id = ANY($1::text[])
         AND p.google_place_id IS DISTINCT FROM s.source_record_id`,
      [all.map((p) => p.place.googlePlaceId)],
    );
    const mergedInto = new Map(merged.rows.map((r) => [r.gid, r.place_id]));
    const prepared = all.filter((p) => !mergedInto.has(p.place.googlePlaceId));
    if (mergedInto.size > 0) {
      const ids = [...new Set(mergedInto.values())];
      await client.query('UPDATE places SET last_seen_at = now() WHERE id = ANY($1::int[])', [ids]);
      await client.query(
        `UPDATE place_sources SET fetched_at = now()
         WHERE source = 'GOOGLE_PLACES' AND source_record_id = ANY($1::text[])`,
        [[...mergedInto.keys()]],
      );
      await client.query(
        `INSERT INTO place_subcategories (place_id, subcategory_id, matched_keyword, source, is_primary)
         SELECT u.place_id, $2, $3, 'GOOGLE_PLACES', false FROM unnest($1::int[]) AS u(place_id)
         ON CONFLICT (place_id, subcategory_id) DO NOTHING`,
        [ids, ctx.subcategoryId, ctx.keyword],
      );
      result.updated += mergedInto.size;
    }
    if (prepared.length === 0) {
      await client.query('COMMIT');
      return result;
    }

    const saved = await client.query<{ id: number; google_place_id: string; inserted: boolean }>(
      `INSERT INTO places (
         google_place_id, name, name_normalized, country_code, city_id, city_name, address, lat, lng,
         website, website_domain, phone_raw, phone_e164, phone_valid, business_status, rating, rating_count,
         google_fetched_at, last_seen_at, updated_at
       )
       SELECT u.gid, u.name, u.name_normalized, u.country_code, u.city_id, u.city_name, u.address, u.lat, u.lng,
              u.website, u.website_domain, u.phone_raw, u.phone_e164, u.phone_valid,
              u.business_status::business_status, u.rating, u.rating_count,
              now(), now(), now()
       FROM unnest(
         $1::text[], $2::text[], $3::text[], $4::text[], $5::int[], $6::text[], $7::text[], $8::float8[],
         $9::float8[], $10::text[], $11::text[], $12::text[], $13::text[], $14::bool[], $15::text[],
         $16::float8[], $17::int[]
       ) AS u(gid, name, name_normalized, country_code, city_id, city_name, address, lat, lng,
              website, website_domain, phone_raw, phone_e164, phone_valid, business_status, rating, rating_count)
       ON CONFLICT (google_place_id) DO UPDATE SET
         name = EXCLUDED.name,
         name_normalized = EXCLUDED.name_normalized,
         address = EXCLUDED.address,
         lat = EXCLUDED.lat,
         lng = EXCLUDED.lng,
         city_id = COALESCE(EXCLUDED.city_id, places.city_id),
         city_name = COALESCE(EXCLUDED.city_name, places.city_name),
         website = COALESCE(EXCLUDED.website, places.website),
         -- A new website decides the domain (a platform link gives NULL on purpose).
         website_domain = CASE WHEN EXCLUDED.website IS NOT NULL
                               THEN EXCLUDED.website_domain ELSE places.website_domain END,
         phone_raw = COALESCE(EXCLUDED.phone_raw, places.phone_raw),
         phone_e164 = CASE WHEN EXCLUDED.phone_raw IS NOT NULL
                           THEN EXCLUDED.phone_e164 ELSE places.phone_e164 END,
         phone_valid = CASE WHEN EXCLUDED.phone_raw IS NOT NULL
                            THEN EXCLUDED.phone_valid ELSE places.phone_valid END,
         business_status = EXCLUDED.business_status,
         rating = EXCLUDED.rating,
         rating_count = EXCLUDED.rating_count,
         google_fetched_at = now(),
         last_seen_at = now(),
         updated_at = now()
       RETURNING id, google_place_id, (xmax = 0) AS inserted`,
      [
        prepared.map((p) => p.place.googlePlaceId),
        prepared.map((p) => p.fields.name),
        prepared.map((p) => p.fields.nameNormalized),
        prepared.map(() => ctx.countryCode),
        prepared.map((p) => p.fields.city?.cityId ?? ctx.cityId),
        prepared.map((p) => p.fields.city?.cityName ?? null),
        prepared.map((p) => p.place.address),
        prepared.map((p) => p.place.lat),
        prepared.map((p) => p.place.lng),
        prepared.map((p) => p.fields.website),
        prepared.map((p) => p.fields.websiteDomain),
        prepared.map((p) => p.fields.phoneRaw),
        prepared.map((p) => p.fields.phoneE164),
        prepared.map((p) => p.fields.phoneValid),
        prepared.map((p) => p.place.businessStatus),
        prepared.map((p) => p.place.rating),
        prepared.map((p) => p.place.ratingCount),
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