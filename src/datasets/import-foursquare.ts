import type { Pool } from 'pg';
import type { Bbox } from '../geonames/build';
import {
  fsqSource,
  latestFsqRelease,
  listFsqFiles,
  readFsqPlaces,
  refreshedCutoff,
  writeFsqPlaces,
  type FsqStats,
} from './foursquare';
import { describeError } from './overture';
import { loadDatasetSettings } from './settings';

export interface FsqImportOptions {
  countryCode: string;
  /** Hugging Face read token (HF_TOKEN). Needed for the download, not for local files. */
  token?: string | null;
  /** A fixed release date; otherwise the setting, otherwise the newest on Hugging Face. */
  release?: string;
  /** Local parquet files instead of the download (tests, or files downloaded by hand). */
  localFiles?: string[];
  dryRun?: boolean;
  onProgress?: (line: string) => void;
  now?: Date;
}

export interface FsqImportResult {
  release: string;
  source: string;
  stats: FsqStats;
  importId: number | null;
  seconds: number;
}

async function countryBox(db: Pool, countryCode: string): Promise<Bbox> {
  const { rows } = await db.query<{
    bbox_south: number | null;
    bbox_west: number | null;
    bbox_north: number | null;
    bbox_east: number | null;
  }>(
    `SELECT bbox_south, bbox_west, bbox_north, bbox_east FROM locations
     WHERE type = 'COUNTRY' AND country_code = $1 AND active LIMIT 1`,
    [countryCode],
  );
  const r = rows[0];
  if (
    !r ||
    r.bbox_south === null ||
    r.bbox_west === null ||
    r.bbox_north === null ||
    r.bbox_east === null
  ) {
    throw new Error(
      `Country ${countryCode} is not imported (or has no box). Run import:geonames -- --country ${countryCode} first.`,
    );
  }
  return { south: r.bbox_south, west: r.bbox_west, north: r.bbox_north, east: r.bbox_east };
}

/**
 * Imports one country's Foursquare places into stg_fsq_places and logs the run in
 * dataset_imports (source FOURSQUARE). The previous data stays until the new release is
 * fully read; then it is replaced in one transaction.
 */
export async function runFoursquareImport(
  db: Pool,
  options: FsqImportOptions,
): Promise<FsqImportResult> {
  const started = Date.now();
  const say = options.onProgress ?? (() => undefined);
  const countryCode = options.countryCode.toUpperCase();
  const token = options.token ?? null;
  if (!options.localFiles && !token) {
    throw new Error(
      'HF_TOKEN is not set in backend/.env. Create a Read token at https://huggingface.co/settings/tokens ' +
        'after accepting the terms of https://huggingface.co/datasets/foursquare/fsq-os-places.',
    );
  }
  const settings = await loadDatasetSettings(db);
  const box = await countryBox(db, countryCode);
  const release = options.localFiles
    ? (options.release ?? 'local')
    : (options.release ?? settings.foursquare.release ?? (await latestFsqRelease(token)));
  const source = options.localFiles ? options.localFiles.join(', ') : fsqSource(release);
  const cutoff = refreshedCutoff(settings.foursquare.maxAgeMonths, options.now);
  say(`Foursquare release ${release}, country ${countryCode}`);
  say(`Reading ${source}`);
  say(`Keeping places refreshed since ${cutoff} (${settings.foursquare.maxAgeMonths} months)`);

  let importId: number | null = null;
  if (!options.dryRun) {
    const { rows } = await db.query<{ id: number }>(
      `INSERT INTO dataset_imports (source, country_code, release, status)
       VALUES ('FOURSQUARE', $1, $2, 'RUNNING') RETURNING id`,
      [countryCode, release],
    );
    importId = rows[0]?.id ?? null;
  }

  try {
    const files = options.localFiles ?? (await listFsqFiles(release, token));
    say(`${files.length} file(s); for each part only the country column is read first`);
    const { kept, stats } = await readFsqPlaces(files, box, countryCode, {
      cutoff,
      token,
      onProgress: say,
    });
    say(`Read ${stats.read} places, kept ${stats.kept}`);
    let removed = 0;
    if (!options.dryRun) {
      ({ removed } = await writeFsqPlaces(db, kept, countryCode, release));
    }
    const full: FsqStats = { ...stats, removed };
    if (importId !== null) {
      await db.query(
        `UPDATE dataset_imports SET status = 'DONE', stats = $2::jsonb, finished_at = now() WHERE id = $1`,
        [importId, JSON.stringify(full)],
      );
    }
    return { release, source, stats: full, importId, seconds: (Date.now() - started) / 1000 };
  } catch (err) {
    if (importId !== null) {
      await db
        .query(
          `UPDATE dataset_imports SET status = 'FAILED', error = $2, finished_at = now() WHERE id = $1`,
          [importId, describeError(err).slice(0, 2000)],
        )
        .catch(() => undefined);
    }
    throw new Error(describeError(err), { cause: err });
  }
}
