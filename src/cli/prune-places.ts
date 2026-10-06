/**
 * Removes places that can never become a lead (step 6.1): no email, no own website,
 * not found by Google, never exported or worked on. Their staged Overture rows go too,
 * so a later merge does not bring them back. Without --apply it only counts.
 *
 *   npm run places:prune -- --country CY            count only
 *   npm run places:prune -- --country CY --apply    delete
 *   add --foursquare to also empty the staged Foursquare places (not used, step 4.6)
 */
import { parseArgs } from 'node:util';
import { Pool } from 'pg';
import { EnvValidationError, loadEnv } from '../config/env';
import { databaseSize, formatBytes, pruneNoContact } from '../datasets/storage';

async function main(): Promise<void> {
  try {
    process.loadEnvFile('.env');
  } catch {
    // No .env file: rely on real environment variables.
  }
  const { values } = parseArgs({
    options: {
      country: { type: 'string' },
      apply: { type: 'boolean', default: false },
      foursquare: { type: 'boolean', default: false },
    },
  });
  const country = (values.country ?? '').toUpperCase();
  if (!/^[A-Z]{2}$/.test(country)) throw new Error('Say which country: --country CY');
  const db = new Pool({ connectionString: loadEnv().DATABASE_URL, max: 2 });
  try {
    const before = await databaseSize(db);
    const r = await pruneNoContact(db, country, !values.apply);
    console.log(`Places with no email and no own website (${country}): ${r.places}`);
    console.log(`Staged Overture rows with no email and no own website: ${r.stagingRows}`);
    if (values.foursquare) {
      const fsq = values.apply
        ? await db.query('DELETE FROM stg_fsq_places WHERE country_code = $1', [country])
        : await db.query('SELECT 1 FROM stg_fsq_places WHERE country_code = $1', [country]);
      console.log(`Staged Foursquare places (not used): ${fsq.rowCount ?? 0}`);
    }
    if (!values.apply) {
      console.log('\nNothing was deleted. To delete them: add --apply');
      return;
    }
    const after = await databaseSize(db);
    console.log(
      `\nDeleted. Database: ${formatBytes(before.totalBytes)} -> ${formatBytes(after.totalBytes)}` +
        ' (run npm run db:compact to give the room back).',
    );
  } finally {
    await db.end();
  }
}

main().catch((err: unknown) => {
  if (err instanceof EnvValidationError) console.error(err.message);
  else console.error('Failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
