/**
 * How much would Foursquare really add on top of what we already have? Read only.
 * Compares the imported Foursquare places of a country with the main tables:
 * own websites we do not know yet (the crawler could find emails there), emails we do
 * not have yet, and how many of those are in business categories (not parks, roads,
 * government buildings or villages).
 *
 *   npm run foursquare:overlap -- --country CY
 */
import { parseArgs } from 'node:util';
import { Pool } from 'pg';
import { analyzeWebsite } from '../cleaning/website';
import { EnvValidationError, loadEnv } from '../config/env';
import { normalizeEmail } from '../lib/email';

/** Top-level Foursquare categories that are mostly not businesses. */
const NOT_BUSINESS_TOPS = new Set(['Landmarks and Outdoors', 'Community and Government', 'Event']);

async function main(): Promise<void> {
  try {
    process.loadEnvFile('.env');
  } catch {
    // No .env file: rely on real environment variables.
  }
  const { values } = parseArgs({ options: { country: { type: 'string' } } });
  const country = (values.country ?? '').toUpperCase();
  if (!/^[A-Z]{2}$/.test(country)) throw new Error('Say which country: --country CY');

  const db = new Pool({ connectionString: loadEnv().DATABASE_URL, max: 2 });
  try {
    const [fsq, domains, emails] = await Promise.all([
      db.query<{ website: string | null; email: string | null; top: string | null }>(
        `SELECT website, email, split_part(category_labels[1], ' > ', 1) AS top
         FROM stg_fsq_places WHERE country_code = $1`,
        [country],
      ),
      db.query<{ d: string }>(
        `SELECT DISTINCT website_domain AS d FROM places
         WHERE country_code = $1 AND website_domain IS NOT NULL`,
        [country],
      ),
      db.query<{ e: string }>(
        `SELECT e.email_normalized AS e FROM emails e JOIN places p ON p.id = e.place_id
         WHERE p.country_code = $1`,
        [country],
      ),
    ]);
    if (fsq.rows.length === 0) {
      throw new Error(`No Foursquare places for ${country}. Run import:foursquare first.`);
    }
    const knownDomains = new Set(domains.rows.map((r) => r.d));
    const knownEmails = new Set(emails.rows.map((r) => r.e));

    let business = 0;
    let ownSite = 0;
    let platformOnly = 0;
    let newSite = 0;
    let newSiteBusiness = 0;
    let withEmail = 0;
    let newEmail = 0;
    const newDomains = new Set<string>();
    for (const r of fsq.rows) {
      const isBusiness = !NOT_BUSINESS_TOPS.has(r.top ?? '');
      if (isBusiness) business += 1;
      const site = analyzeWebsite(r.website);
      if (site.platform) platformOnly += 1;
      if (site.domain) {
        ownSite += 1;
        if (!knownDomains.has(site.domain)) {
          newSite += 1;
          if (isBusiness) {
            newSiteBusiness += 1;
            newDomains.add(site.domain);
          }
        }
      }
      const email = r.email ? normalizeEmail(r.email) : null;
      if (email) {
        withEmail += 1;
        if (!knownEmails.has(email)) newEmail += 1;
      }
    }
    const pad = (n: number) => String(n).padStart(7);
    console.log(`Foursquare places in ${country}:            ${pad(fsq.rows.length)}`);
    console.log(`  in business categories:              ${pad(business)}`);
    console.log(`  with their own website:              ${pad(ownSite)}`);
    console.log(`  only a Facebook/Instagram link:      ${pad(platformOnly)}`);
    console.log(`  website we do NOT know yet:          ${pad(newSite)}`);
    console.log(
      `    of them businesses (distinct sites): ${pad(newDomains.size)}  <- crawler could find emails here`,
    );
    console.log(`  with an email:                       ${pad(withEmail)}`);
    console.log(`    email we do NOT have yet:          ${pad(newEmail)}`);
    console.log(
      `\nWe already know ${knownDomains.size} websites and ${knownEmails.size} emails in ${country}.`,
    );
    if (newSiteBusiness === 0) console.log('Foursquare adds no new business websites.');
  } finally {
    await db.end();
  }
}

main().catch((err: unknown) => {
  if (err instanceof EnvValidationError) console.error(err.message);
  else console.error('Failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
