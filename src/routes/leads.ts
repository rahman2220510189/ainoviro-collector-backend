import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { PLACE_STATUSES, leadFiltersSchema, type LeadService } from '../leads/lead-service';
import { AppError } from '../lib/errors';

const idParamsSchema = z.object({ id: z.coerce.number().int().positive() });
const facetsQuerySchema = z.object({
  country: z
    .string()
    .regex(/^[A-Za-z]{2}$/)
    .default('CY'),
});
const statusBodySchema = z.object({ status: z.enum(PLACE_STATUSES) });
const bulkRejectBodySchema = z.object({
  ids: z.array(z.number().int().positive()).min(1).max(1000),
});

/** Routes under /api/v1/leads (login required, enforced by the parent scope). Spec §13. */
export function leadRoutes(service: LeadService): FastifyPluginAsync {
  return async (app) => {
    // Paginated list with filters (country, city, category, status, needs review ...).
    app.get('/', async (request) => service.list(leadFiltersSchema.parse(request.query)));

    // Values for the filter dropdowns (cities with counts).
    app.get('/facets', async (request) => {
      const { country } = facetsQuerySchema.parse(request.query);
      return service.facets(country);
    });

    app.get('/:id', async (request) => {
      const { id } = idParamsSchema.parse(request.params);
      const lead = await service.get(id);
      if (!lead) throw new AppError(404, 'LEAD_NOT_FOUND', `Lead ${id} not found`);
      return { lead };
    });

    app.patch('/:id', async (request) => {
      const { id } = idParamsSchema.parse(request.params);
      const { status } = statusBodySchema.parse(request.body);
      return { lead: await service.setStatus(id, status, request.adminUser?.id ?? null) };
    });

    app.post('/bulk-reject', async (request) => {
      const { ids } = bulkRejectBodySchema.parse(request.body);
      return service.bulkReject(ids, request.adminUser?.id ?? null);
    });

    // GDPR erasure: emails deleted (their hash kept in suppression), phone removed.
    app.post('/:id/erase', async (request) => {
      const { id } = idParamsSchema.parse(request.params);
      return { erased: await service.erase(id, request.adminUser?.id ?? null) };
    });
  };
}
