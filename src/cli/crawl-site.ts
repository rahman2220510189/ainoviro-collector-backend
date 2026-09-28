/**
 * Crawls ONE website and prints what the crawler did. Nothing is saved.
 *
 *   npm run crawl:site -- --url http://127.0.0.1:5056/ --demo   (local demo site)
 *   npm run crawl:site -- --url https://example.com/              (a real website)
 *
 * --demo allows ONLY the local demo site (npm run dev:test-site) through the
 * private-address guard; every other address is still checked.
 */
import { parseArgs } from 'node:util';
import { crawlSite } from '../crawler/crawl-site';
import {
  crawlerSettingsSchema,
  loadCrawlerSettings,
  type CrawlerSettings,
} from '../crawler/settings';
import { EnvValidationError, loadEnv } from '../config/env';
import { createPrismaClient } from '../db/prisma';
import { extractEmails } from '../lib/email';
import { DEMO_SITE_ORIGIN } from '../dev/test-website';

async function readSettings(): Promise<CrawlerSettings> {
  try {
    process.loadEnvFile('.env');
  } catch {
    // No .env file: defaults are used below.
  }
  try {
    const prisma = createPrismaClient(loadEnv());
    try {
      return await loadCrawlerSettings(prisma);
    } finally {
      await prisma.$disconnect();
    }
  } catch (err) {
    if (err instanceof EnvValidationError)
      console.warn('(.env incomplete: using default crawler settings)');
    else console.warn('(database not reachable: using default crawler settings)');
    return crawlerSettingsSchema.parse({});
  }
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: { url: { type: 'string' }, demo: { type: 'boolean', default: false } },
  });
  if (!values.url) throw new Error('Missing --url, e.g. --url http://127.0.0.1:5056/ --demo');

  const settings = await readSettings();
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
  if (result.looksJavaScriptRendered)
    console.log('  Note:        homepage looks JavaScript-rendered');

  if (result.pages.length > 0) {
    console.log(`  Pages (${result.pages.length}):`);
    for (const page of result.pages) {
      const kb = (Buffer.byteLength(page.html) / 1024).toFixed(1);
      console.log(`    ${page.kind.padEnd(8)} ${page.url}  (${kb} KB)`);
    }
    // Quick preview only; the real extraction (obfuscation, filters, classification) is step 2.3.
    const emails = [...new Set(result.pages.flatMap((p) => extractEmails(p.html)))];
    console.log(
      `  Email-like text seen (preview): ${emails.length > 0 ? emails.join(', ') : 'none'}`,
    );
  }
  for (const problem of result.pageErrors)
    console.log(`  Page problem: ${problem.url} -> ${problem.message}`);
}

main().catch((err: unknown) => {
  console.error('Crawl failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});