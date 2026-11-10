import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app';
import { hashPassword } from '../src/auth/password';
import { SESSION_COOKIE } from '../src/auth/session';
import {
  buildPageRecord,
  googleMapsUrl,
  pageCsvRow,
  PAGE_CSV_HEADER,
  type OvertureRow,
  type PlaceFacts,
} from '../src/pages/page-record';
import {
  areaOfName,
  loadPageTypes,
  parsePageTypes,
  typeOfOvertureCategory,
} from '../src/pages/page-types';
import { createFakeAuthStore, createFakePageService, testDeps, testEnv } from './helpers';

const config = loadPageTypes();
const barber = config.types.find((t) => t.key === 'barber')!;
const limassol = config.areas.find((a) => a.key === 'limassol')!;

const ovt = (over: Partial<OvertureRow> = {}): OvertureRow => ({
  id: 'ovt-1',
  name: ' Nick the Barber ',
  lat: 34.68,
  lng: 33.04,
  taxonomy_primary: 'barber',
  websites: ['https://www.instagram.com/nickbarber?igsh=abc', 'http://nickbarber.cy/'],
  phones: ['99 123456'],
  emails: [],
  socials: ['https://www.facebook.com/nickbarbercy'],
  address: '12 Anexartisias',
  locality: 'Limassol',
  postcode: '3036',
  imported_at: '2026-10-03T10:00:00Z',
  ...over,
});
const place = (over: Partial<PlaceFacts> = {}): PlaceFacts => ({
  id: 42,
  countryCode: 'CY',
  cityName: 'Limassol',
  googlePlaceId: 'ChIJabc',
  primaryEmail: { email: 'info@nickbarber.cy', source: 'mailto', foundAt: '2026-10-05T00:00:00Z' },
  sellsOnline: false,
  page: null,
  ...over,
});

describe('page types config (seed/page-types.json)', () => {
  it('maps Overture categories to launch types and names to areas', () => {
    expect(typeOfOvertureCategory(config, 'hair_salon')?.key).toBe('hair_salon');
    expect(typeOfOvertureCategory(config, 'day_spa')?.key).toBe('massage_spa');
    expect(typeOfOvertureCategory(config, 'restaurant')).toBeNull();
    expect(areaOfName(config, null, 'Λεμεσός')?.key).toBe('limassol');
    expect(areaOfName(config, 'Larnaka District')?.key).toBe('larnaca');
    expect(areaOfName(config, 'Nicosia', 'Strovolos')).toBeNull();
  });

  it('refuses a category listed under two types', () => {
    expect(() =>
      parsePageTypes({
        types: [
          { key: 'a', label: 'A', overture: ['spa'] },
          { key: 'b', label: 'B', overture: ['spa'] },
        ],
        areas: [{ key: 'x', label: 'X', match: ['x'] }],
      }),
    ).toThrow(/two page types/);
  });
});

describe('page record (open data only)', () => {
  it('builds a page from Overture and the website, keeping only the place ID from Google', () => {
    const r = buildPageRecord({
      place: place(),
      overture: ovt(),
      foursquare: null,
      type: barber,
      area: limassol,
    })!;
    expect(r.name).toBe('Nick the Barber');
    expect(r.phone).toBe('+35799123456');
    expect(r.website).toBe('http://nickbarber.cy/');
    expect(r.socials.instagram).toBe('https://www.instagram.com/nickbarber');
    expect(r.socials.facebook).toBe('https://www.facebook.com/nickbarbercy');
    expect(r.email).toBe('info@nickbarber.cy');
    expect(r.google).toEqual({
      placeId: 'ChIJabc',
      mapsUrl: googleMapsUrl('ChIJabc', 'Nick the Barber'),
    });
    expect(r.sources.name).toMatchObject({ source: 'overture', recordId: 'ovt-1' });
    expect(r.sources.email).toMatchObject({ source: 'website', recordId: 'nickbarber.cy' });
    expect(r.attribution).toEqual(['Overture Maps Foundation']);
    expect(r.page.status).toBe('UNPUBLISHED');
    // No Google-derived field anywhere except the place ID and the Maps link.
    expect(Object.values(r.sources).every((s) => s.source !== ('google' as never))).toBe(true);
    expect(r.completeness.missing).toEqual(['opening hours', 'photos', 'services and prices']);
  });

  it('notes a booking platform the business already uses, and falls back to Foursquare', () => {
    const r = buildPageRecord({
      place: place({ primaryEmail: null, googlePlaceId: null }),
      overture: ovt({
        websites: ['https://www.fresha.com/a/nick-barber'],
        phones: ['12'],
        socials: [],
      }),
      foursquare: {
        id: 'fsq-9',
        website: null,
        tel: '+357 25 123456',
        email: null,
        facebook_id: null,
        instagram: '@nick.barber',
        imported_at: '2026-09-01T00:00:00Z',
      },
      type: barber,
      area: limassol,
    })!;
    expect(r.bookingPlatform).toBe('fresha.com');
    expect(r.website).toBeNull();
    expect(r.phone).toBe('+35725123456');
    expect(r.sources.phone).toMatchObject({ source: 'foursquare', recordId: 'fsq-9' });
    expect(r.socials.instagram).toBe('https://instagram.com/nick.barber');
    expect(r.google).toBeNull();
    expect(r.attribution).toContain('Foursquare Open Source Places');
    expect(r.completeness.missing).toContain('email');
  });

  it('gives no page without an Overture record or a name', () => {
    expect(
      buildPageRecord({
        place: place(),
        overture: null,
        foursquare: null,
        type: barber,
        area: limassol,
      }),
    ).toBeNull();
    expect(
      buildPageRecord({
        place: place(),
        overture: ovt({ name: '  ' }),
        foursquare: null,
        type: barber,
        area: limassol,
      }),
    ).toBeNull();
  });

  it('CSV row matches the header', () => {
    const r = buildPageRecord({
      place: place(),
      overture: ovt(),
      foursquare: null,
      type: barber,
      area: limassol,
    })!;
    expect(pageCsvRow(r)).toHaveLength(PAGE_CSV_HEADER.length);
  });
});

describe('pages API', () => {
  const EMAIL = 'admin@example.com';
  const PASSWORD = 'correct-horse-battery';
  const CSRF = { 'x-requested-with': 'XMLHttpRequest' };
  let passwordHash: string;
  let app: FastifyInstance | undefined;
  beforeAll(async () => {
    passwordHash = await hashPassword(PASSWORD, 4);
  });
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });
  async function start() {
    const pages = createFakePageService();
    app = await buildApp(
      testEnv,
      testDeps({
        authStore: createFakeAuthStore([{ id: 1, email: EMAIL, passwordHash }]),
        pageService: pages,
      }),
    );
    await app.ready();
    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: CSRF,
      payload: { email: EMAIL, password: PASSWORD },
    });
    const session = login.cookies.find((c) => c.name === SESSION_COOKIE)!;
    return { server: app, pages, cookie: `${SESSION_COOKIE}=${session.value}` };
  }

  it('requires login', async () => {
    const { server } = await start();
    const res = await server.inject({ method: 'GET', url: '/api/v1/pages/preview' });
    expect(res.statusCode).toBe(401);
  });

  it('preview and export work; export is a download', async () => {
    const { server, cookie } = await start();
    const prev = await server.inject({
      method: 'GET',
      url: '/api/v1/pages/preview?country=cy',
      headers: { cookie },
    });
    expect(prev.statusCode).toBe(200);
    expect(prev.json().preview.country).toBe('CY');
    const csv = await server.inject({
      method: 'GET',
      url: '/api/v1/pages/export?format=csv',
      headers: { cookie },
    });
    expect(csv.headers['content-disposition']).toContain('.csv');
    expect(csv.headers['x-page-count']).toBe('0');
  });

  it('validates removal requests and status updates', async () => {
    const { server, cookie, pages } = await start();
    const bad = await server.inject({
      method: 'POST',
      url: '/api/v1/pages/removals',
      headers: { cookie, ...CSRF },
      payload: { reason: 'no id' },
    });
    expect(bad.statusCode).toBe(400);
    const ok = await server.inject({
      method: 'POST',
      url: '/api/v1/pages/removals',
      headers: { cookie, ...CSRF },
      payload: { phone: '99123456', via: 'whatsapp' },
    });
    expect(ok.statusCode).toBe(200);
    expect(pages.removals).toHaveLength(1);
    const st = await server.inject({
      method: 'POST',
      url: '/api/v1/pages/status',
      headers: { cookie, ...CSRF },
      payload: {
        items: [
          { collectorId: 42, status: 'CLAIMED', pageUrl: 'https://ainoviro.com/nick-barber' },
        ],
      },
    });
    expect(st.json().result).toEqual({ updated: 1, unknown: [] });
  });
});
