/**
 * Prepares places for export (step 2.4), in this order:
 *   1. merges duplicate places (same own domain / phone nearby, or very similar name nearby);
 *   2. gives each place one primary subcategory (the CSV "category");
 *   3. marks chains (chain_blocklist, or one website domain on 3+ places);
 *   4. quality gate (needs_review + reasons) and lead score.
 * Safe to run any number of times. No website or paid API is contacted.
 *
 *   npm run places:process -- --dry-run      show what would change, save nothing
 *   npm run places:process                   apply
 *   npm run places:process -- --country CY --review 20   also list places that need review
 */
import { parseArgs } from 'node:util';
import { Pool } from 'pg';
import { EnvValidationError, loadEnv } from '../config/env';
import { runLeadPipeline, withPipelineLock } from '../leads/process';
import { loadLeadRules } from '../leads/rules';

const REASON_TEXT: Record<string, string> = {
  EMAIL_SYNTAX: 'email syntax invalid',
  EMAIL_NO_MX: 'email domain has no mail server',
  EMAIL_MX_UNKNOWN: 'mail server not checked yet',
  NO_REAL_CITY: 'no real city',
  NO_CATEGORY: 'no category',
  PHONE_INVALID: 'no valid phone',
};

async function main(): Promise<void> {
  try {
    process.loadEnvFile('.env');
  } catch {
    // No .env file: rely on real environment variables.
  }
  const { values } = parseArgs({
    options: {
      country: { type: 'string', default: 'CY' },
      'dry-run': { type: 'boolean', default: false },
      review: { type: 'string' },
    },
  });
  const countryCode = (values.country ?? 'CY').toUpperCase();
  const dryRun = values['dry-run'] ?? false;
  // Room for the lock connection plus the duplicate merges that run side by side.
  const db = new Pool({ connectionString: loadEnv().DATABASE_URL, max: 10 });

  try {
    const rules = await loadLeadRules(db);
    const say = (line: string): void => console.log(line);
    const s = await withPipelineLock(
      db,
      () => runLeadPipeline(db, countryCode, rules, dryRun, say),
      () =>
        say('  waiting: the worker is preparing the leads right now; this continues after it...'),
    );

    console.log(`\nPlaces in ${countryCode}${dryRun ? '  (dry run: nothing saved)' : ''}`);
    console.log(
      `\n1. Duplicates: ${s.dedupe.groups.length} group(s)` +
        (dryRun ? '' : `, ${s.dedupe.merged} place(s) merged away`),
    );
    for (const g of s.dedupe.groups.slice(0, 15)) {
      const names = g.ids.map((id) => `#${id} ${s.dedupe.names.get(id) ?? '?'}`).join('  +  ');
      console.log(`   [${g.reasons.join('+')}] ${names}`);
    }
    if (s.dedupe.groups.length > 15) console.log(`   ... ${s.dedupe.groups.length - 15} more`);
    if (s.dedupe.possible.length > 0) {
      console.log(
        `   Same phone but unrelated names (NOT merged, check by hand): ${s.dedupe.possible.length}`,
      );
      for (const p of s.dedupe.possible.slice(0, 15)) {
        const names = p.ids.map((id) => `#${id} ${s.dedupe.names.get(id) ?? '?'}`).join('  /  ');
        console.log(`   [?] ${names}`);
      }
    }

    console.log(`\n2. Primary category set for ${s.primarySubcategories} place(s)`);

    console.log(
      `\n3. Chains: ${s.chains.byBlocklist + s.chains.bySharedDomain} place(s) ` +
        `(blocklist ${s.chains.byBlocklist}, shared website ${s.chains.bySharedDomain}); ` +
        `changed ${s.chains.changed}`,
    );
    for (const [domain, n] of s.chains.domains.slice(0, 10))
      console.log(`   ${domain}: ${n} places`);

    const q = s.quality;
    console.log(`\n4. Quality gate (places with an email: ${q.withEmail})`);
    console.log(`   Passed:        ${q.passed}`);
    console.log(`   Needs review:  ${q.needsReview}`);
    for (const [reason, n] of Object.entries(q.reasons))
      console.log(`     - ${REASON_TEXT[reason] ?? reason}: ${n}`);
    if (q.scores.length > 0) {
      const sorted = [...q.scores].sort((a, b) => b - a);
      const median = sorted[Math.floor(sorted.length / 2)];
      console.log(
        `   Lead score:    highest ${sorted[0]}, median ${median}, lowest ${sorted[sorted.length - 1]}`,
      );
    }
    console.log(`   Rows changed:  ${q.changed}`);

    console.log(`\nReady for a "new only" export now: ${s.ready}`);
    if (dryRun) console.log('(dry run: the numbers above use the current chain flags)');

    const reviewLimit = values.review ? Math.max(1, Number(values.review) || 20) : 0;
    if (reviewLimit > 0 && !dryRun) {
      const { rows } = await db.query<{
        id: number;
        name: string;
        email: string;
        review_reasons: string[];
      }>(
        `SELECT p.id, p.name, e.email_normalized AS email, p.review_reasons
         FROM places p JOIN emails e ON e.place_id = p.id AND e.is_primary
         WHERE p.country_code = $1 AND p.needs_review ORDER BY p.score DESC, p.id LIMIT $2`,
        [countryCode, reviewLimit],
      );
      console.log(`\nNeeds review (${rows.length}):`);
      for (const r of rows)
        console.log(
          `  #${r.id} ${r.name}  <${r.email}>  ${r.review_reasons.map((x) => REASON_TEXT[x] ?? x).join(', ')}`,
        );
    }
  } finally {
    await db.end();
  }
}

main().catch((err: unknown) => {
  if (err instanceof EnvValidationError) console.error(err.message);
  else console.error('Processing failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
