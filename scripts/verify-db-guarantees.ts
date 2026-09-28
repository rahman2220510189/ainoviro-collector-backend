/**
 * Verifies against the REAL database:
 *  Part 1 - write guarantees (duplicate emails, normalization, one primary email per
 *           place, suppression rules), inside ONE transaction that is always rolled back.
 *  Part 2 - the read queries behind the category and location APIs (read-only).
 *
 * Usage: npm run db:verify
 */
import { Client } from 'pg';
import { EnvValidationError, loadEnv, type Env } from '../src/config/env';
import { createPrismaClient } from '../src/db/prisma';
import { createPrismaCategoryStore } from '../src/services/categories';
import { createPrismaLocationStore } from '../src/services/locations';

// PostgreSQL error codes we expect to see.
const UNIQUE_VIOLATION = '23505';
const CHECK_VIOLATION = '23514';

type Expectation = { kind: 'success' } | { kind: 'error'; code: string };

interface Check {
  name: string;
  sql: string;
  params: unknown[];
  expect: Expectation;
}

interface Tally {
  passed: number;
  total: number;
}

const EMAIL_INSERT = `
  INSERT INTO emails (email, email_normalized, domain, place_id, is_primary, email_type, source, updated_at)
  VALUES ($1, $2, $3, $4, $5, 'GENERIC', 'verify_script', now())`;

function buildWriteChecks(placeId: number): Check[] {
  const domain = 'verify-ainoviro.test';
  return [
    {
      name: 'A. First insert of a new email is accepted',
      sql: EMAIL_INSERT,
      params: [`Info@${domain}`, `info@${domain}`, domain, placeId, true],
      expect: { kind: 'success' },
    },
    {
      name: 'B. Same email with different casing is rejected (duplicate)',
      sql: EMAIL_INSERT,
      params: [`INFO@${domain}`, `info@${domain}`, domain, null, false],
      expect: { kind: 'error', code: UNIQUE_VIOLATION },
    },
    {
      name: 'C. Non-normalized (uppercase) email is rejected',
      sql: EMAIL_INSERT,
      params: [`Sales@${domain}`, `Sales@${domain}`, domain, null, false],
      expect: { kind: 'error', code: CHECK_VIOLATION },
    },
    {
      name: 'D. A second PRIMARY email for the same place is rejected',
      sql: EMAIL_INSERT,
      params: [`owner@${domain}`, `owner@${domain}`, domain, placeId, true],
      expect: { kind: 'error', code: UNIQUE_VIOLATION },
    },
    {
      name: 'E. A second NON-primary email for the same place is accepted',
      sql: EMAIL_INSERT,
      params: [`booking@${domain}`, `booking@${domain}`, domain, placeId, false],
      expect: { kind: 'success' },
    },
    {
      name: 'F. Email whose domain column does not match the address is rejected',
      sql: EMAIL_INSERT,
      params: [`hello@${domain}`, `hello@${domain}`, 'other-domain.test', null, false],
      expect: { kind: 'error', code: CHECK_VIOLATION },
    },
    {
      name: 'G. Suppression row with neither email hash nor domain is rejected',
      sql: `INSERT INTO suppression (reason) VALUES ('MANUAL')`,
      params: [],
      expect: { kind: 'error', code: CHECK_VIOLATION },
    },
    {
      name: 'H. Suppression row with an invalid hash is rejected',
      sql: `INSERT INTO suppression (email_hash, reason) VALUES ($1, 'MANUAL')`,
      // Exactly 64 characters, but not lowercase hex -> must hit the CHECK constraint.
      params: ['Z'.repeat(64)],
      expect: { kind: 'error', code: CHECK_VIOLATION },
    },
  ];
}

/** Runs one check inside a savepoint so a failing statement does not abort the rest. */
async function runWriteCheck(client: Client, check: Check): Promise<boolean> {
  await client.query('SAVEPOINT verify_step');
  try {
    await client.query(check.sql, check.params);
    await client.query('RELEASE SAVEPOINT verify_step');
    if (check.expect.kind === 'success') {
      console.log(`[PASS] ${check.name}`);
      return true;
    }
    console.log(`[FAIL] ${check.name}  -> expected error ${check.expect.code}, but it was accepted`);
    return false;
  } catch (err) {
    await client.query('ROLLBACK TO SAVEPOINT verify_step');
    const code = (err as { code?: string }).code ?? 'unknown';
    const message = err instanceof Error ? err.message : String(err);
    if (check.expect.kind === 'error' && check.expect.code === code) {
      console.log(`[PASS] ${check.name}  -> rejected with ${code}`);
      return true;
    }
    console.log(`[FAIL] ${check.name}  -> unexpected error ${code}: ${message}`);
    return false;
  }
}

async function runWriteChecks(env: Env): Promise<Tally> {
  const client = new Client({ connectionString: env.DATABASE_URL });
  await client.connect();
  const tally: Tally = { passed: 0, total: 0 };
  try {
    await client.query('BEGIN');
    const place = await client.query<{ id: number }>(
      `INSERT INTO places (name, name_normalized, country_code, updated_at)
       VALUES ('Verify Test Shop', 'verify test shop', 'CY', now())
       RETURNING id`,
    );
    const placeId = place.rows[0]?.id;
    if (placeId === undefined) throw new Error('Could not create the test place');

    const checks = buildWriteChecks(placeId);
    tally.total = checks.length;
    for (const check of checks) {
      if (await runWriteCheck(client, check)) tally.passed += 1;
    }
  } finally {
    // Always undo everything: no test data is left in the database.
    await client.query('ROLLBACK').catch(() => undefined);
    await client.end();
  }
  return tally;
}

/** Read-only checks of the exact queries used by the API. */
async function runReadChecks(env: Env): Promise<Tally> {
  const prisma = createPrismaClient(env);
  const tally: Tally = { passed: 0, total: 0 };
  const record = (name: string, ok: boolean, detail: string): void => {
    tally.total += 1;
    if (ok) tally.passed += 1;
    console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}  -> ${detail}`);
  };

  try {
    const tree = await createPrismaCategoryStore(prisma).listCategoryTree(false);
    const subCount = tree.reduce((sum, c) => sum + c.subcategories.length, 0);
    record(
      'I. Category tree query returns 16 categories and 65 subcategories',
      tree.length === 16 && subCount === 65,
      `${tree.length} categories, ${subCount} subcategories`,
    );

    const locations = createPrismaLocationStore(prisma);
    const cyprus = (await locations.listChildren(null)).find(
      (l) => l.countryCode === 'CY' && l.type === 'COUNTRY',
    );
    const districts = cyprus
      ? (await locations.listChildren(cyprus.id)).filter((l) => l.type === 'REGION')
      : [];
    record(
      'J. Location tree query returns Cyprus with 6 districts',
      districts.length === 6,
      cyprus ? `${districts.length} districts` : 'Cyprus not found',
    );

    const expectedCities = await prisma.location.count({
      where: { countryCode: 'CY', type: 'CITY', active: true },
    });
    const allCities = cyprus ? await locations.resolveCityIds([cyprus.id]) : [];
    record(
      'K. Resolving Cyprus returns every active Cyprus city',
      expectedCities > 0 && allCities.length === expectedCities,
      `${allCities.length} of ${expectedCities}`,
    );

    const district = districts.find((d) => d.childCount > 0);
    const districtCities = district ? await locations.resolveCityIds([district.id]) : [];
    record(
      'L. Resolving one district returns only that district\'s cities',
      district !== undefined &&
        districtCities.length === district.childCount &&
        districtCities.every((id) => allCities.includes(id)),
      district ? `${district.name}: ${districtCities.length} cities` : 'no district found',
    );
  } finally {
    await prisma.$disconnect();
  }
  return tally;
}

async function main(): Promise<void> {
  try {
    process.loadEnvFile('.env');
  } catch {
    // No .env file: rely on real environment variables.
  }
  const env = loadEnv();

  console.log('Part 1: write guarantees (all changes rolled back)\n');
  const writes = await runWriteChecks(env);

  console.log('\nPart 2: API read queries (read-only)\n');
  const reads = await runReadChecks(env);

  const passed = writes.passed + reads.passed;
  const total = writes.total + reads.total;
  console.log(`\nResult: ${passed}/${total} checks passed. Test data rolled back.`);
  if (passed !== total) process.exit(1);
}

main().catch((err: unknown) => {
  if (err instanceof EnvValidationError) {
    console.error(err.message);
  } else {
    console.error('Verification could not run:', err instanceof Error ? err.message : err);
  }
  process.exit(1);
});