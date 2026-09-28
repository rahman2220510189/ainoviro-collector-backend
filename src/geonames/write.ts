import type { Client } from 'pg';
import type { LocationDraft, LocationTreeDraft } from './build';

export interface WriteCounts {
  inserted: number;
  updated: number;
}

export interface WriteResult {
  country: WriteCounts;
  regions: WriteCounts;
  cities: WriteCounts;
}

export const GEONAMES_ATTRIBUTION = {
  text: 'Location data from GeoNames (geonames.org), licensed under Creative Commons Attribution (CC BY).',
  url: 'https://www.geonames.org/',
};

const CHUNK_SIZE = 1000;

/**
 * One statement upserts a whole batch (unnest of parallel arrays), keyed by geonames_id.
 * On update, "active" is NOT touched, so admins can disable places and keep them disabled.
 * (xmax = 0) is true only for freshly inserted rows.
 */
const UPSERT_SQL = `
  INSERT INTO locations (
    geonames_id, parent_id, type, name, name_local, country_code, lat, lng,
    bbox_south, bbox_west, bbox_north, bbox_east, population, active, updated_at
  )
  SELECT u.geonames_id, u.parent_id, u.type::location_type, u.name, u.name_local, u.country_code,
         u.lat, u.lng, u.bbox_south, u.bbox_west, u.bbox_north, u.bbox_east, u.population, true, now()
  FROM unnest(
    $1::int[], $2::int[], $3::text[], $4::text[], $5::text[], $6::text[], $7::float8[], $8::float8[],
    $9::float8[], $10::float8[], $11::float8[], $12::float8[], $13::int[]
  ) AS u(geonames_id, parent_id, type, name, name_local, country_code, lat, lng,
         bbox_south, bbox_west, bbox_north, bbox_east, population)
  ON CONFLICT (geonames_id) DO UPDATE SET
    parent_id = EXCLUDED.parent_id,
    type = EXCLUDED.type,
    name = EXCLUDED.name,
    name_local = EXCLUDED.name_local,
    country_code = EXCLUDED.country_code,
    lat = EXCLUDED.lat,
    lng = EXCLUDED.lng,
    bbox_south = EXCLUDED.bbox_south,
    bbox_west = EXCLUDED.bbox_west,
    bbox_north = EXCLUDED.bbox_north,
    bbox_east = EXCLUDED.bbox_east,
    population = EXCLUDED.population,
    updated_at = now()
  RETURNING id, geonames_id, (xmax = 0) AS inserted`;

/** geonames_id -> locations.id for everything written so far. */
type IdMap = Map<number, number>;

async function upsertBatch(client: Client, drafts: LocationDraft[], ids: IdMap): Promise<WriteCounts> {
  const counts: WriteCounts = { inserted: 0, updated: 0 };

  for (let start = 0; start < drafts.length; start += CHUNK_SIZE) {
    const chunk = drafts.slice(start, start + CHUNK_SIZE);
    const parentIds = chunk.map((d) => {
      if (d.parentGeonamesId === null) return null;
      const id = ids.get(d.parentGeonamesId);
      if (id === undefined) throw new Error(`Parent ${d.parentGeonamesId} of ${d.name} not written yet`);
      return id;
    });

    const result = await client.query<{ id: number; geonames_id: number; inserted: boolean }>(
      UPSERT_SQL,
      [
        chunk.map((d) => d.geonamesId),
        parentIds,
        chunk.map((d) => d.type),
        chunk.map((d) => d.name),
        chunk.map((d) => d.nameLocal),
        chunk.map((d) => d.countryCode),
        chunk.map((d) => d.lat),
        chunk.map((d) => d.lng),
        chunk.map((d) => d.bbox?.south ?? null),
        chunk.map((d) => d.bbox?.west ?? null),
        chunk.map((d) => d.bbox?.north ?? null),
        chunk.map((d) => d.bbox?.east ?? null),
        chunk.map((d) => d.population),
      ],
    );

    for (const row of result.rows) {
      ids.set(row.geonames_id, row.id);
      if (row.inserted) counts.inserted += 1;
      else counts.updated += 1;
    }
  }
  return counts;
}

/** Writes regions level by level, so every parent exists before its children. */
async function upsertRegions(client: Client, regions: LocationDraft[], ids: IdMap): Promise<WriteCounts> {
  const total: WriteCounts = { inserted: 0, updated: 0 };
  let remaining = regions;
  while (remaining.length > 0) {
    const ready = remaining.filter((r) => r.parentGeonamesId === null || ids.has(r.parentGeonamesId));
    if (ready.length === 0) throw new Error('Region tree has a missing or circular parent');
    const counts = await upsertBatch(client, ready, ids);
    total.inserted += counts.inserted;
    total.updated += counts.updated;
    remaining = remaining.filter((r) => !ready.includes(r));
  }
  return total;
}

/** Writes the whole tree and the attribution in ONE transaction. */
export async function writeLocationTree(client: Client, tree: LocationTreeDraft): Promise<WriteResult> {
  const ids: IdMap = new Map();
  await client.query('BEGIN');
  try {
    const country = await upsertBatch(client, [tree.country], ids);
    const regions = await upsertRegions(client, tree.regions, ids);
    const cities = await upsertBatch(client, tree.cities, ids);

    await client.query(
      `INSERT INTO settings (key, value, updated_at)
       VALUES ('attribution.geonames', $1::jsonb, now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [JSON.stringify(GEONAMES_ATTRIBUTION)],
    );

    await client.query('COMMIT');
    return { country, regions, cities };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  }
}