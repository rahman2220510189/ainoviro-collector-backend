/**
 * Gives the room of deleted rows back (step 6.1). After places:prune the rows are gone,
 * but Postgres keeps the files at their size until a table is rewritten. VACUUM FULL
 * rewrites the big tables; while it runs (seconds to a minute each) those tables are
 * locked, so stop the worker and do not use the website meanwhile.
 *
 *   npm run db:compact
 */
import { Pool } from 'pg';
import { EnvValidationError, loadEnv } from '../config/env';
import { databaseSize, formatBytes } from '../datasets/storage';

/** The tables that grow with imports; small tables are not worth rewriting. */
const TABLES = [
  'places',
  'stg_overture_places',
  'stg_fsq_places',
  'place_subcategories',
  'place_sources',
  'emails',
  'domain_crawls',
  'audit_log',
];

async function main(): Promise<void> {
  try {
    process.loadEnvFile('.env');
  } catch {
    // No .env file: rely on real environment variables.
  }
  const db = new Pool({ connectionString: loadEnv().DATABASE_URL, max: 1 });
  try {
    const before = await databaseSize(db);
    const existing = new Set(before.tables.map((t) => t.name));
    for (const table of TABLES.filter((t) => existing.has(t))) {
      const started = Date.now();
      await db.query(`VACUUM (FULL, ANALYZE) ${table}`);
      console.log(`  ${table}: done in ${((Date.now() - started) / 1000).toFixed(1)} s`);
    }
    const after = await databaseSize(db);
    console.log(
      `\nDatabase: ${formatBytes(before.totalBytes)} -> ${formatBytes(after.totalBytes)}`,
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
