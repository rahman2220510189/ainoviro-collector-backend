/**
 * Proves against the REAL database that bringing Overture places into the main tables
 * (step 4.4) works: new businesses and emails are saved once, suppressed addresses are
 * never stored, a repeat run doubles nothing, Google's values win on a shared place, and
 * the lead pipeline merges an Overture place with the same business found by Google.
 * Uses the fake country "ZZ" and a fake mail-server lookup (no DNS); all removed at the end.
 *
 * Usage: npm run overture:map -- --seed (once), then  npm run merge:verify
 */
import path from 'node:path';
import { Pool } from 'pg';
import { EnvValidationError, loadEnv } from '../src/config/env';
import { loadOvertureRules } from '../src/datasets/category-map';
import { runOvertureImport } from '../src/datasets/import-overture';
import { mergeOverturePlaces } from '../src/datasets/merge-overture';
import { MxChecker } from '../src/enrich/mx';
import { hashEmail } from '../src/lib/email';
import { runLeadPipeline } from '../src/leads/process';
import { loadLeadRules } from '../src/leads/rules';

const COUNTRY = 'ZZ';
// The fixture's own address uses a placeholder domain that the junk filter rightly drops,
// so the staged row gets a realistic test address (the mail-server lookup is faked).
const SALON_EMAIL = 'info@studio-elena-verify.cy';
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
  await db.query('DELETE FROM places WHERE country_code = $1', [COUNTRY]);
  await db.query('DELETE FROM stg_overture_places WHERE country_code = $1', [COUNTRY]);
  await db.query('DELETE FROM dataset_imports WHERE country_code = $1', [COUNTRY]);
  await db.query(`DELETE FROM locations WHERE country_code = $1 AND type = 'COUNTRY'`, [COUNTRY]);
  await db.query(`DELETE FROM suppression WHERE source_file = 'verify-merge'`);
}

async function main(): Promise<void> {
  try {
    process.loadEnvFile('.env');
  } catch {
    // No .env file: rely on real environment variables.
  }
  const db = new Pool({ connectionString: loadEnv().DATABASE_URL, max: 4 });
  // Every domain "has" a mail server: no real DNS lookups in this test.
  const mx = new MxChecker(async () => [{ exchange: 'mx.test', priority: 10 }]);
  try {
    await cleanup(db);
    if ((await loadOvertureRules(db)).length === 0) {
      throw new Error('No Overture rules in the database. Run: npm run overture:map -- --seed');
    }
    await db.query(
      `INSERT INTO locations (type, name, country_code, bbox_south, bbox_west, bbox_north, bbox_east, active, updated_at)
       VALUES ('COUNTRY', 'Verify ZZ', $1, 34.5, 32.8, 34.9, 33.3, true, now())`,
      [COUNTRY],
    );
    await runOvertureImport(db, {
      countryCode: COUNTRY,
      localFiles: [FIXTURE],
      release: 'v',
      onlyWithContact: false,
    });
    await db.query(
      `UPDATE stg_overture_places SET emails = ARRAY[$2::text] WHERE country_code = $1 AND cardinality(emails) > 0`,
      [COUNTRY, SALON_EMAIL],
    );

    // A Google place that already carries the gym's Overture id (merged earlier).
    await db.query(
      `INSERT INTO places (google_place_id, overture_id, name, name_normalized, country_code, lat, lng, updated_at)
       VALUES ('verify-g-gym', 'ov-gym', 'Power Gym Limassol (Google)', 'power gym limassol google', $1, 34.7, 33.05, now())`,
      [COUNTRY],
    );
    // The same yoga studio, found by Google, a few metres away and without an Overture id.
    await db.query(
      `INSERT INTO places (google_place_id, name, name_normalized, country_code, lat, lng, updated_at)
       VALUES ('verify-g-yoga', 'Yoga Garden', 'yoga garden', $1, 34.7101, 33.0601, now())`,
      [COUNTRY],
    );
    // The salon's address is on the suppression list for the first run.
    await db.query(
      `INSERT INTO suppression (email_hash, email_normalized, domain, reason, source_file)
       VALUES ($1, $2, 'studio-elena-verify.cy', 'MANUAL', 'verify-merge')`,
      [hashEmail(SALON_EMAIL), SALON_EMAIL],
    );

    const dry = await mergeOverturePlaces(db, COUNTRY, { dryRun: true, mx });
    const afterDry = await db.query<{ n: string }>(
      `SELECT count(*) AS n FROM places WHERE country_code = $1 AND google_place_id IS NULL`,
      [COUNTRY],
    );
    check(
      'A. Dry run counts and saves nothing',
      dry.stagingPlaces === 3 && Number(afterDry.rows[0]?.n) === 0,
      `${dry.stagingPlaces} in the import, ${afterDry.rows[0]?.n} saved`,
    );

    const first = await mergeOverturePlaces(db, COUNTRY, { mx });
    const stored = await db.query('SELECT 1 FROM emails WHERE email_normalized = $1', [
      SALON_EMAIL,
    ]);
    check(
      'B. New businesses saved; a suppressed address is never stored',
      first.placesInserted === 2 &&
        first.placesUpdated === 1 &&
        first.emailsSuppressed === 1 &&
        stored.rowCount === 0,
      `inserted ${first.placesInserted}, updated ${first.placesUpdated}, suppressed ${first.emailsSuppressed}, stored ${stored.rowCount}`,
    );

    const gym = await db.query<{ name: string; website: string | null }>(
      `SELECT name, website FROM places WHERE google_place_id = 'verify-g-gym'`,
    );
    check(
      "C. On a Google place Google's name stays; Overture only fills the empty website",
      gym.rows[0]?.name === 'Power Gym Limassol (Google)' &&
        gym.rows[0]?.website === 'https://powergym.example.cy/',
      JSON.stringify(gym.rows[0] ?? null),
    );

    await db.query(`DELETE FROM suppression WHERE source_file = 'verify-merge'`);
    const second = await mergeOverturePlaces(db, COUNTRY, { mx });
    const email = await db.query<{ source: string; is_primary: boolean; mx_valid: boolean | null }>(
      'SELECT source, is_primary, mx_valid FROM emails WHERE email_normalized = $1',
      [SALON_EMAIL],
    );
    check(
      'D. Once allowed, the email is stored from Overture as the primary, with its mail server',
      second.placesInserted === 0 &&
        second.emailsInserted === 1 &&
        email.rows[0]?.source === 'overture' &&
        email.rows[0]?.is_primary === true &&
        email.rows[0]?.mx_valid === true,
      `inserted places ${second.placesInserted}, emails ${second.emailsInserted}, ${JSON.stringify(email.rows[0] ?? null)}`,
    );

    const third = await mergeOverturePlaces(db, COUNTRY, { mx });
    const counts = await db.query<{ places: string; emails: string; sources: string }>(
      `SELECT (SELECT count(*) FROM places WHERE country_code = $1) AS places,
              (SELECT count(*) FROM emails e JOIN places p ON p.id = e.place_id WHERE p.country_code = $1) AS emails,
              (SELECT count(*) FROM place_sources s JOIN places p ON p.id = s.place_id
                WHERE p.country_code = $1 AND s.source = 'OVERTURE') AS sources`,
      [COUNTRY],
    );
    const c = counts.rows[0];
    check(
      'E. Running again doubles nothing',
      third.placesInserted === 0 &&
        third.emailsInserted === 0 &&
        third.emailsAlreadyKnown === 1 &&
        Number(c?.places) === 4 &&
        Number(c?.emails) === 1 &&
        Number(c?.sources) === 3,
      `places ${c?.places}, emails ${c?.emails}, Overture sources ${c?.sources}`,
    );

    const pipeline = await runLeadPipeline(db, COUNTRY, await loadLeadRules(db), false);
    const yoga = await db.query<{ n: string; google: string | null; overture: string | null }>(
      `SELECT count(*) OVER () AS n, google_place_id AS google, overture_id AS overture
       FROM places WHERE country_code = $1 AND name_normalized = 'yoga garden'`,
      [COUNTRY],
    );
    check(
      'F. The pipeline merges the Overture place with the same business from Google',
      pipeline.dedupe.merged >= 1 &&
        yoga.rows.length === 1 &&
        yoga.rows[0]?.google === 'verify-g-yoga' &&
        yoga.rows[0]?.overture === 'ov-noaddr',
      `merged ${pipeline.dedupe.merged}; yoga places ${yoga.rows.length}: ${JSON.stringify(yoga.rows[0] ?? null)}`,
    );

    const fourth = await mergeOverturePlaces(db, COUNTRY, { mx });
    check(
      'G. After the merge, the Overture id updates the merged place instead of making it again',
      fourth.placesInserted === 0 && fourth.placesLinkedToMerged + fourth.placesUpdated === 3,
      `inserted ${fourth.placesInserted}, updated ${fourth.placesUpdated}, linked ${fourth.placesLinkedToMerged}`,
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
