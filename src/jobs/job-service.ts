import type { PrismaClient } from '../generated/prisma/client';
import { AppError } from '../lib/errors';
import { GOOGLE_PROVIDER, GOOGLE_TEXT_SEARCH_SKU, type QuotaGuard } from '../quota/quota-guard';
import { freeCap, pricePerRequestEur, warnPoint } from '../quota/settings';
import type { CostEstimate } from './cost';
import {
  prepareDiscoveryJob,
  saveDiscoveryJob,
  type JobRequest,
  type JobSource,
  type PreparedJob,
} from './create-job';
import { MOCK_QUOTA_PROVIDER, type RunMode, type TaskTile } from './keys';
import { countOvertureInBoxes } from './overture-counts';
import { COMPLETE_JOB_SQL } from './task-store';
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
  sources: JobSource[];
  overtureAvailable: boolean;
  overtureTasks: number;
  overtureKnown: { businesses: number; withEmail: number };
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

type StageCounts = { total: number; done: number; toDo: number; failed: number; skipped: number };

/** Progress per stage: Google search, free data, then websites crawled for emails. */
export interface JobStages {
  /** Google searches only. */
  search: StageCounts;
  /** Free data (Overture), one task per area; null when the job does not use it. */
  free: (StageCounts & { businesses: number; withEmail: number }) | null;
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
  sources: JobSource[];
  /** Google searches waiting for the quota after "Continue with free sources". */
  googleDeferred: number;
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

export type JobAction = 'start' | 'pause' | 'resume' | 'cancel' | 'continue-free';

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
    sources: job.sources,
    overtureAvailable: job.overtureAvailable,
    overtureTasks: job.overtureTasks,
    overtureKnown: job.overtureKnown,
  };
}

const notFound = (id: number): AppError =>
  new AppError(404, 'JOB_NOT_FOUND', `Job ${id} not found`);

const EMPTY_STAGES: JobStages = {
  search: { total: 0, done: 0, toDo: 0, failed: 0, skipped: 0 },
  free: null,
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
      by: ['jobId', 'status', 'source'],
      where: { jobId: { in: ids } },
      _count: { _all: true },
      _sum: { resultsCount: true },
    });
    for (const g of grouped) {
      const entry = stats.get(g.jobId);
      if (!entry) continue;
      entry.tasks[g.status] = (entry.tasks[g.status] ?? 0) + g._count._all;
      // "Results returned" means Google results; free data is counted per business.
      if (g.source === 'GOOGLE_PLACES') entry.results += g._sum.resultsCount ?? 0;
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
      // Deferred (quota) and failed tasks get another chance; Google runs again.
      prisma.jobTask.updateMany({
        where: { jobId: id, status: { in: ['DEFERRED', 'FAILED'] } },
        data: { status: 'PENDING' },
      }),
      prisma.$executeRaw`UPDATE jobs SET options = options - 'googleDeferred' WHERE id = ${id}`,
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

  /** Distinct Overture businesses over all free-data areas of the job (areas can overlap). */
  async function freeTotals(
    jobId: number,
    options: unknown,
  ): Promise<{ businesses: number; withEmail: number }> {
    const [tasks, subs] = await Promise.all([
      prisma.jobTask.findMany({
        where: { jobId, source: 'OVERTURE', status: 'DONE' },
        select: { tile: true },
      }),
      prisma.jobSubcategory.findMany({ where: { jobId }, select: { subcategoryId: true } }),
    ]);
    if (tasks.length === 0) return { businesses: 0, withEmail: 0 };
    const view = optionsView(options);
    return countOvertureInBoxes(prisma, {
      boxes: tasks.map((t) => t.tile as TaskTile),
      subcategoryIds: subs.map((s) => s.subcategoryId),
      allCategories: view.categorySlugs.length === 0,
    });
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
          sourcePlan: true,
          extraBudgetEur: true,
          paidRequestsUsed: true,
        },
      });
      if (!job) return null;
      const [stats, events, places, bySource, free] = await Promise.all([
        taskStats([id]),
        prisma.jobEvent.findMany({ where: { jobId: id }, orderBy: { id: 'desc' }, take: 30 }),
        placeStats(job.startedAt, job.finishedAt),
        prisma.jobTask.groupBy({
          by: ['source', 'status'],
          where: { jobId: id },
          _count: { _all: true },
        }),
        freeTotals(id, job.options),
      ]);
      const summary = toSummary(job, stats.get(id));
      const counts = (source: JobSource): StageCounts => {
        const n = (status: string): number =>
          bySource.find((g) => g.source === source && g.status === status)?._count._all ?? 0;
        return {
          total: bySource.filter((g) => g.source === source).reduce((a, g) => a + g._count._all, 0),
          done: n('DONE'),
          toDo: n('PENDING') + n('RUNNING') + n('DEFERRED'),
          failed: n('FAILED'),
          skipped: n('SKIPPED'),
        };
      };
      const overture = counts('OVERTURE');
      const stages: JobStages = {
        search: counts('GOOGLE_PLACES'),
        free: overture.total > 0 ? { ...overture, ...free } : null,
        places,
      };
      const googleDeferred = bySource
        .filter((g) => g.source === 'GOOGLE_PLACES' && g.status === 'DEFERRED')
        .reduce((a, g) => a + g._count._all, 0);
      return {
        ...summary,
        sources: job.sourcePlan as JobSource[],
        googleDeferred:
          (job.options as Record<string, unknown> | null)?.googleDeferred === true
            ? googleDeferred
            : 0,
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
      // A finished job whose Google searches were put aside can run them later.
      const deferredGoogle =
        job.status === 'COMPLETED'
          ? await prisma.jobTask.count({
              where: { jobId: id, source: 'GOOGLE_PLACES', status: 'DEFERRED' },
            })
          : 0;
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
          need([
            'PAUSED_USER',
            'PAUSED_QUOTA',
            'FAILED',
            ...(deferredGoogle > 0 ? ['COMPLETED'] : []),
          ]);
          await setRunning(id, job.startedAt, 'job_resumed');
          break;
        case 'continue-free':
          // Spec §8 quota modal, option (a): go on with the free sources only. Google
          // searches wait (DEFERRED) and can be run later with Resume.
          need(['RUNNING', 'PAUSED_USER', 'PAUSED_QUOTA', 'FAILED']);
          await prisma.$transaction([
            prisma.jobTask.updateMany({
              where: {
                jobId: id,
                source: 'GOOGLE_PLACES',
                status: { in: ['PENDING', 'DEFERRED', 'FAILED'] },
              },
              data: { status: 'DEFERRED' },
            }),
            prisma.jobTask.updateMany({
              where: {
                jobId: id,
                source: { not: 'GOOGLE_PLACES' },
                status: { in: ['DEFERRED', 'FAILED'] },
              },
              data: { status: 'PENDING' },
            }),
            prisma.$executeRaw`UPDATE jobs
              SET status = 'RUNNING', started_at = coalesce(started_at, now()), finished_at = NULL,
                  last_error = NULL, updated_at = now(),
                  options = options || '{"googleDeferred": true}'::jsonb
              WHERE id = ${id}`,
            prisma.jobEvent.create({
              data: {
                jobId: id,
                type: 'job_continue_free',
                message: 'Continuing with free sources only; Google searches wait for later',
              },
            }),
          ]);
          // Nothing free left to do: the job is finished now.
          if ((await prisma.$executeRawUnsafe(COMPLETE_JOB_SQL, id)) > 0) {
            await prisma.jobEvent.create({
              data: { jobId: id, type: 'job_completed', message: 'All tasks finished' },
            });
          }
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
