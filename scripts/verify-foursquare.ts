/**
 * Proves against the REAL database (and the real Hugging Face listing) that the
 * Foursquare import of step 4.6a works: the token is accepted and the dataset's terms
 * were accepted, the newest release and its files are found, and an import keeps only
 * open, recently refreshed places of the country, without doubling anything on a repeat.
 * The import uses the fake country "ZZ" and the test file; everything is removed at the end.
 *
 * Usage: npm run foursquare:verify
 */
import path from 'node:path';
import { Pool } from 'pg';
import { EnvValidationError, loadEnv } from '../src/config/env';
import { latestFsqRelease, listFsqFiles } from '../src/datasets/foursquare';
import { runFoursquareImport } from '../src/datasets/import-foursquare';

const COUNTRY = 'ZZ';
const FIXTURE = path.join(__dirname, '..', 'tests', 'fixtures', 'fsq-zz.parquet');

let passed = 0;
let total = 0;
function check(name: string, ok: boolean, detail: string): void {
  total += 1;
  if (ok) passed += 1;
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}  -> ${detail}`);
}

async function cleanup(db: Pool): Promise<void> {
  await db.query('DELETE FROM stg_fsq_places WHERE country_code = $1', [COUNTRY]);
  await db.query('DELETE FROM dataset_imports WHERE country_code = $1', [COUNTRY]);
  await db.query(`DELETE FROM locations WHERE country_code = $1 AND type = 'COUNTRY'`, [COUNTRY]);
}

async function main(): Promise<void> {
  try {
    process.loadEnvFile('.env');
  } catch {
    // No .env file: rely on real environment variables.
  }
  const env = loadEnv();
  const db = new Pool({ connectionString: env.DATABASE_URL, max: 3 });
  try {
    await cleanup(db);

    // A. The token works and the account may read the dataset.
    if (!env.HF_TOKEN) {
      check('A. Hugging Face token and access', false, 'HF_TOKEN is not set in backend/.env');
    } else {
      try {
        const release = await latestFsqRelease(env.HF_TOKEN);
        const files = await listFsqFiles(release, env.HF_TOKEN);
        const gb = files.reduce((n, f) => n + (f.size ?? 0), 0) / 1e9;
        check(
          'A. Hugging Face accepts the token and lists the newest release',
          files.length > 0,
          `release ${release}, ${files.length} files (${gb.toFixed(1)} GB for the whole planet; only the country's parts are downloaded)`,
        );
      } catch (err) {
        check(
          'A. Hugging Face token and access',
          false,
          err instanceof Error ? err.message : String(err),
        );
      }
    }

    await db.query(
      `INSERT INTO locations (type, name, country_code, bbox_south, bbox_west, bbox_north, bbox_east, active, updated_at)
       VALUES ('COUNTRY', 'Verify ZZ', $1, 34.5, 32.8, 34.9, 33.3, true, now())`,
      [COUNTRY],
    );
    const now = new Date('2026-10-03T12:00:00Z');

    // B. Only open, recently refreshed places of the country.
    const first = await runFoursquareImport(db, {
      countryCode: COUNTRY,
      localFiles: [FIXTURE],
      release: 'verify-1',
      now,
    });
    const ids = await db.query<{ id: string }>(
      'SELECT id FROM stg_fsq_places WHERE country_code = $1 ORDER BY id',
      [COUNTRY],
    );
    const kept = ids.rows.map((r) => r.id).join(', ');
    check(
      'B. Keeps open, recently refreshed places of the country; drops closed, old, other countries',
      kept === 'fsq-cafe, fsq-dentist, fsq-park' &&
        first.stats.droppedClosed === 1 &&
        first.stats.droppedOld === 1,
      `kept ${kept}; closed ${first.stats.droppedClosed}, too old ${first.stats.droppedOld}`,
    );

    // C. Email and categories are stored as given.
    const cafe = await db.query<{ email: string | null; category_labels: string[] }>(
      `SELECT email, category_labels FROM stg_fsq_places WHERE id = 'fsq-cafe'`,
    );
    check(
      'C. Email (lower case) and Foursquare categories are stored',
      cafe.rows[0]?.email === 'hello@kafelimani.cy' &&
        cafe.rows[0]?.category_labels[0] ===
          'Dining and Drinking > Cafe, Coffee, and Tea House > Café',
      JSON.stringify(cafe.rows[0] ?? null),
    );

    // D. A new release replaces the old one without doubling anything.
    await runFoursquareImport(db, {
      countryCode: COUNTRY,
      localFiles: [FIXTURE],
      release: 'verify-2',
      now,
    });
    const after = await db.query<{ n: string; releases: string }>(
      `SELECT count(*) AS n, string_agg(DISTINCT release, ',') AS releases
       FROM stg_fsq_places WHERE country_code = $1`,
      [COUNTRY],
    );
    const runs = await db.query<{ n: string }>(
      `SELECT count(*) AS n FROM dataset_imports
       WHERE country_code = $1 AND source = 'FOURSQUARE' AND status = 'DONE'`,
      [COUNTRY],
    );
    check(
      'D. Importing again replaces the release and doubles nothing; every run is logged',
      Number(after.rows[0]?.n) === 3 &&
        after.rows[0]?.releases === 'verify-2' &&
        Number(runs.rows[0]?.n) === 2,
      `places ${after.rows[0]?.n}, release ${after.rows[0]?.releases}, logged runs ${runs.rows[0]?.n}`,
    );
  } finally {
    await cleanup(db).catch((err: unknown) => console.error('cleanup failed:', err));
    await db.end();
  }
  console.log(`\n${passed}/${total} checks passed${passed === total ? '' : '  <- PROBLEM'}`);
  if (passed !== total) process.exitCode = 1;
}

main().catch((err: unknown) => {
  if (err instanceof EnvValidationError) console.error(err.message);
  else console.error('Verification failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
