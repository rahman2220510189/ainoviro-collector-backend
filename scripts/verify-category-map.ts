/**
 * Checks against the REAL database that the Overture category rules (step 4.3) are loaded
 * and sort places as agreed: businesses into our categories; parks, government, state
 * schools and universities left out; private schools kept. Read only.
 *
 * Usage: npm run overture:map -- --seed   (once), then   npm run categorymap:verify
 */
import { Pool } from 'pg';
import { EnvValidationError, loadEnv } from '../src/config/env';
import {
  classifyOverture,
  loadOvertureRules,
  readOvertureMapFile,
} from '../src/datasets/category-map';

let passed = 0;
let total = 0;
function check(name: string, ok: boolean, detail: string): void {
  total += 1;
  if (ok) passed += 1;
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}  -> ${detail}`);
}

async function main(): Promise<void> {
  try {
    process.loadEnvFile('.env');
  } catch {
    // No .env file: rely on real environment variables.
  }
  const db = new Pool({ connectionString: loadEnv().DATABASE_URL, max: 2 });
  try {
    const rules = await loadOvertureRules(db);
    const file = readOvertureMapFile();
    check(
      'A. Every rule of the file is in the database',
      rules.length === file.length,
      `${rules.length} in the database, ${file.length} in the file`,
    );

    const { rows } = await db.query<{ id: number; key: string }>(
      `SELECT s.id, c.slug || '/' || s.slug AS key FROM subcategories s JOIN categories c ON c.id = s.category_id`,
    );
    const keyOf = new Map(rows.map((r) => [r.id, r.key]));
    const sortOf = (path: string, basic: string | null = null): string => {
      const c = classifyOverture(
        { taxonomyHierarchy: path === '' ? [] : path.split(' > '), basicCategory: basic },
        rules,
      );
      return c.kind === 'mapped'
        ? (keyOf.get(c.subcategoryId) ?? '?')
        : c.kind === 'excluded'
          ? `excluded: ${c.reason}`
          : 'unmapped';
    };

    const cases: [string, string][] = [
      ['food_and_drink > restaurant > pizza_restaurant', 'food-beverage/dining-takeaway'],
      [
        'lifestyle_services > personal_or_beauty_service > beauty_salon',
        'personal-care-beauty/treatments-services',
      ],
      [
        'sports_and_recreation > sport_or_fitness_facility > gym',
        'fitness-sports/memberships-passes',
      ],
      ['lodging > hotel', 'travel-hospitality/accommodation'],
      [
        'education > place_of_learning > school > private_school',
        'education-coaching/memberships-programs',
      ],
      [
        'education > place_of_learning > specialty_school > language_school',
        'education-coaching/courses-workshops',
      ],
    ];
    const wrong = cases.filter(([p, want]) => sortOf(p) !== want);
    check(
      'B. Businesses land in the agreed categories',
      wrong.length === 0,
      wrong.length === 0
        ? `${cases.length} examples right`
        : wrong.map(([p]) => `${p} -> ${sortOf(p)}`).join('; '),
    );

    const out: string[] = [
      'education > place_of_learning > school > high_school',
      'education > place_of_learning > college_university',
      'community_and_government > government_office',
      'geographic_entities > water_feature > beach',
      'cultural_and_historic > place_of_worship > church',
      'services_and_business > financial_service > atm',
    ];
    const kept = out.filter((p) => !sortOf(p).startsWith('excluded'));
    check(
      'C. State schools, universities, government, nature, churches and ATMs are left out',
      kept.length === 0,
      kept.length === 0 ? `${out.length} examples left out` : `kept by mistake: ${kept.join(', ')}`,
    );

    check(
      'D. Places without a path use the basic category; unknown ones stay unmapped',
      sortOf('', 'fueling_station') === 'automotive-mobility/services-support' &&
        sortOf('', 'nothing_like_this') === 'unmapped',
      `fueling_station -> ${sortOf('', 'fueling_station')}`,
    );
  } finally {
    await db.end();
  }
  console.log(`\n${passed}/${total} checks passed${passed === total ? '' : '  <- PROBLEM'}`);
  if (passed !== total) process.exitCode = 1;
}

main().catch((err: unknown) => {
  if (err instanceof EnvValidationError) console.error(err.message);
  else console.error('Verification failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
