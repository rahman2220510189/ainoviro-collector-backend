/**
 * Crawls ONE website and prints what the crawler found. Nothing is saved.
 *
 *   npm run crawl:site -- --url http://127.0.0.1:5056/ --demo   (local demo site)
 *   npm run crawl:site -- --url https://example.com/              (a real website)
 *
 * --demo allows ONLY the local demo site (npm run dev:test-site) through the
 * private-address guard; every other address is still checked.
 */
import { parseArgs } from 'node:util';
import { Pool } from 'pg';
import { crawlSite } from '../crawler/crawl-site';
import {
  crawlerSettingsSchema,
  loadCrawlerSettings,
  type CrawlerSettings,
} from '../crawler/settings';
import { analyzeWebsite } from '../cleaning/website';
import { EnvValidationError, loadEnv } from '../config/env';
import { createPrismaClient } from '../db/prisma';
import { DEMO_SITE_DOMAIN, DEMO_SITE_ORIGIN } from '../dev/test-website';
import { loadFreeDomainSet } from '../enrich/crawl-queue';
import { evaluateSiteEmails } from '../enrich/evaluate';
import { MxChecker } from '../enrich/mx';
import { describeEvaluation } from '../enrich/report';

async function readConfig(): Promise<{ settings: CrawlerSettings; freeDomains: Set<string> }> {
  try {
    process.loadEnvFile('.env');
  } catch {
    // No .env file: defaults are used below.
  }
  try {
    const env = loadEnv();
    const prisma = createPrismaClient(env);
    const pool = new Pool({ connectionString: env.DATABASE_URL, max: 1 });
    try {
      return {
        settings: await loadCrawlerSettings(prisma),
        freeDomains: await loadFreeDomainSet(pool),
      };
    } finally {
      await prisma.$disconnect();
      await pool.end();
    }
  } catch (err) {
    if (err instanceof EnvValidationError)
      console.warn('(.env incomplete: using default crawler settings)');
    else console.warn('(database not reachable: using default crawler settings)');
    return { settings: crawlerSettingsSchema.parse({}), freeDomains: new Set() };
  }
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: { url: { type: 'string' }, demo: { type: 'boolean', default: false } },
  });
  if (!values.url) throw new Error('Missing --url, e.g. --url http://127.0.0.1:5056/ --demo');

  const { settings, freeDomains } = await readConfig();
  const started = Date.now();
  const result = await crawlSite(values.url, {
    settings,
    testOrigins: values.demo ? [DEMO_SITE_ORIGIN] : undefined,
  });
  const seconds = ((Date.now() - started) / 1000).toFixed(1);

  console.log(`\nWebsite: ${values.url}`);
  console.log(
    `  Result:      ${result.outcome}${result.error ? ` (${result.error.code}: ${result.error.message})` : ''}`,
  );
  if (result.error) console.log(`  Try later:   ${result.error.retryable ? 'yes' : 'no'}`);
  console.log(`  robots.txt:  ${result.robotsStatus ?? '-'}`);
  console.log(
    `  Requests:    ${result.requests} in ${seconds}s (pause ${settings.delayMs} ms between requests)`,
  );
  if (result.finalOrigin) console.log(`  Final site:  ${result.finalOrigin}`);
    if (result.outcome === 'DONE') {
    const how = {
      LINKS: 'link on the homepage',
      SITEMAP: 'found in sitemap.xml',
      GUESSED: 'common address tried directly',
      NONE: 'not found',
    }[result.contactSource ?? 'NONE'];
    console.log(`  Contact page: ${how}`);
  }
  if (result.looksJavaScriptRendered)
    console.log('  Note:        homepage looks JavaScript-rendered');

  if (result.pages.length > 0) {
    console.log(`  Pages (${result.pages.length}):`);
    for (const page of result.pages) {
      const kb = (Buffer.byteLength(page.html) / 1024).toFixed(1);
      console.log(`    ${page.kind.padEnd(8)} ${page.url}  (${kb} KB)`);
    }
    const evaluation = await evaluateSiteEmails(result.pages, {
      // The demo site runs on 127.0.0.1 but pretends to be "anna-beauty.test".
      websiteDomain: values.demo
        ? DEMO_SITE_DOMAIN
        : analyzeWebsite(result.finalOrigin ?? values.url).domain,
      freeDomains,
      mx: new MxChecker(),
    });
    console.log('  Emails (preview, NOT saved):');
    for (const line of describeEvaluation(evaluation)) console.log(line);
  }
  for (const problem of result.pageErrors)
    console.log(`  Page problem: ${problem.url} -> ${problem.message}`);
}

main().catch((err: unknown) => {
  console.error('Crawl failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});