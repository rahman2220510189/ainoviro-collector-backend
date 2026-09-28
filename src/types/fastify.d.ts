// Type augmentation for Fastify plugins used by this app.
import '@fastify/jwt';
import 'fastify';
import type { AdminSession } from '../auth/store';

declare module '@fastify/jwt' {
  interface FastifyJWT {
    /** What we put into the token. */
    payload: { sub: string; email: string };
    /** What request.user holds after jwtVerify(). */
    user: { sub: string; email: string };
  }
}

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by requireAuth for logged-in requests; null otherwise. */
    adminUser: AdminSession | null;
  }
}