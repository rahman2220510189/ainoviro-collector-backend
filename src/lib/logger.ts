import pino, { type Logger, type LoggerOptions } from 'pino';
import type { Env } from '../config/env';

/**
 * Shared pino options used by the HTTP server (via Fastify) and by
 * non-HTTP processes (workers, CLI commands).
 */
export function buildLoggerOptions(env: Env): LoggerOptions {
  const base: LoggerOptions = {
    level: env.NODE_ENV === 'test' ? 'silent' : env.LOG_LEVEL,
    // Never write credentials or session cookies to logs.
    redact: {
      paths: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]'],
      censor: '[REDACTED]',
    },
  };

  if (env.NODE_ENV === 'development') {
    return {
      ...base,
      transport: {
        target: 'pino-pretty',
        options: { translateTime: 'SYS:HH:MM:ss', ignore: 'pid,hostname' },
      },
    };
  }

  // Production and test: plain structured JSON.
  return base;
}

/** Standalone logger for workers and CLI commands. */
export function createLogger(env: Env, name: string): Logger {
  return pino({ ...buildLoggerOptions(env), name });
}