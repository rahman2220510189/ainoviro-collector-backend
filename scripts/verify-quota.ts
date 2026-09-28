/**
 * Proves on the REAL database that the QuotaGuard never over-grants,
 * with 8 workers racing at the same time. Uses provider "verify" and a
 * unique SKU, then deletes everything it created. Makes no Google calls.
 *
 * Usage: npm run quota:verify
 */
import { EnvValidationError, loadEnv } from '../src/config/env';
import { createPrismaClient } from '../src/db/prisma';
import { QuotaGuard, type QuotaDecision, type ReserveInput } from '../src/quota/quota-guard';
import { quotaSettingsSchema } from '../src/quota/settings';

const WORKERS = 8;
const PROVIDER = 'verify';

/** 8 workers call reserve() in parallel, each `perWorker` times. */
async function race(guard: QuotaGuard, input: ReserveInput, perWorker: number): Promise<QuotaDecision[]> {
  const results: QuotaDecision[] = [];
  await Promise.all(
    Array.from({ length: WORKERS }, async () => {
      for (let i = 0; i < perWorker; i += 1) results.push(await guard.reserve(input));
    }),
  );
  return results;
}

const count = (list: QuotaDecision[], pick: (d: QuotaDecision) => boolean): number => list.filter(pick).length;

async function main(): Promise<void> {
  try {
    process.loadEnvFile('.env');
  } catch {
    // No .env file: rely on real environment variables.
  }
  const env = loadEnv();
  const prisma = createPrismaClient(env);
  const sku = `verify-${Date.now()}`;
  const jobIds: number[] = [];
  let passed = 0;
  let total = 0;
  const check = (name: string, ok: boolean, detail: string): void => {
    total += 1;
    if (ok) passed += 1;
    console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}  -> ${detail}`);
  };

  // Round numbers: 1 EUR per paid request, free limit 50, warning at 40.
  const base = quotaSettingsSchema.parse({
    freeLimit: 50,
    warnAt: 0.8,
    pricePer1000Usd: 1000,
    usdToEurRate: 1,
    monthlyHardCapEur: 3,
    billingTimeZone: 'UTC',
  });

  try {
    console.log(`Racing ${WORKERS} parallel workers against the real database...\n`);

    // Part 1: free allowance.
    const free = await race(new QuotaGuard(prisma, base), { provider: PROVIDER, sku }, 20);
    const granted = count(free, (d) => d.granted);
    check('A. 160 parallel attempts with a free limit of 50 grant exactly 50', granted === 50, `${granted} granted`);

    const period = new QuotaGuard(prisma, base).currentPeriod();
    const row = await prisma.apiUsage.findUnique({ where: { provider_sku_period: { provider: PROVIDER, sku, period } } });
    check('B. The database counter never goes past the limit', row?.requestCount === 50, `request_count = ${row?.requestCount}`);

    const warnings = count(free, (d) => d.granted && d.billing === 'FREE' && d.warn);
    check('C. The 80% warning fires exactly once', warnings === 1, `${warnings} warning(s)`);

    const deniedFree = count(free, (d) => !d.granted && d.reason === 'FREE_LIMIT_REACHED');
    check('D. Every other attempt is denied with FREE_LIMIT_REACHED', deniedFree === 110, `${deniedFree} denied`);

    // Part 2: paid requests need a job budget AND the monthly cap.
    const noBudgetJob = await prisma.job.create({ data: { sourcePlan: ['GOOGLE_PLACES'] } });
    jobIds.push(noBudgetJob.id);
    const noBudget = await new QuotaGuard(prisma, base).reserve({ provider: PROVIDER, sku, jobId: noBudgetJob.id });
    check(
      'E. A job without extra budget gets no paid request',
      !noBudget.granted && noBudget.reason === 'FREE_LIMIT_REACHED',
      noBudget.granted ? 'granted!' : noBudget.reason,
    );

    const job = await prisma.job.create({ data: { sourcePlan: ['GOOGLE_PLACES'], extraBudgetEur: 5 } });
    jobIds.push(job.id);
    const paidRound1 = await race(new QuotaGuard(prisma, base), { provider: PROVIDER, sku, jobId: job.id }, 5);
    const paid1 = count(paidRound1, (d) => d.granted && d.billing === 'PAID');
    const capDenied = count(paidRound1, (d) => !d.granted && d.reason === 'MONTHLY_CAP_REACHED');
    check(
      'F. Job budget EUR 5 but monthly cap EUR 3: exactly 3 paid, rest MONTHLY_CAP_REACHED',
      paid1 === 3 && capDenied === 37,
      `${paid1} paid, ${capDenied} capped`,
    );

    const raised = quotaSettingsSchema.parse({ ...base, monthlyHardCapEur: 100 });
    const paidRound2 = await race(new QuotaGuard(prisma, raised), { provider: PROVIDER, sku, jobId: job.id }, 5);
    const paid2 = count(paidRound2, (d) => d.granted && d.billing === 'PAID');
    const budgetDenied = count(paidRound2, (d) => !d.granted && d.reason === 'JOB_BUDGET_EXHAUSTED');
    check(
      'G. Cap raised to EUR 100: exactly 2 more paid (job total 5), rest JOB_BUDGET_EXHAUSTED',
      paid2 === 2 && budgetDenied === 38,
      `${paid2} paid, ${budgetDenied} budget-denied`,
    );

    const jobRow = await prisma.job.findUnique({ where: { id: job.id }, select: { paidRequestsUsed: true } });
    const usage = await prisma.apiUsage.findUnique({ where: { provider_sku_period: { provider: PROVIDER, sku, period } } });
    check(
      'H. Counters agree: job paid 5, monthly paid 5, total requests 55',
      jobRow?.paidRequestsUsed === 5 && usage?.paidCount === 5 && usage.requestCount === 55,
      `job ${jobRow?.paidRequestsUsed}, paid ${usage?.paidCount}, total ${usage?.requestCount}`,
    );
  } finally {
    // Remove everything this script created.
    await prisma.apiUsage.deleteMany({ where: { provider: PROVIDER, sku } });
    if (jobIds.length > 0) await prisma.job.deleteMany({ where: { id: { in: jobIds } } });
    await prisma.$disconnect();
  }

  console.log(`\nResult: ${passed}/${total} checks passed. Test rows removed.`);
  if (passed !== total) process.exit(1);
}

main().catch((err: unknown) => {
  if (err instanceof EnvValidationError) console.error(err.message);
  else console.error('Verification could not run:', err instanceof Error ? err.message : err);
  process.exit(1);
});