import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app';
import { hashPassword } from '../src/auth/password';
import { SESSION_COOKIE } from '../src/auth/session';
import type { CategoryNode } from '../src/services/categories';
import {
  createFakeAuthStore,
  createFakeCategoryStore,
  testDeps,
  testEnv,
  type FakeCategoryStore,
} from './helpers';

const EMAIL = 'admin@example.com';
const PASSWORD = 'correct-horse-battery';

const TREE: CategoryNode[] = [
  {
    id: 16,
    slug: 'fashion-accessories',
    displayName: 'Fashion & Accessories',
    sortOrder: 15,
    active: true,
    subcategories: [
      { id: 61, slug: 'kids-clothing', displayName: "Kids' Clothing", sortOrder: 0, active: true },
    ],
  },
];

let passwordHash: string;
let app: FastifyInstance | undefined;
let categoryStore: FakeCategoryStore;

beforeAll(async () => {
  passwordHash = await hashPassword(PASSWORD, 4);
});

afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function startApp(): Promise<FastifyInstance> {
  categoryStore = createFakeCategoryStore(TREE);
  app = await buildApp(
    testEnv,
    testDeps({
      authStore: createFakeAuthStore([{ id: 1, email: EMAIL, passwordHash }]),
      categoryStore,
    }),
  );
  await app.ready();
  return app;
}

async function loginCookie(server: FastifyInstance): Promise<string> {
  const res = await server.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    headers: { 'x-requested-with': 'XMLHttpRequest' },
    payload: { email: EMAIL, password: PASSWORD },
  });
  const cookie = res.cookies.find((c) => c.name === SESSION_COOKIE);
  if (!cookie) throw new Error('Login failed in test setup');
  return `${SESSION_COOKIE}=${cookie.value}`;
}

describe('GET /api/v1/categories', () => {
  it('requires login', async () => {
    const server = await startApp();
    const res = await server.inject({ method: 'GET', url: '/api/v1/categories' });
    expect(res.statusCode).toBe(401);
    expect(categoryStore.calls).toEqual([]);
  });

  it('returns the active category tree for a logged-in admin', async () => {
    const server = await startApp();
    const cookie = await loginCookie(server);
    const res = await server.inject({ method: 'GET', url: '/api/v1/categories', headers: { cookie } });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ categories: TREE });
    expect(categoryStore.calls).toEqual([false]);
  });

  it('passes includeInactive=true to the store', async () => {
    const server = await startApp();
    const cookie = await loginCookie(server);
    await server.inject({
      method: 'GET',
      url: '/api/v1/categories?includeInactive=true',
      headers: { cookie },
    });
    expect(categoryStore.calls).toEqual([true]);
  });

  it('rejects an invalid includeInactive value', async () => {
    const server = await startApp();
    const cookie = await loginCookie(server);
    const res = await server.inject({
      method: 'GET',
      url: '/api/v1/categories?includeInactive=maybe',
      headers: { cookie },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
  });
});