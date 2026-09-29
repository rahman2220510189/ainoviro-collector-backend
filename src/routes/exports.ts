import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import { z } from 'zod';
import {
  exportFiltersSchema,
  exportRequestSchema,
  type ExportFile,
  type ExportService,
} from '../export/export-service';
import { AppError } from '../lib/errors';

const idParamsSchema = z.object({ id: z.coerce.number().int().positive() });
const listQuerySchema = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) });

function sendCsv(reply: FastifyReply, file: ExportFile): FastifyReply {
  return reply
    .header('Content-Type', 'text/csv; charset=utf-8')
    .header('Content-Disposition', `attachment; filename="${file.filename}"`)
    .header('X-Export-Row-Count', String(file.rowCount))
    .header('X-Export-Batch-Id', file.batchId === null ? '' : String(file.batchId))
    .header('Cache-Control', 'no-store')
    .send(file.csv);
}

/** Routes under /api/v1/exports (login required, enforced by the parent scope). Spec §12. */
export function exportRoutes(service: ExportService): FastifyPluginAsync {
  return async (app) => {
    // How many rows the next "new only" export would have, and how many need review.
    app.get('/preview', async (request) => {
      return { preview: await service.preview(exportFiltersSchema.parse(request.query)) };
    });

    // The one-click export: builds the CSV, then marks the rows exported in one transaction.
    app.get('/csv', async (request, reply) => {
      const file = await service.exportCsv(
        exportRequestSchema.parse(request.query),
        request.adminUser?.id ?? null,
      );
      return sendCsv(reply, file);
    });

    app.get('/batches', async (request) => {
      const { limit } = listQuerySchema.parse(request.query);
      return { batches: await service.listBatches(limit) };
    });

    // Download an earlier batch again (same rows, same order).
    app.get('/batches/:id/download', async (request, reply) => {
      const { id } = idParamsSchema.parse(request.params);
      const file = await service.download(id);
      if (!file) throw new AppError(404, 'BATCH_NOT_FOUND', `Export batch ${id} not found`);
      return sendCsv(reply, file);
    });

    // Undo: rows go back to "new" unless their status changed since the export.
    app.post('/batches/:id/undo', async (request) => {
      const { id } = idParamsSchema.parse(request.params);
      return { undo: await service.undo(id, request.adminUser?.id ?? null) };
    });
  };
}