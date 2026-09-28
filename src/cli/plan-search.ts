/**
 * Shows WHERE a job would search and the minimum number of Google requests.
 * Makes no Google calls.
 *
 * Usage:
 *   npm run plan:search -- --country CY [--districts Limassol,Paphos]
 *        [--categories slug1,slug2] [--greek] [--skip-rural] [--min-population 5000]
 */
import { parseArgs } from 'node:util';
import { EnvValidationError, loadEnv } from '../config/env';
import { createPrismaClient } from '../db/prisma';
import { estimateMinimumRequests, planSearchAreas } from '../planning/search-areas';
import { createPrismaLocationStore } from '../services/locations';
import { countKeywords, listActiveCategorySlugs, loadPlanningCities } from '../services/search-planning';
import { loadSearchSettings } from '../services/settings';

/** Monthly free Text Search allowance as configured in the spec (verified in step 1.4). */
const FREE_MONTHLY_REQUESTS = 1000;

const fmt = (n: number): string => n.toLocaleString('en');
const list = (value: string | undefined): string[] =>
  (value ?? '').split(',').map((v) => v.trim()).filter((v) => v !== '');

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      country: { type: 'string' },
      districts: { type: 'string' },
      categories: { type: 'string' },
      greek: { type: 'boolean', default: false },
      'skip-rural': { type: 'boolean', default: false },
      'min-population': { type: 'string' },
    },
  });
  const countryCode = (values.country ?? '').toUpperCase();
  if (!/^[A-Z]{2}$/.test(countryCode)) throw new Error('Missing --country, e.g. --country CY');

  try {
    process.loadEnvFile('.env');
  } catch {
    // No .env file: rely on real environment variables.
  }
  const env = loadEnv();
  const prisma = createPrismaClient(env);

  try {
    const settings = await loadSearchSettings(prisma);
    const minCityPopulation =
      values['min-population'] !== undefined ? Number(values['min-population']) : settings.minCityPopulation;
    if (!Number.isInteger(minCityPopulation) || minCityPopulation < 0) {
      throw new Error('--min-population must be a whole number, e.g. 5000');
    }
    const includeRural = settings.includeRural && !values['skip-rural'];

    // Scope: the whole country, or selected districts.
    const country = await prisma.location.findFirst({
      where: { type: 'COUNTRY', countryCode, active: true },
      select: { id: true, name: true },
    });
    if (!country) throw new Error(`Country ${countryCode} is not imported. Run import:geonames first.`);

    let scopeIds = [country.id];
    let scopeLabel = `${country.name} (all districts)`;
    const districtNames = list(values.districts);
    if (districtNames.length > 0) {
      const regions = await prisma.location.findMany({
        where: { parentId: country.id, type: 'REGION', active: true },
        select: { id: true, name: true, nameLocal: true },
      });
      scopeIds = districtNames.map((name) => {
        const match = regions.find(
          (r) => r.name.toLowerCase() === name.toLowerCase() || r.nameLocal?.toLowerCase() === name.toLowerCase(),
        );
        if (!match) {
          throw new Error(`Unknown district "${name}". Districts: ${regions.map((r) => r.name).join(', ')}`);
        }
        return match.id;
      });
      scopeLabel = `${country.name} (${districtNames.join(', ')})`;
    }

    // Categories: all, or a validated subset.
    const activeSlugs = await listActiveCategorySlugs(prisma);
    const chosenSlugs = list(values.categories);
    for (const slug of chosenSlugs) {
      if (!activeSlugs.includes(slug)) {
        throw new Error(`Unknown category "${slug}". Categories:\n  ${activeSlugs.join('\n  ')}`);
      }
    }
    const languages = values.greek ? ['en', 'el'] : ['en'];
    const keywordCount = await countKeywords(prisma, languages, chosenSlugs.length > 0 ? chosenSlugs : null);

    // Plan.
    const cityIds = await createPrismaLocationStore(prisma).resolveCityIds(scopeIds);
    const { cities, missingGeometry } = await loadPlanningCities(prisma, cityIds);
    const plan = planSearchAreas(cities, { minCityPopulation, includeRural });
    const cityAreas = plan.areas.filter((a) => a.kind === 'CITY');
    const ruralAreas = plan.areas.filter((a) => a.kind === 'RURAL');
    const minimum = estimateMinimumRequests(plan.areas.length, keywordCount);

    console.log(`\nSearch plan for ${scopeLabel}`);
    console.log(`  Places selected:        ${fmt(cities.length)}${missingGeometry ? ` (+${missingGeometry} without coordinates)` : ''}`);
    console.log(`  City areas:             ${cityAreas.length} (population >= ${fmt(minCityPopulation)})`);
    console.log(`  Rural district areas:   ${includeRural ? ruralAreas.length : 'off'}`);
    console.log(`  Absorbed big towns:     ${plan.absorbed.length}`);
    for (const a of plan.absorbed) console.log(`    - ${a.name} -> inside ${a.intoName}`);
    console.log(`  Small places in cities: ${fmt(plan.coveredSmallPlaces)}`);
    console.log(`  Small places in rural:  ${fmt(plan.ruralPlaces)}`);
    if (!includeRural) console.log(`  Small places NOT searched: ${fmt(plan.excludedRuralPlaces)}`);
    console.log(`  Keywords:               ${keywordCount} (${languages.join(' + ')}; ${chosenSlugs.length > 0 ? chosenSlugs.join(', ') : 'all categories'})`);
    console.log(`\n  Minimum requests:       ${plan.areas.length} areas x ${keywordCount} keywords = ${fmt(minimum)}`);
    console.log('                          (extra result pages and dense-area splits add more)');
    console.log(`  Free monthly allowance: ${fmt(FREE_MONTHLY_REQUESTS)} -> ${minimum <= FREE_MONTHLY_REQUESTS ? 'fits' : 'DOES NOT FIT in one month'}`);

    console.log('\nAreas:');
    for (const area of plan.areas) {
      const pop = area.population ? ` pop ${fmt(area.population)}` : '';
      console.log(`  - ${area.name}${pop}, covers ${area.coveredCityIds.length} place(s)`);
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err: unknown) => {
  if (err instanceof EnvValidationError) {
    console.error(err.message);
  } else {
    console.error('Planning failed:', err instanceof Error ? err.message : err);
  }
  process.exit(1);
});