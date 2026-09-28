/**
 * Removes everything created in MOCK mode: fake places (ids starting "mock-"),
 * mock search history ("mock:" tile keys), mock jobs and the mock quota counter.
 * Jobs and history from before modes existed are removed only if the database
 * holds no real Google data at all.
 *
 * Usage: npm run dev:clear-mock
 */
import { EnvValidationError, loadEnv } from '../src/config/env';
import { createPrismaClient } from '../src/db/prisma';
import { MOCK_QUOTA_PROVIDER, MOCK_TILE_PREFIX } from '../src/jobs/keys';
import { GOOGLE_PROVIDER } from '../src/quota/quota-guard';

async function main(): Promise<void> {
  try {
    process.loadEnvFile('.env');
  } catch {
    // No .env file: rely on real environment variables.
  }
  const prisma = createPrismaClient(loadEnv());
  try {
    const places = await prisma.place.deleteMany({ where: { googlePlaceId: { startsWith: 'mock-' } } });
    const history = await prisma.queryLog.deleteMany({ where: { tileKey: { startsWith: MOCK_TILE_PREFIX } } });
    const jobs = await prisma.job.deleteMany({ where: { options: { path: ['mode'], equals: 'MOCK' } } });
    const counter = await prisma.apiUsage.deleteMany({ where: { provider: MOCK_QUOTA_PROVIDER } });
    console.log(`Deleted: ${places.count} mock places, ${history.count} mock history rows, ${jobs.count} mock jobs, ${counter.count} mock counter rows.`);

    // Legacy test runs (before job modes existed): safe to remove only if nothing real exists.
    const realPlaces = await prisma.place.count();
    const realRequests = await prisma.apiUsage.aggregate({ where: { provider: GOOGLE_PROVIDER }, _sum: { requestCount: true } });
    if (realPlaces === 0 && (realRequests._sum.requestCount ?? 0) === 0) {
      const oldHistory = await prisma.queryLog.deleteMany({});
      const oldJobs = await prisma.job.deleteMany({});
      console.log(`No real Google data exists yet: also removed ${oldHistory.count} old history rows and ${oldJobs.count} old test jobs.`);
    } else {
      console.log('Real Google data exists: old jobs and history were kept.');
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err: unknown) => {
  if (err instanceof EnvValidationError) console.error(err.message);
  else console.error('Cleanup failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});