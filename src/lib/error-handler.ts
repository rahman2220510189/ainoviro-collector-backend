import type { FastifyError, FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import { AppError, errorBody } from './errors';

/**
 * Registers the global error and 404 handlers so that every failure
 * returns the same JSON shape: { error: { code, message, details } }.
 */
export function registerErrorHandlers(app: FastifyInstance): void {
  app.setErrorHandler((error: FastifyError, request, reply) => {
    const err: unknown = error;

    // 1. Known application errors.
    if (err instanceof AppError) {
      return reply.status(err.statusCode).send(errorBody(err.code, err.message, err.details));
    }

    // 2. Request validation errors from zod.
    if (err instanceof ZodError) {
      const details = err.issues.map((issue) => ({
        path: issue.path.map(String).join('.'),
        message: issue.message,
      }));
      return reply.status(400).send(errorBody('VALIDATION_ERROR', 'Invalid request', details));
    }

    // 3. Fastify's own schema validation errors.
    if (error.validation) {
      return reply
        .status(400)
        .send(errorBody('VALIDATION_ERROR', error.message, error.validation));
    }

    const statusCode = typeof error.statusCode === 'number' ? error.statusCode : 500;

    // 4. Rate limit reached (thrown by @fastify/rate-limit).
    if (statusCode === 429) {
      return reply
        .status(429)
        .send(errorBody('RATE_LIMITED', 'Too many attempts. Please wait and try again.'));
    }

    // 5. Other client errors (bad JSON, payload too large, ...).
    if (statusCode >= 400 && statusCode < 500) {
      return reply
        .status(statusCode)
        .send(errorBody(error.code ?? 'REQUEST_ERROR', error.message));
    }

    // 6. Unexpected server errors: log full details, return a generic message.
    request.log.error({ err: error }, 'Unhandled error');
    return reply.status(500).send(errorBody('INTERNAL_ERROR', 'Internal server error'));
  });

  app.setNotFoundHandler((request, reply) => {
    return reply
      .status(404)
      .send(errorBody('NOT_FOUND', `Route ${request.method} ${request.url} not found`));
  });
}