import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import jwt from '@fastify/jwt';
import rateLimit from '@fastify/rate-limit';
import type { Env } from './config/env';
import { csrfGuard } from './auth/csrf';
import { requireAuth } from './auth/require-auth';
import { SESSION_COOKIE } from './auth/session';
import type { AuthStore } from './auth/store';
import { buildLoggerOptions } from './lib/logger';
import { registerErrorHandlers } from './lib/error-handler';
import { authRoutes } from './routes/auth';
import { categoryRoutes } from './routes/categories';
import { healthRoutes } from './routes/health';
import type { CategoryStore } from './services/categories';
import { locationRoutes } from './routes/locations';
import type { LocationStore } from './services/locations';
import type { JobService } from './jobs/job-service';
import { jobRoutes } from './routes/jobs';
/**
 * External dependencies the app needs. Passed in (instead of created here)
 * so tests can supply fakes and never touch a real database.
 */
export interface AppDeps {
  checkDatabase: () => Promise<void>;
  authStore: AuthStore;
  categoryStore: CategoryStore;
    locationStore: LocationStore;
      jobService: JobService;
}

/**
 * Builds the Fastify app without starting to listen.
 * Kept separate from server.ts so tests can call app.inject() directly.
 */
export async function buildApp(env: Env, deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({
    logger: buildLoggerOptions(env),
    // Behind Render's proxy the client IP comes from X-Forwarded-For (needed for rate limits).
    trustProxy: env.TRUST_PROXY,
  });

  // Security headers.
  await app.register(helmet);

  // Only the configured frontend origin may call the API, with cookies.
  await app.register(cors, {
    origin: env.CORS_ORIGIN,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    // X-Requested-With is the required CSRF header (see auth/csrf.ts).
    allowedHeaders: ['Content-Type', 'X-Requested-With'],
    // Lets the frontend read the CSV filename on download.
    exposedHeaders: ['Content-Disposition'],
  });

  // Cookies + JWT: the login token lives in an httpOnly cookie.
  await app.register(cookie);
  await app.register(jwt, {
    secret: env.JWT_SECRET,
    cookie: { cookieName: SESSION_COOKIE, signed: false },
    sign: { expiresIn: `${env.SESSION_TTL_HOURS}h` },
  });

  // Rate limiting is opt-in per route (login uses it).
  await app.register(rateLimit, { global: false });

  app.decorateRequest('adminUser', null);

  registerErrorHandlers(app);

  // Health check lives outside /api/v1 so load balancers can hit it simply.
  await app.register(healthRoutes({ checkDatabase: deps.checkDatabase }));

  // All business routes go under /api/v1.
  await app.register(
    async (api) => {
      api.addHook('onRequest', csrfGuard);

      // Public: login / logout (me is protected inside).
      await api.register(authRoutes(env, deps.authStore), { prefix: '/auth' });

      // Everything registered in this scope requires a logged-in admin.
      await api.register(async (protectedApi) => {
        protectedApi.addHook('preHandler', requireAuth(deps.authStore));

        await protectedApi.register(categoryRoutes(deps.categoryStore), {
          prefix: '/categories',
        });
        await protectedApi.register(locationRoutes(deps.locationStore), {
          prefix: '/locations',
        });
                await protectedApi.register(jobRoutes(deps.jobService), { prefix: '/jobs' });
      });
    },
    { prefix: '/api/v1' },
  );

  return app;
}