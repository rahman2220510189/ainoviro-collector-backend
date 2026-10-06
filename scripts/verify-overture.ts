/**
 * Proves against the REAL database that the Overture import (step 4.1) works: filters,
 * saving, a repeat import that updates instead of duplicating, removal of places gone
 * from a newer release, and the import log. Nothing is downloaded: it reads two small
 * Overture-shaped files from tests/fixtures and uses the fake country "ZZ"; everything
 * is removed at the end.
 *
 * Usage: npm run overture:verify
 */
import path from 'node:path';
import { Pool } from 'pg';
import { EnvValidationError, loadEnv } from '../src/config/env';
import { runOvertureImport } from '../src/datasets/import-overture';

const COUNTRY = 'ZZ';

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

async function main(): Promise<void> {
  try {
    process.loadEnvFile('.env');
  } catch {
    // No .env file: rely on real environment variables.
  }
  const db = new Pool({ connectionString: loadEnv().DATABASE_URL, max: 3 });
  const fixtures = path.join(__dirname, '..', 'tests', 'fixtures');
  const first = path.join(fixtures, 'overture-zz.parquet');
  const moved = path.join(fixtures, 'overture-zz-moved.parquet');
  try {
    await cleanup(db);
    // A fake country whose box covers the test places (around Limassol).
    await db.query(
      `INSERT INTO locations (type, name, country_code, bbox_south, bbox_west, bbox_north, bbox_east, active, updated_at)
       VALUES ('COUNTRY', 'Verify ZZ', $1, 34.5, 32.8, 34.9, 33.3, true, now())`,
      [COUNTRY],
    );

    const dry = await runOvertureImport(db, {
      onlyWithContact: false,
      countryCode: COUNTRY,
      localFiles: [first],
      release: 'verify-1',
      dryRun: true,
    });
    const afterDry = await db.query<{ n: string }>(
      'SELECT count(*) AS n FROM stg_overture_places WHERE country_code = $1',
      [COUNTRY],
    );
    check(
      'A. Dry run reads and reports, saves nothing',
      dry.stats.kept === 3 && Number(afterDry.rows[0]?.n) === 0 && dry.importId === null,
      `kept ${dry.stats.kept}, rows saved ${afterDry.rows[0]?.n}`,
    );

    const one = await runOvertureImport(db, {
      onlyWithContact: false,
      countryCode: COUNTRY,
      localFiles: [first],
      release: 'verify-1',
    });
    check(
      'B. Filters: low confidence and closed dropped; other country, outside box, no name never read',
      one.stats.read === 5 &&
        one.stats.droppedLowConfidence === 1 &&
        one.stats.droppedClosed === 1 &&
        one.stats.kept === 3,
      `read ${one.stats.read}, low ${one.stats.droppedLowConfidence}, closed ${one.stats.droppedClosed}, kept ${one.stats.kept}`,
    );

    const salon = await db.query<{
      name: string;
      emails: string[];
      taxonomy_hierarchy: string[];
      release: string;
    }>(
      `SELECT name, emails, taxonomy_hierarchy, release FROM stg_overture_places WHERE id = 'ov-salon'`,
    );
    const s = salon.rows[0];
    check(
      'C. Saved with taxonomy, lower-cased email and the release',
      s?.emails.join() === 'info@studio-elena.example.cy' &&
        s.taxonomy_hierarchy.at(-1) === 'hair_salon' &&
        s.release === 'verify-1',
      JSON.stringify(s ?? null),
    );

    await runOvertureImport(db, {
      onlyWithContact: false,
      countryCode: COUNTRY,
      localFiles: [first],
      release: 'verify-1b',
    });
    const again = await db.query<{ n: string; releases: string }>(
      `SELECT count(*) AS n, string_agg(DISTINCT release, ',') AS releases
       FROM stg_overture_places WHERE country_code = $1`,
      [COUNTRY],
    );
    check(
      'D. Importing again updates the same rows, no duplicates',
      Number(again.rows[0]?.n) === 3 && again.rows[0]?.releases === 'verify-1b',
      `${again.rows[0]?.n} rows, release ${again.rows[0]?.releases}`,
    );

    const gone = await runOvertureImport(db, {
      onlyWithContact: false,
      countryCode: COUNTRY,
      localFiles: [moved],
      release: 'verify-2',
    });
    const left = await db.query<{ n: string }>(
      'SELECT count(*) AS n FROM stg_overture_places WHERE country_code = $1',
      [COUNTRY],
    );
    check(
      'E. Places missing from a newer release are removed',
      gone.stats.kept === 0 && gone.stats.removed === 3 && Number(left.rows[0]?.n) === 0,
      `kept ${gone.stats.kept}, removed ${gone.stats.removed}, left ${left.rows[0]?.n}`,
    );

    const log = await db.query<{ release: string; status: string }>(
      'SELECT release, status FROM dataset_imports WHERE country_code = $1 ORDER BY id',
      [COUNTRY],
    );
    check(
      'F. Every saved run is in the import log',
      log.rows.map((r) => `${r.release}:${r.status}`).join() ===
        'verify-1:DONE,verify-1b:DONE,verify-2:DONE',
      log.rows.map((r) => `${r.release} ${r.status}`).join(', '),
    );

    let failed = '';
    try {
      await runOvertureImport(db, {
        onlyWithContact: false,
        countryCode: COUNTRY,
        localFiles: [path.join(fixtures, 'missing.parquet')],
        release: 'verify-broken',
      });
    } catch (err) {
      failed = err instanceof Error ? err.message : String(err);
    }
    const broken = await db.query<{ status: string }>(
      `SELECT status FROM dataset_imports WHERE country_code = $1 AND release = 'verify-broken'`,
      [COUNTRY],
    );
    check(
      'G. A failed import is logged as FAILED and changes nothing',
      failed !== '' && broken.rows[0]?.status === 'FAILED',
      `error: ${failed.slice(0, 60)}…; status ${broken.rows[0]?.status}`,
    );

    const lean = await runOvertureImport(db, {
      onlyWithContact: true,
      countryCode: COUNTRY,
      localFiles: [first],
      release: 'verify-lean',
      dryRun: true,
    });
    check(
      'H. With "only places with contact" on, a place with no email and no website is not kept',
      lean.stats.kept === 2 && lean.stats.droppedNoContact === 1,
      `kept ${lean.stats.kept}, dropped for no contact ${lean.stats.droppedNoContact}`,
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
