import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app';
import { AppError } from '../src/lib/errors';
import { testDeps, testEnv } from './helpers';

const dbUp = async (): Promise<void> => {};
const dbDown = async (): Promise<void> => {
  throw new Error('database is down');
};

describe('app with a healthy database', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp(testEnv, testDeps({ checkDatabase: dbUp }));
    // Test-only route to verify the error shape for AppError.
    app.get('/__test/app-error', async () => {
      throw new AppError(409, 'TEST_CONFLICT', 'Something conflicted', { field: 'email' });
    });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /health returns ok with database ok', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'ok', database: 'ok' });
  });

  it('unknown route returns the standard 404 error shape', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/does-not-exist' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({
      error: {
        code: 'NOT_FOUND',
        message: 'Route GET /api/v1/does-not-exist not found',
        details: null,
      },
    });
  });

  it('AppError is converted to the standard error shape', async () => {
    const res = await app.inject({ method: 'GET', url: '/__test/app-error' });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({
      error: { code: 'TEST_CONFLICT', message: 'Something conflicted', details: { field: 'email' } },
    });
  });

  it('CORS allows the configured frontend origin with credentials', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { origin: 'http://localhost:3000' },
    });
    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:3000');
    expect(res.headers['access-control-allow-credentials']).toBe('true');
  });
});

describe('app with an unreachable database', () => {
  it('GET /health returns 503 and database error', async () => {
    const app = await buildApp(testEnv, testDeps({ checkDatabase: dbDown }));
    await app.ready();
    try {
      const res = await app.inject({ method: 'GET', url: '/health' });
      expect(res.statusCode).toBe(503);
      expect(res.json()).toMatchObject({ status: 'degraded', database: 'error' });
    } finally {
      await app.close();
    }
  });
});