import { describe, expect, it } from 'vitest';
import {
  childPath,
  discoveryTaskKey,
  isOfficialGoogle,
  normalizeName,
  queryLogTileKey,
  runModeFor,
  websiteDomainOf,
} from '../src/jobs/keys';

describe('task keys', () => {
  it('builds a deterministic key that differs by tile, keyword and language', () => {
    const base = { areaKey: 'city:12', path: '', subcategoryId: 3, keyword: 'hair salon', language: 'en' };
    expect(discoveryTaskKey(base)).toBe('discovery|GOOGLE_PLACES|city:12|t:root|sub:3|kw:hair salon|en');
    expect(discoveryTaskKey({ ...base, path: '2.1' })).not.toBe(discoveryTaskKey(base));
    expect(discoveryTaskKey({ ...base, language: 'el' })).not.toBe(discoveryTaskKey(base));
  });

  it('builds split paths, and keeps mock search history apart from live history', () => {
    expect(childPath('', 2)).toBe('2');
    expect(childPath('2', 1)).toBe('2.1');
    expect(queryLogTileKey('LIVE', 'city:12', '')).toBe('city:12/root');
    expect(queryLogTileKey('MOCK', 'city:12', '2.1')).toBe('mock:city:12/2.1');
  });
});

describe('place helpers', () => {
  it('normalizes names: lowercase, no accents, single spaces', () => {
    expect(normalizeName('  Café  ANNA   Beauté ')).toBe('cafe anna beaute');
    expect(normalizeName('Λεμεσός Salon')).toBe('λεμεσος salon');
  });

  it('extracts the website domain', () => {
    expect(websiteDomainOf('https://www.Anna-Salon.com.cy/about?x=1')).toBe('anna-salon.com.cy');
    expect(websiteDomainOf('not a url')).toBeNull();
    expect(websiteDomainOf(null)).toBeNull();
  });
});

describe('live safety switch', () => {
  it('recognizes only the official Google URL as live', () => {
    expect(isOfficialGoogle('https://places.googleapis.com')).toBe(true);
    expect(isOfficialGoogle('https://places.googleapis.com/')).toBe(true);
    expect(isOfficialGoogle('http://127.0.0.1:5055')).toBe(false);
  });

  it('derives the run mode from the base URL', () => {
    expect(runModeFor('https://places.googleapis.com')).toBe('LIVE');
    expect(runModeFor('http://127.0.0.1:5055')).toBe('MOCK');
  });
});