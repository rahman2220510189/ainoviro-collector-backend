/**
 * Lists every Overture category found in one country's imported places, with counts,
 * into a CSV file (used to build the category mapping, step 4.3). Read only.
 *
 *   npm run overture:categories -- --country CY
 *   -> data/overture-categories-CY.csv
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
      taxonomy_primary: string | null;
      basic_category: string | null;
      hierarchy: string | null;
      places: string;
      with_website: string;
      with_email: string;
    }>(
      `SELECT taxonomy_primary, basic_category,
              array_to_string(taxonomy_hierarchy, ' > ') AS hierarchy,
              count(*) AS places,
              count(*) FILTER (WHERE cardinality(websites) > 0) AS with_website,
              count(*) FILTER (WHERE cardinality(emails) > 0) AS with_email
       FROM stg_overture_places WHERE country_code = $1
       GROUP BY 1, 2, 3 ORDER BY count(*) DESC, 1`,
      [country],
    );
    if (rows.length === 0) {
      throw new Error(
        `No Overture places for ${country}. Run: npm run import:overture -- --country ${country}`,
      );
    }
    const header = [
      'taxonomy_primary',
      'basic_category',
      'hierarchy',
      'places',
      'with_website',
      'with_email',
    ];
    const csv = toCsv(
      header,
      rows.map((r) => [
        r.taxonomy_primary ?? '',
        r.basic_category ?? '',
        r.hierarchy ?? '',
        r.places,
        r.with_website,
        r.with_email,
      ]),
    );
    const dir = path.join(process.cwd(), 'data');
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `overture-categories-${country}.csv`);
    writeFileSync(file, csv, 'utf8');
    const total = rows.reduce((n, r) => n + Number(r.places), 0);
    console.log(`${rows.length} categories, ${total} places`);
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
