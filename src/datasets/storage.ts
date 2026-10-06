import type { Pool } from 'pg';
import { analyzeWebsite } from '../cleaning/website';

/**
 * Keeping the database small (step 6.1): the free Neon plan has little room, and a big
 * country has ten or more times the places of Cyprus. Only places that can become a lead
 * are worth keeping: the CSV needs an email, and the crawler needs an own website to find
 * one. Places with neither (and no Google record, never exported) are dropped.
 */

export interface TableSize {
  name: string;
  bytes: number;
  rows: number;
}

export interface DatabaseSize {
  totalBytes: number;
  tables: TableSize[];
}

export async function databaseSize(db: Pool): Promise<DatabaseSize> {
  const [total, tables] = await Promise.all([
    db.query<{ bytes: string }>('SELECT pg_database_size(current_database()) AS bytes'),
    db.query<{ name: string; bytes: string; rows: string }>(
      `SELECT c.relname AS name, pg_total_relation_size(c.oid) AS bytes,
              greatest(c.reltuples, 0)::bigint AS rows
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE c.relkind = 'r' AND n.nspname = 'public'
       ORDER BY pg_total_relation_size(c.oid) DESC`,
    ),
  ]);
  return {
    totalBytes: Number(total.rows[0]?.bytes ?? 0),
    tables: tables.rows.map((r) => ({
      name: r.name,
      bytes: Number(r.bytes),
      rows: Number(r.rows),
    })),
  };
}

export const formatBytes = (n: number): string =>
  n >= 1e9
    ? `${(n / 1e9).toFixed(2)} GB`
    : n >= 1e6
      ? `${(n / 1e6).toFixed(1)} MB`
      : `${Math.round(n / 1e3)} kB`;

/** An Overture place can become a lead when it has an email or an own website to crawl. */
export function hasUsefulContact(emails: string[], websites: string[]): boolean {
  return emails.length > 0 || websites.some((w) => analyzeWebsite(w).domain !== null);
}

export interface PruneResult {
  /** Overture-only places with no email and no own website (deleted unless dry run). */
  places: number;
  /** Staged Overture rows without contact (deleted too, or the merge would bring them back). */
  stagingRows: number;
}

/**
 * Removes places that can never become a lead: no email, no own website, not found by
 * Google, never exported or worked on. Also removes the matching staged Overture rows, so
 * a later merge or job does not bring them back. Their categories and sources go with them.
 */
export async function pruneNoContact(
  db: Pool,
  countryCode: string,
  dryRun: boolean,
): Promise<PruneResult> {
  const placeFilter = `
    FROM places p
    WHERE p.country_code = $1
      AND p.google_place_id IS NULL
      AND p.website_domain IS NULL
      AND p.status = 'NEW'
      AND NOT EXISTS (SELECT 1 FROM emails e WHERE e.place_id = p.id)
      AND NOT EXISTS (SELECT 1 FROM export_batch_items x WHERE x.place_id = p.id)
      AND EXISTS (SELECT 1 FROM place_sources s WHERE s.place_id = p.id AND s.source = 'OVERTURE')`;

  // Staged rows: no email, and no website that is a real own site (not Facebook etc.).
  const staged = await db.query<{ id: string; websites: string[] }>(
    `SELECT id, websites FROM stg_overture_places
     WHERE country_code = $1 AND cardinality(emails) = 0`,
    [countryCode],
  );
  const stagingIds = staged.rows.filter((r) => !hasUsefulContact([], r.websites)).map((r) => r.id);

  if (dryRun) {
    const { rows } = await db.query<{ n: string }>(`SELECT count(*) AS n ${placeFilter}`, [
      countryCode,
    ]);
    return { places: Number(rows[0]?.n ?? 0), stagingRows: stagingIds.length };
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const deleted = await client.query(
      `DELETE FROM places WHERE id IN (SELECT p.id ${placeFilter})`,
      [countryCode],
    );
    let stagingRows = 0;
    for (let i = 0; i < stagingIds.length; i += 5000) {
      const r = await client.query('DELETE FROM stg_overture_places WHERE id = ANY($1::text[])', [
        stagingIds.slice(i, i + 5000),
      ]);
      stagingRows += r.rowCount ?? 0;
    }
    await client.query('COMMIT');
    return { places: deleted.rowCount ?? 0, stagingRows };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/** Used before anything is stored, when the database has too few places to measure. */
const DEFAULT_BYTES_PER_PLACE = 2500;

export interface StorageEstimate {
  /** Database size now. */
  currentBytes: number;
  /** Places this import adds (kept minus the ones of this country already staged). */
  newPlaces: number;
  /** Measured from this database: everything it holds, divided by its places. */
  bytesPerPlace: number;
  /** Database size after the import and the merge, roughly. */
  afterBytes: number;
  limitBytes: number;
  fits: boolean;
}

/**
 * How big the database gets when `kept` Overture places of a country come in (step 6.4).
 * Measured from what is already stored (staged row + place + emails + indexes, per place),
 * so it follows this database rather than a guess. Rough, on purpose a little high.
 */
export async function estimateImportStorage(
  db: Pool,
  countryCode: string,
  kept: number,
  limitMb: number,
): Promise<StorageEstimate> {
  const [size, counts] = await Promise.all([
    db.query<{ bytes: string }>('SELECT pg_database_size(current_database()) AS bytes'),
    db.query<{ places: string; staged: string }>(
      `SELECT (SELECT count(*) FROM places) AS places,
              (SELECT count(*) FROM stg_overture_places WHERE country_code = $1) AS staged`,
      [countryCode],
    ),
  ]);
  const currentBytes = Number(size.rows[0]?.bytes ?? 0);
  const places = Number(counts.rows[0]?.places ?? 0);
  const staged = Number(counts.rows[0]?.staged ?? 0);
  const bytesPerPlace =
    places >= 1000 ? Math.round(currentBytes / places) : DEFAULT_BYTES_PER_PLACE;
  const newPlaces = Math.max(0, kept - staged);
  const afterBytes = currentBytes + newPlaces * bytesPerPlace;
  const limitBytes = limitMb * 1e6;
  return {
    currentBytes,
    newPlaces,
    bytesPerPlace,
    afterBytes,
    limitBytes,
    fits: afterBytes <= limitBytes,
  };
}
