/**
 * Loads seed/keywords.json into subcategory_keywords (create / reactivate / deactivate).
 * Idempotent: safe to run again. Run seed:categories first.
 *
 * Usage: npm run seed:keywords
 */
import { ZodError } from 'zod';
import { EnvValidationError, loadEnv } from '../config/env';
import { createPrismaClient } from '../db/prisma';
import { loadCategorySeed } from '../services/category-seed';
import { checkKeywordCoverage, loadKeywordSeed, syncKeywords } from '../services/keyword-seed';

async function main(): Promise<void> {
  try {
    process.loadEnvFile('.env');
  } catch {
    // No .env file: rely on real environment variables.
  }
  const env = loadEnv();

  // Validate both files before touching the database.
  const keywords = loadKeywordSeed();
  const problems = checkKeywordCoverage(keywords, loadCategorySeed());
  if (problems.length > 0) {
    throw new Error(`seed/keywords.json does not match seed/categories.json:\n  - ${problems.join('\n  - ')}`);
  }

  const perLanguage = new Map<string, number>();
  const withoutKeywords: string[] = [];
  for (const [key, entry] of Object.entries(keywords.subcategories)) {
    let count = 0;
    for (const [language, list] of Object.entries(entry.keywords)) {
      perLanguage.set(language, (perLanguage.get(language) ?? 0) + list.length);
      count += list.length;
    }
    if (count === 0) withoutKeywords.push(key);
  }
  const total = [...perLanguage.values()].reduce((a, b) => a + b, 0);
  const byLanguage = [...perLanguage].map(([lang, n]) => `${lang} ${n}`).join(', ');

  const prisma = createPrismaClient(env);
  try {
    const result = await syncKeywords(prisma, keywords);
    console.log(`Keywords in file: ${total} (${byLanguage})`);
    console.log(
      `  created ${result.created}, reactivated ${result.reactivated}, ` +
        `deactivated ${result.deactivated}, unchanged ${result.unchanged}`,
    );
    console.log(`Subcategories without keywords: ${withoutKeywords.length}`);
    for (const key of withoutKeywords) console.log(`  - ${key}`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err: unknown) => {
  if (err instanceof EnvValidationError) {
    console.error(err.message);
  } else if (err instanceof ZodError) {
    console.error('seed/keywords.json is invalid:');
    for (const issue of err.issues) {
      console.error(`  - ${issue.path.map(String).join('.')}: ${issue.message}`);
    }
  } else {
    console.error('Seeding failed:', err instanceof Error ? err.message : err);
  }
  process.exit(1);
});