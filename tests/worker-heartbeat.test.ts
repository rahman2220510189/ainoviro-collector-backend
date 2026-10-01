import { describe, expect, it } from 'vitest';
import { workerStatusFrom } from '../src/jobs/worker-heartbeat';

const NOW = new Date('2026-10-02T12:00:00.000Z');

describe('worker heartbeat', () => {
  it('a recent beat means the worker is running', () => {
    const status = workerStatusFrom(
      { at: '2026-10-02T11:59:30.000Z', mode: 'LIVE', searching: false, crawling: true },
      NOW,
    );
    expect(status).toEqual({
      running: true,
      lastSeenAt: '2026-10-02T11:59:30.000Z',
      mode: 'LIVE',
      searching: false,
      crawling: true,
    });
  });

  it('an old beat means it stopped', () => {
    const status = workerStatusFrom({ at: '2026-10-02T11:50:00.000Z', mode: 'MOCK' }, NOW);
    expect(status.running).toBe(false);
    expect(status.lastSeenAt).toBe('2026-10-02T11:50:00.000Z');
  });

  it('no row or a broken value means never seen', () => {
    expect(workerStatusFrom(undefined, NOW).running).toBe(false);
    expect(workerStatusFrom({ at: 'yesterday' }, NOW)).toEqual({
      running: false,
      lastSeenAt: null,
      mode: null,
      searching: false,
      crawling: false,
    });
  });
});
