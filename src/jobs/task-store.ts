import type { Pool } from 'pg';
import type { Bbox } from '../geonames/build';
import { childPath, discoveryTaskKey, type RunMode, type TaskTile } from './keys';

export type ClaimedTask = {
  id: number;
  jobId: number;
  keyword: string;
  language: string;
  subcategoryId: number;
  depth: number;
  tile: TaskTile;
  locationId: number | null;
};

type TaskRow = {
  id: number;
  job_id: number;
  keyword: string | null;
  language: string | null;
  subcategory_id: number | null;
  depth: number;
  tile: TaskTile | null;
  location_id: number | null;
};

/**
 * Atomically takes the next PENDING task of a RUNNING job of THIS worker's mode.
 * FOR UPDATE SKIP LOCKED lets many workers claim in parallel without ever getting
 * the same task; the mode filter keeps a live worker away from mock jobs and back.
 */
export async function claimNextTask(db: Pool, mode: RunMode): Promise<ClaimedTask | null> {
  const { rows } = await db.query<TaskRow>(
    `UPDATE job_tasks t
     SET status = 'RUNNING', attempts = t.attempts + 1, started_at = now(), updated_at = now()
     WHERE t.id = (
       SELECT t2.id
       FROM job_tasks t2
       JOIN jobs j ON j.id = t2.job_id
       WHERE t2.status = 'PENDING' AND t2.kind = 'DISCOVERY' AND j.status = 'RUNNING'
         AND t2.tile->>'mode' = $1
       ORDER BY t2.job_id, t2.id
       LIMIT 1
       FOR UPDATE OF t2 SKIP LOCKED
     )
     RETURNING t.id, t.job_id, t.keyword, t.language, t.subcategory_id, t.depth, t.tile, t.location_id`,
    [mode],
  );
  const row = rows[0];
  if (!row) return null;

  if (!row.keyword || !row.language || row.subcategory_id === null || !row.tile) {
    await failTask(db, row.id, 'Task is missing keyword, language, subcategory or tile');
    return null;
  }
  return {
    id: row.id,
    jobId: row.job_id,
    keyword: row.keyword,
    language: row.language,
    subcategoryId: row.subcategory_id,
    depth: row.depth,
    tile: row.tile,
    locationId: row.location_id,
  };
}

export async function completeTask(db: Pool, taskId: number, resultsCount: number): Promise<void> {
  await db.query(
    `UPDATE job_tasks SET status = 'DONE', results_count = $2, last_error = NULL,
       finished_at = now(), updated_at = now()
     WHERE id = $1`,
    [taskId, resultsCount],
  );
}

export async function skipTask(db: Pool, taskId: number, note: string): Promise<void> {
  await db.query(
    `UPDATE job_tasks SET status = 'SKIPPED', last_error = $2, finished_at = now(), updated_at = now()
     WHERE id = $1`,
    [taskId, note],
  );
}

/** Back in line after the job is resumed (e.g. quota reached). */
export async function deferTask(db: Pool, taskId: number): Promise<void> {
  await db.query(`UPDATE job_tasks SET status = 'DEFERRED', updated_at = now() WHERE id = $1`, [taskId]);
}

export async function failTask(db: Pool, taskId: number, message: string): Promise<void> {
  await db.query(
    `UPDATE job_tasks SET status = 'FAILED', last_error = $2, finished_at = now(), updated_at = now()
     WHERE id = $1`,
    [taskId, message.slice(0, 2000)],
  );
}

/** Was this exact search (tile + keyword + language) run within the cooldown? */
export async function isInCooldown(
  db: Pool,
  p: { tileKey: string; keyword: string; language: string; days: number },
): Promise<boolean> {
  const { rowCount } = await db.query(
    `SELECT 1 FROM query_log
     WHERE source = 'GOOGLE_PLACES' AND tile_key = $1 AND keyword = $2 AND language = $3
       AND last_run_at > now() - make_interval(days => $4::int)`,
    [p.tileKey, p.keyword, p.language, p.days],
  );
  return (rowCount ?? 0) > 0;
}

/** Adds the 4 quadrant tasks of a saturated tile (idempotent via task_key). */
export async function createChildTasks(db: Pool, parent: ClaimedTask, boxes: Bbox[]): Promise<number> {
  const children = boxes.map((box, index) => {
    const path = childPath(parent.tile.path, index);
    const tile: TaskTile = { ...parent.tile, ...box, path };
    const key = discoveryTaskKey({
      areaKey: parent.tile.areaKey,
      path,
      subcategoryId: parent.subcategoryId,
      keyword: parent.keyword,
      language: parent.language,
    });
    return { key, tile };
  });
  const result = await db.query(
    `INSERT INTO job_tasks (
       job_id, kind, task_key, source, location_id, subcategory_id, keyword, language,
       tile, depth, parent_task_id, status, updated_at
     )
     SELECT $1, 'DISCOVERY', e->>'key', 'GOOGLE_PLACES', $2, $3, $4, $5,
            e->'tile', $6, $7, 'PENDING', now()
     FROM jsonb_array_elements($8::jsonb) AS e
     ON CONFLICT (job_id, task_key) DO NOTHING`,
    [
      parent.jobId,
      parent.locationId,
      parent.subcategoryId,
      parent.keyword,
      parent.language,
      parent.depth + 1,
      parent.id,
      JSON.stringify(children),
    ],
  );
  return result.rowCount ?? 0;
}

export async function logQuery(
  db: Pool,
  p: { locationId: number | null; tileKey: string; keyword: string; language: string; results: number; pages: number },
): Promise<void> {
  await db.query(
    `INSERT INTO query_log (source, location_id, tile_key, keyword, language, last_run_at, results, pages)
     VALUES ('GOOGLE_PLACES', $1, $2, $3, $4, now(), $5, $6)
     ON CONFLICT (source, tile_key, keyword, language) DO UPDATE
       SET last_run_at = now(), results = EXCLUDED.results, pages = EXCLUDED.pages`,
    [p.locationId, p.tileKey, p.keyword, p.language, p.results, p.pages],
  );
}

export async function addEvent(
  db: Pool,
  jobId: number,
  level: 'INFO' | 'WARN' | 'ERROR',
  type: string,
  message: string,
  data: object | null = null,
): Promise<void> {
  await db.query(
    `INSERT INTO job_events (job_id, level, type, message, data) VALUES ($1, $2::event_level, $3, $4, $5::jsonb)`,
    [jobId, level, type, message, data === null ? null : JSON.stringify(data)],
  );
}

/** RUNNING -> PAUSED_QUOTA. Returns true only for the call that changed it. */
export async function pauseJobForQuota(db: Pool, jobId: number): Promise<boolean> {
  const r = await db.query(
    `UPDATE jobs SET status = 'PAUSED_QUOTA', updated_at = now() WHERE id = $1 AND status = 'RUNNING'`,
    [jobId],
  );
  return (r.rowCount ?? 0) > 0;
}

/** RUNNING -> FAILED (e.g. invalid key). It can be resumed after fixing the cause. */
export async function failJob(db: Pool, jobId: number, message: string): Promise<boolean> {
  const r = await db.query(
    `UPDATE jobs SET status = 'FAILED', last_error = $2, updated_at = now() WHERE id = $1 AND status = 'RUNNING'`,
    [jobId, message.slice(0, 2000)],
  );
  return (r.rowCount ?? 0) > 0;
}

/** RUNNING -> COMPLETED when no task is left to do. Safe when several workers race. */
export async function maybeCompleteJob(db: Pool, jobId: number): Promise<boolean> {
  const r = await db.query(
    `UPDATE jobs SET status = 'COMPLETED', finished_at = now(), updated_at = now()
     WHERE id = $1 AND status = 'RUNNING'
       AND NOT EXISTS (
         SELECT 1 FROM job_tasks
         WHERE job_id = $1 AND status IN ('PENDING', 'RUNNING', 'DEFERRED')
       )`,
    [jobId],
  );
  return (r.rowCount ?? 0) > 0;
}

/** Tasks stuck in RUNNING longer than the lease (worker crashed) go back in line. */
export async function recoverStaleTasks(db: Pool, leaseMinutes: number): Promise<number> {
  const r = await db.query(
    `UPDATE job_tasks SET status = 'PENDING', updated_at = now()
     WHERE status = 'RUNNING' AND started_at < now() - make_interval(mins => $1::int)`,
    [leaseMinutes],
  );
  return r.rowCount ?? 0;
}