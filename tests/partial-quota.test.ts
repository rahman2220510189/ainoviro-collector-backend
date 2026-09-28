import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import {
  GooglePlacesClient,
  QuotaDeniedError,
  type GooglePlace,
} from '../src/adapters/google-places';
import {
  createGoogleMockServer,
  type GoogleMock,
  type MockPlace,
} from '../src/dev/google-mock-server';
import { prepareGooglePlaces } from '../src/jobs/place-writer';
import type { QuotaDecision } from '../src/quota/quota-guard';

const BBOX = { south: 34.6, west: 32.9, north: 34.8, east: 33.1 };
let mock: GoogleMock | undefined;

afterEach(async () => {
  await mock?.app.close();
  mock = undefined;
});

function places(n: number): MockPlace[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `salon-${String(i).padStart(3, '0')}`,
    name: `Salon ${i}`,
    keyword: 'hair salon',
    lat: BBOX.south + ((i % 7) + 0.5) * 0.02,
    lng: BBOX.west + (Math.floor(i / 7) + 0.5) * 0.02,
  }));
}

/** Grants the first `limit` requests, refuses the rest. */
function quotaWithLimit(limit: number) {
  let calls = 0;
  return {
    async reserve(): Promise<QuotaDecision> {
      calls += 1;
      return calls <= limit
        ? { granted: true, billing: 'FREE', period: '2026-10', requestCount: calls, warn: false }
        : { granted: false, period: '2026-10', reason: 'FREE_LIMIT_REACHED' };
    },
  };
}

describe('quota refused in the middle of a query', () => {
  it('hands back the pages that were already fetched instead of throwing them away', async () => {
    mock = createGoogleMockServer({ places: places(45), failures: [] });
    await mock.app.listen({ port: 0, host: '127.0.0.1' });
    const { port } = mock.app.server.address() as AddressInfo;
    const client = new GooglePlacesClient({
      apiKey: 'test-key-123456',
      baseUrl: `http://127.0.0.1:${port}`,
      quota: quotaWithLimit(2),
      sleep: async () => {},
    });

    const error = await client
      .searchQuery({ textQuery: 'hair salon', languageCode: 'en', regionCode: 'cy', bbox: BBOX })
      .then(
        () => null,
        (err: unknown) => err,
      );

    expect(error).toBeInstanceOf(QuotaDeniedError);
    const denied = error as QuotaDeniedError;
    expect(denied.reason).toBe('FREE_LIMIT_REACHED');
    // Two pages of 20 were paid for; the third was refused.
    expect(denied.partialPlaces).toHaveLength(40);
    expect(mock.requests).toHaveLength(2);
  });

  it('has nothing to hand back when the very first page is refused', async () => {
    mock = createGoogleMockServer({ places: places(5), failures: [] });
    await mock.app.listen({ port: 0, host: '127.0.0.1' });
    const { port } = mock.app.server.address() as AddressInfo;
    const client = new GooglePlacesClient({
      apiKey: 'test-key-123456',
      baseUrl: `http://127.0.0.1:${port}`,
      quota: quotaWithLimit(0),
      sleep: async () => {},
    });
    const error = await client
      .searchQuery({ textQuery: 'hair salon', languageCode: 'en', regionCode: 'cy', bbox: BBOX })
      .then(
        () => null,
        (err: unknown) => err,
      );
    expect((error as QuotaDeniedError).partialPlaces).toEqual([]);
    expect(mock.requests).toHaveLength(0);
  });
});

describe('prepareGooglePlaces', () => {
  const base: GooglePlace = {
    googlePlaceId: 'a',
    name: 'Anna Salon Ltd',
    address: 'Limassol',
    lat: 34.7,
    lng: 33.0,
    website: 'https://www.instagram.com/anna?igsh=1',
    phoneNational: '99 123456',
    phoneInternational: null,
    businessStatus: 'OPERATIONAL',
    rating: 4.8,
    ratingCount: 20,
    types: [],
    primaryType: null,
  };

  it('skips closed places and duplicates, and cleans the fields', () => {
    const { prepared, skippedClosed } = prepareGooglePlaces(
      [base, { ...base }, { ...base, googlePlaceId: 'b', businessStatus: 'CLOSED_PERMANENTLY' }],
      { countryCode: 'CY', cityId: 7, subcategoryId: 1, keyword: 'hair salon' },
    );
    expect(skippedClosed).toBe(1);
    expect(prepared).toHaveLength(1);
    expect(prepared[0]?.fields).toMatchObject({
      nameNormalized: 'anna salon',
      website: 'https://www.instagram.com/anna',
      websiteDomain: null,
      websitePlatform: 'SOCIAL',
      phoneE164: '+35799123456',
      phoneValid: true,
      // No city lookup given: the writer falls back to the area's city id.
      city: null,
    });
  });
});