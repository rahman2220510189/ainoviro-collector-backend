import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app';
import { hashPassword } from '../src/auth/password';
import { SESSION_COOKIE } from '../src/auth/session';
import { leadFiltersSchema } from '../src/leads/lead-service';
import {
  createFakeAuthStore,
  createFakeLeadService,
  testDeps,
  testEnv,
  type FakeLeadService,
} from './helpers';

const EMAIL = 'admin@example.com';
const PASSWORD = 'correct-horse-battery';
const CSRF = { 'x-requested-with': 'XMLHttpRequest' };

let passwordHash: string;
let app: FastifyInstance | undefined;
let leads: FakeLeadService;

beforeAll(async () => {
  passwordHash = await hashPassword(PASSWORD, 4);
});
afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function start(): Promise<{ server: FastifyInstance; cookie: string }> {
  leads = createFakeLeadService();
  app = await buildApp(
    testEnv,
    testDeps({
      authStore: createFakeAuthStore([{ id: 1, email: EMAIL, passwordHash }]),
      leadService: leads,
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

describe('lead filters', () => {
  it('defaults to CY, businesses with an email, page 1 of 50', () => {
    expect(leadFiltersSchema.parse({})).toEqual({
      country: 'CY',
      hasEmail: 'yes',
      page: 1,
      pageSize: 50,
    });
  });

  it('parses query-string values and rejects unknown statuses', () => {
    expect(
      leadFiltersSchema.parse({ needsReview: 'yes', minScore: '50', status: 'CONTACTED' }),
    ).toMatchObject({ needsReview: 'yes', minScore: 50, status: 'CONTACTED' });
    expect(() => leadFiltersSchema.parse({ status: 'WON' })).toThrow();
    expect(() => leadFiltersSchema.parse({ pageSize: '5000' })).toThrow();
  });
});

describe('leads API', () => {
  it('requires login', async () => {
    const { server } = await start();
    expect((await server.inject({ method: 'GET', url: '/api/v1/leads' })).statusCode).toBe(401);
  });

  it('lists with parsed filters', async () => {
    const { server, cookie } = await start();
    const res = await server.inject({
      method: 'GET',
      url: '/api/v1/leads?country=cy&city=Limassol&needsReview=yes&page=2',
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ items: [], total: 0, page: 2, pageSize: 50 });
    expect(leads.calls[0]?.args[0]).toMatchObject({
      country: 'CY',
      city: 'Limassol',
      needsReview: 'yes',
      page: 2,
    });
  });

  it('returns facets, a lead, and 404 for an unknown lead', async () => {
    const { server, cookie } = await start();
    const facets = await server.inject({
      method: 'GET',
      url: '/api/v1/leads/facets',
      headers: { cookie },
    });
    expect(facets.json()).toEqual({ cities: [{ name: 'Limassol', count: 280 }] });
    const lead = await server.inject({
      method: 'GET',
      url: '/api/v1/leads/7',
      headers: { cookie },
    });
    expect(lead.json().lead.name).toBe('Κομμωτήριο Ελένη');
    const missing = await server.inject({
      method: 'GET',
      url: '/api/v1/leads/99',
      headers: { cookie },
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.code).toBe('LEAD_NOT_FOUND');
  });

  it('changes status, bulk rejects and erases with the admin as actor', async () => {
    const { server, cookie } = await start();
    const patched = await server.inject({
      method: 'PATCH',
      url: '/api/v1/leads/7',
      headers: { ...CSRF, cookie },
      payload: { status: 'CONTACTED' },
    });
    expect(patched.json().lead.status).toBe('CONTACTED');
    const bulk = await server.inject({
      method: 'POST',
      url: '/api/v1/leads/bulk-reject',
      headers: { ...CSRF, cookie },
      payload: { ids: [7, 8, 9] },
    });
    expect(bulk.json()).toEqual({ rejected: 3 });
    const erased = await server.inject({
      method: 'POST',
      url: '/api/v1/leads/7/erase',
      headers: { ...CSRF, cookie },
    });
    expect(erased.json()).toEqual({ erased: { placeId: 7, emailsErased: 2 } });
    expect(leads.calls.map((c) => [c.method, c.args.at(-1)])).toEqual([
      ['setStatus', 1],
      ['bulkReject', 1],
      ['erase', 1],
    ]);
  });

  it('rejects bad input and requests without the CSRF header', async () => {
    const { server, cookie } = await start();
    const bad = await server.inject({
      method: 'PATCH',
      url: '/api/v1/leads/7',
      headers: { ...CSRF, cookie },
      payload: { status: 'WON' },
    });
    expect(bad.statusCode).toBe(400);
    const empty = await server.inject({
      method: 'POST',
      url: '/api/v1/leads/bulk-reject',
      headers: { ...CSRF, cookie },
      payload: { ids: [] },
    });
    expect(empty.statusCode).toBe(400);
    const noCsrf = await server.inject({
      method: 'POST',
      url: '/api/v1/leads/7/erase',
      headers: { cookie },
    });
    expect(noCsrf.statusCode).toBe(403);
    expect(leads.calls).toEqual([]);
  });
});
