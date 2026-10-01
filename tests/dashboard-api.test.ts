import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app';
import { hashPassword } from '../src/auth/password';
import { SESSION_COOKIE } from '../src/auth/session';
import {
  createFakeAuthStore,
  createFakeDashboardService,
  testDeps,
  testEnv,
  type FakeDashboardService,
} from './helpers';

const EMAIL = 'admin@example.com';
const PASSWORD = 'correct-horse-battery';
const CSRF = { 'x-requested-with': 'XMLHttpRequest' };

let passwordHash: string;
let app: FastifyInstance | undefined;
let dashboard: FakeDashboardService;

beforeAll(async () => {
  passwordHash = await hashPassword(PASSWORD, 4);
});

afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function startApp(): Promise<{ server: FastifyInstance; cookie: string }> {
  dashboard = createFakeDashboardService();
  app = await buildApp(
    testEnv,
    testDeps({
      authStore: createFakeAuthStore([{ id: 1, email: EMAIL, passwordHash }]),
      dashboardService: dashboard,
    }),
  );
  await app.ready();
  const login = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    headers: CSRF,
    payload: { email: EMAIL, password: PASSWORD },
  });
  const session = login.cookies.find((c) => c.name === SESSION_COOKIE);
  if (!session) throw new Error('Login failed in test setup');
  return { server: app, cookie: `${SESSION_COOKIE}=${session.value}` };
}

describe('dashboard API', () => {
  it('requires login', async () => {
    const { server } = await startApp();
    const res = await server.inject({ method: 'GET', url: '/api/v1/dashboard' });
    expect(res.statusCode).toBe(401);
  });

  it('returns the summary for Cyprus by default', async () => {
    const { server, cookie } = await startApp();
    const res = await server.inject({
      method: 'GET',
      url: '/api/v1/dashboard',
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().dashboard.leads.ready).toBe(12);
    expect(dashboard.calls).toEqual(['CY']);
  });

  it('upper-cases the country and rejects a bad one', async () => {
    const { server, cookie } = await startApp();
    await server.inject({
      method: 'GET',
      url: '/api/v1/dashboard?country=cy',
      headers: { cookie },
    });
    expect(dashboard.calls).toEqual(['CY']);
    const bad = await server.inject({
      method: 'GET',
      url: '/api/v1/dashboard?country=Cyprus',
      headers: { cookie },
    });
    expect(bad.statusCode).toBe(400);
  });
});
