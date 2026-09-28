/**
 * Shows this month's Google usage against the quota settings.
 *
 * Usage: npm run quota:status
 */
import { EnvValidationError, loadEnv } from '../config/env';
import { createPrismaClient } from '../db/prisma';
import { GOOGLE_PROVIDER, GOOGLE_TEXT_SEARCH_SKU, QuotaGuard } from '../quota/quota-guard';
import { freeCap, loadQuotaSettings, pricePerRequestEur, warnPoint } from '../quota/settings';

const fmt = (n: number): string => n.toLocaleString('en');

async function main(): Promise<void> {
  try {
    process.loadEnvFile('.env');
  } catch {
    // No .env file: rely on real environment variables.
  }
  const env = loadEnv();
  const prisma = createPrismaClient(env);
  try {
    const settings = await loadQuotaSettings(prisma);
    const usage = await new QuotaGuard(prisma, settings).getUsage(GOOGLE_PROVIDER, GOOGLE_TEXT_SEARCH_SKU);
    const cap = freeCap(settings);
    const freeUsed = Math.min(usage.requestCount - usage.paidCount, cap);
    const percent = cap > 0 ? Math.round((freeUsed / cap) * 100) : 0;
    const price = pricePerRequestEur(settings);

    console.log(`Google ${GOOGLE_TEXT_SEARCH_SKU}, billing month ${usage.period} (${settings.billingTimeZone})`);
    console.log(`  Free:  ${fmt(freeUsed)} of ${fmt(cap)} used (${percent}%), warning at ${fmt(warnPoint(settings))}`);
    console.log(`  Left:  ${fmt(Math.max(cap - freeUsed, 0))} free requests this month`);
    console.log(
      `  Paid:  ${fmt(usage.paidCount)} requests (~EUR ${(usage.paidCount * price).toFixed(2)}), ` +
        `monthly cap EUR ${settings.monthlyHardCapEur.toFixed(2)}` +
        (settings.monthlyHardCapEur <= 0 ? ' -> paid requests are disabled' : ''),
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err: unknown) => {
  if (err instanceof EnvValidationError) console.error(err.message);
  else console.error('Failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});