import { EnvValidationError, loadEnv } from './config/env';
import { createPrismaClient, pingDatabase } from './db/prisma';
import { createPrismaAuthStore } from './auth/store';
import { buildApp } from './app';
import { createPrismaCategoryStore } from './services/categories';
import { createPrismaLocationStore } from './services/locations';
import { createPrismaJobService } from './jobs/job-service';
import { runModeFor } from './jobs/keys';
import { QuotaGuard } from './quota/quota-guard';
import { loadQuotaSettings } from './quota/settings';
import { Pool } from 'pg';
import { createExportService } from './export/export-service';
/** Startup problem with a message meant for humans (no stack trace needed). */
class StartupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StartupError';
  }
}

/** Load backend/.env if it exists. Real environment variables always win. */
function loadDotEnvFile(): void {
  try {
    process.loadEnvFile('.env');
  } catch {
    // No .env file: rely on variables already set in the environment.
  }
}

async function main(): Promise<void> {
  loadDotEnvFile();
  const env = loadEnv();

  // Fail fast if the database is unreachable.
  const prisma = createPrismaClient(env);
  try {
    await pingDatabase(prisma);
  } catch (err) {
    await prisma.$disconnect().catch(() => undefined);
    const reason = err instanceof Error ? err.message : String(err);
    throw new StartupError(
      `Cannot connect to the database. Check DATABASE_URL in backend/.env.\n  Reason: ${reason}`,
    );
  }
  // Raw SQL pool for bulk work (exports).
  const pool = new Pool({ connectionString: env.DATABASE_URL, max: 5 });
  const quota = new QuotaGuard(prisma, await loadQuotaSettings(prisma));
  const app = await buildApp(env, {
    checkDatabase: () => pingDatabase(prisma),
    authStore: createPrismaAuthStore(prisma),
    categoryStore: createPrismaCategoryStore(prisma),
    locationStore: createPrismaLocationStore(prisma),
        exportService: createExportService(pool),
    jobService: createPrismaJobService(prisma, { quota, mode: runModeFor(env.GOOGLE_PLACES_BASE_URL) }),
  });
  app.log.info('Database connection OK');

  // Graceful shutdown: finish in-flight requests, close DB, then exit.
  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info({ signal }, 'Shutting down');
    await app.close();
        await pool.end();
    await prisma.$disconnect();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  try {
    await app.listen({ port: env.PORT, host: env.HOST });
  } catch (err) {
    await prisma.$disconnect().catch(() => undefined);
    if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE') {
      throw new StartupError(
        `Port ${env.PORT} is already in use. Change PORT in backend/.env and retry.`,
      );
    }
    throw err;
  }
}

main().catch((err: unknown) => {
  if (err instanceof EnvValidationError || err instanceof StartupError) {
    console.error(err.message);
  } else {
    console.error('Fatal startup error:', err);
  }
  process.exit(1);
});