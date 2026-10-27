import { describe, expect, it } from 'vitest';
import { computeAlerts, type AlertInput } from '../src/health/alerts';
import { LoopHealth, supervise } from '../src/health/loop-health';

const NOW = new Date('2026-10-27T12:00:00Z');
const counts = (over: Partial<AlertInput['current']> = {}): AlertInput['current'] => ({
  ready: 10,
  needsReview: 100,
  reasons: {},
  emailsTotal: 1000,
  exportedTotal: 500,
  ...over,
});
const input = (over: Partial<AlertInput> = {}): AlertInput => ({
  now: NOW,
  worker: { crawling: true, loops: [] },
  current: counts(),
  dayAgo: null,
  sixHoursAgo: null,
  websites: { waiting: 0, lastCrawlAt: null },
  ...over,
});
const snap = (over: Partial<AlertInput['current']> = {}) => ({
  takenAt: '2026-10-26T12:00:00.000Z',
  ...counts(over),
});
const codes = (i: AlertInput) => computeAlerts(i).map((a) => a.code);

describe('dashboard warnings (step 7.5)', () => {
  it('stays quiet when all is well or there is no history yet', () => {
    expect(computeAlerts(input())).toEqual([]);
    expect(
      computeAlerts(input({ current: counts({ emailsTotal: 1100, ready: 30 }), dayAgo: snap() })),
    ).toEqual([]);
  });

  it('catches emails found while nothing becomes ready (the "stuck at 3" case)', () => {
    const alerts = computeAlerts(
      input({
        current: counts({ emailsTotal: 1200, ready: 3, reasons: { EMAIL_NO_MX: 900 } }),
        dayAgo: snap({ ready: 3, reasons: { EMAIL_NO_MX: 850 } }),
      }),
    );
    expect(alerts[0]).toMatchObject({
      level: 'error',
      code: 'NOTHING_BECAME_READY',
      href: '/leads?needsReview=yes&reason=EMAIL_NO_MX',
    });
  });

  it('downloads do not count as "nothing became ready"', () => {
    // 50 became ready and 50 were downloaded: ready stays the same, which is fine.
    expect(
      codes(
        input({
          current: counts({ emailsTotal: 1200, ready: 10, exportedTotal: 550 }),
          dayAgo: snap({ ready: 10, exportedTotal: 500 }),
        }),
      ),
    ).toEqual([]);
  });

  it('warns about a reason that suddenly grows, not about small changes', () => {
    expect(
      codes(
        input({
          current: counts({ ready: 50, reasons: { EMAIL_NO_MX: 400, PHONE_INVALID: 120 } }),
          dayAgo: snap({ ready: 10, reasons: { EMAIL_NO_MX: 200, PHONE_INVALID: 100 } }),
        }),
      ),
    ).toEqual(['REASON_SPIKE_EMAIL_NO_MX']);
  });

  it('warns about loops that keep failing, error after ten', () => {
    const loop = {
      name: 'crawl',
      okAt: null,
      errorAt: NOW.toISOString(),
      errors: 4,
      lastError: 'connect ETIMEDOUT',
      restarts: 0,
    };
    const warn = computeAlerts(input({ worker: { crawling: true, loops: [loop] } }));
    expect(warn[0]).toMatchObject({ level: 'warning', title: 'Website crawling keeps failing' });
    expect(warn[0]?.detail).toContain('connect ETIMEDOUT');
    const err = computeAlerts(
      input({ worker: { crawling: true, loops: [{ ...loop, errors: 12 }] } }),
    );
    expect(err[0]?.level).toBe('error');
    expect(
      computeAlerts(input({ worker: { crawling: true, loops: [{ ...loop, errors: 2 }] } })),
    ).toEqual([]);
    // Worker not running: its old loop states are not shown (the page has its own notice).
    expect(computeAlerts(input({ worker: null }))).toEqual([]);
  });

  it('notices crawling that stopped while websites wait', () => {
    expect(
      codes(input({ websites: { waiting: 300, lastCrawlAt: '2026-10-27T08:00:00Z' } })),
    ).toEqual(['CRAWL_STALLED']);
    expect(
      codes(input({ websites: { waiting: 300, lastCrawlAt: '2026-10-27T11:30:00Z' } })),
    ).toEqual([]);
    expect(codes(input({ websites: { waiting: 0, lastCrawlAt: '2026-10-27T01:00:00Z' } }))).toEqual(
      [],
    );
  });

  it('notices mail-server checks that get no answers', () => {
    const stuck = input({
      current: counts({ reasons: { EMAIL_MX_UNKNOWN: 300 } }),
      sixHoursAgo: snap({ reasons: { EMAIL_MX_UNKNOWN: 280 } }),
    });
    expect(codes(stuck)).toEqual(['MX_CHECKS_STUCK']);
    const shrinking = input({
      current: counts({ reasons: { EMAIL_MX_UNKNOWN: 300 } }),
      sixHoursAgo: snap({ reasons: { EMAIL_MX_UNKNOWN: 900 } }),
    });
    expect(codes(shrinking)).toEqual([]);
  });
});

describe('loop health and supervision', () => {
  it('counts failures in a row and resets after a good round', () => {
    const h = new LoopHealth(() => NOW);
    h.fail('mx', new Error('a'));
    h.fail('mx', new Error('b'));
    expect(h.snapshot()[0]).toMatchObject({ name: 'mx', errors: 2, lastError: 'b' });
    h.ok('mx');
    expect(h.snapshot()[0]).toMatchObject({ errors: 0, okAt: NOW.toISOString() });
  });

  it('restarts a loop that ends by itself, and stops cleanly', async () => {
    const h = new LoopHealth(() => NOW);
    let runs = 0;
    let stop = false;
    const restarts: unknown[] = [];
    await supervise(
      'crawl',
      async () => {
        runs += 1;
        if (runs === 1) throw new Error('boom');
        if (runs === 3) stop = true; // the worker is stopping now
      },
      {
        health: h,
        stopped: () => stop,
        onRestart: (err) => restarts.push(err),
        pause: async () => undefined,
      },
    );
    expect(runs).toBe(3);
    expect(restarts).toHaveLength(2); // after the crash and after the unexpected return
    expect(h.snapshot()[0]).toMatchObject({ restarts: 2, lastError: 'loop ended unexpectedly' });
  });
});
