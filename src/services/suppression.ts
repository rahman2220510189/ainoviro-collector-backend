import { parse } from 'csv-parse/sync';
import type { PrismaClient } from '../generated/prisma/client';
import { emailDomain, extractEmails, hashEmail } from '../lib/email';

/** Reasons allowed for a CSV import. ERASED is reserved for the GDPR erasure feature. */
export const IMPORTABLE_REASONS = [
  'UNSUBSCRIBED',
  'BOUNCED',
  'EXISTING_CONTACT',
  'EXISTING_VENDOR',
  'MANUAL',
] as const;
export type ImportableReason = (typeof IMPORTABLE_REASONS)[number];
type SuppressionReasonValue = ImportableReason | 'ERASED';

/**
 * Which existing reasons a newly imported reason replaces.
 * Mailer signals win: UNSUBSCRIBED beats everything except ERASED; BOUNCED beats
 * the "soft" reasons. Other reasons keep the first one recorded. ERASED is never touched.
 */
export function reasonsReplacedBy(reason: ImportableReason): SuppressionReasonValue[] {
  switch (reason) {
    case 'UNSUBSCRIBED':
      return ['BOUNCED', 'EXISTING_CONTACT', 'EXISTING_VENDOR', 'MANUAL'];
    case 'BOUNCED':
      return ['EXISTING_CONTACT', 'EXISTING_VENDOR', 'MANUAL'];
    default:
      return [];
  }
}

export interface SuppressionRowInput {
  emailHash: string;
  emailNormalized: string;
  domain: string;
}

export interface PreparedSuppression {
  rows: SuppressionRowInput[];
  /** Original values that contain no usable email address. */
  invalid: string[];
  duplicatesInFile: number;
  emptyValues: number;
  /** Cells that contained more than one email (e.g. a link whose text and target differ). */
  cellsWithSeveralEmails: number;
}

/**
 * Reads one column from CSV text. Handles comma, semicolon or tab separators,
 * a UTF-8 BOM (Excel), quoted values, and a case-insensitive header name.
 */
export function readEmailColumn(csvText: string, column: string): string[] {
  const wanted = column.trim().toLowerCase();
  let header: string[] = [];

  const records = parse(csvText, {
    bom: true,
    delimiter: [',', ';', '\t'],
    columns: (names: string[]) => {
      header = names.map((name) => name.trim().toLowerCase());
      return header;
    },
    skip_empty_lines: true,
    relax_column_count: true,
    trim: true,
  }) as Record<string, string | undefined>[];

  if (header.length === 0) throw new Error('The CSV file is empty.');
  if (!header.includes(wanted)) {
    throw new Error(
      `Column "${column}" not found. Columns in this file: ${header.join(', ')}. ` +
        'Use --column to pick the right one.',
    );
  }
  return records.map((record) => record[wanted] ?? '');
}

/**
 * Extracts, normalizes and de-duplicates every email in the given cells.
 * A cell may hold several emails; all of them are suppressed (blocking more is safe).
 */
export function prepareSuppressionRows(values: string[]): PreparedSuppression {
  const result: PreparedSuppression = {
    rows: [],
    invalid: [],
    duplicatesInFile: 0,
    emptyValues: 0,
    cellsWithSeveralEmails: 0,
  };
  const seen = new Set<string>();

  for (const value of values) {
    if (value.trim() === '') {
      result.emptyValues += 1;
      continue;
    }
    const emails = extractEmails(value);
    if (emails.length === 0) {
      result.invalid.push(value);
      continue;
    }
    if (emails.length > 1) result.cellsWithSeveralEmails += 1;

    for (const normalized of emails) {
      const emailHash = hashEmail(normalized);
      if (seen.has(emailHash)) {
        result.duplicatesInFile += 1;
        continue;
      }
      seen.add(emailHash);
      result.rows.push({ emailHash, emailNormalized: normalized, domain: emailDomain(normalized) });
    }
  }
  return result;
}

export interface SuppressionImportResult {
  inserted: number;
  /** Existing entries whose reason was upgraded (e.g. EXISTING_CONTACT -> UNSUBSCRIBED). */
  upgraded: number;
  alreadySuppressed: number;
}

const CHUNK_SIZE = 1000;

/**
 * Inserts rows into the suppression list and upgrades weaker reasons where the new
 * reason is stronger (see reasonsReplacedBy). Safe to run again.
 */
export async function importSuppressionRows(
  prisma: PrismaClient,
  rows: SuppressionRowInput[],
  reason: ImportableReason,
  sourceFile: string,
): Promise<SuppressionImportResult> {
  const replaceable = reasonsReplacedBy(reason);
  let inserted = 0;
  let upgraded = 0;

  for (let start = 0; start < rows.length; start += CHUNK_SIZE) {
    const chunk = rows.slice(start, start + CHUNK_SIZE);
    const created = await prisma.suppression.createMany({
      data: chunk.map((row) => ({ ...row, reason, sourceFile })),
      skipDuplicates: true,
    });
    inserted += created.count;

    // Rows just inserted already carry the new reason, so they are never counted twice.
    if (replaceable.length > 0) {
      const updated = await prisma.suppression.updateMany({
        where: { emailHash: { in: chunk.map((row) => row.emailHash) }, reason: { in: replaceable } },
        data: { reason, sourceFile },
      });
      upgraded += updated.count;
    }
  }
  return { inserted, upgraded, alreadySuppressed: rows.length - inserted - upgraded };
}