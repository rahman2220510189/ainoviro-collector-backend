import type { PrismaClient } from '../generated/prisma/client';

/** Admin as stored (includes the password hash; never sent to clients). */
export interface AdminRecord {
  id: number;
  email: string;
  passwordHash: string;
}

/** Admin as exposed to route handlers and clients. */
export interface AdminSession {
  id: number;
  email: string;
}

/**
 * Everything auth needs from storage. An interface (instead of calling Prisma
 * directly) lets tests use an in-memory fake with no database.
 */
export interface AuthStore {
  findAdminByEmail(email: string): Promise<AdminRecord | null>;
  findAdminById(id: number): Promise<AdminRecord | null>;
  recordLogin(adminId: number, ip: string): Promise<void>;
}

const ADMIN_SELECT = { id: true, email: true, passwordHash: true } as const;

export function createPrismaAuthStore(prisma: PrismaClient): AuthStore {
  return {
    findAdminByEmail(email) {
      return prisma.adminUser.findUnique({ where: { email }, select: ADMIN_SELECT });
    },

    findAdminById(id) {
      return prisma.adminUser.findUnique({ where: { id }, select: ADMIN_SELECT });
    },

    async recordLogin(adminId, ip) {
      // Update last login and write an audit entry atomically.
      await prisma.$transaction([
        prisma.adminUser.update({ where: { id: adminId }, data: { lastLoginAt: new Date() } }),
        prisma.auditLog.create({
          data: {
            actorId: adminId,
            action: 'auth.login',
            entityType: 'admin_user',
            entityId: String(adminId),
            details: { ip },
          },
        }),
      ]);
    },
  };
}