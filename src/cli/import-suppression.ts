/**
 * Imports emails from a CSV into the suppression (block) list, so they are never
 * exported. Idempotent: emails already suppressed are skipped.
 *
 * Usage:
 *   npm run import:suppression -- --file data/contacts.csv --reason EXISTING_CONTACT [--column email]
 * Reasons: UNSUBSCRIBED, BOUNCED, EXISTING_CONTACT, EXISTING_VENDOR, MANUAL
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { EnvValidationError, loadEnv } from '../config/env';
import { createPrismaClient } from '../db/prisma';
import {
  IMPORTABLE_REASONS,
  importSuppressionRows,
  prepareSuppressionRows,
  readEmailColumn,
  type ImportableReason,
} from '../services/suppression';

const USAGE =
  'Usage: npm run import:suppression -- --file <path.csv> --reason <REASON> [--column email]\n' +
  `Reasons: ${IMPORTABLE_REASONS.join(', ')}`;

function parseReason(value: string | undefined): ImportableReason {
  const reason = (value ?? '').toUpperCase();
  const match = IMPORTABLE_REASONS.find((r) => r === reason);
  if (!match) throw new Error(`Invalid or missing --reason.\n${USAGE}`);
  return match;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      file: { type: 'string' },
      reason: { type: 'string' },
      column: { type: 'string', default: 'email' },
    },
  });
  if (!values.file) throw new Error(`Missing --file.\n${USAGE}`);
  const reason = parseReason(values.reason);
  const column = values.column ?? 'email';

  try {
    process.loadEnvFile('.env');
  } catch {
    // No .env file: rely on real environment variables.
  }
  const env = loadEnv();

  // Read and check the whole file before touching the database.
  const values_ = readEmailColumn(readFileSync(values.file, 'utf8'), column);
  const prepared = prepareSuppressionRows(values_);
  const sourceFile = path.basename(values.file);

  console.log(`File: ${sourceFile} (${values_.length} rows)`);
  console.log(`  Valid unique emails: ${prepared.rows.length}`);
  console.log(`  Duplicates in file:  ${prepared.duplicatesInFile}`);
  console.log(`  Empty values:        ${prepared.emptyValues}`);
    console.log(`  Cells with several:  ${prepared.cellsWithSeveralEmails}`);
  const examples = prepared.invalid.slice(0, 5).map((v) => `"${v}"`).join(', ');
  console.log(
    `  Invalid values:      ${prepared.invalid.length}${examples ? `  (e.g. ${examples})` : ''}`,
  );

  const prisma = createPrismaClient(env);
  try {
    const result = await importSuppressionRows(prisma, prepared.rows, reason, sourceFile);
    const total = await prisma.suppression.count();
    console.log(
      `Suppression: ${result.inserted} newly blocked, ${result.upgraded} upgraded to ${reason}, ` +
        `${result.alreadySuppressed} already blocked.`,
    );
    console.log(`Suppression list now has ${total} entries.`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err: unknown) => {
  if (err instanceof EnvValidationError) {
    console.error(err.message);
  } else {
    console.error('Import failed:', err instanceof Error ? err.message : err);
  }
  process.exit(1);
});