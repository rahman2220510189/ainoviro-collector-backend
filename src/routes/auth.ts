import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { Env } from '../config/env';
import { verifyAgainstDummy, verifyPassword } from '../auth/password';
import { requireAuth } from '../auth/require-auth';
import { SESSION_COOKIE, sessionCookieOptions } from '../auth/session';
import type { AuthStore } from '../auth/store';
import { AppError } from '../lib/errors';

const loginBodySchema = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  password: z.string().min(1).max(200),
});

/** Max login attempts per IP address in the time window. */
const LOGIN_RATE_LIMIT = { max: 5, timeWindow: '15 minutes' };

/** Routes under /api/v1/auth */
export function authRoutes(env: Env, store: AuthStore): FastifyPluginAsync {
  return async (app) => {
    app.post('/login', { config: { rateLimit: LOGIN_RATE_LIMIT } }, async (request, reply) => {
      const { email, password } = loginBodySchema.parse(request.body);

      const admin = await store.findAdminByEmail(email);
      const valid = admin
        ? await verifyPassword(password, admin.passwordHash)
        : await verifyAgainstDummy(password);

      if (!admin || !valid) {
        request.log.warn({ email }, 'Failed login attempt');
        // Same message for unknown email and wrong password.
        throw new AppError(401, 'INVALID_CREDENTIALS', 'Email or password is incorrect');
      }

      const token = await reply.jwtSign({ sub: String(admin.id), email: admin.email });
      await store.recordLogin(admin.id, request.ip);
      reply.setCookie(SESSION_COOKIE, token, sessionCookieOptions(env));

      return { user: { id: admin.id, email: admin.email } };
    });

    app.post('/logout', async (_request, reply) => {
      reply.clearCookie(SESSION_COOKIE, { path: '/' });
      return reply.status(204).send();
    });

    app.get('/me', { preHandler: requireAuth(store) }, async (request) => {
      return { user: request.adminUser };
    });
  };
}