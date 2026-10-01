/**
 * Background worker. It does three things, so a job started on the website runs to the end
 * without any command line:
 *   1. Google searches: claims discovery tasks of its own mode and runs them in parallel.
 *      Real Google is blocked unless GOOGLE_LIVE_REQUESTS=true (then only crawling runs).
 *   2. Website crawling (WORKER_CRAWL, default on): websites of new businesses are crawled
 *      for emails with the same polite rules as crawl:run.
 *   3. Lead pipeline: after new results, de-duplication and scores are refreshed.
 * It also writes a heartbeat every 30 s, so the website can show whether it is running.
 *
 * Usage: npm run worker   (Ctrl+C finishes current tasks, then stops)
 */
import { Pool } from 'pg';
import { EnvValidationError, loadEnv } from './config/env';
import { DEFAULT_NEAREST_CITY_KM, loadCityResolver, type CityResolver } from './cleaning/city';
import { loadCrawlerSettings } from './crawler/settings';
import { createPrismaClient } from './db/prisma';
import {
  claimNextDomain,
  loadFreeDomainSet,
  processDomain,
  type CrawlContext,
} from './enrich/crawl-queue';
import { MxChecker } from './enrich/mx';
import { runDiscoveryTask, type DiscoveryContext } from './jobs/discovery';
import { MOCK_QUOTA_PROVIDER, runModeFor } from './jobs/keys';
import { claimNextTask, recoverStaleTasks } from './jobs/task-store';
import { HEARTBEAT_SECONDS, writeHeartbeat } from './jobs/worker-heartbeat';
import { runLeadPipeline, withPipelineLock } from './leads/process';
import { loadLeadRules } from './leads/rules';
import { createLogger } from './lib/logger';
import { GOOGLE_PROVIDER, QuotaGuard } from './quota/quota-guard';
import { loadQuotaSettings } from './quota/settings';
import { loadSearchSettings } from './services/settings';

/** A task RUNNING longer than this is considered abandoned by a crashed worker. */
const LEASE_MINUTES = 10;
/** When no website is waiting, look again after this long. */
const CRAWL_IDLE_MS = 30_000;
/** How often to check whether the lead pipeline needs to run. */
const PIPELINE_EVERY_MS = 2 * 60_000;
/** Settings changed on the website reach a running worker within this time. */
const SETTINGS_RELOAD_MS = 60_000;

class StartupError extends Error {}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Sleeps in short steps so Ctrl+C does not wait for a long idle pause. */
async function idle(ms: number, stopped: () => boolean): Promise<void> {
  for (let waited = 0; waited < ms && !stopped(); waited += 1000) await sleep(1000);
}

async function main(): Promise<void> {
  try {
    process.loadEnvFile('.env');
  } catch {
    // No .env file: rely on real environment variables.
  }
  const env = loadEnv();
  const log = createLogger(env, 'worker');

  const mode = runModeFor(env.GOOGLE_PLACES_BASE_URL);
  let searchOffReason: string | null = null;
  if (!env.GOOGLE_PLACES_API_KEY) {
    searchOffReason = 'GOOGLE_PLACES_API_KEY is not set in backend/.env';
  } else if (mode === 'LIVE' && !env.GOOGLE_LIVE_REQUESTS) {
    searchOffReason = 'the worker points at REAL Google, but GOOGLE_LIVE_REQUESTS is not "true"';
  }
  const searching = searchOffReason === null;
  const crawling = env.WORKER_CRAWL;
  if (!searching && !crawling) {
    throw new StartupError(
      `Nothing to do: Google searches are off (${searchOffReason}) and WORKER_CRAWL is "false".\n` +
        'For development use the mock: GOOGLE_PLACES_BASE_URL=http://127.0.0.1:5055',
    );
  }

  const prisma = createPrismaClient(env);
  const crawlerSettings = await loadCrawlerSettings(prisma);
  const crawlConcurrency = crawling ? crawlerSettings.concurrency : 0;
  const pool = new Pool({
    connectionString: env.DATABASE_URL,
    max: env.WORKER_CONCURRENCY + crawlConcurrency + 3,
  });
  const quota = new QuotaGuard(prisma, await loadQuotaSettings(prisma));
  const searchSettings = await loadSearchSettings(prisma);

  // One city lookup per country, loaded on first use and kept for the worker's lifetime.
  const cityCache = new Map<string, Promise<CityResolver>>();
  const cities = (countryCode: string): Promise<CityResolver> => {
    let cached = cityCache.get(countryCode);
    if (!cached) {
      cached = loadCityResolver(pool, countryCode, {
        minCityPopulation: searchSettings.minCityPopulation,
        maxNearestKm: DEFAULT_NEAREST_CITY_KM,
      });
      cached.catch(() => cityCache.delete(countryCode));
      cityCache.set(countryCode, cached);
    }
    return cached;
  };

  const ctx: DiscoveryContext = {
    db: pool,
    quota,
    apiKey: env.GOOGLE_PLACES_API_KEY ?? '',
    baseUrl: env.GOOGLE_PLACES_BASE_URL,
    quotaProvider: mode === 'LIVE' ? GOOGLE_PROVIDER : MOCK_QUOTA_PROVIDER,
    cooldownDays: searchSettings.cooldownDays,
    cities,
    log,
  };

  let stopping = false;
  const stopped = (): boolean => stopping;
  /** Set when new places or emails arrived; the pipeline timer then refreshes the leads. */
  let dirty = false;

  // --- heartbeat -----------------------------------------------------------------------
  const beat = (): void => {
    writeHeartbeat(pool, {
      mode,
      searching,
      crawling,
      concurrency: env.WORKER_CONCURRENCY,
    }).catch((err: unknown) => log.warn({ err }, 'Heartbeat failed'));
  };
  beat();
  const heartbeatTimer = setInterval(beat, HEARTBEAT_SECONDS * 1000);

  // --- 1. Google searches --------------------------------------------------------------
  let recoveryTimer: NodeJS.Timeout | null = null;
  const searchLoop = async (worker: number): Promise<void> => {
    const pollMs = env.WORKER_POLL_SECONDS * 1000;
    while (!stopping) {
      try {
        const task = await claimNextTask(pool, mode);
        if (!task) {
          await sleep(pollMs);
          continue;
        }
        await runDiscoveryTask(ctx, task);
        dirty = true;
      } catch (err) {
        log.error({ err, worker }, 'Search loop error');
        await sleep(pollMs);
      }
    }
  };
  if (searching) {
    const recovered = await recoverStaleTasks(pool, LEASE_MINUTES);
    if (recovered > 0) log.warn({ recovered }, 'Returned abandoned tasks to the queue');
    recoveryTimer = setInterval(() => {
      recoverStaleTasks(pool, LEASE_MINUTES).catch((err: unknown) =>
        log.error({ err }, 'Stale task recovery failed'),
      );
    }, 60_000);
  } else {
    log.warn(`Google searches are OFF: ${searchOffReason}. Jobs wait; only crawling runs.`);
  }

  // --- 2. Website crawling -------------------------------------------------------------
  const crawlCtx: CrawlContext | null = crawling
    ? {
        db: pool,
        settings: crawlerSettings,
        mx: new MxChecker(),
        freeDomains: await loadFreeDomainSet(pool),
      }
    : null;
  const crawlLoop = async (worker: number): Promise<void> => {
    if (!crawlCtx) return;
    while (!stopping) {
      try {
        const claimed = await claimNextDomain(pool);
        if (!claimed) {
          await idle(CRAWL_IDLE_MS, stopped);
          continue;
        }
        const outcome = await processDomain(crawlCtx, claimed);
        log.info(
          {
            domain: claimed.domain,
            outcome: outcome.crawl.outcome,
            newEmails: outcome.saved.inserted,
          },
          'Website crawled',
        );
        if (outcome.saved.inserted > 0) dirty = true;
      } catch (err) {
        log.error({ err, worker }, 'Crawl loop error');
        await idle(CRAWL_IDLE_MS, stopped);
      }
    }
  };

  // --- settings reload: changes on the Settings page apply without a restart ------------
  // (Except the number of parallel searches / crawls, which is fixed at start.)
  const reloadSettings = async (): Promise<void> => {
    quota.setLimits(await loadQuotaSettings(prisma));
    Object.assign(crawlerSettings, await loadCrawlerSettings(prisma));
    const search = await loadSearchSettings(prisma);
    if (search.minCityPopulation !== searchSettings.minCityPopulation) cityCache.clear();
    Object.assign(searchSettings, search);
    ctx.cooldownDays = search.cooldownDays;
  };
  const settingsTimer = setInterval(() => {
    reloadSettings().catch((err: unknown) => log.warn({ err }, 'Settings reload failed'));
  }, SETTINGS_RELOAD_MS);

  // --- 3. Lead pipeline ----------------------------------------------------------------
  let lastPipelineAt = new Date();
  let pipelineRunning: Promise<void> | null = null;
  const runPipeline = async (): Promise<void> => {
    dirty = false;
    const since = lastPipelineAt;
    lastPipelineAt = new Date();
    const { rows } = await pool.query<{ country_code: string }>(
      'SELECT DISTINCT country_code FROM places WHERE updated_at >= $1',
      [since],
    );
    const rules = await loadLeadRules(pool);
    for (const { country_code: country } of rows) {
      const summary = await withPipelineLock(pool, () =>
        runLeadPipeline(pool, country, rules, false),
      );
      log.info({ country, ready: summary.ready }, 'Leads refreshed');
    }
  };
  const pipelineTimer = setInterval(() => {
    if (!dirty || pipelineRunning) return;
    pipelineRunning = runPipeline()
      .catch((err: unknown) => {
        dirty = true;
        log.error({ err }, 'Lead pipeline failed (will retry)');
      })
      .finally(() => {
        pipelineRunning = null;
      });
  }, PIPELINE_EVERY_MS);

  log.info(
    {
      mode,
      searching,
      crawling,
      baseUrl: env.GOOGLE_PLACES_BASE_URL,
      concurrency: env.WORKER_CONCURRENCY,
      crawlConcurrency,
      cooldownDays: ctx.cooldownDays,
    },
    'Worker started (settings changes are picked up within a minute)',
  );

  const loops = [
    ...(searching
      ? Array.from({ length: env.WORKER_CONCURRENCY }, (_, i) => searchLoop(i + 1))
      : []),
    ...Array.from({ length: crawlConcurrency }, (_, i) => crawlLoop(i + 1)),
  ];

  const shutdown = async (signal: string): Promise<void> => {
    if (stopping) return;
    stopping = true;
    log.info({ signal }, 'Stopping: finishing current tasks...');
    clearInterval(heartbeatTimer);
    clearInterval(pipelineTimer);
    clearInterval(settingsTimer);
    if (recoveryTimer) clearInterval(recoveryTimer);
    await Promise.all(loops);
    await pipelineRunning;
    await pool.end();
    await prisma.$disconnect();
    log.info('Worker stopped');
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err: unknown) => {
  if (err instanceof EnvValidationError || err instanceof StartupError) {
    console.error(err.message);
  } else {
    console.error('Worker failed to start:', err);
  }
  process.exit(1);
});
