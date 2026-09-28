import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app';
import { hashPassword } from '../src/auth/password';
import { SESSION_COOKIE } from '../src/auth/session';
import { createFakeAuthStore, testDeps, testEnv, type FakeAuthStore } from './helpers';

const EMAIL = 'admin@example.com';
const PASSWORD = 'correct-horse-battery';
const CSRF = { 'x-requested-with': 'XMLHttpRequest' };

let passwordHash: string;
let app: FastifyInstance | undefined;
let store: FakeAuthStore;

interface CookieLike {
  name: string;
  value: string;
  httpOnly?: boolean;
  sameSite?: string;
}

beforeAll(async () => {
  // Low bcrypt cost keeps tests fast; production uses 12.
  passwordHash = await hashPassword(PASSWORD, 4);
});

afterEach(async () => {
  await app?.close();
  app = undefined;
});

/** Fresh app (fresh rate-limit counters) with one admin in a fake store. */
async function startApp(): Promise<FastifyInstance> {
  store = createFakeAuthStore([{ id: 1, email: EMAIL, passwordHash }]);
  app = await buildApp(testEnv, testDeps({ authStore: store }));
  await app.ready();
  return app;
}

function login(server: FastifyInstance, body: object, headers: Record<string, string> = CSRF) {
  return server.inject({ method: 'POST', url: '/api/v1/auth/login', headers, payload: body });
}

function findSessionCookie(res: { cookies: CookieLike[] }): CookieLike {
  const cookie = res.cookies.find((c) => c.name === SESSION_COOKIE);
  if (!cookie) throw new Error('Session cookie not set');
  return cookie;
}

async function loggedInCookieHeader(server: FastifyInstance): Promise<string> {
  const res = await login(server, { email: EMAIL, password: PASSWORD });
  return `${SESSION_COOKIE}=${findSessionCookie(res).value}`;
}

describe('POST /api/v1/auth/login', () => {
  it('logs in with correct credentials and sets a secure session cookie', async () => {
    const server = await startApp();
    const res = await login(server, { email: EMAIL, password: PASSWORD });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ user: { id: 1, email: EMAIL } });
    const cookie = findSessionCookie(res);
    expect(cookie.httpOnly).toBe(true);
    expect(cookie.sameSite).toBe('Lax');
    expect(store.loginCalls).toEqual([1]);
  });

  it('treats the email case-insensitively and trims spaces', async () => {
    const server = await startApp();
    const res = await login(server, { email: '  ADMIN@Example.com ', password: PASSWORD });
    expect(res.statusCode).toBe(200);
  });

  it('rejects a wrong password with INVALID_CREDENTIALS and no cookie', async () => {
    const server = await startApp();
    const res = await login(server, { email: EMAIL, password: 'wrong-password' });

    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('INVALID_CREDENTIALS');
    expect(res.cookies.find((c) => c.name === SESSION_COOKIE)).toBeUndefined();
    expect(store.loginCalls).toEqual([]);
  });

  it('rejects an unknown email with exactly the same error', async () => {
    const server = await startApp();
    const wrongPassword = await login(server, { email: EMAIL, password: 'wrong-password' });
    const unknownEmail = await login(server, { email: 'nobody@example.com', password: PASSWORD });

    expect(unknownEmail.statusCode).toBe(401);
    expect(unknownEmail.json()).toEqual(wrongPassword.json());
  });

  it('requires the CSRF header', async () => {
    const server = await startApp();
    const res = await login(server, { email: EMAIL, password: PASSWORD }, {});
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('CSRF_HEADER_MISSING');
  });

  it('rejects an invalid body with VALIDATION_ERROR', async () => {
    const server = await startApp();
    const res = await login(server, { email: 'not-an-email', password: '' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
  });

  it('blocks the 6th attempt within 15 minutes with RATE_LIMITED', async () => {
    const server = await startApp();
    for (let i = 0; i < 5; i += 1) {
      const res = await login(server, { email: EMAIL, password: 'wrong-password' });
      expect(res.statusCode).toBe(401);
    }
    const blocked = await login(server, { email: EMAIL, password: PASSWORD });
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json().error.code).toBe('RATE_LIMITED');
  });
});

describe('GET /api/v1/auth/me', () => {
  it('returns 401 without a session cookie', async () => {
    const server = await startApp();
    const res = await server.inject({ method: 'GET', url: '/api/v1/auth/me' });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('UNAUTHORIZED');
  });

  it('returns the admin with a valid session cookie', async () => {
    const server = await startApp();
    const cookie = await loggedInCookieHeader(server);
    const res = await server.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ user: { id: 1, email: EMAIL } });
  });

  it('returns 401 for a tampered token', async () => {
    const server = await startApp();
    const cookie = `${await loggedInCookieHeader(server)}tampered`;
    const res = await server.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { cookie } });
    expect(res.statusCode).toBe(401);
  });

  it('returns 401 if the admin was removed after login', async () => {
    const server = await startApp();
    const cookie = await loggedInCookieHeader(server);
    store.admins = [];
    const res = await server.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { cookie } });
    expect(res.statusCode).toBe(401);
  });
});

describe('POST /api/v1/auth/logout', () => {
  it('clears the session cookie', async () => {
    const server = await startApp();
    const res = await server.inject({ method: 'POST', url: '/api/v1/auth/logout', headers: CSRF });
    expect(res.statusCode).toBe(204);
    expect(findSessionCookie(res).value).toBe('');
  });
});