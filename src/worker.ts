/**
 * Background worker: claims discovery tasks of its own mode and runs them in parallel.
 * Real Google is blocked unless GOOGLE_LIVE_REQUESTS=true.
 *
 * Usage: npm run worker   (Ctrl+C finishes current tasks, then stops)
 */
import { Pool } from 'pg';
import { EnvValidationError, loadEnv } from './config/env';
import { DEFAULT_NEAREST_CITY_KM, loadCityResolver, type CityResolver } from './cleaning/city';
import { createPrismaClient } from './db/prisma';
import { runDiscoveryTask, type DiscoveryContext } from './jobs/discovery';
import { MOCK_QUOTA_PROVIDER, runModeFor } from './jobs/keys';
import { claimNextTask, recoverStaleTasks } from './jobs/task-store';
import { createLogger } from './lib/logger';
import { GOOGLE_PROVIDER, QuotaGuard } from './quota/quota-guard';
import { loadQuotaSettings } from './quota/settings';
import { loadSearchSettings } from './services/settings';

/** A task RUNNING longer than this is considered abandoned by a crashed worker. */
const LEASE_MINUTES = 10;

class StartupError extends Error {}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function main(): Promise<void> {
  try {
    process.loadEnvFile('.env');
  } catch {
    // No .env file: rely on real environment variables.
  }
  const env = loadEnv();
  const log = createLogger(env, 'worker');

  if (!env.GOOGLE_PLACES_API_KEY) {
    throw new StartupError('GOOGLE_PLACES_API_KEY is not set in backend/.env.');
  }
  const mode = runModeFor(env.GOOGLE_PLACES_BASE_URL);
  if (mode === 'LIVE' && !env.GOOGLE_LIVE_REQUESTS) {
    throw new StartupError(
      'The worker points at REAL Google, but GOOGLE_LIVE_REQUESTS is not "true".\n' +
        'Real requests stay blocked until you explicitly enable them.\n' +
        'For development use the mock: GOOGLE_PLACES_BASE_URL=http://127.0.0.1:5055',
    );
  }

  const prisma = createPrismaClient(env);
  const pool = new Pool({ connectionString: env.DATABASE_URL, max: env.WORKER_CONCURRENCY + 2 });
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
    apiKey: env.GOOGLE_PLACES_API_KEY,
    baseUrl: env.GOOGLE_PLACES_BASE_URL,
    quotaProvider: mode === 'LIVE' ? GOOGLE_PROVIDER : MOCK_QUOTA_PROVIDER,
    cooldownDays: searchSettings.cooldownDays,
    cities,
    log,
  };

  const recovered = await recoverStaleTasks(pool, LEASE_MINUTES);
  if (recovered > 0) log.warn({ recovered }, 'Returned abandoned tasks to the queue');
  const recoveryTimer = setInterval(() => {
    recoverStaleTasks(pool, LEASE_MINUTES).catch((err: unknown) => log.error({ err }, 'Stale task recovery failed'));
  }, 60_000);

  log.info(
    { mode, baseUrl: env.GOOGLE_PLACES_BASE_URL, concurrency: env.WORKER_CONCURRENCY, cooldownDays: ctx.cooldownDays },
    'Worker started (settings are read at start; restart after changing them)',
  );

  let stopping = false;
  const pollMs = env.WORKER_POLL_SECONDS * 1000;
  const loop = async (worker: number): Promise<void> => {
    while (!stopping) {
      try {
        const task = await claimNextTask(pool, mode);
        if (!task) {
          await sleep(pollMs);
          continue;
        }
        await runDiscoveryTask(ctx, task);
      } catch (err) {
        log.error({ err, worker }, 'Worker loop error');
        await sleep(pollMs);
      }
    }
  };
  const loops = Array.from({ length: env.WORKER_CONCURRENCY }, (_, i) => loop(i + 1));

  const shutdown = async (signal: string): Promise<void> => {
    if (stopping) return;
    stopping = true;
    log.info({ signal }, 'Stopping: finishing current tasks...');
    clearInterval(recoveryTimer);
    await Promise.all(loops);
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