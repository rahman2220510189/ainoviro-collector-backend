import { describe, expect, it } from 'vitest';
import { formatBytes, hasUsefulContact } from '../src/datasets/storage';

describe('keeping the database small', () => {
  it('a place is useful with an email or an own website, not with a Facebook page alone', () => {
    expect(hasUsefulContact(['info@shop.cy'], [])).toBe(true);
    expect(hasUsefulContact([], ['https://www.shop.cy/'])).toBe(true);
    expect(hasUsefulContact([], ['https://www.facebook.com/shopcy'])).toBe(false);
    expect(hasUsefulContact([], [])).toBe(false);
  });

  it('shows sizes in plain units', () => {
    expect(formatBytes(512_000)).toBe('512 kB');
    expect(formatBytes(12_200_000)).toBe('12.2 MB');
    expect(formatBytes(1_500_000_000)).toBe('1.50 GB');
  });
});
