/**
 * Proves against the REAL database that the leads API logic (step 3.2) works: filters,
 * detail with history, status change with audit entry, bulk reject, and GDPR erasure
 * (emails deleted, a hash kept in suppression so the address is never collected again).
 * Uses the fake country "ZZ" only; everything it creates is deleted at the end.
 *
 * Usage: npm run leads:verify
 */
import { Pool } from 'pg';
import { EnvValidationError, loadEnv } from '../src/config/env';
import { createLeadService, leadFiltersSchema } from '../src/leads/lead-service';
import { hashEmail } from '../src/lib/email';

const COUNTRY = 'ZZ';
const EMAILS = ['info@verify-lead1.test', 'maria@verify-lead1.test', 'hello@verify-lead2.test'];

let passed = 0;
let total = 0;
function check(name: string, ok: boolean, detail: string): void {
  total += 1;
  if (ok) passed += 1;
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}  -> ${detail}`);
}

async function cleanup(db: Pool): Promise<void> {
  const ids = await db.query<{ id: number }>('SELECT id FROM places WHERE country_code = $1', [
    COUNTRY,
  ]);
  await db.query(
    `DELETE FROM audit_log WHERE entity_type = 'place' AND entity_id = ANY($1::text[])`,
    [ids.rows.map((r) => String(r.id))],
  );
  await db.query(`DELETE FROM emails WHERE domain LIKE 'verify-lead%.test'`);
  await db.query('DELETE FROM places WHERE country_code = $1', [COUNTRY]);
  await db.query('DELETE FROM suppression WHERE email_hash = ANY($1::text[])', [
    EMAILS.map(hashEmail),
  ]);
}

async function addPlace(
  db: Pool,
  name: string,
  opts: { review?: boolean; emails?: string[]; exported?: boolean },
): Promise<number> {
  const { rows } = await db.query<{ id: number }>(
    `INSERT INTO places (name, name_normalized, country_code, city_name, phone_raw, phone_e164, phone_valid,
                         score, needs_review, review_reasons, business_status, updated_at)
     VALUES ($1, lower($1), $2, 'Limassol', '+35799000201', '+35799000201', true, 65, $3, $4, 'OPERATIONAL', now())
     RETURNING id`,
    [name, COUNTRY, opts.review ?? false, opts.review ? ['EMAIL_NO_MX'] : []],
  );
  const id = rows[0]?.id as number;
  for (const [i, email] of (opts.emails ?? []).entries()) {
    await db.query(
      `INSERT INTO emails (email, email_normalized, domain, place_id, is_primary, email_type, is_own_domain,
                           syntax_valid, mx_valid, source, exported_at, status, updated_at)
       VALUES ($1, $1, split_part($1, '@', 2), $2, $3, 'GENERIC', true, true, true, 'mailto', $4, $5, now())`,
      [email, id, i === 0, opts.exported ? new Date() : null, opts.exported ? 'EXPORTED' : 'NEW'],
    );
  }
  return id;
}

async function main(): Promise<void> {
  try {
    process.loadEnvFile('.env');
  } catch {
    // No .env file: rely on real environment variables.
  }
  const db = new Pool({ connectionString: loadEnv().DATABASE_URL, max: 3 });
  const leads = createLeadService(db);
  const f = (q: Record<string, string>) => leadFiltersSchema.parse({ country: COUNTRY, ...q });
  try {
    await cleanup(db);
    const a = await addPlace(db, 'Verify Lead One', { emails: [EMAILS[0] ?? '', EMAILS[1] ?? ''] });
    const b = await addPlace(db, 'Verify Lead Two', {
      emails: [EMAILS[2] ?? ''],
      review: true,
      exported: true,
    });
    await addPlace(db, 'Verify No Email', {});

    const all = await leads.list(f({}));
    check(
      'A. Default list: only businesses with an email',
      all.total === 2 && all.items.every((i) => i.email !== null),
      `${all.total} rows: ${all.items.map((i) => i.name).join(', ')}`,
    );
    const any = await leads.list(f({ hasEmail: 'any' }));
    check('B. hasEmail=any shows all places', any.total === 3, `${any.total} rows`);

    const review = await leads.list(f({ needsReview: 'yes' }));
    const fresh = await leads.list(f({ exported: 'new' }));
    const search = await leads.list(f({ q: 'maria@' }));
    check(
      'C. Filters: need review / not exported / search by email',
      review.items.map((i) => i.id).join() === String(b) &&
        fresh.items.map((i) => i.id).join() === String(a) &&
        search.items.map((i) => i.id).join() === String(a),
      `review ${review.total}, new ${fresh.total}, search ${search.total}`,
    );
    check(
      'D. Row shows extra-email count and review reasons',
      all.items.find((i) => i.id === a)?.extraEmails === 1 &&
        (all.items.find((i) => i.id === b)?.reviewReasons ?? []).join() === 'EMAIL_NO_MX',
      `extra ${all.items.find((i) => i.id === a)?.extraEmails}`,
    );

    const changed = await leads.setStatus(a, 'CONTACTED', null);
    check(
      'E. Status change is saved and appears in the history',
      changed.status === 'CONTACTED' && changed.history.some((h) => h.action === 'lead.status'),
      `status ${changed.status}, history ${changed.history.map((h) => h.action).join(', ')}`,
    );

    const bulk = await leads.bulkReject([a, b], null);
    const afterBulk = await leads.list(f({ status: 'REJECTED' }));
    check(
      'F. Bulk reject',
      bulk.rejected === 2 && afterBulk.total === 2,
      `rejected ${bulk.rejected}`,
    );

    const erased = await leads.erase(a, null);
    const detail = await leads.get(a);
    const suppressed = await db.query<{ n: string }>(
      `SELECT count(*) AS n FROM suppression WHERE email_hash = ANY($1::text[]) AND reason = 'ERASED'`,
      [[hashEmail(EMAILS[0] ?? ''), hashEmail(EMAILS[1] ?? '')]],
    );
    check(
      'G. Erasure: emails and phone gone, both hashes kept in suppression',
      erased.emailsErased === 2 &&
        detail?.emails.length === 0 &&
        detail.phone === null &&
        Number(suppressed.rows[0]?.n) === 2,
      `erased ${erased.emailsErased}, emails left ${detail?.emails.length}, phone ${detail?.phone}, suppressed ${suppressed.rows[0]?.n}`,
    );

    let notFound = '';
    try {
      await leads.setStatus(999_999_999, 'REJECTED', null);
    } catch (err) {
      notFound = err instanceof Error ? err.message : String(err);
    }
    check('H. Unknown lead is refused', notFound.includes('not found'), notFound);
  } finally {
    await cleanup(db).catch((err: unknown) => console.error('cleanup failed:', err));
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
