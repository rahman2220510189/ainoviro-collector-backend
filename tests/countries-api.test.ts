import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app';
import { hashPassword } from '../src/auth/password';
import { SESSION_COOKIE } from '../src/auth/session';
import { loadAllCountryConfigs } from '../src/geonames/config';
import {
  createFakeAuthStore,
  createFakeCountryService,
  testDeps,
  testEnv,
  type FakeCountryService,
} from './helpers';

const EMAIL = 'admin@example.com';
const PASSWORD = 'correct-horse-battery';
const CSRF = { 'x-requested-with': 'XMLHttpRequest' };

let passwordHash: string;
let app: FastifyInstance | undefined;
let countries: FakeCountryService;

beforeAll(async () => {
  passwordHash = await hashPassword(PASSWORD, 4);
});

afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function startApp(): Promise<{ server: FastifyInstance; cookie: string }> {
  countries = createFakeCountryService();
  app = await buildApp(
    testEnv,
    testDeps({
      authStore: createFakeAuthStore([{ id: 1, email: EMAIL, passwordHash }]),
      countryService: countries,
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

describe('countries API', () => {
  it('lists countries after login only', async () => {
    const { server, cookie } = await startApp();
    expect((await server.inject({ method: 'GET', url: '/api/v1/countries' })).statusCode).toBe(401);
    const res = await server.inject({
      method: 'GET',
      url: '/api/v1/countries',
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().countries.map((c: { code: string }) => c.code)).toEqual(['CY', 'GR', 'MT']);
  });

  it('switches CSV export of a country with the admin id (code upper-cased)', async () => {
    const { server, cookie } = await startApp();
    const res = await server.inject({
      method: 'PUT',
      url: '/api/v1/countries/gr',
      headers: { ...CSRF, cookie },
      payload: { exportEnabled: true },
    });
    expect(res.statusCode).toBe(200);
    expect(countries.calls[0]).toEqual({ method: 'setExport', args: ['GR', true, 1] });
    const bad = await server.inject({
      method: 'PUT',
      url: '/api/v1/countries/GR',
      headers: { ...CSRF, cookie },
      payload: { exportEnabled: 'yes' },
    });
    expect(bad.statusCode).toBe(400);
  });

  it('adds a country through the worker (202)', async () => {
    const { server, cookie } = await startApp();
    const res = await server.inject({
      method: 'POST',
      url: '/api/v1/countries/MT/add',
      headers: { ...CSRF, cookie },
    });
    expect(res.statusCode).toBe(202);
    expect(res.json().refresh).toMatchObject({ state: 'REQUESTED', countryCode: 'MT' });
  });
});

describe('country configuration', () => {
  it('has the EU countries plus the UK, Norway and Switzerland, each with English keywords', () => {
    const all = loadAllCountryConfigs();
    expect(Object.keys(all)).toHaveLength(30);
    for (const code of ['CY', 'GR', 'MT', 'DE', 'FR', 'IT', 'ES', 'GB', 'NO', 'CH']) {
      expect(all[code]?.keywordLanguages[0]).toBe('en');
    }
    expect(all.GR?.keywordLanguages).toEqual(['en', 'el']);
    expect(all.GR?.localScript).toBe('Greek');
  });
});
