import { parse } from 'csv-parse/sync';
import type { Pool } from 'pg';
import { z } from 'zod';
import type { PrismaClient } from '../generated/prisma/client';
import { AppError } from '../lib/errors';
import { emailDomain, hashEmail, normalizeEmail } from '../lib/email';
import {
  IMPORTABLE_REASONS,
  importSuppressionRows,
  prepareSuppressionRows,
  readEmailColumn,
  type ImportableReason,
  type SuppressionImportResult,
} from './suppression';

export const SUPPRESSION_REASONS = [...IMPORTABLE_REASONS, 'ERASED'] as const;

export const suppressionListSchema = z.object({
  q: z.string().trim().min(1).max(254).optional(),
  reason: z.enum(SUPPRESSION_REASONS).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(10).max(200).default(50),
});
export type SuppressionListQuery = z.infer<typeof suppressionListSchema>;

export interface SuppressionEntry {
  id: number;
  /** null for erased entries: only the hash is kept. */
  email: string | null;
  domain: string | null;
  reason: string;
  sourceFile: string | null;
  addedAt: Date;
}

export interface SuppressionPage {
  items: SuppressionEntry[];
  total: number;
  page: number;
  pageSize: number;
  /** Entries per reason over the whole list. */
  counts: Record<string, number>;
}

export interface CsvImportResult extends SuppressionImportResult {
  /** Rows read from the file. */
  rows: number;
  invalid: number;
  duplicatesInFile: number;
  empty: number;
  /** Up to 10 values that held no email, to show the user. */
  invalidExamples: string[];
}

/** Statuses the mailer reports (spec §13: bounced, unsubscribed, replied, onboarded ...). */
export const MAILER_STATUSES = [
  'contacted',
  'bounced',
  'unsubscribed',
  'replied',
  'onboarded',
  'product_added',
] as const;
export type MailerStatus = (typeof MAILER_STATUSES)[number];

export interface MailerImportResult {
  rows: number;
  /** Rows per status found in the file. */
  byStatus: Partial<Record<MailerStatus, number>>;
  /** Businesses whose status moved forward (contacted / replied / onboarded / product added). */
  leadsUpdated: number;
  /** Bounced or unsubscribed addresses added to (or upgraded in) the suppression list. */
  suppressed: number;
  /** Addresses in the file that this tool never collected (still suppressed if bounced/unsubscribed). */
  unknownEmails: number;
  invalidRows: number;
  unknownStatuses: string[];
}

/** What the API routes need (a fake is used in tests). */
export interface SuppressionService {
  list(query: SuppressionListQuery): Promise<SuppressionPage>;
  add(email: string, reason: ImportableReason): Promise<SuppressionImportResult>;
  importCsv(input: {
    csv: string;
    column: string;
    reason: ImportableReason;
    filename: string;
  }): Promise<CsvImportResult>;
  importMailerResults(input: { csv: string; filename: string }): Promise<MailerImportResult>;
}

/**
 * A place's status only moves forward: a "replied" from the mailer never overwrites
 * "onboarded", and a rejected lead stays rejected.
 */
const MOVES_FROM: Record<'contacted' | 'replied' | 'onboarded' | 'product_added', string[]> = {
  contacted: ['NEW', 'EXPORTED'],
  replied: ['NEW', 'EXPORTED', 'CONTACTED'],
  onboarded: ['NEW', 'EXPORTED', 'CONTACTED', 'REPLIED'],
  product_added: ['NEW', 'EXPORTED', 'CONTACTED', 'REPLIED', 'ONBOARDED'],
};

interface MailerRow {
  email: string;
  status: string;
  date: Date;
}

/** Reads email,status[,date] from a mailer export (comma, semicolon or tab; BOM ok). */
export function readMailerRows(csv: string): { rows: MailerRow[]; invalidRows: number } {
  let header: string[] = [];
  const records = parse(csv, {
    bom: true,
    delimiter: [',', ';', '\t'],
    columns: (names: string[]) => {
      header = names.map((n) => n.trim().toLowerCase());
      return header;
    },
    skip_empty_lines: true,
    relax_column_count: true,
    trim: true,
  }) as Record<string, string | undefined>[];
  if (header.length === 0) throw new AppError(400, 'CSV_EMPTY', 'The CSV file is empty.');
  for (const needed of ['email', 'status'])
    if (!header.includes(needed))
      throw new AppError(
        400,
        'CSV_COLUMN_MISSING',
        `Column "${needed}" not found. Columns in this file: ${header.join(', ')}. Expected: email,status[,date].`,
      );
  const rows: MailerRow[] = [];
  let invalidRows = 0;
  for (const r of records) {
    const email = normalizeEmail(r.email ?? '');
    const status = (r.status ?? '')
      .trim()
      .toLowerCase()
      .replace(/[\s-]+/g, '_');
    if (!email || status === '') {
      invalidRows += 1;
      continue;
    }
    const parsed = r.date ? new Date(r.date) : null;
    rows.push({
      email,
      status,
      date: parsed && !Number.isNaN(parsed.getTime()) ? parsed : new Date(),
    });
  }
  return { rows, invalidRows };
}

export function createSuppressionService(prisma: PrismaClient, db: Pool): SuppressionService {
  return {
    async list(query) {
      const where: string[] = [];
      const params: unknown[] = [];
      if (query.reason) {
        params.push(query.reason);
        where.push(`reason = $${params.length}::suppression_reason`);
      }
      if (query.q) {
        const normalized = normalizeEmail(query.q);
        params.push(`%${query.q.toLowerCase().replace(/[\\%_]/g, (m) => `\\${m}`)}%`);
        const like = `$${params.length}`;
        if (normalized) {
          // An exact address also finds erased entries, through its hash.
          params.push(hashEmail(normalized));
          where.push(
            `(email_normalized ILIKE ${like} OR domain ILIKE ${like} OR email_hash = $${params.length})`,
          );
        } else {
          where.push(`(email_normalized ILIKE ${like} OR domain ILIKE ${like})`);
        }
      }
      const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
      const total = await db.query<{ n: string }>(
        `SELECT count(*) AS n FROM suppression ${whereSql}`,
        params,
      );
      const { rows } = await db.query<{
        id: number;
        email_normalized: string | null;
        domain: string | null;
        reason: string;
        source_file: string | null;
        added_at: Date;
      }>(
        `SELECT id, email_normalized, domain, reason, source_file, added_at FROM suppression ${whereSql}
         ORDER BY added_at DESC, id DESC LIMIT ${query.pageSize} OFFSET ${(query.page - 1) * query.pageSize}`,
        params,
      );
      const counts = await db.query<{ reason: string; n: string }>(
        'SELECT reason, count(*) AS n FROM suppression GROUP BY reason',
      );
      return {
        items: rows.map((r) => ({
          id: r.id,
          email: r.email_normalized,
          domain: r.domain,
          reason: r.reason,
          sourceFile: r.source_file,
          addedAt: r.added_at,
        })),
        total: Number(total.rows[0]?.n ?? 0),
        page: query.page,
        pageSize: query.pageSize,
        counts: Object.fromEntries(counts.rows.map((c) => [c.reason, Number(c.n)])),
      };
    },

    async add(email, reason) {
      const normalized = normalizeEmail(email);
      if (!normalized)
        throw new AppError(400, 'INVALID_EMAIL', `"${email}" is not a valid email address.`);
      return importSuppressionRows(
        prisma,
        [
          {
            emailHash: hashEmail(normalized),
            emailNormalized: normalized,
            domain: emailDomain(normalized),
          },
        ],
        reason,
        'manual (web)',
      );
    },

    async importCsv({ csv, column, reason, filename }) {
      let values: string[];
      try {
        values = readEmailColumn(csv, column);
      } catch (err) {
        throw new AppError(
          400,
          'CSV_COLUMN_MISSING',
          err instanceof Error ? err.message : String(err),
        );
      }
      const prepared = prepareSuppressionRows(values);
      const result = await importSuppressionRows(prisma, prepared.rows, reason, filename);
      return {
        ...result,
        rows: values.length,
        invalid: prepared.invalid.length,
        duplicatesInFile: prepared.duplicatesInFile,
        empty: prepared.emptyValues,
        invalidExamples: prepared.invalid.slice(0, 10),
      };
    },

    async importMailerResults({ csv, filename }) {
      const { rows, invalidRows } = readMailerRows(csv);
      const byStatus: MailerImportResult['byStatus'] = {};
      const unknownStatuses = new Set<string>();
      const groups = new Map<MailerStatus, MailerRow[]>();
      for (const row of rows) {
        const status = MAILER_STATUSES.find((s) => s === row.status);
        if (!status) {
          unknownStatuses.add(row.status);
          continue;
        }
        byStatus[status] = (byStatus[status] ?? 0) + 1;
        groups.set(status, [...(groups.get(status) ?? []), row]);
      }

      const known = await db.query<{ email_normalized: string }>(
        'SELECT email_normalized FROM emails WHERE email_normalized = ANY($1::text[])',
        [[...new Set(rows.map((r) => r.email))]],
      );
      const knownSet = new Set(known.rows.map((r) => r.email_normalized));

      let suppressed = 0;
      for (const status of ['bounced', 'unsubscribed'] as const) {
        const list = groups.get(status) ?? [];
        if (list.length === 0) continue;
        const column = status === 'bounced' ? 'bounced_at' : 'unsubscribed_at';
        await db.query(
          `UPDATE emails e SET status = $3::email_status, ${column} = COALESCE(e.${column}, u.at), updated_at = now()
           FROM unnest($1::text[], $2::timestamptz[]) AS u(email, at)
           WHERE e.email_normalized = u.email`,
          [list.map((r) => r.email), list.map((r) => r.date), status.toUpperCase()],
        );
        const prepared = prepareSuppressionRows(list.map((r) => r.email));
        const result = await importSuppressionRows(
          prisma,
          prepared.rows,
          status === 'bounced' ? 'BOUNCED' : 'UNSUBSCRIBED',
          filename,
        );
        suppressed += result.inserted + result.upgraded;
      }

      let leadsUpdated = 0;
      for (const status of ['contacted', 'replied', 'onboarded', 'product_added'] as const) {
        const list = groups.get(status) ?? [];
        if (list.length === 0) continue;
        const updated = await db.query<{ id: number; old: string }>(
          `WITH target AS (
             SELECT DISTINCT p.id, p.status::text AS old FROM places p
             JOIN emails e ON e.place_id = p.id
             WHERE e.email_normalized = ANY($1::text[]) AND p.status::text = ANY($2::text[])
           )
           UPDATE places p SET status = $3::place_status, updated_at = now()
           FROM target WHERE p.id = target.id RETURNING p.id, target.old`,
          [list.map((r) => r.email), MOVES_FROM[status], status.toUpperCase()],
        );
        leadsUpdated += updated.rowCount ?? 0;
        for (const r of updated.rows)
          await db.query(
            `INSERT INTO audit_log (action, entity_type, entity_id, details)
             VALUES ('lead.status', 'place', $1, $2)`,
            [
              String(r.id),
              JSON.stringify({ from: r.old, to: status.toUpperCase(), source: filename }),
            ],
          );
      }

      const result: MailerImportResult = {
        rows: rows.length + invalidRows,
        byStatus,
        leadsUpdated,
        suppressed,
        unknownEmails: [...new Set(rows.map((r) => r.email))].filter((e) => !knownSet.has(e))
          .length,
        invalidRows,
        unknownStatuses: [...unknownStatuses],
      };
      await db.query(
        `INSERT INTO audit_log (action, entity_type, entity_id, details)
         VALUES ('mailer.import', 'suppression', NULL, $1)`,
        [JSON.stringify({ file: filename, ...result })],
      );
      return result;
    },
  };
}
