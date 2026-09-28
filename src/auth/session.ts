import type { Env } from '../config/env';

/** Name of the httpOnly cookie that carries the login token. */
export const SESSION_COOKIE = 'ainoviro_session';

/**
 * Cookie settings for the session:
 * - httpOnly: JavaScript in the browser cannot read it (protects against XSS theft)
 * - sameSite lax: not sent on cross-site POSTs (first CSRF layer)
 * - secure: HTTPS-only in production
 */
export function sessionCookieOptions(env: Env) {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: env.NODE_ENV === 'production',
    path: '/',
    maxAge: env.SESSION_TTL_HOURS * 60 * 60, // seconds
  };
}