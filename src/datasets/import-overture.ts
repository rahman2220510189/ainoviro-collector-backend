import type { Pool } from 'pg';
import type { Bbox } from '../geonames/build';
import { readCountryBorder, type CountryBorder } from './country-border';
import { loadDatasetSettings } from './settings';
import { estimateImportStorage, formatBytes, type StorageEstimate } from './storage';
import {
  describeError,
  openUrlWithRetries,
  latestOvertureRelease,
  listOvertureFiles,
  overtureSource,
  readOverturePlaces,
  writeOverturePlaces,
  type OvertureStats,
} from './overture';

export interface OvertureImportOptions {
  countryCode: string;
  /** A fixed release; otherwise the setting, otherwise the newest on S3. */
  release?: string;
  /** Local parquet files instead of S3 (tests, or files downloaded by hand). */
  localFiles?: string[];
  /** Read and report only; nothing is written. */
  dryRun?: boolean;
  /** Progress lines for the command line. */
  onProgress?: (line: string) => void;
  /** Overrides the setting (verification scripts check the other filters without it). */
  onlyWithContact?: boolean;
  /** Local division_area files with the country's outline (tests); with localFiles. */
  borderFiles?: string[];
  /** Overrides the storage limit setting (MB); verification only. */
  storageLimitMb?: number;
}

export interface OvertureImportResult {
  release: string;
  source: string;
  stats: OvertureStats;
  importId: number | null;
  seconds: number;
  /** How big the database gets with this import (also on a dry run). */
  storage: StorageEstimate;
}

/**
 * The country's real outline from the same Overture release (division_area). Without it
 * the import still works with the box only, but says so: in a country whose box covers
 * neighbours, places with no address country may then be from the neighbour.
 */
async function loadBorder(
  countryCode: string,
  box: Bbox,
  release: string,
  options: OvertureImportOptions,
  say: (line: string) => void,
): Promise<CountryBorder | null> {
  if (options.localFiles && !options.borderFiles) return null;
  try {
    say('Reading the country outline (Overture divisions)');
    const files =
      options.borderFiles ??
      (await listOvertureFiles(release, fetch, 'theme=divisions/type=division_area'));
    const border = await readCountryBorder(files, box, countryCode, {
      onProgress: say,
      openUrl: (hp, url) => openUrlWithRetries(hp, url, say),
    });
    if (!border) say(`  no outline for ${countryCode} in this release: using the box only`);
    return border;
  } catch (err) {
    say(`  could not read the country outline (${describeError(err)}): using the box only`);
    return null;
  }
}

/** The newest release, with a clear way out when S3 cannot be listed. */
async function newestRelease(): Promise<string> {
  try {
    return await latestOvertureRelease();
  } catch (err) {
    throw new Error(
      `Could not find the newest Overture release (${err instanceof Error ? err.message : String(err)}). ` +
        'Give it by hand, e.g. --release 2026-09-23.0 (see docs.overturemaps.org/blog/tags/releases).',
      { cause: err },
    );
  }
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
 * Imports one country's Overture places into stg_overture_places and logs the run in
 * dataset_imports. Reading happens before the database transaction starts, so the
 * previous data stays in place until the new release is fully read.
 */
export async function runOvertureImport(
  db: Pool,
  options: OvertureImportOptions,
): Promise<OvertureImportResult> {
  const started = Date.now();
  const say = options.onProgress ?? (() => undefined);
  const countryCode = options.countryCode.toUpperCase();
  const settings = await loadDatasetSettings(db);
  const box = await countryBox(db, countryCode);

  const release = options.localFiles
    ? (options.release ?? 'local')
    : (options.release ?? settings.overture.release ?? (await newestRelease()));
  const source = options.localFiles ? options.localFiles.join(', ') : overtureSource(release);
  say(`Overture release ${release}, country ${countryCode}`);
  say(`Reading ${source}`);

  let importId: number | null = null;
  if (!options.dryRun) {
    const { rows } = await db.query<{ id: number }>(
      `INSERT INTO dataset_imports (source, country_code, release, status)
       VALUES ('OVERTURE', $1, $2, 'RUNNING') RETURNING id`,
      [countryCode, release],
    );
    importId = rows[0]?.id ?? null;
  }

  try {
    const files = options.localFiles ?? (await listOvertureFiles(release));
    say(`${files.length} file(s); only the parts covering ${countryCode} are downloaded`);
    const border = await loadBorder(countryCode, box, release, options, say);
    const { kept, stats } = await readOverturePlaces(
      files,
      box,
      countryCode,
      settings.overture.minConfidence,
      say,
      options.onlyWithContact ?? settings.overture.onlyWithContact,
      border,
    );
    say(`Read ${stats.read} places, kept ${stats.kept}`);

    // Never fill the database past its limit: stop before anything is saved.
    const limitMb = options.storageLimitMb ?? settings.storageLimitMb;
    const storage = await estimateImportStorage(db, countryCode, stats.kept, limitMb);
    say(
      `Database: ${formatBytes(storage.currentBytes)} now, about ${formatBytes(storage.afterBytes)} ` +
        `after this import (limit ${formatBytes(storage.limitBytes)})`,
    );
    if (!storage.fits && !options.dryRun) {
      throw new Error(
        `Not enough room: the database would grow to about ${formatBytes(storage.afterBytes)}, ` +
          `over the limit of ${formatBytes(storage.limitBytes)} (Settings: storageLimitMb). ` +
          'Nothing was saved. Free space first (prune:places, db:compact), raise the minimum ' +
          'confidence, or move to a bigger database plan and raise the limit.',
      );
    }

    let removed = 0;
    if (!options.dryRun) {
      ({ removed } = await writeOverturePlaces(db, kept, countryCode, release));
    }
    const full: OvertureStats = { ...stats, removed };
    if (importId !== null) {
      await db.query(
        `UPDATE dataset_imports SET status = 'DONE', stats = $2::jsonb, finished_at = now() WHERE id = $1`,
        [importId, JSON.stringify(full)],
      );
    }
    return {
      release,
      source,
      stats: full,
      importId,
      seconds: (Date.now() - started) / 1000,
      storage,
    };
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
