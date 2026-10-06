/**
 * Imports Overture Maps places of one country into stg_overture_places (spec §6.2).
 * Free and anonymous; only the part of the planet file inside the country is downloaded.
 * Re-run it when Overture publishes a new release (monthly): places that disappeared
 * are removed, the rest are updated.
 *
 *   npm run import:overture -- --country CY              newest release
 *   npm run import:overture -- --country CY --dry-run    read and report, write nothing
 *   npm run import:overture -- --country CY --release 2026-09-23.0
 *   npm run import:overture -- --country CY --source C:/data/overture/part-0.parquet
 *       (add --border C:/data/overture/division_area.parquet for the country outline)
 *
 * Try a new, big country with --dry-run first: it shows how many places come in and how
 * big the database gets, before anything is saved.
 */
import { parseArgs } from 'node:util';
import { Pool } from 'pg';
import { EnvValidationError, loadEnv } from '../config/env';
import { runOvertureImport } from '../datasets/import-overture';
import { formatBytes } from '../datasets/storage';

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
      border: { type: 'string', multiple: true },
      'dry-run': { type: 'boolean', default: false },
    },
  });
  if (!values.country || !/^[A-Za-z]{2}$/.test(values.country)) {
    throw new Error('Say which country: --country CY');
  }

  const db = new Pool({ connectionString: loadEnv().DATABASE_URL, max: 3 });
  try {
    const result = await runOvertureImport(db, {
      countryCode: values.country,
      release: values.release,
      localFiles: values.source,
      borderFiles: values.border,
      dryRun: values['dry-run'],
      onProgress: (line) => console.log(line),
    });
    const s = result.stats;
    console.log('\nSummary');
    console.log(
      `  Downloaded parts:       ${s.rowGroupsRead} of ${s.rowGroupsRead + s.rowGroupsSkipped} (in ${s.files} files)`,
    );
    console.log(`  Places in the country:  ${s.read}`);
    console.log(`  Dropped, low confidence: ${s.droppedLowConfidence}`);
    console.log(`  Dropped, closed:         ${s.droppedClosed}`);
    console.log(`  Dropped, no email or own website: ${s.droppedNoContact}`);
    console.log(
      s.borderUsed
        ? `  Dropped, outside the country's outline: ${s.droppedOutsideBorder}`
        : '  Country outline: not used (box only)',
    );
    console.log(`  Kept:                   ${s.kept}`);
    console.log(`    with a website:       ${s.withWebsite}`);
    console.log(`    with an email:        ${s.withEmail}`);
    console.log(`    with a phone:         ${s.withPhone}`);
    if (!values['dry-run']) console.log(`  Removed (gone from Overture): ${s.removed}`);
    const st = result.storage;
    console.log(
      `  Database: ${formatBytes(st.currentBytes)} now -> about ${formatBytes(st.afterBytes)} ` +
        `(+${st.newPlaces} places x ${formatBytes(st.bytesPerPlace)}; limit ${formatBytes(st.limitBytes)})` +
        (st.fits ? '' : '  <- TOO BIG, an import would stop'),
    );
    console.log('  Most common categories:');
    for (const c of s.topCategories)
      console.log(`    ${String(c.count).padStart(6)}  ${c.category}`);
    console.log(
      values['dry-run']
        ? `\n(dry run: nothing was saved) ${result.seconds.toFixed(1)} s`
        : `\nSaved to stg_overture_places (import #${result.importId}) in ${result.seconds.toFixed(1)} s`,
    );
  } finally {
    await db.end();
  }
}

main().catch((err: unknown) => {
  if (err instanceof EnvValidationError) console.error(err.message);
  else console.error('Overture import failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
