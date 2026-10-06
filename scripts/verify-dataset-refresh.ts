/**
 * Proves against the REAL database that "Update Overture data" on the Settings page works
 * (step 4.5b): a request is recorded once, exactly one worker takes it, the run imports,
 * merges and refreshes the leads, the result is shown, and a run abandoned by a stopped
 * worker can be taken again. Uses the fake country "ZZ" and the test file (no download,
 * no DNS); everything is removed and the real update status is put back at the end.
 *
 * Stop the worker first (it would take the test request itself).
 * Usage: npm run refresh:verify
 */
import path from 'node:path';
import { Pool } from 'pg';
import { EnvValidationError, loadEnv } from '../src/config/env';
import { loadOvertureRules } from '../src/datasets/category-map';
import { createDatasetService } from '../src/datasets/dataset-service';
import {
  DATASET_REFRESH_KEY,
  claimRefresh,
  requestRefresh,
  runRefresh,
} from '../src/datasets/refresh';
import { MxChecker } from '../src/enrich/mx';
import { WORKER_HEARTBEAT_KEY, workerStatusFrom } from '../src/jobs/worker-heartbeat';

const COUNTRY = 'ZZ';
const FIXTURE = path.join(__dirname, '..', 'tests', 'fixtures', 'overture-zz.parquet');

let passed = 0;
let total = 0;
function check(name: string, ok: boolean, detail: string): void {
  total += 1;
  if (ok) passed += 1;
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}  -> ${detail}`);
}

async function cleanup(db: Pool): Promise<void> {
  const ids = await db.query<{ id: number }>('SELECT id FROM places WHERE country_code = $1', [
    COUNTRY,
  ]);
  const placeIds = ids.rows.map((r) => r.id);
  await db.query('DELETE FROM emails WHERE place_id = ANY($1::int[])', [placeIds]);
  await db.query(
    `DELETE FROM audit_log WHERE entity_type = 'place' AND entity_id = ANY($1::text[])`,
    [placeIds.map(String)],
  );
  await db.query(
    `DELETE FROM audit_log WHERE action = 'dataset.refresh_requested' AND details->>'countryCode' = $1`,
    [COUNTRY],
  );
  await db.query('DELETE FROM places WHERE country_code = $1', [COUNTRY]);
  await db.query('DELETE FROM stg_overture_places WHERE country_code = $1', [COUNTRY]);
  await db.query('DELETE FROM dataset_imports WHERE country_code = $1', [COUNTRY]);
  await db.query(`DELETE FROM locations WHERE country_code = $1 AND type = 'COUNTRY'`, [COUNTRY]);
}

async function main(): Promise<void> {
  try {
    process.loadEnvFile('.env');
  } catch {
    // No .env file: rely on real environment variables.
  }
  const db = new Pool({ connectionString: loadEnv().DATABASE_URL, max: 10 });
  const mx = new MxChecker(async () => [{ exchange: 'mx.test', priority: 10 }]);
  const saved = await db.query<{ value: unknown }>('SELECT value FROM settings WHERE key = $1', [
    DATASET_REFRESH_KEY,
  ]);
  // A test status left behind by an earlier run that was stopped (Ctrl+C) is not real:
  // never put it back, or the worker would later try to "update" the fake country.
  const leftover = saved.rows[0]?.value as { countryCode?: string } | undefined;
  if (leftover?.countryCode === COUNTRY) saved.rows.length = 0;
  // Ctrl+C: still clean up, so no test status stays behind.
  let stopping = false;
  process.once('SIGINT', () => {
    if (stopping) return;
    stopping = true;
    console.log('\nStopped: cleaning up the test data first…');
    void restore().finally(() => process.exit(130));
  });
  async function restore(): Promise<void> {
    await cleanup(db).catch((err: unknown) => console.error('cleanup failed:', err));
    const before = saved.rows[0];
    if (before) {
      await db.query(
        `INSERT INTO settings (key, value, updated_at) VALUES ($1, $2::jsonb, now())
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
        [DATASET_REFRESH_KEY, JSON.stringify(before.value)],
      );
    } else {
      await db.query('DELETE FROM settings WHERE key = $1', [DATASET_REFRESH_KEY]);
    }
  }
  try {
    const beat = await db.query<{ value: unknown }>('SELECT value FROM settings WHERE key = $1', [
      WORKER_HEARTBEAT_KEY,
    ]);
    if (workerStatusFrom(beat.rows[0]?.value).running) {
      throw new Error('The worker is running. Stop it (Ctrl+C) first, then run this again.');
    }
    if ((await loadOvertureRules(db)).length === 0) {
      throw new Error('No Overture rules in the database. Run: npm run overture:map -- --seed');
    }
    await cleanup(db);
    await db.query('DELETE FROM settings WHERE key = $1', [DATASET_REFRESH_KEY]);
    await db.query(
      `INSERT INTO locations (type, name, country_code, bbox_south, bbox_west, bbox_north, bbox_east, active, updated_at)
       VALUES ('COUNTRY', 'Verify ZZ', $1, 34.5, 32.8, 34.9, 33.3, true, now())`,
      [COUNTRY],
    );

    // A. One request at a time.
    const requested = await requestRefresh(db, COUNTRY, null);
    let refused = '';
    try {
      await requestRefresh(db, COUNTRY, null);
    } catch (err) {
      refused = err instanceof Error ? err.message : String(err);
    }
    check(
      'A. The update is recorded once; a second click while it waits is refused',
      requested.state === 'REQUESTED' && refused.includes('already'),
      `state ${requested.state}; second: "${refused}"`,
    );

    // B. Exactly one worker takes it.
    const [first, second] = await Promise.all([claimRefresh(db), claimRefresh(db)]);
    const taken = [first, second].filter((c) => c !== null);
    check(
      'B. When two workers look at once, exactly one takes the update',
      taken.length === 1 && taken[0]?.state === 'RUNNING',
      `${taken.length} took it`,
    );

    // C. The run imports, merges and refreshes the leads.
    const claimed = taken[0];
    if (!claimed) throw new Error('nothing claimed');
    const done = await runRefresh(db, claimed, {
      mx,
      localFiles: [FIXTURE],
      release: 'verify',
      onlyWithContact: false,
      log: (line) => {
        console.log(`       ${line.trim()}`);
        if (line.startsWith('Waiting for the worker')) {
          console.log(
            '       (stuck here? another connection holds the pipeline lock: npm run pipeline:lock)',
          );
        }
      },
    });
    check(
      'C. The update imports, brings the businesses in and refreshes the leads',
      done.state === 'DONE' &&
        done.result?.placesInImport === 3 &&
        done.result.newBusinesses === 3 &&
        done.error === null,
      done.state === 'DONE' ? JSON.stringify(done.result) : `failed: ${done.error}`,
    );

    // D. The Settings page shows it.
    const service = createDatasetService(db);
    const status = await service.overtureStatus(COUNTRY);
    check(
      'D. The Settings page shows the import, the businesses and the finished update',
      status.businesses === 3 && status.refresh.state === 'DONE',
      `businesses ${status.businesses}, update ${status.refresh.state}, history ${status.history.length}`,
    );

    // E. A run abandoned by a stopped worker is taken again.
    const old = new Date(Date.now() - 31 * 60_000).toISOString();
    await db.query(
      `UPDATE settings SET value = value || jsonb_build_object('state', 'RUNNING', 'updatedAt', $2::text)
       WHERE key = $1`,
      [DATASET_REFRESH_KEY, old],
    );
    const again = await claimRefresh(db);
    const fresh = await requestRefresh(db, COUNTRY, null).catch((err: unknown) =>
      err instanceof Error ? err.message : String(err),
    );
    check(
      'E. A run left behind by a stopped worker is taken again (and then blocks new clicks)',
      again?.state === 'RUNNING' && typeof fresh === 'string' && fresh.includes('already'),
      `claimed again: ${again?.state ?? 'no'}; new click: ${typeof fresh === 'string' ? fresh : fresh.state}`,
    );
  } finally {
    // Put the real update status back exactly as it was.
    if (!stopping) {
      stopping = true;
      await restore();
      await db.end();
    }
  }
  console.log(`\n${passed}/${total} checks passed${passed === total ? '' : '  <- PROBLEM'}`);
  if (passed !== total) process.exitCode = 1;
}

main().catch((err: unknown) => {
  if (err instanceof EnvValidationError) console.error(err.message);
  else console.error('Verification failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
