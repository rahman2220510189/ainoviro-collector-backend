import type { PrismaClient } from '../generated/prisma/client';
import { AppError } from '../lib/errors';
import { planSearchAreas, type SearchPlan } from '../planning/search-areas';
import { createPrismaLocationStore } from '../services/locations';
import { loadPlanningCities } from '../services/search-planning';
import { loadSearchSettings } from '../services/settings';
import { DEFAULT_AVERAGE_PAGES, estimateCost, type CostEstimate } from './cost';
import {
  COOLDOWN_NOTE,
  MOCK_TILE_PREFIX,
  discoveryTaskKey,
  queryLogTileKey,
  type RunMode,
  type TaskTile,
} from './keys';

/** What the admin asks for (CLI or API). Missing values come from settings. */
export interface JobRequest {
  name?: string;
  countryCode: string;
  districtNames: string[];
  /** Empty = all categories. */
  categorySlugs: string[];
  greek: boolean;
  includeRural?: boolean;
  minCityPopulation?: number;
  forceRerun: boolean;
}

type TaskInput = {
  kind: 'DISCOVERY';
  taskKey: string;
  source: 'GOOGLE_PLACES';
  status: 'PENDING' | 'SKIPPED';
  lastError: string | null;
  locationId: number;
  subcategoryId: number;
  keyword: string;
  language: string;
  tile: TaskTile;
  depth: number;
};

/** A fully planned job, not yet saved. Used by preview and by create. */
export interface PreparedJob {
  name: string;
  scopeLabel: string;
  mode: RunMode;
  countryCode: string;
  districtNames: string[];
  categorySlugs: string[];
  languages: string[];
  includeRural: boolean;
  minCityPopulation: number;
  cooldownDays: number;
  forceRerun: boolean;
  plan: SearchPlan;
  keywordCount: number;
  cityIds: number[];
  subcategoryIds: number[];
  tasks: TaskInput[];
  skippedByCooldown: number;
  cost: CostEstimate;
}

const invalid = (message: string): AppError => new AppError(400, 'INVALID_JOB_REQUEST', message);

/**
 * Plans a discovery job without saving it: scope, areas, keywords, tasks,
 * cooldown skips and the cost estimate against the free requests left.
 */
export async function prepareDiscoveryJob(
  prisma: PrismaClient,
  request: JobRequest,
  ctx: { mode: RunMode; freeRemaining: number },
): Promise<PreparedJob> {
  const countryCode = request.countryCode.toUpperCase();
  const settings = await loadSearchSettings(prisma);
  const includeRural = request.includeRural ?? settings.includeRural;
  const minCityPopulation = request.minCityPopulation ?? settings.minCityPopulation;
  const languages = request.greek ? ['en', 'el'] : ['en'];

  const country = await prisma.location.findFirst({
    where: { type: 'COUNTRY', countryCode, active: true },
    select: { id: true, name: true },
  });
  if (!country) throw invalid(`Country ${countryCode} is not imported. Run import:geonames first.`);

  // Scope: whole country or chosen districts.
  let scopeIds = [country.id];
  let scopeLabel = `${country.name} (all districts)`;
  if (request.districtNames.length > 0) {
    const regions = await prisma.location.findMany({
      where: { parentId: country.id, type: 'REGION', active: true },
      select: { id: true, name: true, nameLocal: true },
    });
    scopeIds = request.districtNames.map((name) => {
      const wanted = name.toLowerCase();
      const match = regions.find((r) => r.name.toLowerCase() === wanted || r.nameLocal?.toLowerCase() === wanted);
      if (!match) throw invalid(`Unknown district "${name}". Districts: ${regions.map((r) => r.name).join(', ')}`);
      return match.id;
    });
    scopeLabel = `${country.name} (${request.districtNames.join(', ')})`;
  }

  if (request.categorySlugs.length > 0) {
    const active = await prisma.category.findMany({ where: { active: true }, select: { slug: true } });
    const known = new Set(active.map((c) => c.slug));
    for (const slug of request.categorySlugs) {
      if (!known.has(slug)) throw invalid(`Unknown category "${slug}".`);
    }
  }

  const keywords = await prisma.subcategoryKeyword.findMany({
    where: {
      active: true,
      language: { in: languages },
      subcategory: {
        active: true,
        category: {
          active: true,
          ...(request.categorySlugs.length > 0 ? { slug: { in: request.categorySlugs } } : {}),
        },
      },
    },
    orderBy: [{ subcategoryId: 'asc' }, { id: 'asc' }],
    select: { subcategoryId: true, keyword: true, language: true },
  });
  if (keywords.length === 0) throw invalid('No active keywords for this selection.');

  const cityIds = await createPrismaLocationStore(prisma).resolveCityIds(scopeIds);
  const { cities } = await loadPlanningCities(prisma, cityIds);
  const plan = planSearchAreas(cities, { minCityPopulation, includeRural });
  if (plan.areas.length === 0) throw invalid('The plan has no search areas (try including rural areas).');

  // Cooldown: root searches of this mode that ran recently are skipped.
  const rootKey = (areaKey: string): string => queryLogTileKey(ctx.mode, areaKey, '');
  const useCooldown = !request.forceRerun && settings.cooldownDays > 0;
  const recent = useCooldown
    ? await prisma.queryLog.findMany({
        where: {
          source: 'GOOGLE_PLACES',
          lastRunAt: { gt: new Date(Date.now() - settings.cooldownDays * 86_400_000) },
          tileKey: { in: plan.areas.map((a) => rootKey(a.key)) },
        },
        select: { tileKey: true, keyword: true, language: true },
      })
    : [];
  const recentSet = new Set(recent.map((r) => `${r.tileKey}|${r.keyword}|${r.language}`));

  const tasks: TaskInput[] = plan.areas.flatMap((area) =>
    keywords.map((k): TaskInput => {
      const coolingDown = recentSet.has(`${rootKey(area.key)}|${k.keyword}|${k.language}`);
      const tile: TaskTile = {
        ...area.bbox,
        areaKey: area.key,
        areaKind: area.kind,
        path: '',
        countryCode,
        cityId: area.kind === 'CITY' ? area.locationId : null,
        mode: ctx.mode,
        forceRerun: request.forceRerun,
      };
      return {
        kind: 'DISCOVERY',
        taskKey: discoveryTaskKey({
          areaKey: area.key,
          path: '',
          subcategoryId: k.subcategoryId,
          keyword: k.keyword,
          language: k.language,
        }),
        source: 'GOOGLE_PLACES',
        status: coolingDown ? 'SKIPPED' : 'PENDING',
        lastError: coolingDown ? COOLDOWN_NOTE : null,
        locationId: area.locationId,
        subcategoryId: k.subcategoryId,
        keyword: k.keyword,
        language: k.language,
        tile,
        depth: 0,
      };
    }),
  );

  // Average pages per search seen before (same mode), for a realistic estimate.
  const history = await prisma.queryLog.aggregate({
    where: {
      source: 'GOOGLE_PLACES',
      keyword: { in: [...new Set(keywords.map((k) => k.keyword))] },
      tileKey: ctx.mode === 'MOCK' ? { startsWith: MOCK_TILE_PREFIX } : { not: { startsWith: MOCK_TILE_PREFIX } },
    },
    _avg: { pages: true },
    _count: { _all: true },
  });
  const averagePages =
    history._count._all > 0 && history._avg.pages !== null ? history._avg.pages : DEFAULT_AVERAGE_PAGES;
  const tasksToRun = tasks.filter((t) => t.status === 'PENDING').length;

  return {
    name: request.name ?? scopeLabel,
    scopeLabel,
    mode: ctx.mode,
    countryCode,
    districtNames: request.districtNames,
    categorySlugs: request.categorySlugs,
    languages,
    includeRural,
    minCityPopulation,
    cooldownDays: settings.cooldownDays,
    forceRerun: request.forceRerun,
    plan,
    keywordCount: keywords.length,
    cityIds: cities.map((c) => c.id),
    subcategoryIds: [...new Set(keywords.map((k) => k.subcategoryId))],
    tasks,
    skippedByCooldown: tasks.length - tasksToRun,
    cost: estimateCost({ tasksToRun, averagePages, freeRemaining: ctx.freeRemaining }),
  };
}

/** Saves a prepared job as QUEUED. Nothing runs until it is started. */
export async function saveDiscoveryJob(prisma: PrismaClient, job: PreparedJob, createdById?: number): Promise<number> {
  if (job.cost.minimum === 0) {
    throw invalid(
      `Every search in this job ran within the last ${job.cooldownDays} days (cooldown). ` +
        'Use force re-run to search again.',
    );
  }

  return prisma.$transaction(
    async (tx) => {
      const created = await tx.job.create({
        data: {
          name: job.name,
          status: 'QUEUED',
          sourcePlan: ['GOOGLE_PLACES'],
          createdById,
          options: {
            mode: job.mode,
            countryCode: job.countryCode,
            districtNames: job.districtNames,
            categorySlugs: job.categorySlugs,
            languages: job.languages,
            includeRural: job.includeRural,
            minCityPopulation: job.minCityPopulation,
            forceRerun: job.forceRerun,
          },
          estimate: {
            areas: job.plan.areas.length,
            keywords: job.keywordCount,
            tasksToRun: job.cost.minimum,
            skippedByCooldown: job.skippedByCooldown,
            minimum: job.cost.minimum,
            estimated: job.cost.estimated,
            maximumWithoutSplits: job.cost.maximumWithoutSplits,
            freeRemainingAtCreation: job.cost.freeRemaining,
            verdict: job.cost.verdict,
          },
        },
        select: { id: true },
      });
      await tx.jobLocation.createMany({ data: job.cityIds.map((id) => ({ jobId: created.id, locationId: id })) });
      await tx.jobSubcategory.createMany({
        data: job.subcategoryIds.map((id) => ({ jobId: created.id, subcategoryId: id })),
      });
      for (let start = 0; start < job.tasks.length; start += 1000) {
        await tx.jobTask.createMany({
          data: job.tasks.slice(start, start + 1000).map((t) => ({ ...t, jobId: created.id })),
        });
      }
      await tx.jobEvent.create({
        data: {
          jobId: created.id,
          type: 'job_created',
          message: `Created (${job.mode}) with ${job.tasks.length} tasks, ${job.skippedByCooldown} skipped by cooldown`,
        },
      });
      return created.id;
    },
    { timeout: 120_000, maxWait: 10_000 },
  );
}