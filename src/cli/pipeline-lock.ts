/**
 * Shows who holds the lead-pipeline lock (worker, export, a command), and can release it.
 * Older versions took a SESSION lock. Behind a connection pooler (Neon's "-pooler" address)
 * such a lock can stay on a shared server connection after the program has ended, and then
 * everything that needs the pipeline waits. The lock is now transaction-scoped and frees
 * itself; this command clears a lock left over from before (or from a crashed run).
 *
 *   npm run pipeline:lock              who holds it (read only)
 *   npm run pipeline:lock -- --release close the connections that hold it
 */
import { parseArgs } from 'node:util';
import { Pool } from 'pg';
import { EnvValidationError, loadEnv } from '../config/env';

async function main(): Promise<void> {
  try {
    process.loadEnvFile('.env');
  } catch {
    // No .env file: rely on real environment variables.
  }
  const { values } = parseArgs({ options: { release: { type: 'boolean', default: false } } });
  const url = loadEnv().DATABASE_URL;
  const db = new Pool({ connectionString: url, max: 1 });
  try {
    if (/-pooler\./.test(url)) {
      console.log("(The database address goes through Neon's connection pooler.)");
    }
    const me = await db.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
    const myPid = me.rows[0]?.pid;
    // Only this app takes advisory locks, and the pipeline lock is the only long one.
    const { rows } = await db.query<{
      pid: number;
      granted: boolean;
      state: string | null;
      backend_start: Date | null;
      state_change: Date | null;
      client_addr: string | null;
      query: string | null;
    }>(
      `SELECT l.pid, l.granted, a.state, a.backend_start, a.state_change,
              host(a.client_addr) AS client_addr, left(a.query, 120) AS query
       FROM pg_locks l
       LEFT JOIN pg_stat_activity a ON a.pid = l.pid
       WHERE l.locktype = 'advisory' AND l.objsubid = 1
         AND l.objid::text::bigint = (hashtext('ainoviro-lead-pipeline')::bigint & 4294967295)
       ORDER BY l.granted DESC, a.backend_start`,
    );
    const holders = rows.filter((r) => r.granted);
    const waiting = rows.filter((r) => !r.granted);
    if (rows.length === 0) {
      console.log('Nobody holds the lead-pipeline lock. Nothing is waiting.');
      return;
    }
    const age = (d: Date | null): string =>
      d ? `${Math.round((Date.now() - d.getTime()) / 60_000)} min ago` : '?';
    for (const r of holders) {
      console.log(
        `HOLDS  pid ${r.pid}  connected ${age(r.backend_start)}  last activity ${age(r.state_change)}  ` +
          `state ${r.state ?? '?'}  from ${r.client_addr ?? '?'}\n       last query: ${r.query ?? ''}`,
      );
    }
    for (const r of waiting) {
      console.log(`WAITS  pid ${r.pid}  since ${age(r.state_change)}`);
    }
    if (!values.release) {
      console.log(
        '\nIf the holder is not a worker or command that is really running now, release it:\n' +
          '  npm run pipeline:lock -- --release',
      );
      return;
    }
    for (const r of holders) {
      if (r.pid === myPid) {
        // The pooler handed this command the very connection that holds the left-over
        // lock: release it here instead of closing our own connection.
        await db.query('SELECT pg_advisory_unlock_all()');
        console.log(`pid ${r.pid}: lock released (it was left on a shared pooler connection)`);
        continue;
      }
      const res = await db.query<{ ok: boolean }>('SELECT pg_terminate_backend($1) AS ok', [r.pid]);
      console.log(`pid ${r.pid}: ${res.rows[0]?.ok ? 'closed, lock released' : 'could not close'}`);
    }
    const left = await db.query(
      `SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND objsubid = 1 AND granted
         AND objid::text::bigint = (hashtext('ainoviro-lead-pipeline')::bigint & 4294967295)`,
    );
    console.log(
      left.rowCount === 0
        ? 'The lead-pipeline lock is free now.'
        : 'The lock is still held. Run this again, or wait a minute and check.',
    );
  } finally {
    await db.end();
  }
}

main().catch((err: unknown) => {
  if (err instanceof EnvValidationError) console.error(err.message);
  else console.error('Failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
