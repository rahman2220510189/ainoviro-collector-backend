/**
 * Proves against the REAL database that the Settings page logic (step 3.6) works:
 * validation and safety limits, saving with an audit entry, the quota reload, and the
 * chain blocklist. Every setting is put back exactly as it was at the end, and the
 * test chain and audit rows are removed.
 *
 * Usage: npm run settings:verify
 */
import { Pool } from 'pg';
import { EnvValidationError, loadEnv } from '../src/config/env';
import { AppError } from '../src/lib/errors';
import type { QuotaSettings } from '../src/quota/settings';
import {
  SETTINGS_SECTIONS,
  SECTION_NAMES,
  createSettingsService,
} from '../src/services/settings-service';

const CHAIN = 'Verify Chain ZZ';

let passed = 0;
let total = 0;
function check(name: string, ok: boolean, detail: string): void {
  total += 1;
  if (ok) passed += 1;
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}  -> ${detail}`);
}

async function errorCode(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
    return 'no error';
  } catch (err) {
    return err instanceof AppError ? err.code : String(err);
  }
}

async function main(): Promise<void> {
  try {
    process.loadEnvFile('.env');
  } catch {
    // No .env file: rely on real environment variables.
  }
  const env = loadEnv();
  const db = new Pool({ connectionString: env.DATABASE_URL, max: 4 });
  const keys = SECTION_NAMES.map((s) => SETTINGS_SECTIONS[s].key);
  const original = await db.query<{ key: string; value: unknown; updated_at: Date }>(
    'SELECT key, value, updated_at FROM settings WHERE key = ANY($1::text[])',
    [keys],
  );
  const startedAt = new Date();
  const reloaded: QuotaSettings[] = [];
  const service = createSettingsService(db, { onQuotaChange: (s) => reloaded.push(s) });

  try {
    const all = await service.getAll();
    check(
      'A. All four sections load, with defaults',
      SECTION_NAMES.every(
        (s) => all.sections[s] && Object.keys(all.sections[s].defaults).length > 0,
      ),
      `quota free limit ${String(all.sections.quota.values.freeLimit)}, cooldown ${String(all.sections.search.values.cooldownDays)} days, ${all.chains.length} chains`,
    );

    const quota = all.sections.quota.values;
    const tooMany = await errorCode(() =>
      service.update('quota', { ...quota, freeLimit: 1_000_000 }, null),
    );
    const tooExpensive = await errorCode(() =>
      service.update('quota', { ...quota, monthlyHardCapEur: 10_000 }, null),
    );
    const wrongType = await errorCode(() =>
      service.update('search', { ...all.sections.search.values, cooldownDays: 'soon' }, null),
    );
    check(
      'B. Unsafe or wrong values are refused',
      tooMany === 'INVALID_SETTINGS' &&
        tooExpensive === 'INVALID_SETTINGS' &&
        wrongType === 'INVALID_SETTINGS',
      `free limit 1,000,000: ${tooMany}; cap 10,000 EUR: ${tooExpensive}; cooldown "soon": ${wrongType}`,
    );

    const search = all.sections.search.values as { cooldownDays: number };
    const newCooldown = search.cooldownDays === 30 ? 31 : 30;
    const saved = await service.update('search', { ...search, cooldownDays: newCooldown }, null);
    const auditRow = await db.query<{ details: { changed: Record<string, unknown> } }>(
      `SELECT details FROM audit_log WHERE action = 'settings.update' AND entity_id = 'search'
         AND created_at >= $1 ORDER BY id DESC LIMIT 1`,
      [startedAt],
    );
    check(
      'C. A valid change is saved and written to the audit log',
      saved.values.cooldownDays === newCooldown &&
        auditRow.rows[0]?.details.changed.cooldownDays !== undefined &&
        reloaded.length === 0,
      `cooldown ${search.cooldownDays} -> ${String(saved.values.cooldownDays)}, audit: ${JSON.stringify(auditRow.rows[0]?.details.changed ?? null)}`,
    );

    const warnAt = (quota.warnAt as number) === 0.8 ? 0.75 : 0.8;
    await service.update('quota', { ...quota, warnAt }, null);
    check(
      'D. Saving the quota reloads the running quota guard at once',
      reloaded.length === 1 && reloaded[0]?.warnAt === warnAt,
      `guard now warns at ${String(reloaded[0]?.warnAt)}`,
    );

    const added = await service.addChain(CHAIN, 'https://www.verify-chain-zz.test/', null);
    const entry = added.find((c) => c.name === CHAIN);
    const badDomain = await errorCode(() => service.addChain('Other', 'not a website', null));
    check(
      'E. Chain added (website cleaned to its domain); a bad website is refused',
      entry?.domain === 'verify-chain-zz.test' && badDomain === 'INVALID_CHAIN',
      `${entry?.name} (${entry?.domain}), bad website: ${badDomain}`,
    );

    const after = entry ? await service.removeChain(entry.id, null) : added;
    const missing = await errorCode(() => service.removeChain(entry?.id ?? 999_999, null));
    check(
      'F. Chain removed; removing it again says not found',
      !after.some((c) => c.name === CHAIN) && missing === 'CHAIN_NOT_FOUND',
      `${after.length} chains left, again: ${missing}`,
    );
  } finally {
    // Put every setting back exactly as it was, and remove the test traces.
    await db.query('DELETE FROM settings WHERE key = ANY($1::text[])', [keys]);
    for (const row of original.rows) {
      await db.query('INSERT INTO settings (key, value, updated_at) VALUES ($1, $2::jsonb, $3)', [
        row.key,
        JSON.stringify(row.value),
        row.updated_at,
      ]);
    }
    await db.query(`DELETE FROM chain_blocklist WHERE display_name = $1`, [CHAIN]);
    await db.query(
      `DELETE FROM audit_log WHERE actor_id IS NULL AND created_at >= $1
         AND action IN ('settings.update', 'chain.add', 'chain.remove')`,
      [startedAt],
    );
  }

  const restored = await db.query<{ key: string; value: unknown }>(
    'SELECT key, value FROM settings WHERE key = ANY($1::text[]) ORDER BY key',
    [keys],
  );
  const same =
    JSON.stringify(restored.rows.map((r) => [r.key, r.value])) ===
    JSON.stringify(
      [...original.rows].sort((a, b) => a.key.localeCompare(b.key)).map((r) => [r.key, r.value]),
    );
  check(
    'G. Every setting is back exactly as before',
    same,
    `${restored.rows.length} saved section(s) unchanged`,
  );
  await db.end();
  console.log(`\n${passed}/${total} checks passed${passed === total ? '' : '  <- PROBLEM'}`);
  if (passed !== total) process.exitCode = 1;
}

main().catch((err: unknown) => {
  if (err instanceof EnvValidationError) console.error(err.message);
  else console.error('Verification failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
