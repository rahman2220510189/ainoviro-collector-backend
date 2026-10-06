import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app';
import { hashPassword } from '../src/auth/password';
import { SESSION_COOKIE } from '../src/auth/session';
import { isRefreshBusy, refreshStateSchema } from '../src/datasets/refresh';
import {
  createFakeAuthStore,
  createFakeDatasetService,
  testDeps,
  testEnv,
  type FakeDatasetService,
} from './helpers';

const EMAIL = 'admin@example.com';
const PASSWORD = 'correct-horse-battery';
const CSRF = { 'x-requested-with': 'XMLHttpRequest' };

let passwordHash: string;
let app: FastifyInstance | undefined;
let datasets: FakeDatasetService;

beforeAll(async () => {
  passwordHash = await hashPassword(PASSWORD, 4);
});

afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function startApp(): Promise<{ server: FastifyInstance; cookie: string }> {
  datasets = createFakeDatasetService();
  app = await buildApp(
    testEnv,
    testDeps({
      authStore: createFakeAuthStore([{ id: 1, email: EMAIL, passwordHash }]),
      datasetService: datasets,
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

describe('datasets API', () => {
  it('requires login', async () => {
    const { server } = await startApp();
    const res = await server.inject({ method: 'GET', url: '/api/v1/datasets/overture' });
    expect(res.statusCode).toBe(401);
  });

  it('returns the Overture status, the newest release and the category report', async () => {
    const { server, cookie } = await startApp();
    const status = await server.inject({
      method: 'GET',
      url: '/api/v1/datasets/overture',
      headers: { cookie },
    });
    expect(status.statusCode).toBe(200);
    expect(status.json().overture).toMatchObject({ businesses: 30845, refresh: { state: 'IDLE' } });

    const latest = await server.inject({
      method: 'GET',
      url: '/api/v1/datasets/overture/latest',
      headers: { cookie },
    });
    expect(latest.json().latest).toEqual({ release: '2026-10-21.0', newer: true, error: null });

    const report = await server.inject({
      method: 'GET',
      url: '/api/v1/datasets/overture/report',
      headers: { cookie },
    });
    expect(report.json().report.byExclusion[0].reason).toBe('park or nature');
  });

  it('accepts one update request (202) with the admin id and refuses a second (409)', async () => {
    const { server, cookie } = await startApp();
    const first = await server.inject({
      method: 'POST',
      url: '/api/v1/datasets/overture/refresh',
      headers: { ...CSRF, cookie },
    });
    expect(first.statusCode).toBe(202);
    expect(first.json().refresh.state).toBe('REQUESTED');
    expect(datasets.calls[0]).toEqual({ method: 'requestOvertureRefresh', args: ['CY', 1] });

    const second = await server.inject({
      method: 'POST',
      url: '/api/v1/datasets/overture/refresh',
      headers: { ...CSRF, cookie },
    });
    expect(second.statusCode).toBe(409);
    expect(second.json().error.code).toBe('REFRESH_BUSY');
  });

  it('needs the CSRF header to request an update', async () => {
    const { server, cookie } = await startApp();
    const res = await server.inject({
      method: 'POST',
      url: '/api/v1/datasets/overture/refresh',
      headers: { cookie },
    });
    expect(res.statusCode).toBe(403);
    expect(datasets.calls).toHaveLength(0);
  });
});

describe('isRefreshBusy', () => {
  const now = Date.parse('2026-10-03T12:00:00Z');
  const at = (minutesAgo: number) => new Date(now - minutesAgo * 60_000).toISOString();
  const state = (s: 'IDLE' | 'REQUESTED' | 'RUNNING' | 'DONE', minutesAgo: number) =>
    refreshStateSchema.parse({ state: s, updatedAt: at(minutesAgo) });

  it('is busy while waiting or running, not when finished', () => {
    expect(isRefreshBusy(state('REQUESTED', 1), now)).toBe(true);
    expect(isRefreshBusy(state('RUNNING', 5), now)).toBe(true);
    expect(isRefreshBusy(state('DONE', 1), now)).toBe(false);
    expect(isRefreshBusy(state('IDLE', 1), now)).toBe(false);
  });

  it('treats a run that has not moved for 30 minutes as abandoned', () => {
    expect(isRefreshBusy(state('RUNNING', 31), now)).toBe(false);
  });
});
