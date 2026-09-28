/**
 * Loads seed/categories.json into the database (create / update / deactivate).
 * Idempotent: safe to run again.
 *
 * Usage: npm run seed:categories
 */
import { ZodError } from 'zod';
import { EnvValidationError, loadEnv } from '../config/env';
import { createPrismaClient } from '../db/prisma';
import { loadCategorySeed } from '../services/category-seed';
import { syncCategories, type SyncCounts } from '../services/categories';

function describe(counts: SyncCounts): string {
  return `created ${counts.created}, updated ${counts.updated}, deactivated ${counts.deactivated}`;
}

async function main(): Promise<void> {
  try {
    process.loadEnvFile('.env');
  } catch {
    // No .env file: rely on real environment variables.
  }
  const env = loadEnv();

  // Validate the file before touching the database.
  const seed = loadCategorySeed();

  const prisma = createPrismaClient(env);
  try {
    console.log('Syncing categories (this can take up to a minute)...');
    const result = await syncCategories(prisma, seed);

    const [activeCategories, activeSubcategories] = await Promise.all([
      prisma.category.count({ where: { active: true } }),
      prisma.subcategory.count({ where: { active: true, category: { active: true } } }),
    ]);

    console.log(`Categories:    ${describe(result.categories)}`);
    console.log(`Subcategories: ${describe(result.subcategories)}`);
    console.log(
      `Database now has ${activeCategories} active categories and ${activeSubcategories} active subcategories.`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err: unknown) => {
  if (err instanceof EnvValidationError) {
    console.error(err.message);
  } else if (err instanceof ZodError) {
    console.error('seed/categories.json is invalid:');
    for (const issue of err.issues) {
      console.error(`  - ${issue.path.map(String).join('.')}: ${issue.message}`);
    }
  } else {
    console.error('Seeding failed:', err instanceof Error ? err.message : err);
  }
  process.exit(1);
});