/**
 * Proves against the REAL database that the New job page logic (step 3.4) works:
 * scope from the location tree (a district, or single cities), the cost preview, saving
 * a job, its detail with progress stages, the quota status and the budget rules.
 * No Google request is made: the test job is created in MOCK mode, never started,
 * and deleted at the end.
 *
 * Usage: npm run jobs:verify
 */
import { EnvValidationError, loadEnv } from '../src/config/env';
import { createPrismaClient } from '../src/db/prisma';
import { createPrismaJobService } from '../src/jobs/job-service';
import { AppError } from '../src/lib/errors';
import { QuotaGuard } from '../src/quota/quota-guard';
import { loadQuotaSettings } from '../src/quota/settings';

const JOB_NAME = 'verify-jobs-api (safe to delete)';

let passed = 0;
let total = 0;
function check(name: string, ok: boolean, detail: string): void {
  total += 1;
  if (ok) passed += 1;
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}  -> ${detail}`);
}

async function errorCode(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
    return 'no error';
  } catch (err) {
    return err instanceof AppError ? err.code : String(err);
  }
}

async function main(): Promise<void> {
  try {
    process.loadEnvFile('.env');
  } catch {
    // No .env file: rely on real environment variables.
  }
  const env = loadEnv();
  const prisma = createPrismaClient(env);
  const quota = new QuotaGuard(prisma, await loadQuotaSettings(prisma));
  // MOCK: the test job could only ever be run by a mock worker, and it is never started.
  const service = createPrismaJobService(prisma, { quota, mode: 'MOCK' });

  const cleanup = () => prisma.job.deleteMany({ where: { name: JOB_NAME } });
  try {
    await cleanup();
    const country = await prisma.location.findFirst({
      where: { type: 'COUNTRY', countryCode: 'CY', active: true },
      select: { id: true },
    });
    const district = await prisma.location.findFirst({
      where: { parentId: country?.id, type: 'REGION', active: true },
      orderBy: { name: 'asc' },
      select: { id: true, name: true },
    });
    const cities = await prisma.location.findMany({
      where: { parentId: district?.id, type: 'CITY', active: true },
      orderBy: [{ population: { sort: 'desc', nulls: 'last' } }],
      take: 2,
      select: { id: true, name: true },
    });
    const category = await prisma.category.findFirst({
      where: { active: true },
      orderBy: { sortOrder: 'asc' },
      select: { slug: true },
    });
    if (!country || !district || cities.length === 0 || !category) {
      throw new Error('Cyprus locations or categories are missing (run the seeds first).');
    }

    const base = { countryCode: 'CY', districtNames: [], greek: false, forceRerun: true };
    const byDistrict = await service.preview({
      ...base,
      locationIds: [district.id],
      categorySlugs: [category.slug],
    });
    check(
      'A. Preview for one district from the tree',
      byDistrict.scopeLabel === `Cyprus (${district.name})` && byDistrict.tasksToRun > 0,
      `${byDistrict.scopeLabel}: ${byDistrict.areas} area(s), ${byDistrict.tasksToRun} searches`,
    );

    const cityIds = cities.map((c) => c.id);
    const byCity = await service.preview({
      ...base,
      locationIds: cityIds,
      categorySlugs: [category.slug],
      includeRural: true,
    });
    check(
      'B. Preview for single cities is not bigger than the district',
      byCity.tasksToRun > 0 && byCity.tasksToRun <= byDistrict.tasksToRun,
      `${byCity.scopeLabel}: ${byCity.tasksToRun} searches (district ${byDistrict.tasksToRun})`,
    );

    const otherCountry = await prisma.location.findFirst({
      where: { countryCode: { not: 'CY' }, active: true },
      select: { id: true },
    });
    const wrong = await errorCode(() =>
      service.preview({
        ...base,
        locationIds: [otherCountry?.id ?? 999_999_999],
        categorySlugs: [],
      }),
    );
    const both = await errorCode(() =>
      service.preview({
        ...base,
        districtNames: [district.name],
        locationIds: [district.id],
        categorySlugs: [],
      }),
    );
    check(
      'C. Locations outside Cyprus, or districts and locations together, are refused',
      wrong === 'INVALID_JOB_REQUEST' && both === 'INVALID_JOB_REQUEST',
      `outside: ${wrong}, both: ${both}`,
    );

    const created = await service.create({
      ...base,
      name: JOB_NAME,
      locationIds: cityIds,
      categorySlugs: [category.slug],
      includeRural: true,
    });
    const detail = await service.get(created.jobId);
    check(
      'D. Job saved as QUEUED with its scope and categories',
      detail?.status === 'QUEUED' &&
        detail.options.scopeLabel === byCity.scopeLabel &&
        detail.options.categorySlugs.join() === category.slug &&
        detail.options.mode === 'MOCK',
      `job ${created.jobId}: ${detail?.status}, ${detail?.options.scopeLabel}`,
    );

    const locations = await prisma.jobLocation.count({ where: { jobId: created.jobId } });
    check(
      'E. Detail shows the search stage; nothing found before start',
      detail?.stages.search.toDo === byCity.tasksToRun &&
        detail.stages.places.newPlaces === 0 &&
        locations >= cityIds.length,
      `searches to do ${detail?.stages.search.toDo}, new places ${detail?.stages.places.newPlaces}, cities saved ${locations}`,
    );

    const status = await service.quotaStatus();
    check(
      'F. Quota status reads the mock counter and the worker heartbeat',
      status.mode === 'MOCK' &&
        status.freeRemaining <= status.freeCap &&
        typeof status.worker.running === 'boolean',
      `used ${status.used}/${status.freeCap}, worker ${status.worker.running ? 'running' : 'not running'}`,
    );

    const settings = quota.limits();
    const budget = await errorCode(() => service.approveBudget(created.jobId, 1));
    const expected =
      settings.monthlyHardCapEur > 0 ? 'INVALID_JOB_STATE' : 'PAID_REQUESTS_DISABLED';
    check(
      'G. A budget is refused (paid requests off, or the job is not paused by the quota)',
      budget === expected,
      `${budget} (monthly cap ${settings.monthlyHardCapEur} EUR)`,
    );

    const cancelled = await service.act(created.jobId, 'cancel');
    const after = await service.get(created.jobId);
    check(
      'H. Cancel: no search is left to run',
      cancelled.status === 'CANCELLED' && after?.stages.search.toDo === 0,
      `${cancelled.status}, searches to do ${after?.stages.search.toDo}`,
    );
  } finally {
    await cleanup().catch((err: unknown) => console.error('cleanup failed:', err));
    await prisma.$disconnect();
  }
  console.log(`\n${passed}/${total} checks passed${passed === total ? '' : '  <- PROBLEM'}`);
  if (passed !== total) process.exitCode = 1;
}

main().catch((err: unknown) => {
  if (err instanceof EnvValidationError) console.error(err.message);
  else console.error('Verification failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
