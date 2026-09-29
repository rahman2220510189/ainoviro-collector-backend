import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app';
import { hashPassword } from '../src/auth/password';
import { SESSION_COOKIE } from '../src/auth/session';
import { csvCell, protectCell, toCsv, UTF8_BOM } from '../src/export/csv';
import { exportRequestSchema } from '../src/export/export-service';
import {
  EXPORT_PROFILES,
  countryName,
  exportFilename,
  mailerNotes,
  renderRows,
  type ExportLead,
} from '../src/export/profiles';
import {
  createFakeAuthStore,
  createFakeExportService,
  testDeps,
  testEnv,
  type FakeExportService,
} from './helpers';

function lead(extra: Partial<ExportLead> = {}): ExportLead {
  return {
    placeId: 1,
    emailId: 10,
    businessName: 'Κομμωτήριο Ελένη',
    email: 'info@eleni.cy',
    extraEmails: [],
    emailType: 'GENERIC',
    emailOwnDomain: true,
    phone: '+35799123456',
    website: 'https://eleni.cy/',
    address: 'Anexartisias 1, Limassol',
    city: 'Limassol',
    countryCode: 'CY',
    lat: 34.68,
    lng: 33.04,
    category: 'Beauty & Personal Care',
    subcategories: ['Hair Salon', 'Nail Salon'],
    sources: ['google_places'],
    rating: 4.8,
    ratingCount: 40,
    score: 75,
    status: 'NEW',
    firstSeenAt: new Date('2026-09-20T10:00:00Z'),
    ...extra,
  };
}

describe('CSV writing', () => {
  it('starts with a BOM and ends every line with CRLF', () => {
    const csv = toCsv(['a', 'b'], [['1', '2']]);
    expect(csv.startsWith(UTF8_BOM)).toBe(true);
    expect(csv).toBe(`${UTF8_BOM}a,b\r\n1,2\r\n`);
    expect(csv.replace(/\r\n/g, '')).not.toMatch(/\n/);
  });

  it('quotes commas, quotes and line breaks', () => {
    expect(csvCell('Hair, Nails')).toBe('"Hair, Nails"');
    expect(csvCell('The "Best" Salon')).toBe('"The ""Best"" Salon"');
    expect(csvCell('line1\nline2')).toBe('"line1\nline2"');
    expect(csvCell(null)).toBe('');
    expect(csvCell(4.5)).toBe('4.5');
  });

  it('protects against CSV injection', () => {
    for (const bad of ['=HYPERLINK("x")', '+1+2', '-2+3', '@SUM(A1)', '\tx']) {
      expect(protectCell(bad)).toBe(`'${bad}`);
    }
    expect(csvCell('=1+1,2')).toBe(`"'=1+1,2"`);
    expect(protectCell('Salon = Beauty')).toBe('Salon = Beauty');
  });

  it('leaves real E.164 phone numbers untouched for the mailer', () => {
    expect(protectCell('+35799123456')).toBe('+35799123456');
    expect(protectCell('+357 99 123456')).toBe("'+357 99 123456");
  });
});

describe('export profiles', () => {
  it('mailer_v1 has exactly the spec columns in the spec order', () => {
    expect(renderRows(EXPORT_PROFILES.mailer_v1!, []).header.join(',')).toBe(
      'business_name,email,phone,website,city,category,notes',
    );
  });

  it('legacy_9col has exactly the 9 old columns', () => {
    expect(renderRows(EXPORT_PROFILES.legacy_9col!, []).header.join(',')).toBe(
      'name,email,phone,businessName,website,category,source,status,createdAt',
    );
  });

  it('fills a mailer_v1 row', () => {
    const { rows } = renderRows(EXPORT_PROFILES.mailer_v1!, [lead()]);
    expect(rows[0]).toEqual([
      'Κομμωτήριο Ελένη',
      'info@eleni.cy',
      '+35799123456',
      'https://eleni.cy/',
      'Limassol',
      'Beauty & Personal Care',
      'Cyprus | Hair Salon;Nail Salon | google_places',
    ]);
  });

  it('puts other emails into notes', () => {
    expect(mailerNotes(lead({ extraEmails: ['maria@eleni.cy', 'eleni@gmail.com'] }))).toBe(
      'Cyprus | Hair Salon;Nail Salon | google_places | extra_emails=maria@eleni.cy;eleni@gmail.com',
    );
  });

  it('names countries and files as the spec says', () => {
    expect(countryName('cy')).toBe('Cyprus');
    expect(exportFilename(new Date('2026-09-30T23:10:00Z'), 'cy', 44)).toBe(
      'ainoviro_leads_2026-09-30_CY_44.csv',
    );
  });

  it('defaults to mailer_v1 / new / CY and rejects unknown profiles', () => {
    expect(exportRequestSchema.parse({})).toMatchObject({
      profile: 'mailer_v1',
      scope: 'new',
      country: 'CY',
    });
    expect(() => exportRequestSchema.parse({ profile: 'excel' })).toThrow();
  });
});

describe('exports API', () => {
  const EMAIL = 'admin@example.com';
  const PASSWORD = 'correct-horse-battery';
  const CSRF = { 'x-requested-with': 'XMLHttpRequest' };
  let passwordHash: string;
  let app: FastifyInstance | undefined;
  let exports: FakeExportService;

  beforeAll(async () => {
    passwordHash = await hashPassword(PASSWORD, 4);
  });
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  async function start(): Promise<{ server: FastifyInstance; cookie: string }> {
    exports = createFakeExportService();
    app = await buildApp(
      testEnv,
      testDeps({
        authStore: createFakeAuthStore([{ id: 1, email: EMAIL, passwordHash }]),
        exportService: exports,
      }),
    );
    await app.ready();
    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: CSRF,
      payload: { email: EMAIL, password: PASSWORD },
    });
    const session = login.cookies.find((c) => c.name === SESSION_COOKIE);
    if (!session) throw new Error('Login failed in test setup');
    return { server: app, cookie: `${SESSION_COOKIE}=${session.value}` };
  }

  it('requires login', async () => {
    const { server } = await start();
    const res = await server.inject({ method: 'GET', url: '/api/v1/exports/csv' });
    expect(res.statusCode).toBe(401);
  });

  it('streams the CSV with filename, BOM and the batch id', async () => {
    const { server, cookie } = await start();
    const res = await server.inject({
      method: 'GET',
      url: '/api/v1/exports/csv?country=cy&city=Limassol&minScore=50',
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(res.headers['content-disposition']).toBe(
      'attachment; filename="ainoviro_leads_2026-09-30_CY_1.csv"',
    );
    expect(res.headers['x-export-batch-id']).toBe('5');
    expect(res.rawPayload.subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]));
    expect(res.body).toContain('Κομμωτήριο Ελένη');
    expect(exports.calls[0]).toEqual({
      method: 'exportCsv',
      args: [
        {
          country: 'CY',
          city: 'Limassol',
          minScore: 50,
          profile: 'mailer_v1',
          scope: 'new',
        },
        1,
      ],
    });
  });

  it('previews, lists, downloads and undoes batches', async () => {
    const { server, cookie } = await start();
    const preview = await server.inject({
      method: 'GET',
      url: '/api/v1/exports/preview',
      headers: { cookie },
    });
    expect(preview.json()).toEqual({ preview: { newRows: 44, needsReview: 1 } });

    const again = await server.inject({
      method: 'GET',
      url: '/api/v1/exports/batches/5/download',
      headers: { cookie },
    });
    expect(again.statusCode).toBe(200);
    const missing = await server.inject({
      method: 'GET',
      url: '/api/v1/exports/batches/99/download',
      headers: { cookie },
    });
    expect(missing.statusCode).toBe(404);

    const undo = await server.inject({
      method: 'POST',
      url: '/api/v1/exports/batches/5/undo',
      headers: { ...CSRF, cookie },
    });
    expect(undo.json()).toEqual({ undo: { batchId: 5, returned: 1, kept: 0 } });
  });

  it('refuses unknown profiles', async () => {
    const { server, cookie } = await start();
    const res = await server.inject({
      method: 'GET',
      url: '/api/v1/exports/csv?profile=nope',
      headers: { cookie },
    });
    expect(res.statusCode).toBe(400);
    expect(exports.calls).toEqual([]);
  });
});