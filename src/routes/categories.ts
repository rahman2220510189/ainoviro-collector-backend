import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { CategoryStore } from '../services/categories';

const listQuerySchema = z.object({
  includeInactive: z.enum(['true', 'false']).default('false'),
});

/** Routes under /api/v1/categories (login required, enforced by the parent scope). */
export function categoryRoutes(store: CategoryStore): FastifyPluginAsync {
  return async (app) => {
    // GET /api/v1/categories?includeInactive=true|false
    app.get('/', async (request) => {
      const { includeInactive } = listQuerySchema.parse(request.query);
      const categories = await store.listCategoryTree(includeInactive === 'true');
      return { categories };
    });
  };
}