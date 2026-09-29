/**
 * Crawls the websites of places that have no email yet and SAVES the emails found.
 * This contacts REAL websites (politely: robots.txt, 1.5 s pause, max 5 pages each).
 *
 *   npm run crawl:run -- --dry-run [--limit 20]   list the websites that are due (no requests)
 *   npm run crawl:run -- --limit 5                crawl at most 5 websites, then stop
 *   npm run crawl:run -- --domain ledi.cy         crawl one specific website
 *   npm run crawl:run -- --watch                  keep crawling new websites (Ctrl+C to stop)
 *   npm run crawl:run -- --recheck-no-email --limit 20
 *        also crawl again websites where no email was found before (skips the 90-day wait;
 *        used to measure improvements of the email finder)
 */
import { parseArgs } from 'node:util';
import { Pool } from 'pg';
import { loadCrawlerSettings } from '../crawler/settings';
import { EnvValidationError, loadEnv } from '../config/env';
import { createPrismaClient } from '../db/prisma';
import {
  claimNextDomain,
  countDueDomains,
  listDueDomains,
  loadFreeDomainSet,
  processDomain,
  type CrawlContext,
  type DomainOutcome,
  type QueueOptions,
} from '../enrich/crawl-queue';
import { MxChecker } from '../enrich/mx';
import { describeEvaluation } from '../enrich/report';

const WATCH_POLL_MS = 30_000;
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

interface Totals {
  websites: number;
  withEmail: number;
  withoutEmail: number;
  robotsBlocked: number;
  failed: number;
  newEmails: number;
  knownEmails: number;
  suppressed: number;
}

function printOutcome(n: number, outcome: DomainOutcome): void {
  const { claimed, crawl, evaluation, saved } = outcome;
  const status = crawl.error ? `${crawl.outcome} (${crawl.error.code})` : crawl.outcome;
  console.log(
    `\n[${n}] ${claimed.domain}  -> ${status}, ${crawl.pages.length} page(s), ${crawl.requests} request(s)`,
  );
  if (claimed.placeIds.length > 1) console.log(`    used by ${claimed.placeIds.length} places`);
  if (crawl.contactSource === 'SITEMAP' || crawl.contactSource === 'GUESSED')
    console.log(`    contact page found via ${crawl.contactSource.toLowerCase()}`);
  if (crawl.outcome === 'DONE' && crawl.looksJavaScriptRendered)
    console.log('    note: homepage looks JavaScript-rendered');
  if (crawl.outcome === 'DONE')
    for (const line of describeEvaluation(evaluation)) console.log(line);
  else if (crawl.error) console.log(`    reason: ${crawl.error.message}`);
  console.log(
    `    saved: ${saved.inserted} new, ${saved.alreadyKnown} already known, ${saved.suppressed} suppressed` +
      (saved.primary ? `; primary = ${saved.primary}` : ''),
  );
}

async function main(): Promise<void> {
  try {
    process.loadEnvFile('.env');
  } catch {
    // No .env file: rely on real environment variables.
  }
  const { values } = parseArgs({
    options: {
      limit: { type: 'string' },
      domain: { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
      watch: { type: 'boolean', default: false },
      'recheck-no-email': { type: 'boolean', default: false },
    },
  });
  const queue: QueueOptions = {
    onlyDomain: values.domain,
    // Only websites crawled before this run started, so none is crawled twice in one run.
    recheckNoEmailBefore: values['recheck-no-email'] ? new Date() : null,
  };
  const limit = values.limit ? Math.max(1, Number(values.limit) || 1) : values.domain ? 1 : null;
  if (!values['dry-run'] && !values.watch && limit === null) {
    throw new Error(
      'Say how many websites to crawl: --limit 5 (or --domain x.cy, --watch, --dry-run)',
    );
  }

  const env = loadEnv();
  const prisma = createPrismaClient(env);
  const settings = await loadCrawlerSettings(prisma);
  await prisma.$disconnect();
  const db = new Pool({ connectionString: env.DATABASE_URL, max: settings.concurrency + 2 });

  try {
    const due = await countDueDomains(db, queue);
    console.log(`Websites waiting for a crawl: ${due}`);

    if (values['dry-run']) {
      const domains = await listDueDomains(db, limit ?? 20, queue);
      for (const d of domains) console.log(`  - ${d}`);
      console.log('(dry run: no website was contacted)');
      return;
    }

    const ctx: CrawlContext = {
      db,
      settings,
      mx: new MxChecker(),
      freeDomains: await loadFreeDomainSet(db),
    };
    const totals: Totals = {
      websites: 0,
      withEmail: 0,
      withoutEmail: 0,
      robotsBlocked: 0,
      failed: 0,
      newEmails: 0,
      knownEmails: 0,
      suppressed: 0,
    };
    let stopping = false;
    process.on('SIGINT', () => {
      if (stopping) process.exit(1);
      stopping = true;
      console.log('\nStopping after the websites in progress... (Ctrl+C again to quit now)');
    });

    let started = 0;
    const loop = async (): Promise<void> => {
      while (!stopping && (limit === null || started < limit)) {
        started += 1;
        const claimed = await claimNextDomain(db, queue);
        if (!claimed) {
          started -= 1;
          if (!values.watch) return;
          await sleep(WATCH_POLL_MS);
          continue;
        }
        let outcome: DomainOutcome;
        try {
          outcome = await processDomain(ctx, claimed);
        } catch (err) {
          totals.failed += 1;
          console.error(
            `\n${claimed.domain}: unexpected error, will retry tomorrow:`,
            err instanceof Error ? err.message : err,
          );
          continue;
        }
        totals.websites += 1;
        if (outcome.crawl.outcome === 'ROBOTS_BLOCKED') totals.robotsBlocked += 1;
        else if (outcome.crawl.outcome === 'FAILED') totals.failed += 1;
        else if (outcome.evaluation.emails.length > 0) totals.withEmail += 1;
        else totals.withoutEmail += 1;
        totals.newEmails += outcome.saved.inserted;
        totals.knownEmails += outcome.saved.alreadyKnown;
        totals.suppressed += outcome.saved.suppressed;
        printOutcome(totals.websites, outcome);
      }
    };
    const parallel = Math.min(settings.concurrency, limit ?? settings.concurrency);
    console.log(
      `Crawling ${limit === null ? 'continuously' : `up to ${limit}`} website(s), ${parallel} at a time...`,
    );
    await Promise.all(Array.from({ length: parallel }, () => loop()));

    console.log('\nSummary');
    console.log(`  Websites crawled:  ${totals.websites}`);
    console.log(`  With email:        ${totals.withEmail}`);
    console.log(
      `  No email found:    ${totals.withoutEmail} (tried again after ${settings.retryWithoutEmailDays} days)`,
    );
    console.log(`  robots.txt said no:${String(totals.robotsBlocked).padStart(2)}`);
    console.log(`  Failed:            ${totals.failed}`);
    console.log(
      `  Emails: ${totals.newEmails} new, ${totals.knownEmails} already known, ${totals.suppressed} suppressed`,
    );
    console.log(`  Still waiting:     ${await countDueDomains(db, queue)}`);
  } finally {
    await db.end();
  }
}

main().catch((err: unknown) => {
  if (err instanceof EnvValidationError) console.error(err.message);
  else console.error('Crawl run failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});