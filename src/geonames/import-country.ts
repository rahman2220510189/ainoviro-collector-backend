import { readFileSync } from 'node:fs';
import { Client } from 'pg';
import { buildLocationTree, type LocationTreeDraft } from './build';
import { loadCountryConfig } from './config';
import { ensureGeonamesFile, readCountryDump } from './download';
import { parseAdminCodes, parseCountryInfo, parseGeonamesFile } from './parse';
import { writeLocationTree, type WriteResult } from './write';

export interface GeonamesImportResult {
  tree: LocationTreeDraft;
  result: WriteResult;
}

/**
 * Imports one country's location tree from GeoNames (country -> regions -> cities), the
 * same as `npm run import:geonames`. Used by the command line and by the worker when a
 * country is added on the Settings page. Idempotent: rows are keyed by geonames_id.
 */
export async function importGeonamesCountry(
  databaseUrl: string,
  countryCode: string,
  options: { refresh?: boolean; onProgress?: (line: string) => void } = {},
): Promise<GeonamesImportResult> {
  const say = options.onProgress ?? (() => undefined);
  const refresh = options.refresh ?? false;
  const config = loadCountryConfig(countryCode);
  say(`Downloading GeoNames files for ${countryCode} (cached for 30 days)...`);
  const countryInfoText = readFileSync(
    await ensureGeonamesFile('countryInfo.txt', refresh),
    'utf8',
  );
  const admin1Text = readFileSync(
    await ensureGeonamesFile('admin1CodesASCII.txt', refresh),
    'utf8',
  );
  const admin2Text = config.useAdmin2
    ? readFileSync(await ensureGeonamesFile('admin2Codes.txt', refresh), 'utf8')
    : null;
  const dumpText = readCountryDump(
    await ensureGeonamesFile(`${countryCode}.zip`, refresh),
    countryCode,
  );
  const tree = buildLocationTree({
    countryCode,
    countryInfo: parseCountryInfo(countryInfoText, countryCode),
    admin1: parseAdminCodes(admin1Text, countryCode),
    admin2: admin2Text ? parseAdminCodes(admin2Text, countryCode) : null,
    rows: parseGeonamesFile(dumpText),
    config,
  });
  say(
    `Writing ${tree.regions.length} regions and ${tree.cities.length} places (one transaction)...`,
  );
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    return { tree, result: await writeLocationTree(client, tree) };
  } finally {
    await client.end();
  }
}
