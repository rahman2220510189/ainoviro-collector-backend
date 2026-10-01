import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app';
import { hashPassword } from '../src/auth/password';
import { SESSION_COOKIE } from '../src/auth/session';
import { readMailerRows } from '../src/services/suppression-service';
import {
  createFakeAuthStore,
  createFakeSuppressionService,
  testDeps,
  testEnv,
  type FakeSuppressionService,
} from './helpers';

const EMAIL = 'admin@example.com';
const PASSWORD = 'correct-horse-battery';
const CSRF = { 'x-requested-with': 'XMLHttpRequest' };

let passwordHash: string;
let app: FastifyInstance | undefined;
let suppression: FakeSuppressionService;

beforeAll(async () => {
  passwordHash = await hashPassword(PASSWORD, 4);
});
afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function start(): Promise<{ server: FastifyInstance; cookie: string }> {
  suppression = createFakeSuppressionService();
  app = await buildApp(
    testEnv,
    testDeps({
      authStore: createFakeAuthStore([{ id: 1, email: EMAIL, passwordHash }]),
      suppressionService: suppression,
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

describe('mailer results CSV', () => {
  it('reads email, status and an optional date (BOM, semicolons, odd spacing)', () => {
    const csv =
      '﻿Email;Status;Date\r\n INFO@Shop.cy ;Bounced;2026-10-01\r\nmaria@shop.cy;Product Added;\r\n;replied;\r\n';
    const { rows, invalidRows } = readMailerRows(csv);
    expect(invalidRows).toBe(1);
    expect(rows.map((r) => [r.email, r.status])).toEqual([
      ['info@shop.cy', 'bounced'],
      ['maria@shop.cy', 'product_added'],
    ]);
    expect(rows[0]?.date.toISOString()).toBe('2026-10-01T00:00:00.000Z');
  });

  it('names the missing column', () => {
    expect(() => readMailerRows('email,result\na@b.cy,bounced\n')).toThrow(/Column "status"/);
  });
});

describe('suppression API', () => {
  it('requires login', async () => {
    const { server } = await start();
    expect((await server.inject({ method: 'GET', url: '/api/v1/suppression' })).statusCode).toBe(
      401,
    );
  });

  it('lists with filters and adds one address (MANUAL by default)', async () => {
    const { server, cookie } = await start();
    const list = await server.inject({
      method: 'GET',
      url: '/api/v1/suppression?reason=BOUNCED&q=shop',
      headers: { cookie },
    });
    expect(list.statusCode).toBe(200);
    const added = await server.inject({
      method: 'POST',
      url: '/api/v1/suppression',
      headers: { ...CSRF, cookie },
      payload: { email: 'info@shop.cy' },
    });
    expect(added.json()).toEqual({ result: { inserted: 1, upgraded: 0, alreadySuppressed: 0 } });
    expect(suppression.calls.map((c) => [c.method, c.args])).toEqual([
      ['list', [{ reason: 'BOUNCED', q: 'shop', page: 1, pageSize: 50 }]],
      ['add', ['info@shop.cy', 'MANUAL']],
    ]);
  });

  it('imports a CSV and mailer results; refuses ERASED as an import reason', async () => {
    const { server, cookie } = await start();
    const csv = await server.inject({
      method: 'POST',
      url: '/api/v1/suppression/import',
      headers: { ...CSRF, cookie },
      payload: { csv: 'email\na@b.cy\n', filename: 'old.csv', reason: 'EXISTING_CONTACT' },
    });
    expect(csv.json().result.inserted).toBe(2);
    const erased = await server.inject({
      method: 'POST',
      url: '/api/v1/suppression/import',
      headers: { ...CSRF, cookie },
      payload: { csv: 'email\na@b.cy\n', filename: 'x.csv', reason: 'ERASED' },
    });
    expect(erased.statusCode).toBe(400);
    const mailer = await server.inject({
      method: 'POST',
      url: '/api/v1/suppression/mailer-results',
      headers: { ...CSRF, cookie },
      payload: { csv: 'email,status\na@b.cy,bounced\n', filename: 'results.csv' },
    });
    expect(mailer.json().result.suppressed).toBe(1);
  });
});
