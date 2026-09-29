/**
 * Proves against the REAL database that the one-click export (step 2.5) is safe:
 * exact mailer_v1 columns, BOM + CRLF, Greek names, CSV-injection protection; only
 * exportable rows (no review / chain / suppressed / closed); rows are marked in a batch;
 * a second click gives 0 rows; re-download gives the same rows; undo returns rows
 * to "new" except those whose status changed since.
 * Uses the fake country "ZZ" only; everything it creates is deleted at the end.
 *
 * Usage: npm run export:verify
 */
import { Pool } from 'pg';
import { EnvValidationError, loadEnv } from '../src/config/env';
import { UTF8_BOM } from '../src/export/csv';
import { createExportService, exportRequestSchema } from '../src/export/export-service';
import { AppError } from '../src/lib/errors';
import { hashEmail } from '../src/lib/email';

const COUNTRY = 'ZZ';
const LAT = 34.6786;
const LNG = 33.0413;
const SUPPRESSED_EMAIL = 'info@verify-exp5.test';

let passed = 0;
let total = 0;
function check(name: string, ok: boolean, detail: string): void {
  total += 1;
  if (ok) passed += 1;
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}  -> ${detail}`);
}

/** Splits CSV lines into cells (enough for this check: quoted cells without line breaks). */
function parseLine(line: string): string[] {
  const cells: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i += 1;
      } else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      cells.push(cur);
      cur = '';
    } else cur += ch;
  }
  cells.push(cur);
  return cells;
}

async function cleanup(db: Pool, batchIds: number[]): Promise<void> {
  const ids = await db.query<{ id: number }>('SELECT id FROM places WHERE country_code = $1', [
    COUNTRY,
  ]);
  const placeIds = ids.rows.map((r) => r.id);
  const batches = await db.query<{ batch_id: number }>(
    'SELECT DISTINCT batch_id FROM export_batch_items WHERE place_id = ANY($1::int[])',
    [placeIds],
  );
  const allBatches = [...new Set([...batchIds, ...batches.rows.map((r) => r.batch_id)])];
  await db.query(
    `DELETE FROM audit_log WHERE entity_type = 'export_batch' AND entity_id = ANY($1::text[])`,
    [allBatches.map(String)],
  );
  await db.query(
    `DELETE FROM emails WHERE domain LIKE 'verify-exp%.test' OR domain = 'verify-chainx.test'`,
  );
  await db.query('DELETE FROM export_batches WHERE id = ANY($1::int[])', [allBatches]);
  await db.query('DELETE FROM places WHERE country_code = $1', [COUNTRY]);
  await db.query('DELETE FROM suppression WHERE email_hash = $1', [hashEmail(SUPPRESSED_EMAIL)]);
}

async function main(): Promise<void> {
  try {
    process.loadEnvFile('.env');
  } catch {
    // No .env file: rely on real environment variables.
  }
  const db = new Pool({ connectionString: loadEnv().DATABASE_URL, max: 3 });
  const service = createExportService(db);
  const batchIds: number[] = [];
  try {
    await cleanup(db, []);
    const sub = await db.query<{ id: number }>('SELECT id FROM subcategories ORDER BY id LIMIT 1');
    const subcategoryId = sub.rows[0]?.id;
    if (!subcategoryId) throw new Error('No subcategories: seed the categories first.');

    let n = 0;
    const addPlace = async (
      name: string,
      opts: { domain: string; phone?: string | null; status?: string; emails?: string[] },
    ): Promise<number> => {
      n += 1;
      const phone =
        opts.phone === undefined ? `+357990001${String(n).padStart(2, '0')}` : opts.phone;
      const { rows } = await db.query<{ id: number }>(
        `INSERT INTO places (name, name_normalized, country_code, city_name, lat, lng, website,
                             website_domain, phone_raw, phone_e164, phone_valid, business_status, updated_at)
         VALUES ($1, lower($1), $2, 'Limassol', $3, $4, $5, $6, $7, $7, $8, $9::business_status, now())
         RETURNING id`,
        [
          name,
          COUNTRY,
          LAT + n * 0.01,
          LNG,
          `https://${opts.domain}/`,
          opts.domain,
          phone,
          phone !== null,
          opts.status ?? 'OPERATIONAL',
        ],
      );
      const id = rows[0]?.id as number;
      await db.query(
        `INSERT INTO place_subcategories (place_id, subcategory_id, matched_keyword, source, is_primary)
         VALUES ($1, $2, 'verify', 'GOOGLE_PLACES', true)`,
        [id, subcategoryId],
      );
      await db.query(
        `INSERT INTO place_sources (place_id, source, source_record_id) VALUES ($1, 'GOOGLE_PLACES', $2)`,
        [id, `verify-exp-gid-${id}`],
      );
      for (const [i, email] of (opts.emails ?? []).entries()) {
        await db.query(
          `INSERT INTO emails (email, email_normalized, domain, place_id, is_primary, email_type,
                               is_own_domain, syntax_valid, mx_valid, source, updated_at)
           VALUES ($1, $1, split_part($1, '@', 2), $2, $3, 'GENERIC', true, true, true, 'mailto', now())`,
          [email, id, i === 0],
        );
      }
      return id;
    };

    const greek = await addPlace('Κομμωτήριο Ελένη', {
      domain: 'verify-exp1.test',
      emails: ['info@verify-exp1.test', 'maria@verify-exp1.test'],
    });
    const evil = await addPlace('=HYPERLINK("http://evil.test")', {
      domain: 'verify-exp2.test',
      emails: ['hello@verify-exp2.test'],
    });
    await addPlace('Salon, With "Quotes"', {
      domain: 'verify-exp3.test',
      emails: ['info@verify-exp3.test'],
    });
    await addPlace('No Phone Salon', {
      domain: 'verify-exp4.test',
      phone: null,
      emails: ['info@verify-exp4.test'],
    });
    await addPlace('Suppressed Salon', { domain: 'verify-exp5.test', emails: [SUPPRESSED_EMAIL] });
    await db.query(
      `INSERT INTO suppression (email_hash, domain, reason, source_file) VALUES ($1, 'verify-exp5.test', 'MANUAL', 'verify')`,
      [hashEmail(SUPPRESSED_EMAIL)],
    );
    await addPlace('Closed Salon', {
      domain: 'verify-exp6.test',
      status: 'CLOSED_TEMPORARILY',
      emails: ['info@verify-exp6.test'],
    });
    for (let i = 0; i < 3; i += 1)
      await addPlace(`Chain Branch ${i}`, {
        domain: 'verify-chainx.test',
        emails: i === 0 ? ['a@verify-chainx.test'] : [],
      });

    const request = exportRequestSchema.parse({ country: COUNTRY });
    const first = await service.exportCsv(request, null);
    if (first.batchId) batchIds.push(first.batchId);
    const body = first.csv.slice(UTF8_BOM.length);
    const lines = body.split('\r\n').filter((l) => l !== '');
    const rows = lines.slice(1).map(parseLine);

    check(
      'A. File starts with the UTF-8 BOM and uses CRLF only',
      first.csv.startsWith(UTF8_BOM) && !body.replace(/\r\n/g, '').includes('\n'),
      `BOM ${first.csv.startsWith(UTF8_BOM)}, ${lines.length} lines`,
    );
    check(
      'B. Header is exactly the mailer_v1 columns',
      lines[0] === 'business_name,email,phone,website,city,category,notes',
      lines[0] ?? '-',
    );
    check(
      'C. Only the 3 exportable businesses (no review, suppressed, closed or chain)',
      first.rowCount === 3 && rows.every((r) => r.length === 7),
      `${first.rowCount} rows: ${rows.map((r) => r[1]).join(', ')}`,
    );
    const greekRow = rows.find((r) => r[1] === 'info@verify-exp1.test');
    check(
      'D. Greek name intact, extra email in notes',
      greekRow?.[0] === 'Κομμωτήριο Ελένη' &&
        (greekRow?.[6] ?? '').endsWith('extra_emails=maria@verify-exp1.test'),
      `${greekRow?.[0]} | ${greekRow?.[6]}`,
    );
    const evilRow = rows.find((r) => r[1] === 'hello@verify-exp2.test');
    check(
      'E. A name starting with "=" is neutralised; quotes and commas survive',
      (evilRow?.[0] ?? '').startsWith("'=") &&
        rows.some((r) => r[0] === 'Salon, With "Quotes"') &&
        (greekRow?.[2] ?? '') === '+35799000101',
      `${evilRow?.[0]} ; phone ${greekRow?.[2]}`,
    );
    check(
      'F. Filename follows the spec',
      /^ainoviro_leads_\d{4}-\d{2}-\d{2}_ZZ_3\.csv$/.test(first.filename),
      first.filename,
    );

    const marked = await db.query<{ n: string }>(
      `SELECT count(*) AS n FROM emails e JOIN places p ON p.id = e.place_id
       WHERE p.country_code = $1 AND e.status = 'EXPORTED' AND e.export_batch_id = $2
         AND p.status = 'EXPORTED'`,
      [COUNTRY, first.batchId],
    );
    check(
      'G. The 3 rows are marked exported in one batch',
      first.batchId !== null && Number(marked.rows[0]?.n) === 3,
      `batch #${first.batchId}, marked ${marked.rows[0]?.n}`,
    );

    const second = await service.exportCsv(request, null);
    check(
      'H. A second click gives 0 new rows and no batch',
      second.rowCount === 0 && second.batchId === null,
      `${second.rowCount} rows, batch ${second.batchId ?? '-'}`,
    );

    const again = first.batchId ? await service.download(first.batchId) : null;
    check(
      'I. Re-download gives the same file',
      again?.csv === first.csv,
      again ? `${again.rowCount} rows, identical: ${again.csv === first.csv}` : 'not found',
    );

    const all = await service.exportCsv(
      exportRequestSchema.parse({ country: COUNTRY, scope: 'all' }),
      null,
    );
    check(
      'J. "Include already exported" gives the rows again without a new batch',
      all.rowCount === 3 && all.batchId === null,
      `${all.rowCount} rows, batch ${all.batchId ?? '-'}`,
    );

    // Someone already contacted one business: undo must not reset it.
    await db.query(`UPDATE places SET status = 'CONTACTED' WHERE id = $1`, [evil]);
    const undo = await service.undo(first.batchId as number, null);
    check(
      'K. Undo returns 2 rows to "new" and keeps the contacted one',
      undo.returned === 2 && undo.kept === 1,
      `returned ${undo.returned}, kept ${undo.kept}`,
    );

    const third = await service.exportCsv(request, null);
    if (third.batchId) batchIds.push(third.batchId);
    check(
      'L. After undo the next export has those 2 rows again',
      third.rowCount === 2 && third.batchId !== null && !third.csv.includes('verify-exp2.test'),
      `${third.rowCount} rows in batch #${third.batchId}`,
    );

    let refused = '';
    try {
      await service.undo(first.batchId as number, null);
    } catch (err) {
      refused = err instanceof AppError ? err.code : String(err);
    }
    check('M. The same batch cannot be undone twice', refused === 'BATCH_ALREADY_UNDONE', refused);

    const greekStill = await db.query<{ status: string }>(
      'SELECT status FROM places WHERE id = $1',
      [greek],
    );
    check(
      'N. Re-exported row is marked again',
      greekStill.rows[0]?.status === 'EXPORTED',
      `status ${greekStill.rows[0]?.status}`,
    );
  } finally {
    await cleanup(db, batchIds).catch((err: unknown) => console.error('cleanup failed:', err));
    await db.end();
  }
  console.log(`\n${passed}/${total} checks passed${passed === total ? '' : '  <- PROBLEM'}`);
  if (passed !== total) process.exitCode = 1;
}

main().catch((err: unknown) => {
  if (err instanceof EnvValidationError) console.error(err.message);
  else console.error('Verification failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});