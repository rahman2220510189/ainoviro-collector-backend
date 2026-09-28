/**
 * Imports one country's location tree from GeoNames.
 * Idempotent: re-running updates existing rows (keyed by geonames_id).
 *
 * Usage: npm run import:geonames -- --country CY [--refresh]
 */
import { parseArgs } from 'node:util';
import { readFileSync } from 'node:fs';
import { Client } from 'pg';
import { ZodError } from 'zod';
import { EnvValidationError, loadEnv } from '../config/env';
import { loadCountryConfig } from '../geonames/config';
import { buildLocationTree } from '../geonames/build';
import { ensureGeonamesFile, readCountryDump } from '../geonames/download';
import { parseAdminCodes, parseCountryInfo, parseGeonamesFile } from '../geonames/parse';
import { writeLocationTree, type WriteCounts } from '../geonames/write';

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
  const config = loadCountryConfig(countryCode);
  const refresh = values.refresh ?? false;

  console.log(`Downloading GeoNames files for ${countryCode} (cached for 30 days)...`);
  const countryInfoText = readFileSync(await ensureGeonamesFile('countryInfo.txt', refresh), 'utf8');
  const admin1Text = readFileSync(await ensureGeonamesFile('admin1CodesASCII.txt', refresh), 'utf8');
  const admin2Text = config.useAdmin2
    ? readFileSync(await ensureGeonamesFile('admin2Codes.txt', refresh), 'utf8')
    : null;
  const dumpText = readCountryDump(await ensureGeonamesFile(`${countryCode}.zip`, refresh), countryCode);

  const tree = buildLocationTree({
    countryCode,
    countryInfo: parseCountryInfo(countryInfoText, countryCode),
    admin1: parseAdminCodes(admin1Text, countryCode),
    admin2: admin2Text ? parseAdminCodes(admin2Text, countryCode) : null,
    rows: parseGeonamesFile(dumpText),
    config,
  });

  console.log('Writing to the database (one transaction)...');
  const client = new Client({ connectionString: env.DATABASE_URL });
  await client.connect();
  try {
    const result = await writeLocationTree(client, tree);

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
  } finally {
    await client.end();
  }
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