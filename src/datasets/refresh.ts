import type { Pool } from 'pg';
import { z } from 'zod';
import type { MxChecker } from '../enrich/mx';
import { countReadyLeads, runLeadPipeline, withPipelineLock } from '../leads/process';
import { loadLeadRules } from '../leads/rules';
import { AppError } from '../lib/errors';
import { importGeonamesCountry } from '../geonames/import-country';
import { runOvertureImport } from './import-overture';
import { mergeOverturePlaces } from './merge-overture';

/**
 * "Update Overture data" from the Settings page (no command line once hosted).
 * The website only records the request; the worker picks it up and runs the same steps
 * as the command line: import:overture -> merge:overture -> lead pipeline.
 * The state lives in settings.key = "dataset_refresh", so every page sees the progress.
 */
export const DATASET_REFRESH_KEY = 'dataset_refresh';

/** A run that has not moved for this long is treated as abandoned (worker stopped). */
export const REFRESH_STALE_MINUTES = 30;

export const refreshStateSchema = z.object({
  state: z.enum(['IDLE', 'REQUESTED', 'RUNNING', 'DONE', 'FAILED']).default('IDLE'),
  countryCode: z.string().nullable().default(null),
  requestedAt: z.string().nullable().default(null),
  requestedBy: z.number().nullable().default(null),
  startedAt: z.string().nullable().default(null),
  finishedAt: z.string().nullable().default(null),
  /** Last progress line, e.g. "Saving businesses: 5000/31545". */
  step: z.string().nullable().default(null),
  updatedAt: z.string().nullable().default(null),
  error: z.string().nullable().default(null),
  result: z
    .object({
      release: z.string(),
      placesInImport: z.number(),
      newBusinesses: z.number(),
      newEmails: z.number(),
      duplicatesMerged: z.number(),
      readyBefore: z.number(),
      readyAfter: z.number(),
    })
    .nullable()
    .default(null),
});

export type RefreshState = z.infer<typeof refreshStateSchema>;

export async function readRefreshState(db: Pool): Promise<RefreshState> {
  const { rows } = await db.query<{ value: unknown }>('SELECT value FROM settings WHERE key = $1', [
    DATASET_REFRESH_KEY,
  ]);
  const parsed = refreshStateSchema.safeParse(rows[0]?.value ?? {});
  return parsed.success ? parsed.data : refreshStateSchema.parse({});
}

async function writeState(db: Pool, state: RefreshState): Promise<void> {
  await db.query(
    `INSERT INTO settings (key, value, updated_at) VALUES ($1, $2::jsonb, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [DATASET_REFRESH_KEY, JSON.stringify(state)],
  );
}

/** Still waiting or running, and not abandoned. */
export function isRefreshBusy(state: RefreshState, now = Date.now()): boolean {
  if (state.state !== 'REQUESTED' && state.state !== 'RUNNING') return false;
  const last = Date.parse(state.updatedAt ?? state.requestedAt ?? '');
  return Number.isFinite(last) && now - last < REFRESH_STALE_MINUTES * 60_000;
}

/** Records the request. Refuses a second one while the first is waiting or running. */
export async function requestRefresh(
  db: Pool,
  countryCode: string,
  adminId: number | null,
): Promise<RefreshState> {
  const current = await readRefreshState(db);
  if (isRefreshBusy(current)) {
    throw new AppError(
      409,
      'REFRESH_BUSY',
      current.state === 'RUNNING'
        ? 'An Overture update is already running.'
        : 'An Overture update is already waiting for the worker.',
    );
  }
  const now = new Date().toISOString();
  const next: RefreshState = {
    ...refreshStateSchema.parse({}),
    state: 'REQUESTED',
    countryCode,
    requestedAt: now,
    requestedBy: adminId,
    updatedAt: now,
    step: 'Waiting for the worker',
  };
  await writeState(db, next);
  await db.query(
    `INSERT INTO audit_log (actor_id, action, entity_type, entity_id, details)
     VALUES ($1, 'dataset.refresh_requested', 'dataset', 'overture', $2::jsonb)`,
    [adminId, JSON.stringify({ countryCode })],
  );
  return next;
}

/**
 * Takes a waiting request (or an abandoned run) for this worker. Atomic: when several
 * workers check at once, only one gets it.
 */
export async function claimRefresh(db: Pool): Promise<RefreshState | null> {
  const now = new Date().toISOString();
  const { rows } = await db.query<{ value: unknown }>(
    `UPDATE settings
     SET value = value || jsonb_build_object('state', 'RUNNING', 'startedAt', $2::text,
                                             'updatedAt', $2::text, 'step', 'Starting'),
         updated_at = now()
     WHERE key = $1
       AND (value->>'state' = 'REQUESTED'
            OR (value->>'state' = 'RUNNING'
                AND (value->>'updatedAt')::timestamptz < now() - make_interval(mins => $3::int)))
     RETURNING value`,
    [DATASET_REFRESH_KEY, now, REFRESH_STALE_MINUTES],
  );
  const row = rows[0];
  return row ? refreshStateSchema.parse(row.value) : null;
}

/** Runs a claimed refresh to the end and records the outcome. Never throws. */
export async function runRefresh(
  db: Pool,
  claimed: RefreshState,
  deps: {
    mx?: MxChecker;
    log?: (line: string) => void;
    /** Local parquet files instead of the download (verification only). */
    localFiles?: string[];
    release?: string;
    onlyWithContact?: boolean;
    /** Needed to add a new country (its cities come from GeoNames first). */
    databaseUrl?: string;
  } = {},
): Promise<RefreshState> {
  const country = claimed.countryCode ?? 'CY';
  let state: RefreshState = { ...claimed };
  let lastWrite = 0;
  // Progress lines are written at most every 5 s (they come quickly while reading files).
  const step = async (line: string, force = false): Promise<void> => {
    deps.log?.(line);
    state = { ...state, step: line.trim(), updatedAt: new Date().toISOString() };
    if (force || Date.now() - lastWrite > 5000) {
      lastWrite = Date.now();
      await writeState(db, state).catch(() => undefined);
    }
  };
  const progress = (line: string): void => void step(line);

  try {
    // A country added on the Settings page has no cities yet: GeoNames first.
    const known = await db.query(
      `SELECT 1 FROM locations WHERE type = 'COUNTRY' AND country_code = $1 AND active`,
      [country],
    );
    if (known.rowCount === 0) {
      if (!deps.databaseUrl) throw new Error(`Country ${country} is not imported yet.`);
      await step(`Adding ${country}: downloading its cities from GeoNames`, true);
      const geo = await importGeonamesCountry(deps.databaseUrl, country, { onProgress: progress });
      await step(
        `${geo.tree.country.name}: ${geo.tree.cities.length} cities and villages added`,
        true,
      );
    }
    const readyBefore = await countReadyLeads(db, country);
    await step('Downloading the newest Overture release (only the part for this country)', true);
    const imported = await runOvertureImport(db, {
      countryCode: country,
      onProgress: progress,
      localFiles: deps.localFiles,
      release: deps.release,
      onlyWithContact: deps.onlyWithContact,
    });
    await step(`Bringing ${imported.stats.kept} places into the main tables`, true);
    const merged = await mergeOverturePlaces(db, country, {
      mx: deps.mx,
      onProgress: (line) => void step(`Saving businesses: ${line.trim()}`),
    });
    await step('Merging duplicates and updating lead scores', true);
    const rules = await loadLeadRules(db);
    const pipeline = await withPipelineLock(
      db,
      () => runLeadPipeline(db, country, rules, false, progress),
      () => progress('Waiting for the worker to finish preparing leads'),
    );
    state = {
      ...state,
      state: 'DONE',
      finishedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      step: null,
      error: null,
      result: {
        release: imported.release,
        placesInImport: imported.stats.kept,
        newBusinesses: merged.placesInserted,
        newEmails: merged.emailsInserted,
        duplicatesMerged: pipeline.dedupe.merged,
        readyBefore,
        readyAfter: pipeline.ready,
      },
    };
  } catch (err) {
    state = {
      ...state,
      state: 'FAILED',
      finishedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      error: (err instanceof Error ? err.message : String(err)).slice(0, 1000),
    };
  }
  await writeState(db, state).catch(() => undefined);
  return state;
}
