import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app';
import { hashPassword } from '../src/auth/password';
import { SESSION_COOKIE } from '../src/auth/session';
import type { LocationNode } from '../src/services/locations';
import {
  createFakeAuthStore,
  createFakeLocationStore,
  testDeps,
  testEnv,
  type FakeLocationStore,
} from './helpers';

const EMAIL = 'admin@example.com';
const PASSWORD = 'correct-horse-battery';

const CYPRUS: LocationNode = {
  id: 1, parentId: null, type: 'COUNTRY', name: 'Cyprus', nameLocal: 'Κύπρος',
  countryCode: 'CY', population: 1189265, childCount: 6,
};
const LIMASSOL_DISTRICT: LocationNode = {
  id: 5, parentId: 1, type: 'REGION', name: 'Limassol', nameLocal: 'Λεμεσός',
  countryCode: 'CY', population: null, childCount: 120,
};

let passwordHash: string;
let app: FastifyInstance | undefined;
let locationStore: FakeLocationStore;

beforeAll(async () => {
  passwordHash = await hashPassword(PASSWORD, 4);
});

afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function startApp(): Promise<FastifyInstance> {
  locationStore = createFakeLocationStore(
    new Map([
      [null, [CYPRUS]],
      [1, [LIMASSOL_DISTRICT]],
    ]),
    [101, 102, 103],
  );
  app = await buildApp(
    testEnv,
    testDeps({
      authStore: createFakeAuthStore([{ id: 1, email: EMAIL, passwordHash }]),
      locationStore,
    }),
  );
  await app.ready();
  return app;
}

async function get(server: FastifyInstance, url: string) {
  const login = await server.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    headers: { 'x-requested-with': 'XMLHttpRequest' },
    payload: { email: EMAIL, password: PASSWORD },
  });
  const cookie = login.cookies.find((c) => c.name === SESSION_COOKIE);
  if (!cookie) throw new Error('Login failed in test setup');
  return server.inject({ method: 'GET', url, headers: { cookie: `${SESSION_COOKIE}=${cookie.value}` } });
}

describe('GET /api/v1/locations/tree', () => {
  it('requires login', async () => {
    const server = await startApp();
    const res = await server.inject({ method: 'GET', url: '/api/v1/locations/tree' });
    expect(res.statusCode).toBe(401);
  });

  it('returns the countries when no parent_id is given', async () => {
    const server = await startApp();
    const res = await get(server, '/api/v1/locations/tree');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ locations: [CYPRUS] });
    expect(locationStore.childCalls).toEqual([null]);
  });

  it('returns the children of parent_id', async () => {
    const server = await startApp();
    const res = await get(server, '/api/v1/locations/tree?parent_id=1');
    expect(res.json()).toEqual({ locations: [LIMASSOL_DISTRICT] });
    expect(locationStore.childCalls).toEqual([1]);
  });

  it('rejects an invalid parent_id', async () => {
    const server = await startApp();
    const res = await get(server, '/api/v1/locations/tree?parent_id=abc');
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
  });
});

describe('GET /api/v1/locations/resolve', () => {
  it('returns the city ids and count, de-duplicating the input ids', async () => {
    const server = await startApp();
    const res = await get(server, '/api/v1/locations/resolve?ids=5,5,7');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ cityIds: [101, 102, 103], count: 3 });
    expect(locationStore.resolveCalls).toEqual([[5, 7]]);
  });

  it('rejects malformed ids', async () => {
    const server = await startApp();
    const res = await get(server, '/api/v1/locations/resolve?ids=5,abc');
    expect(res.statusCode).toBe(400);
  });
});