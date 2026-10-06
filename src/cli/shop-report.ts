/**
 * How far the online-shop check has come (step 6.3), per country. Read only.
 *
 *   npm run shop:report
 */
import { Pool } from 'pg';
import { EnvValidationError, loadEnv } from '../config/env';
import { countDueShopChecks } from '../enrich/shop-check';

async function main(): Promise<void> {
  try {
    process.loadEnvFile('.env');
  } catch {
    // No .env file: rely on real environment variables.
  }
  const db = new Pool({ connectionString: loadEnv().DATABASE_URL, max: 2 });
  try {
    const [byCountry, signals, due] = await Promise.all([
      db.query<{ country_code: string; checked: string; selling: string; leads: string }>(
        `SELECT p.country_code,
                count(DISTINCT sc.domain) FILTER (WHERE sc.status <> 'RUNNING') AS checked,
                count(DISTINCT sc.domain) FILTER (WHERE sc.sells_online) AS selling,
                count(DISTINCT p.id) FILTER (WHERE sc.sells_online AND EXISTS
                  (SELECT 1 FROM emails e WHERE e.place_id = p.id)) AS leads
         FROM places p JOIN domain_shop_checks sc ON sc.domain = p.website_domain
         GROUP BY p.country_code ORDER BY p.country_code`,
      ),
      db.query<{ signal: string; n: string }>(
        `SELECT s AS signal, count(*) AS n FROM domain_shop_checks, unnest(signals) AS s
         WHERE sells_online GROUP BY s ORDER BY count(*) DESC`,
      ),
      countDueShopChecks(db),
    ]);
    console.log('Online-shop check (websites read so far)');
    for (const r of byCountry.rows) {
      console.log(
        `  ${r.country_code}: ${r.checked} websites checked, ${r.selling} sell online ` +
          `(${r.leads} businesses with an email)`,
      );
    }
    if (byCountry.rows.length === 0) console.log('  nothing checked yet (the worker does it)');
    console.log(`  waiting to be checked: ${due}`);
    if (signals.rows.length > 0) {
      console.log('\nWhat was found:');
      for (const s of signals.rows) console.log(`  ${s.n.padStart(6)}  ${s.signal}`);
    }
  } finally {
    await db.end();
  }
}

main().catch((err: unknown) => {
  if (err instanceof EnvValidationError) console.error(err.message);
  else console.error('Failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
