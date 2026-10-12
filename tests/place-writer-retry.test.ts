import { describe, expect, it } from 'vitest';
import { isRetryableDbError } from '../src/jobs/place-writer';

describe('saving search results when two saves collide', () => {
  it('repeats a save only after a deadlock or serialization failure', () => {
    expect(isRetryableDbError({ code: '40P01' })).toBe(true);
    expect(isRetryableDbError({ code: '40001' })).toBe(true);
    expect(isRetryableDbError({ code: '23505' })).toBe(false); // unique violation: a real bug
    expect(isRetryableDbError(new Error('boom'))).toBe(false);
    expect(isRetryableDbError(null)).toBe(false);
  });
});
