import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  compareReleases,
  latestOvertureRelease,
  listOvertureFiles,
  overtureSource,
  readOverturePlaces,
  rowGroupMayOverlap,
  withRetries,
} from '../src/datasets/overture';

const BOX = { south: 34.5, west: 32.2, north: 35.7, east: 34.6 };
const FIXTURES = path.join(__dirname, 'fixtures');
/** Same places as overture-cy, moved 3 degrees north (outside Cyprus). */
const FAR = path.join(FIXTURES, 'overture-zz-moved.parquet');
const CY = path.join(FIXTURES, 'overture-cy.parquet');

const read = (files: string[], minConfidence = 0.6) =>
  readOverturePlaces(files, BOX, 'CY', minConfidence);

describe('Overture import', () => {
  it('keeps open and unknown-status places in the country with enough confidence', async () => {
    const { kept, stats } = await read([CY]);
    expect(kept.map((p) => p.id).sort()).toEqual(['ov-gym', 'ov-noaddr', 'ov-salon']);
    expect(stats).toMatchObject({
      read: 5,
      kept: 3,
      droppedLowConfidence: 1,
      droppedClosed: 1,
      withWebsite: 2,
      withEmail: 1,
      withPhone: 1,
    });
  });

  it('never keeps places outside the box, in another country or without a name', async () => {
    const { kept, stats } = await read([CY], 0);
    const ids = kept.map((p) => p.id);
    expect(ids).not.toContain('ov-athens');
    expect(ids).not.toContain('ov-turkey');
    expect(ids).not.toContain('ov-noname');
    expect(stats.read).toBe(5);
  });

  it('reads the v2 taxonomy, contacts and source datasets', async () => {
    const { kept } = await read([CY]);
    const salon = kept.find((p) => p.id === 'ov-salon');
    expect(salon).toMatchObject({
      name: 'Studio Elena Hair & Beauty',
      taxonomyPrimary: 'hair_salon',
      taxonomyHierarchy: ['services_and_business', 'beauty_service', 'hair_salon'],
      basicCategory: 'beauty_salon',
      websites: ['https://www.studio-elena.example.cy/'],
      emails: ['info@studio-elena.example.cy'],
      phones: ['+357 25 123456'],
      locality: 'Limassol',
      datasets: ['meta'],
    });
    expect(salon?.lat).toBeCloseTo(34.68, 4);
    expect(salon?.lng).toBeCloseTo(33.04, 4);
  });

  it('a lower confidence threshold keeps more', async () => {
    const { stats } = await read([CY], 0.2);
    expect(stats.kept).toBe(4);
    expect(stats.droppedLowConfidence).toBe(0);
  });

  it('skips a file part whose statistics lie outside the country, without reading it', async () => {
    const { stats } = await read([CY, FAR]);
    expect(stats).toMatchObject({ files: 2, rowGroupsRead: 1, rowGroupsSkipped: 1, kept: 3 });
  });

  it('reads a part when its statistics are missing (never skips by mistake)', () => {
    expect(rowGroupMayOverlap({ columns: [] }, BOX)).toBe(true);
  });

  it('finds the newest release and lists every places file, page by page', async () => {
    const releases =
      '<ListBucketResult><CommonPrefixes><Prefix>release/2026-08-20.0/</Prefix></CommonPrefixes>' +
      '<CommonPrefixes><Prefix>release/2026-09-23.9/</Prefix></CommonPrefixes>' +
      '<CommonPrefixes><Prefix>release/2026-09-23.10/</Prefix></CommonPrefixes></ListBucketResult>';
    const one = await latestOvertureRelease(
      (async () => new Response(releases, { status: 200 })) as unknown as typeof fetch,
    );
    expect(one).toBe('2026-09-23.10');
    expect(compareReleases('2026-09-23.2', '2026-09-23.10')).toBeLessThan(0);

    const pages = [
      '<r><Key>release/R/theme=places/type=place/part-0.parquet</Key><IsTruncated>true</IsTruncated><NextContinuationToken>t1</NextContinuationToken></r>',
      '<r><Key>release/R/theme=places/type=place/part-1.parquet</Key><IsTruncated>false</IsTruncated></r>',
    ];
    const asked: string[] = [];
    const files = await listOvertureFiles('R', (async (url: string) => {
      asked.push(url);
      return new Response(pages[asked.length - 1], { status: 200 });
    }) as unknown as typeof fetch);
    expect(files).toEqual([
      'https://overturemaps-us-west-2.s3.us-west-2.amazonaws.com/release/R/theme=places/type=place/part-0.parquet',
      'https://overturemaps-us-west-2.s3.us-west-2.amazonaws.com/release/R/theme=places/type=place/part-1.parquet',
    ]);
    expect(asked[1]).toContain('continuation-token=t1');
    expect(overtureSource('R')).toBe(
      's3://overturemaps-us-west-2/release/R/theme=places/type=place/',
    );
  });

  it('a failing release list is a clear error', async () => {
    const fail = (async () => new Response('nope', { status: 403 })) as unknown as typeof fetch;
    await expect(latestOvertureRelease(fail)).rejects.toThrow('HTTP 403');
    await expect(listOvertureFiles('R', fail)).rejects.toThrow('HTTP 403');
  });

  it('reads over HTTP with range requests, as from S3', async () => {
    const bytes = readFileSync(CY);
    const ranges: string[] = [];
    const server: Server = createServer((req, res) => {
      const range = /bytes=(\d+)-(\d*)/.exec(req.headers.range ?? '');
      if (req.method === 'HEAD' || !range) {
        res.writeHead(200, { 'Content-Length': bytes.length, 'Accept-Ranges': 'bytes' });
        res.end(req.method === 'HEAD' ? undefined : bytes);
        return;
      }
      ranges.push(range[0]);
      const start = Number(range[1]);
      const end = range[2] ? Number(range[2]) : bytes.length - 1;
      res.writeHead(206, {
        'Content-Length': end - start + 1,
        'Content-Range': `bytes ${start}-${end}/${bytes.length}`,
      });
      res.end(bytes.subarray(start, end + 1));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const { port } = server.address() as AddressInfo;
      const { kept } = await read([`http://127.0.0.1:${port}/part-0.parquet`]);
      expect(kept.map((p) => p.id).sort()).toEqual(['ov-gym', 'ov-noaddr', 'ov-salon']);
      expect(ranges.length).toBeGreaterThan(0);
    } finally {
      server.close();
    }
  });

  it('retries a dropped connection instead of failing the import', async () => {
    const bytes = readFileSync(CY);
    let dropped = 0;
    const server: Server = createServer((req, res) => {
      const range = /bytes=(\d+)-(\d*)/.exec(req.headers.range ?? '');
      if (req.method === 'HEAD' || !range) {
        res.writeHead(200, { 'Content-Length': bytes.length, 'Accept-Ranges': 'bytes' });
        res.end();
        return;
      }
      if (dropped < 2) {
        dropped += 1;
        req.socket.destroy(); // the connection breaks, like home internet does
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
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const retries: string[] = [];
    try {
      const { port } = server.address() as AddressInfo;
      const { kept } = await readOverturePlaces(
        [`http://127.0.0.1:${port}/part-0.parquet`],
        BOX,
        'CY',
        0.6,
        (line) => retries.push(line),
      );
      expect(kept).toHaveLength(3);
      expect(dropped).toBe(2);
      expect(retries.some((l) => l.includes('trying again'))).toBe(true);
    } finally {
      server.close();
    }
  }, 20_000);

  it('gives up after the last attempt with the real reason', async () => {
    let calls = 0;
    const failing = () => {
      calls += 1;
      return Promise.reject(new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } }));
    };
    await expect(withRetries(failing, { attempts: 3, baseMs: 1 })).rejects.toThrow('fetch failed');
    expect(calls).toBe(3);
  });
});
