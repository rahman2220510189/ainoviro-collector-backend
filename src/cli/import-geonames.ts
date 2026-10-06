/**
 * Imports one country's location tree from GeoNames.
 * Idempotent: re-running updates existing rows (keyed by geonames_id).
 *
 * Usage: npm run import:geonames -- --country CY [--refresh]
 */
import { parseArgs } from 'node:util';
import { ZodError } from 'zod';
import { EnvValidationError, loadEnv } from '../config/env';
import { importGeonamesCountry } from '../geonames/import-country';
import type { WriteCounts } from '../geonames/write';

function describe(counts: WriteCounts): string {
  return `${counts.inserted + counts.updated} (new ${counts.inserted}, updated ${counts.updated})`;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      country: { type: 'string' },
      refresh: { type: 'boolean', default: false },
    },
  });
  const countryCode = (values.country ?? '').toUpperCase();
  if (!/^[A-Z]{2}$/.test(countryCode)) {
    throw new Error('Usage: npm run import:geonames -- --country CY [--refresh]');
  }

  try {
    process.loadEnvFile('.env');
  } catch {
    // No .env file: rely on real environment variables.
  }
  const env = loadEnv();
  const { tree, result } = await importGeonamesCountry(env.DATABASE_URL, countryCode, {
    refresh: values.refresh ?? false,
    onProgress: (line) => console.log(line),
  });
  const largest = [...tree.cities]
    .sort((a, b) => (b.population ?? 0) - (a.population ?? 0))
    .slice(0, 5)
    .map((c) => `${c.name} (${(c.population ?? 0).toLocaleString('en')})`)
    .join(', ');

  console.log(`\n${tree.country.name}: done.`);
  console.log(`  Country: ${describe(result.country)}`);
  console.log(`  Regions: ${describe(result.regions)}`);
  console.log(`  Cities:  ${describe(result.cities)}`);
  console.log(
    `  Skipped: ${tree.stats.skippedNotPopulated} non-populated features, ` +
      `${tree.stats.skippedExcludedCodes} city sections/historical/abandoned, ` +
      `${tree.stats.skippedNoCoordinates} without coordinates`,
  );
  console.log(`  Largest cities: ${largest}`);
}

main().catch((err: unknown) => {
  if (err instanceof EnvValidationError) {
    console.error(err.message);
  } else if (err instanceof ZodError) {
    console.error('seed/countries.json is invalid:');
    for (const issue of err.issues) {
      console.error(`  - ${issue.path.map(String).join('.')}: ${issue.message}`);
    }
  } else {
    console.error('Import failed:', err instanceof Error ? err.message : err);
  }
  process.exit(1);
});
