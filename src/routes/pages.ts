import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import {
  pageExportSchema,
  pageFiltersSchema,
  pageRemovalSchema,
  pageStatusSchema,
  type PageService,
} from '../pages/page-service';

const limitSchema = z.object({ limit: z.coerce.number().int().min(1).max(500).default(100) });

/**
 * Routes under /api/v1/pages (login required): data for the claimable ainoviro pages,
 * removal requests and page status from the platform (step 7.6). Read-only for leads:
 * nothing here marks a lead as exported.
 */
export function pageRoutes(service: PageService): FastifyPluginAsync {
  return async (app) => {
    app.get('/config', async () => {
      const c = service.config();
      return {
        types: c.types.map((t) => ({ key: t.key, label: t.label })),
        areas: c.areas.map((a) => ({ key: a.key, label: a.label })),
      };
    });

    app.get('/preview', async (request) => {
      return { preview: await service.preview(pageFiltersSchema.parse(request.query)) };
    });

    app.get('/export', async (request, reply) => {
      const { format, ...filters } = pageExportSchema.parse(request.query);
      const file = await service.exportFile(pageFiltersSchema.parse(filters), format);
      return reply
        .header('Content-Type', file.contentType)
        .header('Content-Disposition', `attachment; filename="${file.filename}"`)
        .header('X-Page-Count', String(file.count))
        .header('Cache-Control', 'no-store')
        .send(file.body);
    });

    app.get('/removals', async (request) => {
      const { limit } = limitSchema.parse(request.query);
      return { removals: await service.listRemovals(limit) };
    });

    app.post('/removals', async (request) => {
      return { removal: await service.requestRemoval(pageRemovalSchema.parse(request.body)) };
    });

    // The platform (or the Growth Agent) reports pages published, claimed or removed.
    app.post('/status', async (request) => {
      return { result: await service.setStatuses(pageStatusSchema.parse(request.body)) };
    });
  };
}
