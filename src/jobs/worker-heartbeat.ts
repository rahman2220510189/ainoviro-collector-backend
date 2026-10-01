import type { Pool } from 'pg';
import type { RunMode } from './keys';

/** The worker writes this settings row every HEARTBEAT_SECONDS while it runs. */
export const WORKER_HEARTBEAT_KEY = 'worker_heartbeat';
export const HEARTBEAT_SECONDS = 30;
/** Older than this = the worker is not running (missed about three beats). */
export const HEARTBEAT_STALE_SECONDS = 100;

export interface WorkerHeartbeat {
  /** ISO time of the last beat. */
  at: string;
  mode: RunMode;
  /** Runs Google searches (off when real Google is not switched on). */
  searching: boolean;
  /** Crawls websites for emails. */
  crawling: boolean;
  concurrency: number;
}

export interface WorkerStatus {
  running: boolean;
  lastSeenAt: string | null;
  mode: RunMode | null;
  searching: boolean;
  crawling: boolean;
}

export async function writeHeartbeat(db: Pool, beat: Omit<WorkerHeartbeat, 'at'>): Promise<void> {
  const value: WorkerHeartbeat = { at: new Date().toISOString(), ...beat };
  await db.query(
    `INSERT INTO settings (key, value, updated_at) VALUES ($1, $2::jsonb, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [WORKER_HEARTBEAT_KEY, JSON.stringify(value)],
  );
}

/** Reads the last beat (any shape problem counts as "never seen"). */
export function workerStatusFrom(value: unknown, now: Date = new Date()): WorkerStatus {
  const beat = value as Partial<WorkerHeartbeat> | null | undefined;
  const at = typeof beat?.at === 'string' ? new Date(beat.at) : null;
  if (!at || Number.isNaN(at.getTime())) {
    return { running: false, lastSeenAt: null, mode: null, searching: false, crawling: false };
  }
  return {
    running: now.getTime() - at.getTime() < HEARTBEAT_STALE_SECONDS * 1000,
    lastSeenAt: at.toISOString(),
    mode: beat?.mode === 'LIVE' || beat?.mode === 'MOCK' ? beat.mode : null,
    searching: beat?.searching === true,
    crawling: beat?.crawling === true,
  };
}
