import type { FastifyRequest } from 'fastify';
import { AppError } from '../lib/errors';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * CSRF protection (second layer, on top of SameSite=Lax cookies):
 * every state-changing request must carry "X-Requested-With: XMLHttpRequest".
 * Browsers only allow a cross-site page to add custom headers after a CORS
 * preflight, and CORS only allows our own frontend origin.
 */
export async function csrfGuard(request: FastifyRequest): Promise<void> {
  if (SAFE_METHODS.has(request.method)) return;
  if (request.headers['x-requested-with'] !== 'XMLHttpRequest') {
    throw new AppError(403, 'CSRF_HEADER_MISSING', 'Missing required X-Requested-With header');
  }
}