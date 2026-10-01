import type { PrismaClient } from '../generated/prisma/client';
import { AppError } from '../lib/errors';
import { GOOGLE_PROVIDER, GOOGLE_TEXT_SEARCH_SKU, type QuotaGuard } from '../quota/quota-guard';
import { freeCap, pricePerRequestEur, warnPoint } from '../quota/settings';
import type { CostEstimate } from './cost';
import {
  prepareDiscoveryJob,
  saveDiscoveryJob,
  type JobRequest,
  type PreparedJob,
} from './create-job';
import { MOCK_QUOTA_PROVIDER, type RunMode } from './keys';
import { WORKER_HEARTBEAT_KEY, workerStatusFrom, type WorkerStatus } from './worker-heartbeat';

export const TASK_STATUSES = [
  'PENDING',
  'RUNNING',
  'DONE',
  'DEFERRED',
  'FAILED',
  'SKIPPED',
] as const;

export interface JobPreview {
  scopeLabel: string;
  mode: RunMode;
  areas: number;
  absorbedTowns: number;
  keywordCount: number;
  tasksTotal: number;
  tasksToRun: number;
  skippedByCooldown: number;
  includeRural: boolean;
  minCityPopulation: number;
  cooldownDays: number;
  forceRerun: boolean;
  cost: CostEstimate;
}

export interface JobSummary {
  id: number;
  name: string | null;
  status: string;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  lastError: string | null;
  /** Task count per status. */
  tasks: Record<string, number>;
  resultsReturned: number;
}

export interface JobEventView {
  createdAt: string;
  level: string;
  type: string;
  message: string;
}

/** Progress per stage: Google search, then websites crawled for emails. */
export interface JobStages {
  search: { total: number; done: number; toDo: number; failed: number; skipped: number };
  /** Businesses first seen while this job ran (new leads, not ones found before). */
  places: {
    newPlaces: number;
    withWebsite: number;
    websitesChecked: number;
    waitingForCrawl: number;
    withEmail: number;
  };
}

/** What the job was asked to search (from jobs.options). */
export interface JobOptionsView {
  mode: RunMode | null;
  scopeLabel: string | null;
  categorySlugs: string[];
  languages: string[];
  includeRural: boolean | null;
  forceRerun: boolean;
}

export interface JobDetail extends JobSummary {
  /** Same as stages.places.newPlaces (kept for the CLI). */
  newPlacesSinceStart: number;
  estimate: unknown;
  options: JobOptionsView;
  stages: JobStages;
  extraBudgetEur: number | null;
  paidRequestsUsed: number;
  events: JobEventView[];
}

/** Google allowance this month, the safety switches and whether the worker runs. */
export interface QuotaStatus {
  /** Which counter jobs use: real Google or the local mock. */
  mode: RunMode;
  /** GOOGLE_LIVE_REQUESTS on the API server (the worker checks its own). */
  liveRequestsEnabled: boolean;
  period: string;
  freeLimit: number;
  /** Free requests that may be used (free limit x hard stop). */
  freeCap: number;
  used: number;
  freeRemaining: number;
  /** Request number at which the warning fires. */
  warnAt: number;
  paidCount: number;
  monthlyHardCapEur: number;
  pricePerRequestEur: number;
  worker: WorkerStatus;
}

export type JobAction = 'start' | 'pause' | 'resume' | 'cancel';

/** Everything the API and CLI can do with jobs (an interface so tests can fake it). */
export interface JobService {
  preview(request: JobRequest): Promise<JobPreview>;
  create(
    request: JobRequest,
    createdById?: number,
  ): Promise<{ jobId: number; preview: JobPreview }>;
  list(limit: number): Promise<JobSummary[]>;
  get(id: number): Promise<JobDetail | null>;
  act(id: number, action: JobAction): Promise<JobSummary>;
  /** Approves an extra EUR budget for a quota-paused job and resumes it (spec §8). */
  approveBudget(id: number, extraEur: number): Promise<JobSummary>;
  quotaStatus(): Promise<QuotaStatus>;
}

function toPreview(job: PreparedJob): JobPreview {
  return {
    scopeLabel: job.scopeLabel,
    mode: job.mode,
    areas: job.plan.areas.length,
    absorbedTowns: job.plan.absorbed.length,
    keywordCount: job.keywordCount,
    tasksTotal: job.tasks.length,
    tasksToRun: job.cost.minimum,
    skippedByCooldown: job.skippedByCooldown,
    includeRural: job.includeRural,
    minCityPopulation: job.minCityPopulation,
    cooldownDays: job.cooldownDays,
    forceRerun: job.forceRerun,
    cost: job.cost,
  };
}

const notFound = (id: number): AppError =>
  new AppError(404, 'JOB_NOT_FOUND', `Job ${id} not found`);

const EMPTY_STAGES: JobStages = {
  search: { total: 0, done: 0, toDo: 0, failed: 0, skipped: 0 },
  places: { newPlaces: 0, withWebsite: 0, websitesChecked: 0, waitingForCrawl: 0, withEmail: 0 },
};

function optionsView(options: unknown): JobOptionsView {
  const o = (options ?? {}) as Record<string, unknown>;
  const strings = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  return {
    mode: o.mode === 'LIVE' || o.mode === 'MOCK' ? o.mode : null,
    scopeLabel: typeof o.scopeLabel === 'string' ? o.scopeLabel : null,
    categorySlugs: strings(o.categorySlugs),
    languages: strings(o.languages),
    includeRural: typeof o.includeRural === 'boolean' ? o.includeRural : null,
    forceRerun: o.forceRerun === true,
  };
}

export function createPrismaJobService(
  prisma: PrismaClient,
  deps: { quota: QuotaGuard; mode: RunMode; liveRequestsEnabled?: boolean },
): JobService {
  const provider = deps.mode === 'LIVE' ? GOOGLE_PROVIDER : MOCK_QUOTA_PROVIDER;

  const prepare = async (request: JobRequest): Promise<PreparedJob> =>
    prepareDiscoveryJob(prisma, request, {
      mode: deps.mode,
      freeRemaining: await deps.quota.freeRemaining(provider, GOOGLE_TEXT_SEARCH_SKU),
    });

  /** Task counts and result sums for several jobs in one query. */
  async function taskStats(
    ids: number[],
  ): Promise<Map<number, { tasks: Record<string, number>; results: number }>> {
    const stats = new Map<number, { tasks: Record<string, number>; results: number }>();
    for (const id of ids)
      stats.set(id, { tasks: Object.fromEntries(TASK_STATUSES.map((s) => [s, 0])), results: 0 });
    if (ids.length === 0) return stats;
    const grouped = await prisma.jobTask.groupBy({
      by: ['jobId', 'status'],
      where: { jobId: { in: ids } },
      _count: { _all: true },
      _sum: { resultsCount: true },
    });
    for (const g of grouped) {
      const entry = stats.get(g.jobId);
      if (!entry) continue;
      entry.tasks[g.status] = g._count._all;
      entry.results += g._sum.resultsCount ?? 0;
    }
    return stats;
  }

  type JobRow = {
    id: number;
    name: string | null;
    status: string;
    createdAt: Date;
    startedAt: Date | null;
    finishedAt: Date | null;
    lastError: string | null;
  };
  const toSummary = (
    job: JobRow,
    stats: { tasks: Record<string, number>; results: number } | undefined,
  ): JobSummary => ({
    id: job.id,
    name: job.name,
    status: job.status,
    createdAt: job.createdAt.toISOString(),
    startedAt: job.startedAt?.toISOString() ?? null,
    finishedAt: job.finishedAt?.toISOString() ?? null,
    lastError: job.lastError,
    tasks: stats?.tasks ?? {},
    resultsReturned: stats?.results ?? 0,
  });
  const summarySelect = {
    id: true,
    name: true,
    status: true,
    createdAt: true,
    startedAt: true,
    finishedAt: true,
    lastError: true,
  } as const;

  async function summaryOf(id: number): Promise<JobSummary> {
    const job = await prisma.job.findUnique({ where: { id }, select: summarySelect });
    if (!job) throw notFound(id);
    return toSummary(job, (await taskStats([id])).get(id));
  }

  async function setRunning(id: number, startedAt: Date | null, eventType: string): Promise<void> {
    await prisma.$transaction([
      prisma.job.update({
        where: { id },
        data: {
          status: 'RUNNING',
          startedAt: startedAt ?? new Date(),
          finishedAt: null,
          lastError: null,
        },
      }),
      // Deferred (quota) and failed tasks get another chance.
      prisma.jobTask.updateMany({
        where: { jobId: id, status: { in: ['DEFERRED', 'FAILED'] } },
        data: { status: 'PENDING' },
      }),
      prisma.jobEvent.create({
        data: { jobId: id, type: eventType, message: `Job set to RUNNING (${eventType})` },
      }),
    ]);
  }

  /** New businesses seen while the job ran, and how far their websites got. */
  async function placeStats(
    startedAt: Date | null,
    finishedAt: Date | null,
  ): Promise<JobStages['places']> {
    if (!startedAt) return EMPTY_STAGES.places;
    const rows = await prisma.$queryRaw<
      { new_places: number; with_website: number; checked: number; with_email: number }[]
    >`
      SELECT count(*)::int AS new_places,
             count(*) FILTER (WHERE own)::int AS with_website,
             count(*) FILTER (WHERE own AND crawl_status IN ('DONE', 'FAILED', 'SKIPPED'))::int AS checked,
             count(*) FILTER (WHERE has_email)::int AS with_email
      FROM (
        SELECT p.website_domain IS NOT NULL AND p.website IS NOT NULL
                 AND p.website_domain !~ '(^|\\.)example\\.[a-z.]+$' AS own,
               d.status::text AS crawl_status,
               EXISTS (SELECT 1 FROM emails e WHERE e.place_id = p.id) AS has_email
        FROM places p
        LEFT JOIN domain_crawls d ON d.domain = p.website_domain
        WHERE p.first_seen_at >= ${startedAt}
          AND p.first_seen_at <= ${finishedAt ?? new Date()}
      ) x`;
    const r = rows[0];
    if (!r) return EMPTY_STAGES.places;
    return {
      newPlaces: r.new_places,
      withWebsite: r.with_website,
      websitesChecked: r.checked,
      waitingForCrawl: Math.max(r.with_website - r.checked, 0),
      withEmail: r.with_email,
    };
  }

  return {
    async preview(request) {
      return toPreview(await prepare(request));
    },

    async create(request, createdById) {
      const prepared = await prepare(request);
      const jobId = await saveDiscoveryJob(prisma, prepared, createdById);
      return { jobId, preview: toPreview(prepared) };
    },

    async list(limit) {
      const jobs = await prisma.job.findMany({
        orderBy: { id: 'desc' },
        take: limit,
        select: summarySelect,
      });
      const stats = await taskStats(jobs.map((j) => j.id));
      return jobs.map((j) => toSummary(j, stats.get(j.id)));
    },

    async get(id) {
      const job = await prisma.job.findUnique({
        where: { id },
        select: {
          ...summarySelect,
          estimate: true,
          options: true,
          extraBudgetEur: true,
          paidRequestsUsed: true,
        },
      });
      if (!job) return null;
      const [stats, events, places] = await Promise.all([
        taskStats([id]),
        prisma.jobEvent.findMany({ where: { jobId: id }, orderBy: { id: 'desc' }, take: 30 }),
        placeStats(job.startedAt, job.finishedAt),
      ]);
      const summary = toSummary(job, stats.get(id));
      const t = summary.tasks;
      const n = (status: string): number => t[status] ?? 0;
      const stages: JobStages = {
        search: {
          total: Object.values(t).reduce((a, b) => a + b, 0),
          done: n('DONE'),
          toDo: n('PENDING') + n('RUNNING') + n('DEFERRED'),
          failed: n('FAILED'),
          skipped: n('SKIPPED'),
        },
        places,
      };
      return {
        ...summary,
        newPlacesSinceStart: places.newPlaces,
        estimate: job.estimate,
        options: optionsView(job.options),
        stages,
        extraBudgetEur: job.extraBudgetEur === null ? null : Number(job.extraBudgetEur),
        paidRequestsUsed: job.paidRequestsUsed,
        events: events.reverse().map((e) => ({
          createdAt: e.createdAt.toISOString(),
          level: e.level,
          type: e.type,
          message: e.message,
        })),
      };
    },

    async approveBudget(id, extraEur) {
      const settings = deps.quota.limits();
      const price = pricePerRequestEur(settings);
      if (settings.monthlyHardCapEur <= 0 || price <= 0) {
        throw new AppError(
          409,
          'PAID_REQUESTS_DISABLED',
          'Paid Google requests are turned off (monthly cap is 0 EUR). Resume next month instead.',
        );
      }
      if (extraEur > settings.monthlyHardCapEur) {
        throw new AppError(
          400,
          'BUDGET_TOO_HIGH',
          `The extra budget cannot be more than the monthly cap of ${settings.monthlyHardCapEur} EUR.`,
        );
      }
      const job = await prisma.job.findUnique({
        where: { id },
        select: { status: true, startedAt: true, paidRequestsUsed: true },
      });
      if (!job) throw notFound(id);
      if (job.status !== 'PAUSED_QUOTA') {
        throw new AppError(
          409,
          'INVALID_JOB_STATE',
          `Job ${id} is ${job.status}; a budget can only be added when it is paused by the quota.`,
        );
      }
      // The guard compares paid requests x price with this total, so add to what is spent.
      const spent = job.paidRequestsUsed * price;
      const total = Math.round((spent + extraEur) * 100) / 100;
      await prisma.$transaction([
        prisma.job.update({ where: { id }, data: { extraBudgetEur: total } }),
        prisma.jobEvent.create({
          data: {
            jobId: id,
            level: 'WARN',
            type: 'budget_approved',
            message: `Extra Google budget approved: ${extraEur.toFixed(2)} EUR (total ${total.toFixed(2)} EUR)`,
          },
        }),
      ]);
      await setRunning(id, job.startedAt, 'job_resumed');
      return summaryOf(id);
    },

    async quotaStatus() {
      const settings = deps.quota.limits();
      const provider = deps.mode === 'LIVE' ? GOOGLE_PROVIDER : MOCK_QUOTA_PROVIDER;
      const [usage, freeRemaining, beat] = await Promise.all([
        deps.quota.getUsage(provider, GOOGLE_TEXT_SEARCH_SKU),
        deps.quota.freeRemaining(provider, GOOGLE_TEXT_SEARCH_SKU),
        prisma.setting.findUnique({ where: { key: WORKER_HEARTBEAT_KEY } }),
      ]);
      return {
        mode: deps.mode,
        liveRequestsEnabled: deps.liveRequestsEnabled ?? false,
        period: usage.period,
        freeLimit: settings.freeLimit,
        freeCap: freeCap(settings),
        used: usage.requestCount,
        freeRemaining,
        warnAt: warnPoint(settings),
        paidCount: usage.paidCount,
        monthlyHardCapEur: settings.monthlyHardCapEur,
        pricePerRequestEur: Math.round(pricePerRequestEur(settings) * 10000) / 10000,
        worker: workerStatusFrom(beat?.value),
      };
    },

    async act(id, action) {
      const job = await prisma.job.findUnique({
        where: { id },
        select: { status: true, startedAt: true },
      });
      if (!job) throw notFound(id);
      const need = (allowed: string[]): void => {
        if (!allowed.includes(job.status)) {
          throw new AppError(
            409,
            'INVALID_JOB_STATE',
            `Job ${id} is ${job.status}; "${action}" needs ${allowed.join(' or ')}.`,
          );
        }
      };

      switch (action) {
        case 'start':
          need(['QUEUED']);
          await setRunning(id, job.startedAt, 'job_started');
          break;
        case 'resume':
          need(['PAUSED_USER', 'PAUSED_QUOTA', 'FAILED']);
          await setRunning(id, job.startedAt, 'job_resumed');
          break;
        case 'pause':
          need(['RUNNING']);
          await prisma.$transaction([
            prisma.job.update({ where: { id }, data: { status: 'PAUSED_USER' } }),
            prisma.jobEvent.create({
              data: { jobId: id, type: 'job_paused', message: 'Paused by admin' },
            }),
          ]);
          break;
        case 'cancel':
          need(['QUEUED', 'RUNNING', 'PAUSED_USER', 'PAUSED_QUOTA', 'FAILED']);
          await prisma.$transaction([
            prisma.job.update({
              where: { id },
              data: { status: 'CANCELLED', finishedAt: new Date() },
            }),
            prisma.jobTask.updateMany({
              where: { jobId: id, status: { in: ['PENDING', 'DEFERRED'] } },
              data: { status: 'SKIPPED' },
            }),
            prisma.jobEvent.create({
              data: {
                jobId: id,
                level: 'WARN',
                type: 'job_cancelled',
                message: 'Cancelled by admin',
              },
            }),
          ]);
          break;
      }
      return summaryOf(id);
    },
  };
}
