import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  fsqRowGroupMayHold,
  latestFsqRelease,
  listFsqFiles,
  readFsqPlaces,
  refreshedCutoff,
  toFsqPlace,
} from '../src/datasets/foursquare';

const BOX = { south: 34.5, west: 32.2, north: 35.7, east: 34.6 };
const CY = path.join(__dirname, 'fixtures', 'fsq-cy.parquet');
const CUTOFF = '2024-10-03';

const listen = async (server: Server): Promise<number> => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as AddressInfo).port;
};

/** A fake Hugging Face API answering one JSON body per path. */
const fakeFetch = (
  pages: Record<string, { status?: number; body: unknown; link?: string }>,
): typeof fetch =>
  (async (input: Parameters<typeof fetch>[0]) => {
    const url = String(input);
    const page = Object.entries(pages).find(([k]) => url.endsWith(k))?.[1];
    if (!page) return new Response('not found', { status: 404 });
    return new Response(JSON.stringify(page.body), {
      status: page.status ?? 200,
      headers: page.link ? { link: page.link } : {},
    });
  }) as typeof fetch;

describe('Foursquare import', () => {
  it('keeps open, recently refreshed places of the country; drops closed and old ones', async () => {
    const { kept, stats } = await readFsqPlaces([CY], BOX, 'CY', { cutoff: CUTOFF });
    expect(kept.map((p) => p.id).sort()).toEqual(['fsq-cafe', 'fsq-dentist', 'fsq-park']);
    expect(stats).toMatchObject({ read: 5, kept: 3, droppedClosed: 1, droppedOld: 1 });
    const cafe = kept.find((p) => p.id === 'fsq-cafe');
    expect(cafe).toMatchObject({
      name: 'Kafe Limani',
      email: 'hello@kafelimani.cy',
      website: 'https://www.kafelimani.cy',
      tel: '+357 25 123456',
      categoryLabels: ['Dining and Drinking > Cafe, Coffee, and Tea House > Café'],
      dateRefreshed: '2026-05-01',
    });
  });

  it('never keeps another country, wrong coordinates or a place without a name', () => {
    const base = {
      fsq_place_id: 'x',
      name: 'Shop',
      latitude: 34.7,
      longitude: 33.0,
      country: 'CY',
    };
    expect(toFsqPlace(base, BOX, 'CY')).not.toBeNull();
    expect(toFsqPlace({ ...base, country: 'TR' }, BOX, 'CY')).toBeNull();
    expect(toFsqPlace({ ...base, latitude: 37.9 }, BOX, 'CY')).toBeNull();
    expect(toFsqPlace({ ...base, name: '  ' }, BOX, 'CY')).toBeNull();
    // Dates as Date objects (some releases) become the same text.
    const p = toFsqPlace({ ...base, date_refreshed: new Date('2026-05-01T00:00:00Z') }, BOX, 'CY');
    expect(p?.dateRefreshed).toBe('2026-05-01');
  });

  it('keeps places refreshed within the last N months', () => {
    expect(refreshedCutoff(24, new Date('2026-10-03T10:00:00Z'))).toBe('2024-10-03');
    expect(refreshedCutoff(6, new Date('2026-10-03T10:00:00Z'))).toBe('2026-04-03');
  });

  it('skips a file part whose statistics prove it holds none of the country', () => {
    const group = (country: [string, string], lat: [number, number]) => ({
      columns: [
        {
          meta_data: {
            path_in_schema: ['country'],
            statistics: { min_value: country[0], max_value: country[1] },
          },
        },
        {
          meta_data: {
            path_in_schema: ['latitude'],
            statistics: { min_value: lat[0], max_value: lat[1] },
          },
        },
        {
          meta_data: {
            path_in_schema: ['longitude'],
            statistics: { min_value: 32.5, max_value: 34.0 },
          },
        },
      ],
    });
    expect(fsqRowGroupMayHold(group(['DE', 'FR'], [34.6, 35.2]), BOX, 'CY')).toBe(false);
    expect(fsqRowGroupMayHold(group(['AT', 'GR'], [40, 50]), BOX, 'CY')).toBe(false);
    expect(fsqRowGroupMayHold(group(['AT', 'GR'], [34.6, 35.2]), BOX, 'CY')).toBe(true);
    // No statistics: always read (never skip by mistake).
    expect(fsqRowGroupMayHold({ columns: [] }, BOX, 'CY')).toBe(true);
  });

  it('finds the newest release and lists every places file with its size, page by page', async () => {
    const fetchFn = fakeFetch({
      '/tree/main/release': {
        body: [
          { type: 'directory', path: 'release/dt=2026-07-09' },
          { type: 'directory', path: 'release/dt=2026-08-11' },
          { type: 'file', path: 'release/README.md' },
        ],
      },
      '/places/parquet': {
        body: [
          {
            type: 'file',
            path: 'release/dt=2026-08-11/places/parquet/places_000000.parquet',
            size: 118,
          },
        ],
        link: '<https://huggingface.co/api/next-page?cursor=2>; rel="next"',
      },
      '/next-page?cursor=2': {
        body: [
          {
            type: 'file',
            path: 'release/dt=2026-08-11/places/parquet/places_000001.parquet',
            size: 120,
          },
        ],
      },
    });
    expect(await latestFsqRelease('hf_test', fetchFn)).toBe('2026-08-11');
    const files = await listFsqFiles('2026-08-11', 'hf_test', fetchFn);
    expect(files).toEqual([
      {
        url: 'https://huggingface.co/datasets/foursquare/fsq-os-places/resolve/main/release/dt=2026-08-11/places/parquet/places_000000.parquet',
        size: 118,
      },
      {
        url: 'https://huggingface.co/datasets/foursquare/fsq-os-places/resolve/main/release/dt=2026-08-11/places/parquet/places_000001.parquet',
        size: 120,
      },
    ]);
  });

  it('explains a missing access approval or a bad token', async () => {
    await expect(
      latestFsqRelease('hf_test', fakeFetch({ '/tree/main/release': { status: 403, body: {} } })),
    ).rejects.toThrow(/Agree and access repository/);
    await expect(
      latestFsqRelease('hf_bad', fakeFetch({ '/tree/main/release': { status: 401, body: {} } })),
    ).rejects.toThrow(/HF_TOKEN/);
  });

  it('downloads with range requests and the token, and never sends the token to the file store', async () => {
    const bytes = readFileSync(CY);
    const storeAuth: (string | undefined)[] = [];
    const store = createServer((req, res) => {
      storeAuth.push(req.headers.authorization);
      const range = /bytes=(\d+)-(\d*)/.exec(req.headers.range ?? '');
      if (!range) {
        res.writeHead(200, { 'Content-Length': bytes.length });
        res.end(bytes);
        return;
      }
      const start = Number(range[1]);
      const end = range[2] ? Number(range[2]) : bytes.length - 1;
      res.writeHead(206, {
        'Content-Length': end - start + 1,
        'Content-Range': `bytes ${start}-${end}/${bytes.length}`,
      });
      res.end(bytes.subarray(start, end + 1));
    });
    const storePort = await listen(store);
    const hubAuth: (string | undefined)[] = [];
    // Like Hugging Face: checks the token, then redirects to its file store (another host).
    const hub = createServer((req, res) => {
      hubAuth.push(req.headers.authorization);
      if (req.headers.authorization !== 'Bearer hf_test_token_1234567890') {
        res.writeHead(401);
        res.end();
        return;
      }
      res.writeHead(302, { Location: `http://localhost:${storePort}/signed/places.parquet` });
      res.end();
    });
    const hubPort = await listen(hub);
    try {
      const { kept } = await readFsqPlaces(
        [{ url: `http://127.0.0.1:${hubPort}/resolve/main/places.parquet`, size: bytes.length }],
        BOX,
        'CY',
        { cutoff: CUTOFF, token: 'hf_test_token_1234567890' },
      );
      expect(kept.map((p) => p.id).sort()).toEqual(['fsq-cafe', 'fsq-dentist', 'fsq-park']);
      // The hub is asked once per file; every byte range goes to the signed link.
      expect(hubAuth.length).toBe(1);
      expect(hubAuth.every((a) => a === 'Bearer hf_test_token_1234567890')).toBe(true);
      expect(storeAuth.length).toBeGreaterThan(0);
      expect(storeAuth.every((a) => a === undefined)).toBe(true);
    } finally {
      hub.close();
      store.close();
    }
  });
});
