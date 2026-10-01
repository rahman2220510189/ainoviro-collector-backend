import type { PrismaClient } from '../generated/prisma/client';
import {
  billingPeriod,
  freeCap,
  pricePerRequestEur,
  warnPoint,
  type QuotaSettings,
} from './settings';

/** Internal names for what we count. The Google SKU mapping is confirmed in step 1.4. */
export const GOOGLE_PROVIDER = 'google_places';
export const GOOGLE_TEXT_SEARCH_SKU = 'text_search';

export type DenyReason =
  /** Free allowance used up and no extra budget for this request. */
  | 'FREE_LIMIT_REACHED'
  /** The job's approved extra budget is spent. */
  | 'JOB_BUDGET_EXHAUSTED'
  /** The absolute monthly EUR ceiling for paid requests is reached (or is 0). */
  | 'MONTHLY_CAP_REACHED';

export type QuotaDecision =
  | { granted: true; billing: 'FREE'; period: string; requestCount: number; warn: boolean }
  | {
      granted: true;
      billing: 'PAID';
      period: string;
      requestCount: number;
      paidCount: number;
      costEur: number;
    }
  | { granted: false; period: string; reason: DenyReason };

export interface ReserveInput {
  provider: string;
  sku: string;
  /** Only requests belonging to a job may use that job's extra budget. */
  jobId?: number;
}

/** Thrown inside the paid transaction to roll it back with a reason. */
class Deny extends Error {
  constructor(public readonly reason: DenyReason) {
    super(reason);
  }
}

/**
 * Every billable request must call reserve() FIRST and only proceed if granted.
 *
 * Free path: one atomic INSERT ... ON CONFLICT DO UPDATE ... WHERE count < cap,
 * so any number of parallel workers can never exceed the cap.
 * Paid path: one transaction that increments the job's paid counter and the
 * monthly paid counter, each only if its budget allows; otherwise it rolls back.
 * Lock order is always job row -> usage row, so paid requests cannot deadlock.
 * A granted request is counted even if the HTTP call later fails (conservative).
 */
export class QuotaGuard {
  constructor(
    private readonly prisma: PrismaClient,
    private settings: QuotaSettings,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** The settings this guard enforces (read at start). */
  limits(): QuotaSettings {
    return this.settings;
  }

  /** Replaces the settings (after a change on the Settings page); the next reserve() uses them. */
  setLimits(settings: QuotaSettings): void {
    this.settings = settings;
  }

  currentPeriod(): string {
    return billingPeriod(this.now(), this.settings.billingTimeZone);
  }

  async reserve({ provider, sku, jobId }: ReserveInput): Promise<QuotaDecision> {
    const period = this.currentPeriod();
    const cap = freeCap(this.settings);

    if (cap > 0) {
      const rows = await this.prisma.$queryRaw<{ request_count: number }[]>`
        INSERT INTO api_usage AS u (provider, sku, period, request_count, paid_count, updated_at)
        VALUES (${provider}, ${sku}, ${period}, 1, 0, now())
        ON CONFLICT (provider, sku, period) DO UPDATE
          SET request_count = u.request_count + 1, updated_at = now()
          WHERE u.request_count < ${cap}
        RETURNING request_count`;
      const row = rows[0];
      if (row) {
        const requestCount = Number(row.request_count);
        return {
          granted: true,
          billing: 'FREE',
          period,
          requestCount,
          warn: requestCount === warnPoint(this.settings),
        };
      }
    }

    if (jobId === undefined) return { granted: false, period, reason: 'FREE_LIMIT_REACHED' };
    return this.reservePaid(provider, sku, period, jobId);
  }

  private async reservePaid(
    provider: string,
    sku: string,
    period: string,
    jobId: number,
  ): Promise<QuotaDecision> {
    const price = pricePerRequestEur(this.settings);
    const monthlyCap = this.settings.monthlyHardCapEur;

    try {
      return await this.prisma.$transaction(
        async (tx): Promise<QuotaDecision> => {
          // 1. The job must have an approved budget left for one more request.
          const job = await tx.$queryRaw<{ paid: number }[]>`
            UPDATE jobs SET paid_requests_used = paid_requests_used + 1, updated_at = now()
            WHERE id = ${jobId}
              AND extra_budget_eur IS NOT NULL
              AND (paid_requests_used + 1) * ${price}::numeric <= extra_budget_eur
            RETURNING paid_requests_used AS paid`;
          if (!job[0]) {
            const info = await tx.job.findUnique({
              where: { id: jobId },
              select: { extraBudgetEur: true },
            });
            const hasBudget = Number(info?.extraBudgetEur ?? 0) > 0;
            throw new Deny(hasBudget ? 'JOB_BUDGET_EXHAUSTED' : 'FREE_LIMIT_REACHED');
          }

          // 2. The absolute monthly ceiling must allow it. A price of 0 is never
          //    treated as "unlimited paid requests".
          if (monthlyCap <= 0 || price <= 0) throw new Deny('MONTHLY_CAP_REACHED');

          await tx.$executeRaw`
            INSERT INTO api_usage (provider, sku, period, request_count, paid_count, updated_at)
            VALUES (${provider}, ${sku}, ${period}, 0, 0, now())
            ON CONFLICT (provider, sku, period) DO NOTHING`;
          const usage = await tx.$queryRaw<{ request_count: number; paid_count: number }[]>`
            UPDATE api_usage
            SET request_count = request_count + 1, paid_count = paid_count + 1, updated_at = now()
            WHERE provider = ${provider} AND sku = ${sku} AND period = ${period}
              AND (paid_count + 1) * ${price}::numeric <= ${monthlyCap}::numeric
            RETURNING request_count, paid_count`;
          const row = usage[0];
          if (!row) throw new Deny('MONTHLY_CAP_REACHED');

          return {
            granted: true,
            billing: 'PAID',
            period,
            requestCount: Number(row.request_count),
            paidCount: Number(row.paid_count),
            costEur: price,
          };
        },
        { timeout: 15_000, maxWait: 10_000 },
      );
    } catch (err) {
      if (err instanceof Deny) return { granted: false, period, reason: err.reason };
      throw err;
    }
  }

  /** Current month's usage for one provider/SKU. */
  async getUsage(
    provider: string,
    sku: string,
  ): Promise<{ period: string; requestCount: number; paidCount: number }> {
    const period = this.currentPeriod();
    const row = await this.prisma.apiUsage.findUnique({
      where: { provider_sku_period: { provider, sku, period } },
      select: { requestCount: true, paidCount: true },
    });
    return { period, requestCount: row?.requestCount ?? 0, paidCount: row?.paidCount ?? 0 };
  }

  /** Free requests still available this month for one provider/SKU. */
  async freeRemaining(provider: string, sku: string): Promise<number> {
    const usage = await this.getUsage(provider, sku);
    const cap = freeCap(this.settings);
    const freeUsed = Math.min(usage.requestCount - usage.paidCount, cap);
    return Math.max(cap - freeUsed, 0);
  }
}
