import { PrismaPg } from '@prisma/adapter-pg';
import type { Env } from '../config/env';
import { PrismaClient } from '../generated/prisma/client';
/**
 * Creates the Prisma Client. Prisma 7 requires a driver adapter;
 * we use the node-postgres (pg) adapter with the pooled Neon URL.
 */
export function createPrismaClient(env: Env): PrismaClient {
  const adapter = new PrismaPg({ connectionString: env.DATABASE_URL });
  return new PrismaClient({
    adapter,
    // Prisma's defaults (2 s to start a transaction, 5 s to finish it) are too short for a
    // remote Neon database: opening a new connection, or waking a suspended database,
    // can take several seconds.
    transactionOptions: { maxWait: 15_000, timeout: 30_000 },
  });
}

/** Resolves if the database answers a trivial query, rejects otherwise. */
export async function pingDatabase(prisma: PrismaClient): Promise<void> {
  await prisma.$queryRaw`SELECT 1`;
}