import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { LocationStore } from '../services/locations';

const MAX_RESOLVE_IDS = 500;

const treeQuerySchema = z.object({
  parent_id: z.coerce.number().int().positive().optional(),
});

const resolveQuerySchema = z.object({
  ids: z
    .string()
    .regex(/^\d+(,\d+)*$/, 'ids must be comma-separated numbers, e.g. 1,2,3')
    .transform((value) => [...new Set(value.split(',').map(Number))])
    .refine((ids) => ids.length <= MAX_RESOLVE_IDS, `at most ${MAX_RESOLVE_IDS} ids`),
});

/** Routes under /api/v1/locations (login required, enforced by the parent scope). */
export function locationRoutes(store: LocationStore): FastifyPluginAsync {
  return async (app) => {
    // GET /api/v1/locations/tree            -> countries
    // GET /api/v1/locations/tree?parent_id=5 -> children of location 5
    app.get('/tree', async (request) => {
      const { parent_id: parentId } = treeQuerySchema.parse(request.query);
      const locations = await store.listChildren(parentId ?? null);
      return { locations };
    });

    // GET /api/v1/locations/resolve?ids=3,7 -> every active city under 3 and 7
    app.get('/resolve', async (request) => {
      const { ids } = resolveQuerySchema.parse(request.query);
      const cityIds = await store.resolveCityIds(ids);
      return { cityIds, count: cityIds.length };
    });
  };
}