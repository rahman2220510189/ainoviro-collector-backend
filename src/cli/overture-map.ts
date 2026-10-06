/**
 * The Overture category rules (seed/overture-category-map.json).
 *
 *   npm run overture:map -- --seed                 load the file into the database
 *   npm run overture:map -- --report --country CY  how the rules sort the imported places
 *
 * Re-run --seed after editing the file. Nothing is changed by --report.
 */
import { parseArgs } from 'node:util';
import { Pool } from 'pg';
import { EnvValidationError, loadEnv } from '../config/env';
import {
  overtureMappingReport,
  readOvertureMapFile,
  seedOvertureMap,
} from '../datasets/category-map';

const pad = (n: number, w = 6) => String(n).padStart(w);

async function main(): Promise<void> {
  try {
    process.loadEnvFile('.env');
  } catch {
    // No .env file: rely on real environment variables.
  }
  const { values } = parseArgs({
    options: {
      seed: { type: 'boolean', default: false },
      report: { type: 'boolean', default: false },
      country: { type: 'string' },
    },
  });
  if (!values.seed && !values.report) throw new Error('Use --seed and/or --report --country CY');

  const db = new Pool({ connectionString: loadEnv().DATABASE_URL, max: 2 });
  try {
    if (values.seed) {
      const rules = readOvertureMapFile();
      const r = await seedOvertureMap(db, rules);
      console.log(
        `Overture rules: ${rules.length} in the file (${r.created} new, ${r.updated} updated, ${r.removed} removed)`,
      );
    }
    if (values.report) {
      const country = (values.country ?? '').toUpperCase();
      if (!/^[A-Z]{2}$/.test(country)) throw new Error('Say which country: --country CY');
      const r = await overtureMappingReport(db, country);
      console.log(`\nOverture places in ${country}: ${r.total}`);
      console.log(`  Businesses (kept):  ${pad(r.mapped)}  (${r.mappedWithEmail} with an email)`);
      console.log(`  Not a business:     ${pad(r.excluded)}`);
      console.log(`  No category:        ${pad(r.unmapped)}  (kept, held for review)`);
      console.log('\n  Places / with email, per category:');
      for (const c of r.byCategory)
        console.log(`    ${pad(c.places)} ${pad(c.withEmail)}  ${c.category}`);
      console.log('\n  Left out, per reason:');
      for (const c of r.byExclusion)
        console.log(`    ${pad(c.places)} ${pad(c.withEmail)}  ${c.reason}`);
      if (r.topUnmapped.length > 0) {
        console.log('\n  Without a rule:');
        for (const c of r.topUnmapped) console.log(`    ${pad(c.places)}  ${c.category}`);
      }
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
