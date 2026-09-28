import { PrismaPg } from '@prisma/adapter-pg';
import type { Env } from '../config/env';
import { PrismaClient } from '../generated/prisma/client';
/**
 * Creates the Prisma Client. Prisma 7 requires a driver adapter;
 * we use the node-postgres (pg) adapter with the pooled Neon URL.
 */
export function createPrismaClient(env: Env): PrismaClient {
  const adapter = new PrismaPg({ connectionString: env.DATABASE_URL });
  return new PrismaClient({ adapter });
}

/** Resolves if the database answers a trivial query, rejects otherwise. */
export async function pingDatabase(prisma: PrismaClient): Promise<void> {
  await prisma.$queryRaw`SELECT 1`;
}