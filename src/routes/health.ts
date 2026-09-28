import type { FastifyPluginAsync } from 'fastify';

export interface HealthDeps {
  /** Resolves if the database is reachable, rejects otherwise. */
  checkDatabase: () => Promise<void>;
}

// Neon may need a moment to wake a suspended compute, so allow a few seconds.
const DB_CHECK_TIMEOUT_MS = 5000;

/** Rejects if the promise does not settle within `ms` milliseconds. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out after ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * GET /health
 * 200 when everything is reachable, 503 when the database is not.
 */
export function healthRoutes(deps: HealthDeps): FastifyPluginAsync {
  return async (app) => {
    app.get('/health', async (request, reply) => {
      let database: 'ok' | 'error' = 'ok';
      try {
        await withTimeout(deps.checkDatabase(), DB_CHECK_TIMEOUT_MS);
      } catch (err) {
        database = 'error';
        request.log.warn({ err }, 'Health check: database unreachable');
      }

      const healthy = database === 'ok';
      return reply.status(healthy ? 200 : 503).send({
        status: healthy ? 'ok' : 'degraded',
        database,
        uptimeSeconds: Math.round(process.uptime()),
        timestamp: new Date().toISOString(),
      });
    });
  };
}