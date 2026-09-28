import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { searchWithSplitting, splitBbox } from '../src/adapters/adaptive-search';
import {
  GooglePlacesClient,
  GooglePlacesError,
  QuotaDeniedError,
  TEXT_SEARCH_FIELD_MASK,
  type TextSearchQuery,
} from '../src/adapters/google-places';
import {
  createGoogleMockServer,
  type GoogleMock,
  type MockFailure,
  type MockPlace,
} from '../src/dev/google-mock-server';
import type { QuotaDecision, ReserveInput } from '../src/quota/quota-guard';
const API_KEY = 'test-key-123456';
const BBOX = { south: 34.6, west: 32.9, north: 34.8, east: 33.1 };

let mock: GoogleMock | undefined;

afterEach(async () => {
  await mock?.app.close();
  mock = undefined;
});

async function startMock(places: MockPlace[], failures: MockFailure[] = []): Promise<string> {
  mock = createGoogleMockServer({ apiKey: API_KEY, places, failures });
  await mock.app.listen({ port: 0, host: '127.0.0.1' });
  const { port } = mock.app.server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

/** Counts reserve() calls; refuses after `limit`. */
function fakeQuota(limit = Number.POSITIVE_INFINITY) {
  const state = { calls: 0 };
  return {
    state,
    async reserve(): Promise<QuotaDecision> {
      state.calls += 1;
      return state.calls <= limit
        ? { granted: true, billing: 'FREE', period: '2026-09', requestCount: state.calls, warn: false }
        : { granted: false, period: '2026-09', reason: 'FREE_LIMIT_REACHED' };
    },
  };
}

/** n x n places evenly spread inside the box, never on a mid-line. */
function grid(keyword: string, n: number, box = BBOX): MockPlace[] {
  const places: MockPlace[] = [];
  for (let i = 0; i < n; i += 1) {
    for (let j = 0; j < n; j += 1) {
      places.push({
        id: `${keyword}-${String(i).padStart(2, '0')}-${String(j).padStart(2, '0')}`,
        name: `${keyword} ${i}-${j}`,
        keyword,
        lat: box.south + ((i + 0.5) / n) * (box.north - box.south),
        lng: box.west + ((j + 0.5) / n) * (box.east - box.west),
      });
    }
  }
  return places;
}

function makeClient(baseUrl: string, quota = fakeQuota(), apiKey = API_KEY) {
  return new GooglePlacesClient({ apiKey, baseUrl, quota, maxAttempts: 3, sleep: async () => {} });
}

const query = (textQuery: string): TextSearchQuery => ({
  textQuery,
  languageCode: 'en',
  regionCode: 'cy',
  bbox: BBOX,
});

describe('field mask', () => {
  it('asks for website and phone but nothing from a more expensive tier', () => {
    expect(TEXT_SEARCH_FIELD_MASK).toContain('places.websiteUri');
    expect(TEXT_SEARCH_FIELD_MASK).toContain('nextPageToken');
    for (const expensive of ['*', 'places.reviews', 'places.photos', 'places.editorialSummary', 'places.regularOpeningHours']) {
      expect(TEXT_SEARCH_FIELD_MASK.split(',')).not.toContain(expensive);
    }
  });
});

describe('GooglePlacesClient', () => {
  it('sends the key, field mask, page size, language, region and rectangle', async () => {
    const baseUrl = await startMock(grid('gym', 2));
    await makeClient(baseUrl).searchPage(query('gym'));

    const sent = mock?.requests[0];
    expect(sent?.headers['x-goog-api-key']).toBe(API_KEY);
    expect(sent?.headers['x-goog-fieldmask']).toBe(TEXT_SEARCH_FIELD_MASK);
    expect(sent?.body).toMatchObject({
      textQuery: 'gym',
      languageCode: 'en',
      regionCode: 'cy',
      pageSize: 20,
      locationRestriction: {
        rectangle: {
          low: { latitude: BBOX.south, longitude: BBOX.west },
          high: { latitude: BBOX.north, longitude: BBOX.east },
        },
      },
    });
  });

  it('maps a Google place into our shape', async () => {
    const baseUrl = await startMock([
      { id: 'p1', name: 'Anna Salon', keyword: 'hair salon', lat: 34.7, lng: 33.0, website: 'https://anna.cy/', phone: '25 123456' },
    ]);
    const page = await makeClient(baseUrl).searchPage(query('hair salon'));
    expect(page.places[0]).toEqual({
      googlePlaceId: 'p1',
      name: 'Anna Salon',
      address: 'Anna Salon, Cyprus',
      lat: 34.7,
      lng: 33.0,
      website: 'https://anna.cy/',
      phoneNational: '25 123456',
      phoneInternational: '+357 25 123456',
      businessStatus: 'OPERATIONAL',
      rating: 4.5,
      ratingCount: 12,
      types: ['hair_salon', 'establishment'],
      primaryType: 'hair_salon',
    });
    expect(page.nextPageToken).toBeNull();
  });

  it('follows pages (20 + 20 + 5) and takes one quota ticket per page', async () => {
    const places = grid('cafe', 7).slice(0, 45);
    const baseUrl = await startMock(places);
    const quota = fakeQuota();
    const result = await makeClient(baseUrl, quota).searchQuery(query('cafe'));
    expect(result).toMatchObject({ pages: 3, attempts: 3, saturated: false });
    expect(result.places).toHaveLength(45);
    expect(quota.state.calls).toBe(3);
  });

  it('stops after one page when there is no next page', async () => {
    const baseUrl = await startMock(grid('florist', 2));
    const quota = fakeQuota();
    const result = await makeClient(baseUrl, quota).searchQuery(query('florist'));
    expect(result).toMatchObject({ pages: 1, saturated: false });
    expect(quota.state.calls).toBe(1);
  });

  it('retries a 429 and takes a new quota ticket for the retry', async () => {
    const baseUrl = await startMock(grid('gym', 2), [
      { status: 429, googleStatus: 'RESOURCE_EXHAUSTED', message: 'Too many requests' },
    ]);
    const quota = fakeQuota();
    const page = await makeClient(baseUrl, quota).searchPage(query('gym'));
    expect(page.attempts).toBe(2);
    expect(page.places).toHaveLength(4);
    expect(quota.state.calls).toBe(2);
  });

  it('gives up after 3 attempts on repeated 503 with a retryable error', async () => {
    const outage = { status: 503, googleStatus: 'UNAVAILABLE', message: 'Service unavailable' };
    const baseUrl = await startMock(grid('gym', 2), [outage, outage, outage]);
    const quota = fakeQuota();
    const error = await makeClient(baseUrl, quota).searchPage(query('gym')).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GooglePlacesError);
    expect((error as GooglePlacesError).retryable).toBe(true);
    expect(quota.state.calls).toBe(3);
  });

  it('does not retry a wrong API key (403)', async () => {
    const baseUrl = await startMock(grid('gym', 2));
    const error = await makeClient(baseUrl, fakeQuota(), 'wrong-key-000000').searchPage(query('gym')).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GooglePlacesError);
    expect(error).toMatchObject({ httpStatus: 403, retryable: false, googleStatus: 'PERMISSION_DENIED' });
    expect(mock?.requests).toHaveLength(1);
  });

  it('sends nothing to Google when the quota guard refuses', async () => {
    const baseUrl = await startMock(grid('gym', 2));
    const error = await makeClient(baseUrl, fakeQuota(0)).searchPage(query('gym')).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(QuotaDeniedError);
    expect((error as QuotaDeniedError).reason).toBe('FREE_LIMIT_REACHED');
    expect(mock?.requests).toHaveLength(0);
  });
});

describe('adaptive splitting', () => {
  it('splits a box into 4 quadrants that cover it exactly', () => {
    const parts = splitBbox(BBOX);
    expect(parts).toHaveLength(4);
    expect(Math.min(...parts.map((p) => p.south))).toBe(BBOX.south);
    expect(Math.max(...parts.map((p) => p.north))).toBe(BBOX.north);
    expect(Math.min(...parts.map((p) => p.west))).toBe(BBOX.west);
    expect(Math.max(...parts.map((p) => p.east))).toBe(BBOX.east);
  });

  it('recovers all 100 places when one query is capped at 60', async () => {
    const baseUrl = await startMock(grid('restaurant', 10));
    const quota = fakeQuota();
    const result = await searchWithSplitting(
      makeClient(baseUrl, quota),
      { textQuery: 'restaurant', languageCode: 'en', regionCode: 'cy' },
      BBOX,
    );
    // Whole box: 60 (3 pages, full) -> 4 quadrants of 25 (2 pages each).
    expect(result.places).toHaveLength(100);
    expect(result).toMatchObject({ tilesSearched: 5, pages: 11, saturatedAtMaxDepth: 0 });
    expect(quota.state.calls).toBe(11);
  });

  it('respects the maximum depth and reports the still-full tile', async () => {
    const baseUrl = await startMock(grid('restaurant', 10));
    const result = await searchWithSplitting(
      makeClient(baseUrl),
      { textQuery: 'restaurant', languageCode: 'en', regionCode: 'cy' },
      BBOX,
      0,
    );
    expect(result.places).toHaveLength(60);
    expect(result).toMatchObject({ tilesSearched: 1, saturatedAtMaxDepth: 1 });
  });
    it('counts quota under a custom provider, so the mock never touches the real counter', async () => {
    const baseUrl = await startMock(grid('gym', 2));
    const providers: string[] = [];
    const quota = {
      async reserve(input: ReserveInput): Promise<QuotaDecision> {
        providers.push(input.provider);
        return { granted: true, billing: 'FREE', period: '2026-09', requestCount: 1, warn: false };
      },
    };
    const client = new GooglePlacesClient({
      apiKey: API_KEY, baseUrl, quota, quotaProvider: 'google_places_mock', sleep: async () => {},
    });
    await client.searchPage(query('gym'));
    expect(providers).toEqual(['google_places_mock']);
  });

});