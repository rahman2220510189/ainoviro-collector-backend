/**
 * Prints the most recently saved places, to eyeball real results.
 *
 * Usage: npm run dev:show-places -- [--limit 15]
 */
import { parseArgs } from 'node:util';
import { EnvValidationError, loadEnv } from '../src/config/env';
import { createPrismaClient } from '../src/db/prisma';

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { limit: { type: 'string', default: '15' } } });
  const limit = Math.min(Math.max(Number(values.limit) || 15, 1), 100);

  try {
    process.loadEnvFile('.env');
  } catch {
    // No .env file: rely on real environment variables.
  }
  const prisma = createPrismaClient(loadEnv());
  try {
    const total = await prisma.place.count();
    const withWebsite = await prisma.place.count({ where: { website: { not: null } } });
    const places = await prisma.place.findMany({
      orderBy: { id: 'desc' },
      take: limit,
      select: {
        name: true,
        website: true,
        phoneRaw: true,
        businessStatus: true,
        subcategories: { select: { matchedKeyword: true } },
      },
    });

    console.log(`Places in database: ${total} (with website: ${withWebsite})\n`);
    for (const p of places) {
      const keywords = p.subcategories.map((s) => s.matchedKeyword).join(', ');
      console.log(`- ${p.name}  [${keywords}]`);
      console.log(`    website: ${p.website ?? '-'}   phone: ${p.phoneRaw ?? '-'}   ${p.businessStatus}`);
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err: unknown) => {
  if (err instanceof EnvValidationError) console.error(err.message);
  else console.error('Failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});