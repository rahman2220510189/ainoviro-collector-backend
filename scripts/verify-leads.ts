/**
 * Proves against the REAL database that step 2.4 works: duplicate places merge into
 * one (sources, subcategories and emails move, one primary email, audit log written),
 * a merged Google id never creates the duplicate again, chains and the quality gate are
 * set, the score follows the rules, and a second run changes nothing.
 * Uses the fake country "ZZ" only; everything it creates is deleted at the end.
 * No website or paid API is contacted.
 *
 * Usage: npm run places:verify
 */
import { Pool } from 'pg';
import type { GooglePlace } from '../src/adapters/google-places';
import { EnvValidationError, loadEnv } from '../src/config/env';
import { writeGooglePlaces } from '../src/jobs/place-writer';
import { runLeadPipeline } from '../src/leads/process';
import { DEFAULT_LEAD_RULES } from '../src/leads/rules';

const COUNTRY = 'ZZ';
const DOMAIN = 'verify-ainoviro.test';
const LAT = 34.6786;
const LNG = 33.0413;

let passed = 0;
let total = 0;
function check(name: string, ok: boolean, detail: string): void {
  total += 1;
  if (ok) passed += 1;
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}  -> ${detail}`);
}

async function cleanup(db: Pool): Promise<void> {
  const { rows } = await db.query<{ id: number }>('SELECT id FROM places WHERE country_code = $1', [
    COUNTRY,
  ]);
  const ids = rows.map((r) => String(r.id));
  await db.query(`DELETE FROM emails WHERE domain LIKE '%verify-%.test'`);
  await db.query('DELETE FROM places WHERE country_code = $1', [COUNTRY]);
  await db.query(`DELETE FROM place_sources WHERE source_record_id LIKE 'verify-gid-%'`);
  await db.query(
    `DELETE FROM audit_log WHERE action = 'place.merge' AND (entity_id = ANY($1::text[])
       OR details::text LIKE '%verify-gid-%')`,
    [ids],
  );
}

interface NewPlace {
  name: string;
  lat?: number;
  lng?: number;
  domain?: string | null;
  phone?: string | null;
  gid?: string;
  city?: string;
}

async function insertPlace(db: Pool, subcategoryId: number, p: NewPlace): Promise<number> {
  const phone = p.phone === undefined ? '+35799000001' : p.phone;
  const { rows } = await db.query<{ id: number }>(
    `INSERT INTO places (name, name_normalized, country_code, city_name, lat, lng, website, website_domain,
                         phone_raw, phone_e164, phone_valid, google_place_id, business_status, updated_at)
     VALUES ($1, lower($1), $2, $3, $4, $5, $6, $7, $8, $8, $9, $10, 'OPERATIONAL', now())
     RETURNING id`,
    [
      p.name,
      COUNTRY,
      p.city ?? 'Limassol',
      p.lat ?? LAT,
      p.lng ?? LNG,
      p.domain ? `https://${p.domain}/` : null,
      p.domain ?? null,
      phone,
      phone !== null,
      p.gid ?? null,
    ],
  );
  const id = rows[0]?.id as number;
  if (p.gid)
    await db.query(
      `INSERT INTO place_sources (place_id, source, source_record_id) VALUES ($1, 'GOOGLE_PLACES', $2)`,
      [id, p.gid],
    );
  await db.query(
    `INSERT INTO place_subcategories (place_id, subcategory_id, matched_keyword, source)
     VALUES ($1, $2, 'verify', 'GOOGLE_PLACES')`,
    [id, subcategoryId],
  );
  return id;
}

async function insertEmail(
  db: Pool,
  placeId: number,
  email: string,
  opts: { primary: boolean; ownDomain: boolean; type: 'GENERIC' | 'PERSONAL' },
): Promise<void> {
  await db.query(
    `INSERT INTO emails (email, email_normalized, domain, place_id, is_primary, email_type, is_own_domain,
                         syntax_valid, mx_valid, source, updated_at)
     VALUES ($1, $1, split_part($1, '@', 2), $2, $3, $4::email_type, $5, true, true, 'mailto', now())`,
    [email, placeId, opts.primary, opts.type, opts.ownDomain],
  );
}

async function main(): Promise<void> {
  try {
    process.loadEnvFile('.env');
  } catch {
    // No .env file: rely on real environment variables.
  }
  const db = new Pool({ connectionString: loadEnv().DATABASE_URL, max: 3 });
  try {
    await cleanup(db);
    const sub = await db.query<{ id: number }>('SELECT id FROM subcategories ORDER BY id LIMIT 1');
    const subcategoryId = sub.rows[0]?.id;
    if (!subcategoryId) throw new Error('No subcategories: run npm run seed:categories first.');

    // Same business twice (same domain, 50 m apart), each with its own primary email.
    const a = await insertPlace(db, subcategoryId, {
      name: 'Verify Beauty',
      domain: DOMAIN,
      gid: 'verify-gid-a',
    });
    const b = await insertPlace(db, subcategoryId, {
      name: 'Verify Beauty Limassol',
      domain: DOMAIN,
      gid: 'verify-gid-b',
      lat: LAT + 0.00045,
    });
    await insertEmail(db, a, `info@${DOMAIN}`, { primary: true, ownDomain: true, type: 'GENERIC' });
    await insertEmail(db, b, `maria@${DOMAIN}`, {
      primary: true,
      ownDomain: true,
      type: 'PERSONAL',
    });
    // A different business next door.
    const c = await insertPlace(db, subcategoryId, {
      name: 'Other Nails Studio',
      phone: '+35799000002',
      lat: LAT + 0.0003,
    });
    // One company with three far-apart branches: a chain.
    const chain = [];
    for (let i = 0; i < 3; i += 1) {
      chain.push(
        await insertPlace(db, subcategoryId, {
          name: `Big Brand ${i}`,
          domain: 'verify-chain.test',
          phone: `+3579900001${i}`,
          lat: LAT + 0.05 * (i + 1),
        }),
      );
    }
    // A lead with problems: country as city, no phone.
    const g = await insertPlace(db, subcategoryId, {
      name: 'Problem Salon',
      city: 'Cyprus',
      phone: null,
      lat: LAT - 0.05,
    });
    await insertEmail(db, g, 'problem@verify-problem.test', {
      primary: true,
      ownDomain: false,
      type: 'PERSONAL',
    });

    const first = await runLeadPipeline(db, COUNTRY, DEFAULT_LEAD_RULES, false);

    check(
      'A. The two copies are found as one group',
      first.dedupe.groups.length === 1 &&
        first.dedupe.groups[0]?.ids.join() === `${a},${b}` &&
        first.dedupe.merged === 1,
      `groups ${first.dedupe.groups.map((x) => x.ids.join('+')).join(', ')}, merged ${first.dedupe.merged}`,
    );

    const left = await db.query<{ id: number }>('SELECT id FROM places WHERE id = ANY($1::int[])', [
      [a, b],
    ]);
    check(
      'B. The older place survives, the copy is deleted',
      left.rows.length === 1 && left.rows[0]?.id === a,
      `left: ${left.rows.map((r) => r.id).join(', ')}`,
    );

    const emails = await db.query<{ email_normalized: string; is_primary: boolean }>(
      'SELECT email_normalized, is_primary FROM emails WHERE place_id = $1 ORDER BY id',
      [a],
    );
    const primaries = emails.rows.filter((e) => e.is_primary);
    check(
      'C. Both emails moved, exactly one primary',
      emails.rows.length === 2 && primaries.length === 1,
      emails.rows.map((e) => `${e.email_normalized}${e.is_primary ? '*' : ''}`).join(', '),
    );

    const sources = await db.query<{ source_record_id: string; place_id: number }>(
      `SELECT source_record_id, place_id FROM place_sources WHERE source_record_id LIKE 'verify-gid-%'
       ORDER BY 1`,
    );
    check(
      'D. Both Google ids now point to the surviving place',
      sources.rows.length === 2 && sources.rows.every((s) => s.place_id === a),
      sources.rows.map((s) => `${s.source_record_id}->#${s.place_id}`).join(', '),
    );

    const audit = await db.query<{ details: { reasons: string[] } }>(
      `SELECT details FROM audit_log WHERE action = 'place.merge' AND entity_id = $1`,
      [String(a)],
    );
    check(
      'E. The merge is written to audit_log',
      audit.rows.length === 1 && (audit.rows[0]?.details.reasons ?? []).includes('DOMAIN'),
      `${audit.rows.length} entry, reasons ${audit.rows[0]?.details.reasons.join('+') ?? '-'}`,
    );

    const flags = await db.query<{
      id: number;
      is_chain: boolean;
      needs_review: boolean;
      review_reasons: string[];
      score: number;
    }>(
      'SELECT id, is_chain, needs_review, review_reasons, score FROM places WHERE country_code = $1',
      [COUNTRY],
    );
    const byId = new Map(flags.rows.map((r) => [r.id, r]));
    check(
      'F. The shop next door is untouched and not a chain',
      byId.has(c) && byId.get(c)?.is_chain === false,
      `#${c} exists: ${byId.has(c)}`,
    );
    check(
      'G. Three branches with one website are a chain (score -50)',
      chain.every(
        (id) => byId.get(id)?.is_chain === true && (byId.get(id)?.score ?? 0) === 15 + 10 + 10 - 50,
      ),
      chain
        .map((id) => `#${id} chain=${byId.get(id)?.is_chain} score=${byId.get(id)?.score}`)
        .join(', '),
    );
    check(
      'H. The problem lead needs review with the right reasons',
      byId.get(g)?.needs_review === true &&
        byId.get(g)?.review_reasons.join() === 'NO_REAL_CITY,PHONE_INVALID',
      `reasons: ${byId.get(g)?.review_reasons.join(', ') ?? '-'}`,
    );
    check(
      'I. The merged lead passes with score 65 (own email 30 + website 15 + phone 10 + open 10)',
      byId.get(a)?.needs_review === false && byId.get(a)?.score === 65,
      `needs_review=${byId.get(a)?.needs_review}, score=${byId.get(a)?.score}`,
    );

    const primarySub = await db.query<{ n: string }>(
      `SELECT count(*) AS n FROM place_subcategories ps JOIN places p ON p.id = ps.place_id
       WHERE p.country_code = $1 AND ps.is_primary`,
      [COUNTRY],
    );
    check(
      'J. Every place has exactly one primary category',
      Number(primarySub.rows[0]?.n) === flags.rows.length,
      `${primarySub.rows[0]?.n} primary for ${flags.rows.length} places`,
    );

    const second = await runLeadPipeline(db, COUNTRY, DEFAULT_LEAD_RULES, false);
    check(
      'K. A second run changes nothing',
      second.dedupe.groups.length === 0 &&
        second.chains.changed === 0 &&
        second.quality.changed === 0 &&
        second.primarySubcategories === 0,
      `groups ${second.dedupe.groups.length}, chain changes ${second.chains.changed}, ` +
        `quality changes ${second.quality.changed}`,
    );

    // Google returns the merged-away id again: it must update the survivor, not insert.
    const before = flags.rows.length;
    const again: GooglePlace = {
      googlePlaceId: 'verify-gid-b',
      name: 'Verify Beauty Limassol',
      address: null,
      lat: LAT + 0.00045,
      lng: LNG,
      website: `https://${DOMAIN}/`,
      phoneNational: null,
      phoneInternational: '+357 99 000001',
      businessStatus: 'OPERATIONAL',
      rating: null,
      ratingCount: null,
      types: [],
      primaryType: null,
    };
    const written = await writeGooglePlaces(db, [again], {
      countryCode: COUNTRY,
      cityId: null,
      subcategoryId,
      keyword: 'verify',
    });
    const after = await db.query<{ n: string }>(
      'SELECT count(*) AS n FROM places WHERE country_code = $1',
      [COUNTRY],
    );
    check(
      'L. A merged Google id found again does not create the duplicate',
      Number(after.rows[0]?.n) === before && written.inserted === 0 && written.updated === 1,
      `places ${before} -> ${after.rows[0]?.n}, inserted ${written.inserted}, updated ${written.updated}`,
    );
  } finally {
    await cleanup(db).catch(() => undefined);
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