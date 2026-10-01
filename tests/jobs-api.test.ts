import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app';
import { hashPassword } from '../src/auth/password';
import { SESSION_COOKIE } from '../src/auth/session';
import {
  createFakeAuthStore,
  createFakeJobService,
  testDeps,
  testEnv,
  type FakeJobService,
} from './helpers';

const EMAIL = 'admin@example.com';
const PASSWORD = 'correct-horse-battery';
const CSRF = { 'x-requested-with': 'XMLHttpRequest' };

let passwordHash: string;
let app: FastifyInstance | undefined;
let jobs: FakeJobService;

beforeAll(async () => {
  passwordHash = await hashPassword(PASSWORD, 4);
});

afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function startApp(): Promise<{ server: FastifyInstance; cookie: string }> {
  jobs = createFakeJobService();
  app = await buildApp(
    testEnv,
    testDeps({
      authStore: createFakeAuthStore([{ id: 1, email: EMAIL, passwordHash }]),
      jobService: jobs,
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

describe('jobs API', () => {
  it('requires login', async () => {
    const { server } = await startApp();
    const res = await server.inject({ method: 'GET', url: '/api/v1/jobs' });
    expect(res.statusCode).toBe(401);
  });

  it('previews a job with defaults filled in and the country code upper-cased', async () => {
    const { server, cookie } = await startApp();
    const res = await server.inject({
      method: 'POST',
      url: '/api/v1/jobs/preview',
      headers: { ...CSRF, cookie },
      payload: { countryCode: 'cy' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().preview.cost.verdict).toBe('FITS');
    expect(jobs.calls[0]).toEqual({
      method: 'preview',
      args: [
        {
          countryCode: 'CY',
          districtNames: [],
          categorySlugs: [],
          greek: false,
          forceRerun: false,
        },
      ],
    });
  });

  it('rejects an invalid job request', async () => {
    const { server, cookie } = await startApp();
    const res = await server.inject({
      method: 'POST',
      url: '/api/v1/jobs/preview',
      headers: { ...CSRF, cookie },
      payload: { countryCode: 'Cyprus' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
  });

  it('creates a job (201) and records the admin who created it', async () => {
    const { server, cookie } = await startApp();
    const res = await server.inject({
      method: 'POST',
      url: '/api/v1/jobs',
      headers: { ...CSRF, cookie },
      payload: {
        countryCode: 'CY',
        districtNames: ['Limassol'],
        categorySlugs: ['personal-care-beauty'],
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().jobId).toBe(7);
    expect(jobs.calls[0]?.args[1]).toBe(1);
  });

  it('runs job actions and rejects unknown ones', async () => {
    const { server, cookie } = await startApp();
    const paused = await server.inject({
      method: 'POST',
      url: '/api/v1/jobs/7/pause',
      headers: { ...CSRF, cookie },
    });
    expect(paused.statusCode).toBe(200);
    expect(paused.json().job.status).toBe('PAUSED_USER');
    expect(jobs.calls[0]).toEqual({ method: 'act', args: [7, 'pause'] });

    const unknown = await server.inject({
      method: 'POST',
      url: '/api/v1/jobs/7/explode',
      headers: { ...CSRF, cookie },
    });
    expect(unknown.statusCode).toBe(400);
  });

  it('returns 404 for a job that does not exist', async () => {
    const { server, cookie } = await startApp();
    const res = await server.inject({
      method: 'GET',
      url: '/api/v1/jobs/999',
      headers: { cookie },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('JOB_NOT_FOUND');
  });

  it('passes location tree ids through to the job service', async () => {
    const { server, cookie } = await startApp();
    const res = await server.inject({
      method: 'POST',
      url: '/api/v1/jobs/preview',
      headers: { ...CSRF, cookie },
      payload: {
        countryCode: 'CY',
        locationIds: [335, 12],
        categorySlugs: ['personal-care-beauty'],
      },
    });
    expect(res.statusCode).toBe(200);
    expect(jobs.calls[0]?.args[0]).toMatchObject({ locationIds: [335, 12] });

    const bad = await server.inject({
      method: 'POST',
      url: '/api/v1/jobs/preview',
      headers: { ...CSRF, cookie },
      payload: { countryCode: 'CY', locationIds: ['Limassol'] },
    });
    expect(bad.statusCode).toBe(400);
  });

  it('returns the quota status (not mistaken for a job id)', async () => {
    const { server, cookie } = await startApp();
    const res = await server.inject({
      method: 'GET',
      url: '/api/v1/jobs/quota',
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().quota).toMatchObject({ freeRemaining: 880, worker: { running: true } });
    expect(jobs.calls[0]?.method).toBe('quotaStatus');
  });

  it('approves an extra budget only with a positive amount', async () => {
    const { server, cookie } = await startApp();
    const ok = await server.inject({
      method: 'POST',
      url: '/api/v1/jobs/7/budget',
      headers: { ...CSRF, cookie },
      payload: { extraBudgetEur: 5 },
    });
    expect(ok.statusCode).toBe(200);
    expect(jobs.calls[0]).toEqual({ method: 'approveBudget', args: [7, 5] });

    const zero = await server.inject({
      method: 'POST',
      url: '/api/v1/jobs/7/budget',
      headers: { ...CSRF, cookie },
      payload: { extraBudgetEur: 0 },
    });
    expect(zero.statusCode).toBe(400);
  });
});
