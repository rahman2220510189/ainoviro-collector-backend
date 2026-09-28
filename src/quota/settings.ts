import { z } from 'zod';
import type { PrismaClient } from '../generated/prisma/client';

function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

/** Quota settings, stored as JSON in settings.key = "quota". Spec §8. */
export const quotaSettingsSchema = z.object({
  /** Free billable requests per SKU per month. */
  freeLimit: z.number().int().min(0).default(1000),
  /** Warn when this fraction of the free limit is reached. */
  warnAt: z.number().min(0).max(1).default(0.8),
  /** Stop free requests at this fraction of the free limit (1.0 = all of it). */
  hardStop: z.number().min(0).max(1).default(1),
  /** USD per 1,000 billed requests (verify against Google's price list). */
  pricePer1000Usd: z.number().min(0).default(35),
  /** Conversion rate; set to the current rate. */
  usdToEurRate: z.number().positive().default(0.9),
  /** Absolute monthly ceiling for PAID requests. 0 = paid requests impossible. */
  monthlyHardCapEur: z.number().min(0).default(0),
  /** Google resets free usage at midnight US Pacific time on the 1st. */
  billingTimeZone: z.string().refine(isValidTimeZone, 'unknown time zone').default('America/Los_Angeles'),
});

export type QuotaSettings = z.infer<typeof quotaSettingsSchema>;

export const QUOTA_SETTINGS_KEY = 'quota';

export async function loadQuotaSettings(prisma: PrismaClient): Promise<QuotaSettings> {
  const row = await prisma.setting.findUnique({ where: { key: QUOTA_SETTINGS_KEY } });
  return quotaSettingsSchema.parse(row?.value ?? {});
}

/** "YYYY-MM" of the given moment in the billing time zone. */
export function billingPeriod(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit' }).formatToParts(date);
  const year = parts.find((p) => p.type === 'year')?.value;
  const month = parts.find((p) => p.type === 'month')?.value;
  if (!year || !month) throw new Error(`Could not compute billing period for ${timeZone}`);
  return `${year}-${month}`;
}

/** Number of free requests that may be granted this month. */
export function freeCap(settings: QuotaSettings): number {
  return Math.floor(settings.freeLimit * settings.hardStop);
}

/** The request number at which the warning fires (0 = never). */
export function warnPoint(settings: QuotaSettings): number {
  return Math.ceil(settings.freeLimit * settings.warnAt);
}

export function pricePerRequestEur(settings: QuotaSettings): number {
  return (settings.pricePer1000Usd / 1000) * settings.usdToEurRate;
}