/**
 * Manages chain_blocklist: businesses that are chains or franchises and must not be
 * exported (spec §10). Run "npm run places:process" afterwards to apply the change.
 *
 *   npm run chains -- --list
 *   npm run chains -- --add "Zara" [--domain zara.com]
 *   npm run chains -- --remove "Zara"
 */
import { parseArgs } from 'node:util';
import { Pool } from 'pg';
import { normalizeBusinessName } from '../cleaning/name';
import { analyzeWebsite } from '../cleaning/website';
import { EnvValidationError, loadEnv } from '../config/env';

async function main(): Promise<void> {
  try {
    process.loadEnvFile('.env');
  } catch {
    // No .env file: rely on real environment variables.
  }
  const { values } = parseArgs({
    options: {
      list: { type: 'boolean', default: false },
      add: { type: 'string' },
      remove: { type: 'string' },
      domain: { type: 'string' },
    },
  });
  if (!values.list && !values.add && !values.remove)
    throw new Error('Use --list, --add "Name" [--domain x.com] or --remove "Name"');

  const db = new Pool({ connectionString: loadEnv().DATABASE_URL, max: 1 });
  try {
    if (values.add) {
      const name = normalizeBusinessName(values.add);
      if (name === '') throw new Error('The name is empty after cleaning.');
      const domain = values.domain ? analyzeWebsite(values.domain).domain : null;
      await db.query(
        `INSERT INTO chain_blocklist (name_normalized, display_name, domain) VALUES ($1, $2, $3)
         ON CONFLICT (name_normalized) DO UPDATE SET display_name = $2, domain = COALESCE($3, chain_blocklist.domain)`,
        [name, values.add.trim(), domain],
      );
      console.log(`Added: ${values.add.trim()} (matches names starting with "${name}")`);
    }
    if (values.remove) {
      const { rowCount } = await db.query(
        'DELETE FROM chain_blocklist WHERE name_normalized = $1',
        [normalizeBusinessName(values.remove)],
      );
      console.log(rowCount ? `Removed: ${values.remove}` : `Not on the list: ${values.remove}`);
    }
    const { rows } = await db.query<{ display_name: string; domain: string | null }>(
      'SELECT display_name, domain FROM chain_blocklist ORDER BY name_normalized',
    );
    console.log(`\nChain blocklist (${rows.length}):`);
    for (const r of rows) console.log(`  - ${r.display_name}${r.domain ? `  (${r.domain})` : ''}`);
    if (values.add || values.remove) console.log('\nApply it: npm run places:process');
  } finally {
    await db.end();
  }
}

main().catch((err: unknown) => {
  if (err instanceof EnvValidationError) console.error(err.message);
  else console.error('Failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});