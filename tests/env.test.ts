import { describe, expect, it } from 'vitest';
import { EnvValidationError, loadEnv } from '../src/config/env';

const VALID_DB_URL = 'postgresql://user:password@localhost:5432/ainoviro';
const VALID_SECRET = 'a-valid-jwt-secret-with-at-least-32-chars';
const VALID_BASE = { DATABASE_URL: VALID_DB_URL, DIRECT_URL: VALID_DB_URL, JWT_SECRET: VALID_SECRET };

/** Run loadEnv and return the thrown EnvValidationError (fails the test if nothing is thrown). */
function expectEnvError(source: NodeJS.ProcessEnv): EnvValidationError {
  try {
    loadEnv(source);
  } catch (err) {
    expect(err).toBeInstanceOf(EnvValidationError);
    return err as EnvValidationError;
  }
  throw new Error('Expected loadEnv to throw, but it did not');
}

describe('loadEnv', () => {
  it('applies defaults when only the required values are provided', () => {
    const env = loadEnv({ ...VALID_BASE });
    expect(env).toEqual({
      NODE_ENV: 'development',
      HOST: '0.0.0.0',
      PORT: 5000,
      LOG_LEVEL: 'info',
      CORS_ORIGIN: 'http://localhost:3000',
      DATABASE_URL: VALID_DB_URL,
      DIRECT_URL: VALID_DB_URL,
      JWT_SECRET: VALID_SECRET,
      SESSION_TTL_HOURS: 12,
            TRUST_PROXY: false,
                  GOOGLE_PLACES_BASE_URL: 'https://places.googleapis.com',
                        GOOGLE_LIVE_REQUESTS: false,
      WORKER_CONCURRENCY: 4,
      WORKER_POLL_SECONDS: 5,
    });
  });

  it('coerces PORT from string to number', () => {
    const env = loadEnv({ ...VALID_BASE, PORT: '5055' });
    expect(env.PORT).toBe(5055);
  });

  it('rejects a missing DATABASE_URL', () => {
    const err = expectEnvError({ DIRECT_URL: VALID_DB_URL, JWT_SECRET: VALID_SECRET });
    expect(err.problems.some((p) => p.startsWith('DATABASE_URL'))).toBe(true);
  });

  it('rejects a missing DIRECT_URL', () => {
    const err = expectEnvError({ DATABASE_URL: VALID_DB_URL, JWT_SECRET: VALID_SECRET });
    expect(err.problems.some((p) => p.startsWith('DIRECT_URL'))).toBe(true);
  });

  it('rejects a DATABASE_URL that is not PostgreSQL', () => {
    const err = expectEnvError({ ...VALID_BASE, DATABASE_URL: 'mysql://user:pw@localhost/db' });
    expect(err.problems.some((p) => p.includes('must start with postgresql://'))).toBe(true);
  });

  it('rejects an invalid PORT', () => {
    const err = expectEnvError({ ...VALID_BASE, PORT: '99999' });
    expect(err.problems.some((p) => p.startsWith('PORT'))).toBe(true);
  });

  it('rejects a JWT_SECRET shorter than 32 characters', () => {
    const err = expectEnvError({ ...VALID_BASE, JWT_SECRET: 'too-short' });
    expect(err.problems.some((p) => p.startsWith('JWT_SECRET'))).toBe(true);
  });
  
  it('parses TRUST_PROXY=true as a boolean', () => {
    const env = loadEnv({ ...VALID_BASE, TRUST_PROXY: 'true' });
    expect(env.TRUST_PROXY).toBe(true);
  });
});