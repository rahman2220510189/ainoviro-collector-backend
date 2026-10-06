/**
 * How much room the database uses, and which tables take it (step 6.1). Read only.
 * The free Neon plan has little storage; check your limit in the Neon console (Usage).
 *
 *   npm run db:size
 */
import { Pool } from 'pg';
import { EnvValidationError, loadEnv } from '../config/env';
import { databaseSize, formatBytes } from '../datasets/storage';

async function main(): Promise<void> {
  try {
    process.loadEnvFile('.env');
  } catch {
    // No .env file: rely on real environment variables.
  }
  const db = new Pool({ connectionString: loadEnv().DATABASE_URL, max: 1 });
  try {
    const size = await databaseSize(db);
    console.log(`Database size: ${formatBytes(size.totalBytes)}\n`);
    console.log('Largest tables:');
    for (const t of size.tables.slice(0, 15)) {
      console.log(
        `  ${formatBytes(t.bytes).padStart(9)}  ${String(t.rows.toLocaleString('en')).padStart(10)} rows  ${t.name}`,
      );
    }
    console.log(
      '\nCompare with the storage limit of your Neon plan (Neon console, Usage).' +
        '\nTo free room: npm run places:prune -- --country CY   (shows what would go first)',
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
