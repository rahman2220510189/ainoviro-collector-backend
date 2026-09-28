import type { FastifyRequest } from 'fastify';
import { AppError } from '../lib/errors';
import type { AuthStore } from './store';

/**
 * preHandler that allows the request only for a logged-in admin who still exists.
 * On success, request.adminUser is set.
 */
export function requireAuth(store: AuthStore) {
  return async (request: FastifyRequest): Promise<void> => {
    try {
      await request.jwtVerify();
    } catch {
      throw new AppError(401, 'UNAUTHORIZED', 'Please log in');
    }

    // The token is valid, but the admin may have been removed since it was issued.
    const adminId = Number(request.user.sub);
    const admin = Number.isInteger(adminId) ? await store.findAdminById(adminId) : null;
    if (!admin) {
      throw new AppError(401, 'UNAUTHORIZED', 'Please log in');
    }

    request.adminUser = { id: admin.id, email: admin.email };
  };
}