import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app';
import { hashPassword } from '../src/auth/password';
import { SESSION_COOKIE } from '../src/auth/session';
import {
  createFakeAuthStore,
  createFakeSettingsService,
  testDeps,
  testEnv,
  type FakeSettingsService,
} from './helpers';

const EMAIL = 'admin@example.com';
const PASSWORD = 'correct-horse-battery';
const CSRF = { 'x-requested-with': 'XMLHttpRequest' };

let passwordHash: string;
let app: FastifyInstance | undefined;
let settings: FakeSettingsService;

beforeAll(async () => {
  passwordHash = await hashPassword(PASSWORD, 4);
});

afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function startApp(): Promise<{ server: FastifyInstance; cookie: string }> {
  settings = createFakeSettingsService();
  app = await buildApp(
    testEnv,
    testDeps({
      authStore: createFakeAuthStore([{ id: 1, email: EMAIL, passwordHash }]),
      settingsService: settings,
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

describe('settings API', () => {
  it('requires login', async () => {
    const { server } = await startApp();
    const res = await server.inject({ method: 'GET', url: '/api/v1/settings' });
    expect(res.statusCode).toBe(401);
  });

  it('returns every section and the chain list', async () => {
    const { server, cookie } = await startApp();
    const res = await server.inject({
      method: 'GET',
      url: '/api/v1/settings',
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().settings.sections.quota.values.freeLimit).toBe(20);
    expect(res.json().settings.chains[0].name).toBe('Zara');
  });

  it('saves a known section with the admin id and rejects an unknown one', async () => {
    const { server, cookie } = await startApp();
    const ok = await server.inject({
      method: 'PUT',
      url: '/api/v1/settings/quota',
      headers: { ...CSRF, cookie },
      payload: { values: { freeLimit: 1000 } },
    });
    expect(ok.statusCode).toBe(200);
    expect(settings.calls[0]).toEqual({
      method: 'update',
      args: ['quota', { freeLimit: 1000 }, 1],
    });

    const unknown = await server.inject({
      method: 'PUT',
      url: '/api/v1/settings/secrets',
      headers: { ...CSRF, cookie },
      payload: { values: {} },
    });
    expect(unknown.statusCode).toBe(400);
  });

  it('needs the CSRF header to change anything', async () => {
    const { server, cookie } = await startApp();
    const res = await server.inject({
      method: 'PUT',
      url: '/api/v1/settings/quota',
      headers: { cookie },
      payload: { values: { freeLimit: 1000 } },
    });
    expect(res.statusCode).toBe(403);
    expect(settings.calls).toEqual([]);
  });

  it('adds and removes chain entries', async () => {
    const { server, cookie } = await startApp();
    const add = await server.inject({
      method: 'POST',
      url: '/api/v1/settings/chains',
      headers: { ...CSRF, cookie },
      payload: { name: 'Zara', domain: 'zara.com' },
    });
    expect(add.statusCode).toBe(200);
    const del = await server.inject({
      method: 'DELETE',
      url: '/api/v1/settings/chains/1',
      headers: { ...CSRF, cookie },
    });
    expect(del.statusCode).toBe(200);
    expect(settings.calls.map((c) => c.method)).toEqual(['addChain', 'removeChain']);
  });
});
