/**
 * Changes the monthly free-request limit used by the QuotaGuard.
 * Workers read it at start, so restart the worker after a change.
 *
 * Usage:
 *   npm run quota:set -- --free-limit 20    (e.g. a capped first live run)
 *   npm run quota:set -- --reset            (back to the default, 1,000)
 */
import { parseArgs } from 'node:util';
import { EnvValidationError, loadEnv } from '../config/env';
import { createPrismaClient } from '../db/prisma';
import { QUOTA_SETTINGS_KEY, quotaSettingsSchema } from '../quota/settings';

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: { 'free-limit': { type: 'string' }, reset: { type: 'boolean', default: false } },
  });
  if (!values.reset && values['free-limit'] === undefined) {
    throw new Error('Usage: npm run quota:set -- --free-limit 20   or   --reset');
  }

  try {
    process.loadEnvFile('.env');
  } catch {
    // No .env file: rely on real environment variables.
  }
  const prisma = createPrismaClient(loadEnv());
  try {
    const row = await prisma.setting.findUnique({ where: { key: QUOTA_SETTINGS_KEY } });
    const current =
      row?.value && typeof row.value === 'object' && !Array.isArray(row.value)
        ? { ...(row.value as Record<string, unknown>) }
        : {};

    if (values.reset) {
      delete current.freeLimit;
    } else {
      current.freeLimit = Number(values['free-limit']);
    }

    // Validate the whole settings object before saving anything.
    const effective = quotaSettingsSchema.parse(current);
    // JSON round-trip gives Prisma a plain JSON value.
    const value = JSON.parse(JSON.stringify(current)) as object;
    await prisma.setting.upsert({
      where: { key: QUOTA_SETTINGS_KEY },
      create: { key: QUOTA_SETTINGS_KEY, value },
      update: { value },
    });

    console.log(`Free monthly limit is now ${effective.freeLimit} (warning at ${Math.ceil(effective.freeLimit * effective.warnAt)}).`);
    console.log('Restart the worker (and the API server) so they use the new limit.');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err: unknown) => {
  if (err instanceof EnvValidationError) console.error(err.message);
  else console.error('Failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});