/**
 * Brings the imported Overture places into the main tables (step 4.4), then runs the lead
 * pipeline: duplicates with Google places are merged, chains marked, scores computed.
 * Safe to run again after every new Overture import: nothing is stored twice.
 *
 *   npm run merge:overture -- --country CY --dry-run   count only, write nothing
 *   npm run merge:overture -- --country CY             save
 */
import { parseArgs } from 'node:util';
import { Pool } from 'pg';
import { EnvValidationError, loadEnv } from '../config/env';
import { mergeOverturePlaces } from '../datasets/merge-overture';
import { countReadyLeads, runLeadPipeline, withPipelineLock } from '../leads/process';
import { loadLeadRules } from '../leads/rules';

const pad = (n: number) => String(n).padStart(7);

async function main(): Promise<void> {
  try {
    process.loadEnvFile('.env');
  } catch {
    // No .env file: rely on real environment variables.
  }
  const { values } = parseArgs({
    options: {
      country: { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
      'no-pipeline': { type: 'boolean', default: false },
    },
  });
  const country = (values.country ?? '').toUpperCase();
  if (!/^[A-Z]{2}$/.test(country)) throw new Error('Say which country: --country CY');
  const dryRun = values['dry-run'];

  // Room for the lock connection plus the duplicate merges that run side by side.
  const db = new Pool({ connectionString: loadEnv().DATABASE_URL, max: 10 });
  const started = Date.now();
  try {
    const readyBefore = await countReadyLeads(db, country);
    const s = await mergeOverturePlaces(db, country, {
      dryRun,
      onProgress: (line) => console.log(line),
    });
    console.log('\nOverture places');
    console.log(`  in the import:                ${pad(s.stagingPlaces)}`);
    console.log(`  left out (not a business):    ${pad(s.skippedNotBusiness)}`);
    console.log(`  businesses without category:  ${pad(s.withoutCategory)}  (held for review)`);
    if (!dryRun) {
      console.log(`  new businesses saved:         ${pad(s.placesInserted)}`);
      console.log(
        `  businesses updated:           ${pad(s.placesUpdated + s.placesLinkedToMerged)}`,
      );
    }
    console.log('Emails');
    if (!dryRun) {
      console.log(`  new emails saved:             ${pad(s.emailsInserted)}`);
      console.log(`  already known (not doubled):  ${pad(s.emailsAlreadyKnown)}`);
      console.log(`  on the suppression list:      ${pad(s.emailsSuppressed)}  (never stored)`);
    }
    console.log(`  junk / not an address:        ${pad(s.emailsRejected)}`);
    console.log(
      `  domain has no mail server:    ${pad(s.emailsNoMailServer)}  (stored, held back)`,
    );
    console.log(`Websites left for the crawler:  ${pad(s.websitesForCrawler)}  (no email yet)`);

    if (!dryRun && !values['no-pipeline']) {
      console.log('\nLead pipeline: merging duplicates, chains, quality, scores...');
      const rules = await loadLeadRules(db);
      const say = (line: string): void => console.log(line);
      const p = await withPipelineLock(
        db,
        () => runLeadPipeline(db, country, rules, false, say),
        () =>
          say('  waiting: the worker is preparing the leads right now; this continues after it...'),
      );
      console.log(`  duplicates merged:            ${pad(p.dedupe.merged)}`);
      console.log(`  ready to download:            ${pad(readyBefore)} -> ${p.ready}`);
    }
    console.log(
      `\n${dryRun ? '(dry run: nothing was saved) ' : ''}${((Date.now() - started) / 1000).toFixed(0)} s`,
    );
  } finally {
    await db.end();
  }
}

main().catch((err: unknown) => {
  if (err instanceof EnvValidationError) console.error(err.message);
  else console.error('Overture merge failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
