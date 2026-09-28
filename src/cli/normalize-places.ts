/**
 * Re-cleans places that are already in the database with the current rules:
 * website (tracking parameters removed, platform links detected), own domain,
 * phone E.164, matching name and city. Safe to run many times.
 *
 *   npm run places:normalize -- --country CY [--dry-run]
 */
import { parseArgs } from 'node:util';
import { Pool, type PoolClient } from 'pg';
import { DEFAULT_NEAREST_CITY_KM, loadCityResolver, type CityMethod } from '../cleaning/city';
import { normalizePlaceFields, type NormalizedPlaceFields } from '../cleaning/normalize-place';
import type { PlatformKind } from '../cleaning/platforms';
import { EnvValidationError, loadEnv } from '../config/env';
import { createPrismaClient } from '../db/prisma';
import { loadSearchSettings } from '../services/settings';

const BATCH_SIZE = 500;

interface PlaceRow {
  id: number;
  name: string;
  website: string | null;
  phone_raw: string | null;
  lat: number | null;
  lng: number | null;
  city_id: number | null;
}

interface Summary {
  places: number;
  changed: number;
  websites: number;
  websitesCleaned: number;
  ownDomains: number;
  platforms: Partial<Record<PlatformKind, number>>;
  phones: number;
  phonesValid: number;
  cities: Partial<Record<CityMethod | 'NONE', number>>;
  topCities: Map<string, number>;
}

function sameValues(row: PlaceRow & Record<string, unknown>, f: NormalizedPlaceFields): boolean {
  return (
    row.name_normalized === f.nameNormalized &&
    row.website === f.website &&
    row.website_domain === f.websiteDomain &&
    row.phone_e164 === f.phoneE164 &&
    row.phone_valid === f.phoneValid &&
    row.city_id === (f.city?.cityId ?? row.city_id) &&
    row.city_name === (f.city?.cityName ?? row.city_name)
  );
}

async function writeBatch(
  client: PoolClient,
  rows: { id: number; f: NormalizedPlaceFields; cityId: number | null }[],
) {
  await client.query(
    `UPDATE places p SET
       name_normalized = u.name_normalized,
       website = u.website,
       website_domain = u.website_domain,
       phone_e164 = u.phone_e164,
       phone_valid = u.phone_valid,
       city_id = u.city_id,
       city_name = COALESCE(u.city_name, p.city_name),
       updated_at = now()
     FROM unnest($1::int[], $2::text[], $3::text[], $4::text[], $5::text[], $6::bool[], $7::int[], $8::text[])
       AS u(id, name_normalized, website, website_domain, phone_e164, phone_valid, city_id, city_name)
     WHERE p.id = u.id`,
    [
      rows.map((r) => r.id),
      rows.map((r) => r.f.nameNormalized),
      rows.map((r) => r.f.website),
      rows.map((r) => r.f.websiteDomain),
      rows.map((r) => r.f.phoneE164),
      rows.map((r) => r.f.phoneValid),
      rows.map((r) => r.cityId),
      rows.map((r) => r.f.city?.cityName ?? null),
    ],
  );
}

async function main(): Promise<void> {
  try {
    process.loadEnvFile('.env');
  } catch {
    // No .env file: rely on real environment variables.
  }
  const { values } = parseArgs({
    options: {
      country: { type: 'string', default: 'CY' },
      'dry-run': { type: 'boolean', default: false },
    },
  });
  const countryCode = (values.country ?? 'CY').toUpperCase();
  const dryRun = values['dry-run'] ?? false;

  const env = loadEnv();
  const prisma = createPrismaClient(env);
  const pool = new Pool({ connectionString: env.DATABASE_URL, max: 2 });
  try {
    const searchSettings = await loadSearchSettings(prisma);
    const cities = await loadCityResolver(pool, countryCode, {
      minCityPopulation: searchSettings.minCityPopulation,
      maxNearestKm: DEFAULT_NEAREST_CITY_KM,
    });
    if (cities.size === 0)
      throw new Error(
        `No cities for ${countryCode}. Run: npm run import:geonames -- --country ${countryCode}`,
      );

    const { rows } = await pool.query<PlaceRow & Record<string, unknown>>(
      `SELECT id, name, name_normalized, website, website_domain, phone_raw, phone_e164, phone_valid,
              lat, lng, city_id, city_name
       FROM places WHERE country_code = $1 ORDER BY id`,
      [countryCode],
    );

    const summary: Summary = {
      places: rows.length,
      changed: 0,
      websites: 0,
      websitesCleaned: 0,
      ownDomains: 0,
      platforms: {},
      phones: 0,
      phonesValid: 0,
      cities: {},
      topCities: new Map(),
    };
    const updates: { id: number; f: NormalizedPlaceFields; cityId: number | null }[] = [];

    for (const row of rows) {
      const f = normalizePlaceFields(
        { name: row.name, website: row.website, phone: row.phone_raw, lat: row.lat, lng: row.lng },
        { countryCode, cities, fallbackCityId: row.city_id },
      );
      if (row.website) {
        summary.websites += 1;
        if (f.website !== row.website) summary.websitesCleaned += 1;
      }
      if (f.websiteDomain) summary.ownDomains += 1;
      if (f.websitePlatform)
        summary.platforms[f.websitePlatform] = (summary.platforms[f.websitePlatform] ?? 0) + 1;
      if (f.phoneRaw) summary.phones += 1;
      if (f.phoneValid) summary.phonesValid += 1;
      const method = f.city?.method ?? 'NONE';
      summary.cities[method] = (summary.cities[method] ?? 0) + 1;
      if (f.city)
        summary.topCities.set(f.city.cityName, (summary.topCities.get(f.city.cityName) ?? 0) + 1);

      if (!sameValues(row, f))
        updates.push({ id: row.id, f, cityId: f.city?.cityId ?? row.city_id });
    }
    summary.changed = updates.length;

    if (!dryRun && updates.length > 0) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        for (let i = 0; i < updates.length; i += BATCH_SIZE) {
          await writeBatch(client, updates.slice(i, i + BATCH_SIZE));
        }
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw err;
      } finally {
        client.release();
      }
    }

    const fmt = (n: number | undefined): string => (n ?? 0).toLocaleString('en');
    console.log(
      `\nPlaces in ${countryCode}: ${fmt(summary.places)}${dryRun ? '  (dry run: nothing saved)' : ''}`,
    );
    console.log(`  Changed:              ${fmt(summary.changed)}`);
    console.log(
      `  Websites:             ${fmt(summary.websites)} (cleaned ${fmt(summary.websitesCleaned)})`,
    );
    console.log(
      `    Own website:        ${fmt(summary.ownDomains)}  <- these will be crawled for emails`,
    );
    for (const [kind, count] of Object.entries(summary.platforms)) {
      console.log(`    ${`${kind}:`.padEnd(20)}${fmt(count)}  (not crawled)`);
    }
    console.log(
      `  Phones:               ${fmt(summary.phones)} (valid E.164: ${fmt(summary.phonesValid)})`,
    );
    console.log(
      `  City: inside a town area ${fmt(summary.cities.CITY_AREA)}, nearest place ${fmt(summary.cities.NEAREST)}, ` +
        `search area ${fmt(summary.cities.FALLBACK)}, none ${fmt(summary.cities.NONE)}`,
    );
    const top = [...summary.topCities.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
    console.log(
      `  Top cities:           ${top.map(([name, n]) => `${name} ${n}`).join(', ') || '-'}`,
    );
  } finally {
    await pool.end();
    await prisma.$disconnect();
  }
}

main().catch((err: unknown) => {
  if (err instanceof EnvValidationError) console.error(err.message);
  else console.error('Normalization failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});