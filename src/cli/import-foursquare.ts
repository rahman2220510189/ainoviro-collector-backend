/**
 * Imports Foursquare OS Places of one country into stg_fsq_places (spec §6.2), from the
 * monthly release on Hugging Face. Needs HF_TOKEN in backend/.env (a free Read token of
 * an account that accepted the dataset's terms). Only the parts of the files that hold
 * the country are downloaded. Re-run it for a new release: gone places are removed.
 *
 *   npm run import:foursquare -- --country CY              newest release
 *   npm run import:foursquare -- --country CY --dry-run    read and report, write nothing
 *   npm run import:foursquare -- --country CY --release 2026-08-11
 *   npm run import:foursquare -- --country CY --source C:/data/fsq/places_000000.parquet
 */
import { parseArgs } from 'node:util';
import { Pool } from 'pg';
import { EnvValidationError, loadEnv } from '../config/env';
import { runFoursquareImport } from '../datasets/import-foursquare';

async function main(): Promise<void> {
  try {
    process.loadEnvFile('.env');
  } catch {
    // No .env file: rely on real environment variables.
  }
  const { values } = parseArgs({
    options: {
      country: { type: 'string' },
      release: { type: 'string' },
      source: { type: 'string', multiple: true },
      'dry-run': { type: 'boolean', default: false },
    },
  });
  if (!values.country || !/^[A-Za-z]{2}$/.test(values.country)) {
    throw new Error('Say which country: --country CY');
  }
  const env = loadEnv();
  const db = new Pool({ connectionString: env.DATABASE_URL, max: 3 });
  try {
    const result = await runFoursquareImport(db, {
      countryCode: values.country,
      token: env.HF_TOKEN ?? null,
      release: values.release,
      localFiles: values.source,
      dryRun: values['dry-run'],
      onProgress: (line) => console.log(line),
    });
    const s = result.stats;
    console.log('\nSummary');
    console.log(
      `  Parts with places of the country: ${s.rowGroupsRead} of ${s.rowGroupsRead + s.rowGroupsSkipped} (in ${s.files} files)`,
    );
    console.log(`  Places in the country:  ${s.read}`);
    console.log(`  Dropped, closed:        ${s.droppedClosed}`);
    console.log(`  Dropped, not refreshed recently: ${s.droppedOld}`);
    console.log(`  Kept:                   ${s.kept}`);
    console.log(`    with a website:       ${s.withWebsite}`);
    console.log(`    with an email:        ${s.withEmail}`);
    console.log(`    with a phone:         ${s.withPhone}`);
    if (!values['dry-run']) console.log(`  Removed (gone from Foursquare): ${s.removed}`);
    console.log('  Most common categories:');
    for (const c of s.topCategories)
      console.log(`    ${String(c.count).padStart(6)}  ${c.category}`);
    console.log(
      values['dry-run']
        ? `\n(dry run: nothing was saved) ${result.seconds.toFixed(1)} s`
        : `\nSaved to stg_fsq_places (import #${result.importId}) in ${result.seconds.toFixed(1)} s`,
    );
  } finally {
    await db.end();
  }
}

main().catch((err: unknown) => {
  if (err instanceof EnvValidationError) console.error(err.message);
  else console.error('Foursquare import failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
