import { describe, expect, it } from 'vitest';
import {
  billingPeriod,
  freeCap,
  pricePerRequestEur,
  quotaSettingsSchema,
  warnPoint,
} from '../src/quota/settings';

describe('billingPeriod', () => {
  it('follows Google (US Pacific) at the month boundary, unlike UTC', () => {
    // 1 Oct 05:00 UTC is still 30 Sep 22:00 in Los Angeles.
    const moment = new Date('2026-10-01T05:00:00Z');
    expect(billingPeriod(moment, 'America/Los_Angeles')).toBe('2026-09');
    expect(billingPeriod(moment, 'UTC')).toBe('2026-10');
  });

  it('formats a normal date as YYYY-MM', () => {
    expect(billingPeriod(new Date('2026-03-15T12:00:00Z'), 'UTC')).toBe('2026-03');
  });
});

describe('quota settings', () => {
  const defaults = quotaSettingsSchema.parse({});

  it('has safe defaults: 1,000 free, warn at 80%, paid requests disabled', () => {
    expect(defaults).toMatchObject({
      freeLimit: 1000,
      warnAt: 0.8,
      hardStop: 1,
      monthlyHardCapEur: 0,
      billingTimeZone: 'America/Los_Angeles',
    });
  });

  it('computes the free cap and the warning point', () => {
    expect(freeCap(defaults)).toBe(1000);
    expect(warnPoint(defaults)).toBe(800);
    expect(freeCap({ ...defaults, hardStop: 0.5 })).toBe(500);
  });

  it('converts the price per 1,000 USD to EUR per request', () => {
    expect(pricePerRequestEur({ ...defaults, pricePer1000Usd: 35, usdToEurRate: 0.9 })).toBeCloseTo(0.0315, 6);
  });

  it('rejects an unknown time zone and out-of-range values', () => {
    expect(() => quotaSettingsSchema.parse({ billingTimeZone: 'Mars/Olympus' })).toThrow();
    expect(() => quotaSettingsSchema.parse({ warnAt: 1.5 })).toThrow();
  });
});