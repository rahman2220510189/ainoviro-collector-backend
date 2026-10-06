/**
 * Lists every Foursquare category found in one country's imported places, with counts,
 * into a CSV file (used to build the category rules, step 4.6b). Read only.
 * A place with several categories is counted under each of them.
 *
 *   npm run foursquare:categories -- --country CY
 *   -> data/foursquare-categories-CY.csv
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { Pool } from 'pg';
import { EnvValidationError, loadEnv } from '../config/env';
import { toCsv } from '../export/csv';

async function main(): Promise<void> {
  try {
    process.loadEnvFile('.env');
  } catch {
    // No .env file: rely on real environment variables.
  }
  const { values } = parseArgs({ options: { country: { type: 'string' } } });
  const country = (values.country ?? '').toUpperCase();
  if (!/^[A-Z]{2}$/.test(country)) throw new Error('Say which country: --country CY');

  const db = new Pool({ connectionString: loadEnv().DATABASE_URL, max: 1 });
  try {
    const { rows } = await db.query<{
      label: string;
      first_places: string;
      places: string;
      with_website: string;
      with_email: string;
    }>(
      `SELECT coalesce(l.label, '(no category)') AS label,
              count(*) FILTER (WHERE l.n = 1 OR l.n IS NULL) AS first_places,
              count(*) AS places,
              count(*) FILTER (WHERE s.website IS NOT NULL) AS with_website,
              count(*) FILTER (WHERE s.email IS NOT NULL) AS with_email
       FROM stg_fsq_places s
       LEFT JOIN LATERAL unnest(s.category_labels) WITH ORDINALITY AS l(label, n) ON true
       WHERE s.country_code = $1
       GROUP BY 1 ORDER BY count(*) DESC, 1`,
      [country],
    );
    if (rows.length === 0) {
      throw new Error(
        `No Foursquare places for ${country}. Run: npm run import:foursquare -- --country ${country}`,
      );
    }
    const csv = toCsv(
      ['category', 'places', 'as_first_category', 'with_website', 'with_email'],
      rows.map((r) => [r.label, r.places, r.first_places, r.with_website, r.with_email]),
    );
    const dir = path.join(process.cwd(), 'data');
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `foursquare-categories-${country}.csv`);
    writeFileSync(file, csv, 'utf8');
    const total = await db.query<{ n: string }>(
      'SELECT count(*) AS n FROM stg_fsq_places WHERE country_code = $1',
      [country],
    );
    console.log(`${rows.length} categories, ${total.rows[0]?.n ?? 0} places`);
    console.log(`Saved: ${file}`);
  } finally {
    await db.end();
  }
}

main().catch((err: unknown) => {
  if (err instanceof EnvValidationError) console.error(err.message);
  else console.error('Failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
