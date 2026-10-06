/**
 * Checks against the REAL database the safety parts of step 6.4, with the fake country
 * "ZZ" and test files (nothing downloaded):
 *  A. the country's real outline drops places with no address country that lie outside it;
 *  B. a dry run tells how big the database gets, without saving anything;
 *  C. an import that would pass the storage limit stops before saving anything.
 * Everything is removed at the end.
 *
 * Usage: npm run border:verify
 */
import path from 'node:path';
import { Pool } from 'pg';
import { EnvValidationError, loadEnv } from '../src/config/env';
import { runOvertureImport } from '../src/datasets/import-overture';
import { formatBytes } from '../src/datasets/storage';

const COUNTRY = 'ZZ';
const FIXTURES = path.join(__dirname, '..', 'tests', 'fixtures');
const PLACES = path.join(FIXTURES, 'overture-zz.parquet');
const DIVISIONS = path.join(FIXTURES, 'divisions-cy.parquet');

let passed = 0;
let total = 0;
function check(name: string, ok: boolean, detail: string): void {
  total += 1;
  if (ok) passed += 1;
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}  -> ${detail}`);
}

async function cleanup(db: Pool): Promise<void> {
  await db.query('DELETE FROM stg_overture_places WHERE country_code = $1', [COUNTRY]);
  await db.query('DELETE FROM dataset_imports WHERE country_code = $1', [COUNTRY]);
  await db.query(`DELETE FROM locations WHERE country_code = $1 AND type = 'COUNTRY'`, [COUNTRY]);
}

async function staged(db: Pool): Promise<number> {
  const { rows } = await db.query<{ n: string }>(
    'SELECT count(*) AS n FROM stg_overture_places WHERE country_code = $1',
    [COUNTRY],
  );
  return Number(rows[0]?.n ?? 0);
}

async function main(): Promise<void> {
  try {
    process.loadEnvFile('.env');
  } catch {
    // No .env file: rely on real environment variables.
  }
  const db = new Pool({ connectionString: loadEnv().DATABASE_URL, max: 4 });
  try {
    await cleanup(db);
    await db.query(
      `INSERT INTO locations (type, name, country_code, bbox_south, bbox_west, bbox_north, bbox_east, active, updated_at)
       VALUES ('COUNTRY', 'Verify ZZ', $1, 34.5, 32.8, 34.9, 33.3, true, now())`,
      [COUNTRY],
    );
    const base = {
      countryCode: COUNTRY,
      localFiles: [PLACES],
      release: 'verify',
      onlyWithContact: false,
    };

    // A + B: dry run with the outline.
    const dry = await runOvertureImport(db, { ...base, borderFiles: [DIVISIONS], dryRun: true });
    const boxOnly = await runOvertureImport(db, { ...base, dryRun: true });
    check(
      "A. The country's outline drops a place with no address country outside it (box only keeps it)",
      dry.stats.borderUsed &&
        dry.stats.droppedOutsideBorder === 1 &&
        dry.stats.kept === boxOnly.stats.kept - 1 &&
        !boxOnly.stats.borderUsed,
      `with outline: kept ${dry.stats.kept}, outside ${dry.stats.droppedOutsideBorder}; box only: kept ${boxOnly.stats.kept}`,
    );
    const s = dry.storage;
    check(
      'B. A dry run tells how big the database gets, and saves nothing',
      s.currentBytes > 0 && s.afterBytes >= s.currentBytes && s.fits && (await staged(db)) === 0,
      `now ${formatBytes(s.currentBytes)}, after about ${formatBytes(s.afterBytes)} (+${s.newPlaces} x ${formatBytes(s.bytesPerPlace)}), limit ${formatBytes(s.limitBytes)}`,
    );

    // C: a limit smaller than the database itself.
    let refused = '';
    try {
      await runOvertureImport(db, { ...base, borderFiles: [DIVISIONS], storageLimitMb: 1 });
    } catch (err) {
      refused = err instanceof Error ? err.message : String(err);
    }
    const failed = await db.query<{ status: string }>(
      'SELECT status FROM dataset_imports WHERE country_code = $1 ORDER BY id DESC LIMIT 1',
      [COUNTRY],
    );
    check(
      'C. An import that would pass the storage limit stops before saving anything',
      refused.startsWith('Not enough room') &&
        (await staged(db)) === 0 &&
        failed.rows[0]?.status === 'FAILED',
      `"${refused.slice(0, 90)}…"; staged rows ${await staged(db)}; import ${failed.rows[0]?.status}`,
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
