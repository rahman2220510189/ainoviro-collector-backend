import { describe, expect, it } from 'vitest';
import { hourIn, insideWindow, keepAwakeConfigFromEnv, parseHours } from '../src/keep-awake';

describe('keep-awake (free hosting stays awake during working hours)', () => {
  it('reads the hours and the address, and stays off without them', () => {
    expect(parseHours('9-21')).toEqual({ startHour: 9, endHour: 21 });
    expect(parseHours('22-6')).toEqual({ startHour: 22, endHour: 6 });
    expect(parseHours('nonsense')).toBeNull();
    expect(parseHours('9-9')).toBeNull();
    expect(keepAwakeConfigFromEnv({})).toBeNull();
    expect(keepAwakeConfigFromEnv({ KEEP_AWAKE_HOURS: '9-21' })).toBeNull(); // no address
    expect(
      keepAwakeConfigFromEnv({
        KEEP_AWAKE_HOURS: '9-21',
        RENDER_EXTERNAL_URL: 'https://ainoviro-api.onrender.com/',
      }),
    ).toEqual({
      url: 'https://ainoviro-api.onrender.com',
      startHour: 9,
      endHour: 21,
      timeZone: 'Asia/Dhaka',
    });
    expect(
      keepAwakeConfigFromEnv({
        KEEP_AWAKE_HOURS: '9-21',
        KEEP_AWAKE_TZ: 'Not/AZone',
        RENDER_EXTERNAL_URL: 'https://x.onrender.com',
      }),
    ).toBeNull();
  });

  it('knows whether an hour is inside the window, also across midnight', () => {
    expect(insideWindow(9, 9, 21)).toBe(true);
    expect(insideWindow(20, 9, 21)).toBe(true);
    expect(insideWindow(21, 9, 21)).toBe(false);
    expect(insideWindow(23, 22, 6)).toBe(true);
    expect(insideWindow(3, 22, 6)).toBe(true);
    expect(insideWindow(12, 22, 6)).toBe(false);
  });

  it('turns UTC into local hours (Dhaka is UTC+6)', () => {
    expect(hourIn('Asia/Dhaka', new Date('2026-10-27T03:30:00Z'))).toBe(9);
    expect(hourIn('Asia/Dhaka', new Date('2026-10-27T20:00:00Z'))).toBe(2);
  });
});
