import type { Pool } from 'pg';
import type { Logger } from 'pino';
import { mergeOverturePlaces } from '../datasets/merge-overture';
import type { MxChecker } from '../enrich/mx';
import { tileBox } from './keys';
import * as store from './task-store';
import type { ClaimedOvertureTask } from './task-store';

export interface OvertureTaskContext {
  db: Pool;
  mx?: MxChecker;
  log: Logger;
}

export interface OvertureAreaResult {
  /** Places of the imported Overture data that were not in the main tables yet. */
  newPlaces: number;
  newEmails: number;
  /** Overture businesses in this area for the job's categories (new and known). */
  businesses: number;
  withEmail: number;
}

/**
 * Counts the Overture businesses inside a box for the job's subcategories (all of them,
 * plus places without a category, when the job asked for all categories).
 */
export async function countOvertureBusinesses(
  db: Pool,
  jobId: number,
  box: { south: number; west: number; north: number; east: number },
): Promise<{ businesses: number; withEmail: number }> {
  const { rows } = await db.query<{ businesses: number; with_email: number }>(
    `WITH job AS (
       SELECT coalesce(jsonb_array_length(options->'categorySlugs'), 0) = 0 AS all_categories
       FROM jobs WHERE id = $1
     )
     SELECT count(*)::int AS businesses,
            count(*) FILTER (WHERE EXISTS (
              SELECT 1 FROM emails e WHERE e.place_id = p.id AND e.mx_valid IS NOT FALSE
            ))::int AS with_email
     FROM places p, job
     WHERE p.lat BETWEEN $2 AND $3 AND p.lng BETWEEN $4 AND $5
       AND EXISTS (SELECT 1 FROM place_sources s WHERE s.place_id = p.id AND s.source = 'OVERTURE')
       AND (
         EXISTS (
           SELECT 1 FROM place_subcategories ps
           JOIN job_subcategories js ON js.subcategory_id = ps.subcategory_id AND js.job_id = $1
           WHERE ps.place_id = p.id
         )
         OR (job.all_categories AND NOT EXISTS (
           SELECT 1 FROM place_subcategories ps WHERE ps.place_id = p.id
         ))
       )`,
    [jobId, box.south, box.north, box.west, box.east],
  );
  return { businesses: rows[0]?.businesses ?? 0, withEmail: rows[0]?.with_email ?? 0 };
}

/**
 * Runs ONE free-data task (spec §5 source plan, Phase 4): brings in the imported Overture
 * places of this area that are not in the main tables yet (same rules as merge:overture),
 * then counts the Overture businesses here for the job's categories. No Google, no cost.
 * Their websites are crawled for emails by the worker like any other place.
 */
export async function runOvertureTask(
  ctx: OvertureTaskContext,
  task: ClaimedOvertureTask,
): Promise<OvertureAreaResult | null> {
  const box = tileBox(task.tile);
  const area = task.tile.areaName ?? task.tile.areaKey;
  let result: OvertureAreaResult | null = null;
  try {
    const merged = await mergeOverturePlaces(ctx.db, task.tile.countryCode, {
      bbox: box,
      onlyNew: true,
      mx: ctx.mx,
    });
    const counted = await countOvertureBusinesses(ctx.db, task.jobId, box);
    result = {
      newPlaces: merged.placesInserted,
      newEmails: merged.emailsInserted,
      ...counted,
    };
    await store.completeTask(ctx.db, task.id, counted.businesses);
    await store.addEvent(
      ctx.db,
      task.jobId,
      'INFO',
      'overture_area_done',
      `Free data (Overture), ${area}: ${counted.businesses} businesses, ` +
        `${counted.withEmail} with email` +
        (merged.placesInserted > 0 ? ` (${merged.placesInserted} new)` : ''),
      { taskId: task.id, ...result },
    );
    ctx.log.info({ taskId: task.id, area: task.tile.areaKey, ...result }, 'Overture task done');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await store.failTask(ctx.db, task.id, message);
    await store.addEvent(
      ctx.db,
      task.jobId,
      'ERROR',
      'task_failed',
      `Free data (Overture) for ${area} failed: ${message}`,
    );
    ctx.log.error({ taskId: task.id, err: message }, 'Overture task failed');
  }

  if (await store.maybeCompleteJob(ctx.db, task.jobId)) {
    await store.addEvent(ctx.db, task.jobId, 'INFO', 'job_completed', 'All tasks finished');
  }
  return result;
}
