import type { PrismaClient } from '../generated/prisma/client';
import { AppError } from '../lib/errors';
import { GOOGLE_PROVIDER, GOOGLE_TEXT_SEARCH_SKU, type QuotaGuard } from '../quota/quota-guard';
import type { CostEstimate } from './cost';
import { prepareDiscoveryJob, saveDiscoveryJob, type JobRequest, type PreparedJob } from './create-job';
import { MOCK_QUOTA_PROVIDER, type RunMode } from './keys';

export const TASK_STATUSES = ['PENDING', 'RUNNING', 'DONE', 'DEFERRED', 'FAILED', 'SKIPPED'] as const;

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

export interface JobDetail extends JobSummary {
  newPlacesSinceStart: number;
  estimate: unknown;
  events: JobEventView[];
}

export type JobAction = 'start' | 'pause' | 'resume' | 'cancel';

/** Everything the API and CLI can do with jobs (an interface so tests can fake it). */
export interface JobService {
  preview(request: JobRequest): Promise<JobPreview>;
  create(request: JobRequest, createdById?: number): Promise<{ jobId: number; preview: JobPreview }>;
  list(limit: number): Promise<JobSummary[]>;
  get(id: number): Promise<JobDetail | null>;
  act(id: number, action: JobAction): Promise<JobSummary>;
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

const notFound = (id: number): AppError => new AppError(404, 'JOB_NOT_FOUND', `Job ${id} not found`);

export function createPrismaJobService(prisma: PrismaClient, deps: { quota: QuotaGuard; mode: RunMode }): JobService {
  const provider = deps.mode === 'LIVE' ? GOOGLE_PROVIDER : MOCK_QUOTA_PROVIDER;

  const prepare = async (request: JobRequest): Promise<PreparedJob> =>
    prepareDiscoveryJob(prisma, request, {
      mode: deps.mode,
      freeRemaining: await deps.quota.freeRemaining(provider, GOOGLE_TEXT_SEARCH_SKU),
    });

  /** Task counts and result sums for several jobs in one query. */
  async function taskStats(ids: number[]): Promise<Map<number, { tasks: Record<string, number>; results: number }>> {
    const stats = new Map<number, { tasks: Record<string, number>; results: number }>();
    for (const id of ids) stats.set(id, { tasks: Object.fromEntries(TASK_STATUSES.map((s) => [s, 0])), results: 0 });
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
  const toSummary = (job: JobRow, stats: { tasks: Record<string, number>; results: number } | undefined): JobSummary => ({
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
    id: true, name: true, status: true, createdAt: true, startedAt: true, finishedAt: true, lastError: true,
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
        data: { status: 'RUNNING', startedAt: startedAt ?? new Date(), finishedAt: null, lastError: null },
      }),
      // Deferred (quota) and failed tasks get another chance.
      prisma.jobTask.updateMany({ where: { jobId: id, status: { in: ['DEFERRED', 'FAILED'] } }, data: { status: 'PENDING' } }),
      prisma.jobEvent.create({ data: { jobId: id, type: eventType, message: `Job set to RUNNING (${eventType})` } }),
    ]);
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
      const jobs = await prisma.job.findMany({ orderBy: { id: 'desc' }, take: limit, select: summarySelect });
      const stats = await taskStats(jobs.map((j) => j.id));
      return jobs.map((j) => toSummary(j, stats.get(j.id)));
    },

    async get(id) {
      const job = await prisma.job.findUnique({ where: { id }, select: { ...summarySelect, estimate: true } });
      if (!job) return null;
      const [stats, events, newPlaces] = await Promise.all([
        taskStats([id]),
        prisma.jobEvent.findMany({ where: { jobId: id }, orderBy: { id: 'desc' }, take: 20 }),
        job.startedAt ? prisma.place.count({ where: { firstSeenAt: { gte: job.startedAt } } }) : Promise.resolve(0),
      ]);
      return {
        ...toSummary(job, stats.get(id)),
        newPlacesSinceStart: newPlaces,
        estimate: job.estimate,
        events: events.reverse().map((e) => ({
          createdAt: e.createdAt.toISOString(),
          level: e.level,
          type: e.type,
          message: e.message,
        })),
      };
    },

    async act(id, action) {
      const job = await prisma.job.findUnique({ where: { id }, select: { status: true, startedAt: true } });
      if (!job) throw notFound(id);
      const need = (allowed: string[]): void => {
        if (!allowed.includes(job.status)) {
          throw new AppError(409, 'INVALID_JOB_STATE', `Job ${id} is ${job.status}; "${action}" needs ${allowed.join(' or ')}.`);
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
            prisma.jobEvent.create({ data: { jobId: id, type: 'job_paused', message: 'Paused by admin' } }),
          ]);
          break;
        case 'cancel':
          need(['QUEUED', 'RUNNING', 'PAUSED_USER', 'PAUSED_QUOTA', 'FAILED']);
          await prisma.$transaction([
            prisma.job.update({ where: { id }, data: { status: 'CANCELLED', finishedAt: new Date() } }),
            prisma.jobTask.updateMany({
              where: { jobId: id, status: { in: ['PENDING', 'DEFERRED'] } },
              data: { status: 'SKIPPED' },
            }),
            prisma.jobEvent.create({ data: { jobId: id, level: 'WARN', type: 'job_cancelled', message: 'Cancelled by admin' } }),
          ]);
          break;
      }
      return summaryOf(id);
    },
  };
}