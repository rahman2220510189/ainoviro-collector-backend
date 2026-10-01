import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { suppressionListSchema, type SuppressionService } from '../services/suppression-service';
import { IMPORTABLE_REASONS } from '../services/suppression';

/** CSV files arrive as text inside JSON (read in the browser); up to 10 MB. */
const CSV_BODY_LIMIT = 10 * 1024 * 1024;

const addBodySchema = z.object({
  email: z.string().trim().min(3).max(254),
  reason: z.enum(IMPORTABLE_REASONS).default('MANUAL'),
});
const importBodySchema = z.object({
  csv: z.string().min(1, 'The file is empty'),
  filename: z.string().trim().min(1).max(200),
  column: z.string().trim().min(1).max(100).default('email'),
  reason: z.enum(IMPORTABLE_REASONS),
});
const mailerBodySchema = z.object({
  csv: z.string().min(1, 'The file is empty'),
  filename: z.string().trim().min(1).max(200),
});

/** Routes under /api/v1/suppression (login required, enforced by the parent scope). Spec §13. */
export function suppressionRoutes(service: SuppressionService): FastifyPluginAsync {
  return async (app) => {
    app.get('/', async (request) => service.list(suppressionListSchema.parse(request.query)));

    // Add one address by hand.
    app.post('/', async (request) => {
      const { email, reason } = addBodySchema.parse(request.body);
      return { result: await service.add(email, reason) };
    });

    // Import a list (existing contacts, vendors, old unsubscribes ...) from a CSV column.
    app.post('/import', { bodyLimit: CSV_BODY_LIMIT }, async (request) => {
      const body = importBodySchema.parse(request.body);
      return { result: await service.importCsv(body) };
    });

    // Import the mailer's results: email,status[,date].
    app.post('/mailer-results', { bodyLimit: CSV_BODY_LIMIT }, async (request) => {
      const body = mailerBodySchema.parse(request.body);
      return { result: await service.importMailerResults(body) };
    });
  };
}
