/**
 * Loads seed/free_email_domains.json into the database (adds new, removes deleted).
 * Idempotent: safe to run again.
 *
 * Usage: npm run seed:free-domains
 */
import { ZodError } from 'zod';
import { EnvValidationError, loadEnv } from '../config/env';
import { createPrismaClient } from '../db/prisma';
import { loadFreeEmailDomains, syncFreeEmailDomains } from '../services/free-email-domains';

async function main(): Promise<void> {
  try {
    process.loadEnvFile('.env');
  } catch {
    // No .env file: rely on real environment variables.
  }
  const env = loadEnv();
  const domains = loadFreeEmailDomains();

  const prisma = createPrismaClient(env);
  try {
    const result = await syncFreeEmailDomains(prisma, domains);
    console.log(
      `Free email domains: added ${result.added}, removed ${result.removed}, total ${result.total}.`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err: unknown) => {
  if (err instanceof EnvValidationError) {
    console.error(err.message);
  } else if (err instanceof ZodError) {
    console.error('seed/free_email_domains.json is invalid:');
    for (const issue of err.issues) {
      console.error(`  - ${issue.path.map(String).join('.')}: ${issue.message}`);
    }
  } else {
    console.error('Seeding failed:', err instanceof Error ? err.message : err);
  }
  process.exit(1);
});