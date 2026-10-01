/**
 * Proves against the REAL database that the suppression page logic (step 3.3) works:
 * add one address, import a CSV, and import mailer results (bounces and unsubscribes
 * are blocked, replies and onboardings move the lead forward, never backward).
 * Uses the fake country "ZZ" and "verify-sup*.test" addresses; all removed at the end.
 *
 * Usage: npm run suppression:verify
 */
import { Pool } from 'pg';
import { EnvValidationError, loadEnv } from '../src/config/env';
import { createPrismaClient } from '../src/db/prisma';
import { createSuppressionService } from '../src/services/suppression-service';

const COUNTRY = 'ZZ';
const FILES = ['manual (web)', 'verify-old.csv', 'verify-results.csv', 'verify-results-2.csv'];

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
    `DELETE FROM audit_log WHERE (entity_type = 'place' AND entity_id = ANY($1::text[]))
       OR (action = 'mailer.import' AND details->>'file' LIKE 'verify-%')`,
    [ids.rows.map((r) => String(r.id))],
  );
  await db.query(`DELETE FROM emails WHERE domain LIKE 'verify-sup%.test'`);
  await db.query('DELETE FROM places WHERE country_code = $1', [COUNTRY]);
  await db.query(
    `DELETE FROM suppression WHERE domain LIKE 'verify-sup%.test' AND source_file = ANY($1::text[])`,
    [FILES],
  );
}

async function addLead(db: Pool, email: string, status: string): Promise<number> {
  const { rows } = await db.query<{ id: number }>(
    `INSERT INTO places (name, name_normalized, country_code, status, updated_at)
     VALUES ($1, lower($1), $2, $3::place_status, now()) RETURNING id`,
    [`Verify ${email}`, COUNTRY, status],
  );
  const id = rows[0]?.id as number;
  await db.query(
    `INSERT INTO emails (email, email_normalized, domain, place_id, is_primary, email_type, source,
                         status, exported_at, updated_at)
     VALUES ($1, $1, split_part($1, '@', 2), $2, true, 'GENERIC', 'mailto', 'EXPORTED', now(), now())`,
    [email, id],
  );
  return id;
}

async function main(): Promise<void> {
  try {
    process.loadEnvFile('.env');
  } catch {
    // No .env file: rely on real environment variables.
  }
  const env = loadEnv();
  const db = new Pool({ connectionString: env.DATABASE_URL, max: 3 });
  const prisma = createPrismaClient(env);
  const service = createSuppressionService(prisma, db);
  try {
    await cleanup(db);
    const bounced = await addLead(db, 'a@verify-sup1.test', 'EXPORTED');
    const replied = await addLead(db, 'b@verify-sup2.test', 'EXPORTED');
    const onboarded = await addLead(db, 'c@verify-sup4.test', 'ONBOARDED');

    const first = await service.add('Manual@Verify-Sup3.test', 'MANUAL');
    const again = await service.add('manual@verify-sup3.test', 'MANUAL');
    check(
      'A. Add one address; adding it again changes nothing',
      first.inserted === 1 && again.alreadySuppressed === 1,
      `first inserted ${first.inserted}, again already ${again.alreadySuppressed}`,
    );

    const csv = await service.importCsv({
      csv: 'Name;E-mail\r\nOne;x1@verify-sup5.test\r\nTwo;not an email\r\nThree;X1@verify-sup5.test\r\nFour;x2@verify-sup5.test\r\n',
      column: 'e-mail',
      reason: 'EXISTING_CONTACT',
      filename: 'verify-old.csv',
    });
    check(
      'B. CSV import: 2 added, 1 duplicate, 1 invalid shown',
      csv.inserted === 2 &&
        csv.duplicatesInFile === 1 &&
        csv.invalid === 1 &&
        csv.invalidExamples[0] === 'not an email',
      `inserted ${csv.inserted}, duplicates ${csv.duplicatesInFile}, invalid ${csv.invalid}`,
    );

    const result = await service.importMailerResults({
      csv:
        'email,status,date\n' +
        'a@verify-sup1.test,bounced,2026-10-01\n' +
        'b@verify-sup2.test,replied,\n' +
        'c@verify-sup4.test,replied,\n' +
        'nobody@verify-sup6.test,unsubscribed,\n' +
        'x2@verify-sup5.test,unsubscribed,\n' +
        'a@verify-sup1.test,opened,\n',
      filename: 'verify-results.csv',
    });
    check(
      'C. Mailer import summary',
      result.byStatus.bounced === 1 &&
        result.byStatus.unsubscribed === 2 &&
        result.byStatus.replied === 2 &&
        result.unknownEmails === 2 &&
        result.unknownStatuses.join() === 'opened',
      JSON.stringify(result.byStatus) +
        ` unknown emails ${result.unknownEmails}, unknown statuses ${result.unknownStatuses.join()}`,
    );

    const bouncedRow = await db.query<{ status: string; bounced_at: Date | null; reason: string }>(
      `SELECT e.status, e.bounced_at, s.reason FROM emails e
       JOIN suppression s ON s.email_hash = encode(sha256(convert_to(e.email_normalized, 'UTF8')), 'hex')
       WHERE e.place_id = $1`,
      [bounced],
    );
    check(
      'D. Bounce: email marked BOUNCED with its date, address blocked',
      bouncedRow.rows[0]?.status === 'BOUNCED' &&
        bouncedRow.rows[0]?.bounced_at?.toISOString().startsWith('2026-10-01') === true &&
        bouncedRow.rows[0]?.reason === 'BOUNCED',
      JSON.stringify(bouncedRow.rows[0] ?? null),
    );

    const statuses = await db.query<{ id: number; status: string }>(
      'SELECT id, status FROM places WHERE id = ANY($1::int[])',
      [[replied, onboarded]],
    );
    const statusOf = (id: number) => statuses.rows.find((r) => r.id === id)?.status;
    check(
      'E. Reply moves the lead forward, but never back from Onboarded',
      statusOf(replied) === 'REPLIED' &&
        statusOf(onboarded) === 'ONBOARDED' &&
        result.leadsUpdated === 1,
      `replied lead ${statusOf(replied)}, onboarded lead ${statusOf(onboarded)}, updated ${result.leadsUpdated}`,
    );

    const upgraded = await db.query<{ reason: string }>(
      `SELECT reason FROM suppression WHERE email_normalized = 'x2@verify-sup5.test'`,
    );
    const unknown = await db.query<{ reason: string }>(
      `SELECT reason FROM suppression WHERE email_normalized = 'nobody@verify-sup6.test'`,
    );
    check(
      'F. Unsubscribe upgrades an existing entry and blocks an unknown address too',
      upgraded.rows[0]?.reason === 'UNSUBSCRIBED' && unknown.rows[0]?.reason === 'UNSUBSCRIBED',
      `existing -> ${upgraded.rows[0]?.reason}, unknown -> ${unknown.rows[0]?.reason}`,
    );

    const list = await service.list({ q: 'verify-sup5', page: 1, pageSize: 50 });
    const byReason = await service.list({
      reason: 'BOUNCED',
      q: 'verify-sup1',
      page: 1,
      pageSize: 50,
    });
    check(
      'G. List search and reason filter',
      list.total === 2 && byReason.total === 1 && (list.counts.UNSUBSCRIBED ?? 0) >= 2,
      `search ${list.total}, bounced ${byReason.total}`,
    );

    const repeat = await service.importMailerResults({
      csv: 'email,status\nb@verify-sup2.test,replied\na@verify-sup1.test,bounced\n',
      filename: 'verify-results-2.csv',
    });
    check(
      'H. Importing the same results again changes nothing',
      repeat.leadsUpdated === 0 && repeat.suppressed === 0,
      `updated ${repeat.leadsUpdated}, suppressed ${repeat.suppressed}`,
    );
  } finally {
    await cleanup(db).catch((err: unknown) => console.error('cleanup failed:', err));
    await db.end();
    await prisma.$disconnect();
  }
  console.log(`\n${passed}/${total} checks passed${passed === total ? '' : '  <- PROBLEM'}`);
  if (passed !== total) process.exitCode = 1;
}

main().catch((err: unknown) => {
  if (err instanceof EnvValidationError) console.error(err.message);
  else console.error('Verification failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
