/**
 * Proves against the REAL database that the online-shop check of step 6.3 works: a small
 * shop website on this computer (a cart and an Etsy shop link) is read once, robots.txt
 * respected, the business is marked "sells online", its lead score goes up, and the Leads
 * list and the CSV filter find it; a plain website is not marked. Uses the fake country
 * "ZZ"; everything is removed at the end. No real website is contacted.
 *
 * Usage: npm run shop:verify
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Pool } from 'pg';
import { EnvValidationError, loadEnv } from '../src/config/env';
import { loadCrawlerSettings } from '../src/crawler/settings';
import { createPrismaClient } from '../src/db/prisma';
import { claimNextShopCheck, runShopCheck } from '../src/enrich/shop-check';
import { createExportService } from '../src/export/export-service';
import { createLeadService, leadFiltersSchema } from '../src/leads/lead-service';
import { runLeadPipeline } from '../src/leads/process';
import { DEFAULT_LEAD_RULES } from '../src/leads/rules';

const COUNTRY = 'ZZ';

let passed = 0;
let total = 0;
function check(name: string, ok: boolean, detail: string): void {
  total += 1;
  if (ok) passed += 1;
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}  -> ${detail}`);
}

const SHOP_HTML =
  '<html><head><title>Ceramics</title></head><body><h1>Handmade ceramics</h1>' +
  '<a href="/cart">Cart</a><a href="https://www.etsy.com/shop/ZzCeramics">Our Etsy shop</a></body></html>';
const PLAIN_HTML = '<html><body><h1>Cafe</h1><a href="/contact">Contact</a></body></html>';

async function cleanup(db: Pool): Promise<void> {
  const ids = await db.query<{ id: number }>('SELECT id FROM places WHERE country_code = $1', [
    COUNTRY,
  ]);
  const placeIds = ids.rows.map((r) => r.id);
  await db.query('DELETE FROM emails WHERE place_id = ANY($1::int[])', [placeIds]);
  await db.query('DELETE FROM places WHERE country_code = $1', [COUNTRY]);
  await db.query(`DELETE FROM domain_shop_checks WHERE domain IN ('127.0.0.1', 'localhost')`);
}

async function main(): Promise<void> {
  try {
    process.loadEnvFile('.env');
  } catch {
    // No .env file: rely on real environment variables.
  }
  const env = loadEnv();
  const db = new Pool({ connectionString: env.DATABASE_URL, max: 4 });
  const prisma = createPrismaClient(env);
  const server: Server = createServer((req, res) => {
    if (req.url === '/robots.txt') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('User-agent: *\nAllow: /\n');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end((req.headers.host ?? '').startsWith('127.0.0.1') ? SHOP_HTML : PLAIN_HTML);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  const shopUrl = `http://127.0.0.1:${port}/`;
  const plainUrl = `http://localhost:${port}/`;
  try {
    await cleanup(db);
    const settings = await loadCrawlerSettings(prisma);
    const add = async (name: string, website: string, domain: string, email: string) => {
      const { rows } = await db.query<{ id: number }>(
        `INSERT INTO places (name, name_normalized, country_code, city_name, website, website_domain,
                             phone_valid, updated_at)
         VALUES ($1, lower($1), $2, 'Test City', $3, $4, true, now()) RETURNING id`,
        [name, COUNTRY, website, domain],
      );
      const id = rows[0]?.id as number;
      // A category, so the lead passes the quality gate and can go into a CSV.
      await db.query(
        `INSERT INTO place_subcategories (place_id, subcategory_id, source, is_primary)
         SELECT $1, id, 'OVERTURE', true FROM subcategories ORDER BY id LIMIT 1`,
        [id],
      );
      await db.query(
        `INSERT INTO emails (email, email_normalized, place_id, is_primary, email_type, is_own_domain,
                             syntax_valid, mx_valid, source, domain, updated_at)
         VALUES ($1, $1, $2, true, 'GENERIC', false, true, true, 'overture', split_part($1, '@', 2), now())`,
        [email, id],
      );
      return id;
    };
    const shopId = await add('ZZ Ceramics', shopUrl, '127.0.0.1', 'hello@zz-ceramics-verify.test');
    await add('ZZ Cafe', plainUrl, 'localhost', 'hello@zz-cafe-verify.test');
    await runLeadPipeline(db, COUNTRY, DEFAULT_LEAD_RULES, false);
    const before = await db.query<{ score: number }>('SELECT score FROM places WHERE id = $1', [
      shopId,
    ]);

    const origins = [`http://127.0.0.1:${port}`, `http://localhost:${port}`];
    const shop = await claimNextShopCheck(db, '127.0.0.1');
    const plain = await claimNextShopCheck(db, 'localhost');
    const shopFound = shop ? await runShopCheck(db, shop, settings, origins) : null;
    const plainFound = plain ? await runShopCheck(db, plain, settings, origins) : null;
    check(
      'A. A website with a cart and an Etsy shop sells online; a plain website does not',
      shopFound?.sellsOnline === true &&
        shopFound.signals.join() === 'cart,etsy' &&
        plainFound?.sellsOnline === false,
      `shop: ${JSON.stringify(shopFound)}; plain: ${JSON.stringify(plainFound)}`,
    );

    const again = await claimNextShopCheck(db, '127.0.0.1');
    check(
      'B. A checked website is not read again (until the recheck time)',
      again === null,
      again ? 'claimed again' : 'not claimed again',
    );

    await runLeadPipeline(db, COUNTRY, DEFAULT_LEAD_RULES, false);
    const after = await db.query<{ score: number }>('SELECT score FROM places WHERE id = $1', [
      shopId,
    ]);
    check(
      'C. The lead score goes up by the "sells online" points',
      (after.rows[0]?.score ?? 0) - (before.rows[0]?.score ?? 0) ===
        DEFAULT_LEAD_RULES.score.sellsOnline,
      `score ${before.rows[0]?.score} -> ${after.rows[0]?.score}`,
    );

    const leads = await createLeadService(db).list(
      leadFiltersSchema.parse({ country: COUNTRY, sellsOnline: 'yes' }),
    );
    const preview = await createExportService(db).preview({
      country: COUNTRY,
      sellsOnline: 'yes',
    } as never);
    check(
      'D. The Leads list and the CSV filter "sells online" find only that business',
      leads.total === 1 &&
        leads.items[0]?.name === 'ZZ Ceramics' &&
        leads.items[0]?.onlineSignals.join() === 'cart,etsy' &&
        preview.newRows === 1,
      `leads ${leads.total} (${leads.items.map((l) => l.name).join(', ')}), CSV rows ${preview.newRows}`,
    );
  } finally {
    server.close();
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
