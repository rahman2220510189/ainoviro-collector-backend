import type { Pool, PoolClient } from 'pg';
import { pickPrimaryIndex } from '../enrich/classify';
import { chooseSurvivor, type DuplicateGroup } from './dedupe';

interface PlaceRow {
  id: number;
  name: string;
  status: string;
  address: string | null;
  lat: number | null;
  lng: number | null;
  city_id: number | null;
  city_name: string | null;
  website: string | null;
  website_domain: string | null;
  phone_raw: string | null;
  phone_e164: string | null;
  phone_valid: boolean;
  google_place_id: string | null;
  overture_id: string | null;
  fsq_id: string | null;
  business_status: string;
  rating: number | null;
  rating_count: number | null;
  first_seen_at: Date;
  last_seen_at: Date;
  last_crawled_at: Date | null;
  has_primary: boolean;
}

export interface MergeResult {
  survivorId: number;
  mergedIds: number[];
}

const firstSet = <T>(values: (T | null)[]): T | null => values.find((v) => v !== null) ?? null;

/**
 * Field precedence (spec §11): the survivor keeps its own values; empty fields are
 * filled from the merged places (oldest first). A valid phone beats an invalid one,
 * an own website beats a platform link, and the rating with more reviews wins.
 */
function mergedFields(survivor: PlaceRow, others: PlaceRow[]): Partial<PlaceRow> {
  const all = [survivor, ...others];
  const withPhone = survivor.phone_valid
    ? survivor
    : (others.find((o) => o.phone_valid) ?? survivor);
  const withSite = survivor.website_domain
    ? survivor
    : (others.find((o) => o.website_domain) ?? survivor);
  const rated =
    [...all].sort((a, b) => (b.rating_count ?? -1) - (a.rating_count ?? -1))[0] ?? survivor;
  const located =
    survivor.lat !== null ? survivor : (others.find((o) => o.lat !== null) ?? survivor);
  const time = (d: Date | null): number => (d ? d.getTime() : 0);
  return {
    address: firstSet(all.map((p) => p.address)),
    lat: located.lat,
    lng: located.lng,
    city_id: firstSet(all.map((p) => p.city_id)),
    city_name: firstSet(all.map((p) => p.city_name)),
    website: withSite.website ?? firstSet(all.map((p) => p.website)),
    website_domain: withSite.website_domain,
    phone_raw: withPhone.phone_raw ?? firstSet(all.map((p) => p.phone_raw)),
    phone_e164: withPhone.phone_e164,
    phone_valid: withPhone.phone_valid,
    google_place_id: firstSet(all.map((p) => p.google_place_id)),
    overture_id: firstSet(all.map((p) => p.overture_id)),
    fsq_id: firstSet(all.map((p) => p.fsq_id)),
    rating: rated.rating,
    rating_count: rated.rating_count,
    first_seen_at: new Date(Math.min(...all.map((p) => time(p.first_seen_at)))),
    last_seen_at: new Date(Math.max(...all.map((p) => time(p.last_seen_at)))),
    last_crawled_at: all.some((p) => p.last_crawled_at)
      ? new Date(Math.max(...all.map((p) => time(p.last_crawled_at))))
      : null,
  };
}

/** Gives the survivor a primary email if it has none (after emails were moved to it). */
async function ensurePrimaryEmail(client: PoolClient, placeId: number): Promise<void> {
  const { rows } = await client.query<{
    id: number;
    is_primary: boolean;
    is_own_domain: boolean;
    email_type: 'GENERIC' | 'PERSONAL';
    mx_valid: boolean | null;
  }>(
    `SELECT id, is_primary, is_own_domain, email_type, mx_valid FROM emails
     WHERE place_id = $1 ORDER BY id`,
    [placeId],
  );
  if (rows.length === 0 || rows.some((r) => r.is_primary)) return;
  const best =
    rows[
      pickPrimaryIndex(
        rows.map((r) => ({
          isOwnDomain: r.is_own_domain,
          emailType: r.email_type,
          mxValid: r.mx_valid,
        })),
      )
    ];
  if (best) await client.query('UPDATE emails SET is_primary = true WHERE id = $1', [best.id]);
}

/**
 * Merges one group of duplicate places into one, in ONE transaction:
 * sources, subcategories (union), emails, export items and job tasks move to the
 * surviving place; empty fields are filled; the other places are deleted; the merge is
 * written to audit_log. Returns null when the group changed meanwhile (fewer than two
 * of its places still exist).
 */
export async function mergePlaceGroup(
  db: Pool,
  group: DuplicateGroup,
): Promise<MergeResult | null> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query<PlaceRow>(
      `SELECT p.id, p.name, p.status, p.address, p.lat, p.lng, p.city_id, p.city_name, p.website,
              p.website_domain, p.phone_raw, p.phone_e164, p.phone_valid, p.google_place_id,
              p.overture_id, p.fsq_id, p.business_status, p.rating, p.rating_count,
              p.first_seen_at, p.last_seen_at, p.last_crawled_at,
              EXISTS (SELECT 1 FROM emails e WHERE e.place_id = p.id AND e.is_primary) AS has_primary
       FROM places p WHERE p.id = ANY($1::int[]) ORDER BY p.id FOR UPDATE`,
      [group.ids],
    );
    if (rows.length < 2) {
      await client.query('ROLLBACK');
      return null;
    }
    const survivorId = chooseSurvivor(
      rows.map((r) => ({ id: r.id, status: r.status, hasPrimaryEmail: r.has_primary })),
    );
    const survivor = rows.find((r) => r.id === survivorId) as PlaceRow;
    const others = rows.filter((r) => r.id !== survivorId);
    const otherIds = others.map((r) => r.id);
    const fields = mergedFields(survivor, others);

    await client.query('UPDATE place_sources SET place_id = $1 WHERE place_id = ANY($2::int[])', [
      survivorId,
      otherIds,
    ]);
    await client.query(
      `INSERT INTO place_subcategories (place_id, subcategory_id, matched_keyword, source, is_primary, created_at)
       SELECT $1, subcategory_id, matched_keyword, source, false, created_at
       FROM place_subcategories WHERE place_id = ANY($2::int[])
       ON CONFLICT (place_id, subcategory_id) DO NOTHING`,
      [survivorId, otherIds],
    );
    // Only one primary email per place: moved emails lose the flag, then the best is chosen.
    await client.query(
      `UPDATE emails SET is_primary = false WHERE place_id = ANY($1::int[]) AND is_primary`,
      [otherIds],
    );
    await client.query('UPDATE emails SET place_id = $1 WHERE place_id = ANY($2::int[])', [
      survivorId,
      otherIds,
    ]);
    await ensurePrimaryEmail(client, survivorId);
    await client.query(
      'UPDATE export_batch_items SET place_id = $1 WHERE place_id = ANY($2::int[])',
      [survivorId, otherIds],
    );
    await client.query('UPDATE job_tasks SET place_id = $1 WHERE place_id = ANY($2::int[])', [
      survivorId,
      otherIds,
    ]);
    // Delete first: the source ids (UNIQUE) can then move to the survivor.
    await client.query('DELETE FROM places WHERE id = ANY($1::int[])', [otherIds]);
    await client.query(
      `UPDATE places SET address = $2, lat = $3, lng = $4, city_id = $5, city_name = $6, website = $7,
              website_domain = $8, phone_raw = $9, phone_e164 = $10, phone_valid = $11,
              google_place_id = $12, overture_id = $13, fsq_id = $14, rating = $15, rating_count = $16,
              first_seen_at = $17, last_seen_at = $18, last_crawled_at = $19, updated_at = now()
       WHERE id = $1`,
      [
        survivorId,
        fields.address,
        fields.lat,
        fields.lng,
        fields.city_id,
        fields.city_name,
        fields.website,
        fields.website_domain,
        fields.phone_raw,
        fields.phone_e164,
        fields.phone_valid,
        fields.google_place_id,
        fields.overture_id,
        fields.fsq_id,
        fields.rating,
        fields.rating_count,
        fields.first_seen_at,
        fields.last_seen_at,
        fields.last_crawled_at,
      ],
    );
    await client.query(
      `INSERT INTO audit_log (action, entity_type, entity_id, details)
       VALUES ('place.merge', 'place', $1, $2)`,
      [
        String(survivorId),
        JSON.stringify({
          reasons: group.reasons,
          merged: others.map((o) => ({ id: o.id, name: o.name, googlePlaceId: o.google_place_id })),
        }),
      ],
    );
    await client.query('COMMIT');
    return { survivorId, mergedIds: otherIds };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}