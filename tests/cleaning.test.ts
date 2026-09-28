import { describe, expect, it } from 'vitest';
import { CityResolver, distanceKm, type CityRecord } from '../src/cleaning/city';
import { normalizeBusinessName } from '../src/cleaning/name';
import { normalizePlaceFields } from '../src/cleaning/normalize-place';
import { normalizePhone } from '../src/cleaning/phone';
import { platformKindOfHost } from '../src/cleaning/platforms';
import { analyzeWebsite, cleanWebsiteUrl } from '../src/cleaning/website';

describe('cleanWebsiteUrl', () => {
  it('removes tracking parameters but keeps real ones', () => {
    expect(cleanWebsiteUrl('https://www.instagram.com/mamasita.cy?igsh=MXd6a2&utm_source=qr')).toBe(
      'https://www.instagram.com/mamasita.cy',
    );
    expect(cleanWebsiteUrl('https://shop.cy/page?id=5&fbclid=abc&UTM_Campaign=x')).toBe(
      'https://shop.cy/page?id=5',
    );
    expect(cleanWebsiteUrl('https://shop.cy/?srsltid=AfmBOoq')).toBe('https://shop.cy/');
  });

  it('adds a missing scheme, lowercases the host and drops the fragment and trailing dot', () => {
    expect(cleanWebsiteUrl('WWW.Anna-Salon.COM.CY/About#team')).toBe(
      'http://www.anna-salon.com.cy/About',
    );
    expect(cleanWebsiteUrl('https://taplink.cc/diademastudio.')).toBe(
      'https://taplink.cc/diademastudio',
    );
    expect(cleanWebsiteUrl('//cdn.shop.cy/x')).toBe('https://cdn.shop.cy/x');
  });

  it('rejects values that are not web addresses', () => {
    for (const bad of [
      null,
      '',
      '   ',
      'not a url',
      'mailto:info@shop.cy',
      'ftp://shop.cy',
      'javascript:alert(1)',
      'localhost',
    ]) {
      expect(cleanWebsiteUrl(bad), String(bad)).toBeNull();
    }
  });
});

describe('platform detection', () => {
  it('recognizes social, link-in-bio, booking and listing hosts, including subdomains', () => {
    expect(platformKindOfHost('www.instagram.com')).toBe('SOCIAL');
    expect(platformKindOfHost('m.facebook.com')).toBe('SOCIAL');
    expect(platformKindOfHost('taplink.cc')).toBe('LINK_IN_BIO');
    expect(platformKindOfHost('n1432904.alteg.io')).toBe('BOOKING');
    expect(platformKindOfHost('hey-beauty.app')).toBe('BOOKING');
    expect(platformKindOfHost('www.tripadvisor.co.uk')).toBe('MAPS_LISTING');
    expect(platformKindOfHost('www.treatwell.gr')).toBe('BOOKING');
  });

  it('treats ordinary and self-hosted sites as own websites', () => {
    for (const host of [
      'ledi.cy',
      'www.medichiccenter.com',
      'soul-beauty.netlify.app',
      'myinstagramtips.com',
      'bookingcyprus.com.cy',
    ]) {
      expect(platformKindOfHost(host), host).toBeNull();
    }
  });

  it('gives an own domain only for own websites', () => {
    expect(analyzeWebsite('https://www.Ledi.cy/')).toEqual({
      website: 'https://www.ledi.cy/',
      domain: 'ledi.cy',
      platform: null,
    });
    expect(analyzeWebsite('https://www.facebook.com/share/1QvX/')).toEqual({
      website: 'https://www.facebook.com/share/1QvX/',
      domain: null,
      platform: 'SOCIAL',
    });
    expect(analyzeWebsite(null)).toEqual({ website: null, domain: null, platform: null });
  });
});

describe('normalizePhone', () => {
  it('turns Cypriot numbers into E.164', () => {
    expect(normalizePhone('+357 99 039334', 'CY')).toEqual({
      raw: '+357 99 039334',
      e164: '+35799039334',
      valid: true,
    });
    expect(normalizePhone('25 353525', 'CY')).toEqual({
      raw: '25 353525',
      e164: '+35725353525',
      valid: true,
    });
    expect(normalizePhone('00357 99039334', 'CY').e164).toBe('+35799039334');
  });

  it('keeps foreign numbers in their own country', () => {
    expect(normalizePhone('+44 20 7946 0958', 'CY').e164).toBe('+442079460958');
  });

  it('keeps the raw value of invalid numbers without an E.164', () => {
    expect(normalizePhone('12345', 'CY')).toEqual({ raw: '12345', e164: null, valid: false });
    expect(normalizePhone('call us', 'CY')).toEqual({ raw: 'call us', e164: null, valid: false });
    expect(normalizePhone('  ', 'CY')).toEqual({ raw: null, e164: null, valid: false });
  });
});

describe('normalizeBusinessName', () => {
  it('removes accents, punctuation and trailing legal forms', () => {
    expect(normalizeBusinessName('  Café  ANNA   Beauté ')).toBe('cafe anna beaute');
    expect(normalizeBusinessName('Anna Beauty Ltd.')).toBe('anna beauty');
    expect(normalizeBusinessName('ANNA BEAUTY LIMITED')).toBe('anna beauty');
    expect(normalizeBusinessName('Κομμωτήριο Άννα Ε.Π.Ε.')).toBe('κομμωτηριο αννα');
    expect(normalizeBusinessName('Salon Maria ΛΤΔ')).toBe('salon maria');
    expect(normalizeBusinessName("Maria's Nails & Spa, Co. Ltd")).toBe('marias nails & spa');
  });

  it('never returns an empty name', () => {
    expect(normalizeBusinessName('Limited')).toBe('limited');
    expect(normalizeBusinessName('Ltd Co')).toBe('ltd');
  });
});

// Limassol-like fixture: a big city box that covers a suburb, plus a village outside it.
const LIMASSOL: CityRecord = {
  id: 1,
  name: 'Limassol',
  lat: 34.6841,
  lng: 33.0379,
  population: 154000,
  bbox: { south: 34.6135, west: 32.952, north: 34.7547, east: 33.1238 },
};
const GERMASOGEIA: CityRecord = {
  id: 2,
  name: 'Germasógeia',
  lat: 34.7178,
  lng: 33.0875,
  population: 13421,
  bbox: { south: 34.6874, west: 33.0505, north: 34.7482, east: 33.1245 },
};
const PAREKKLISIA: CityRecord = {
  id: 3,
  name: 'Parekklisia',
  lat: 34.7333,
  lng: 33.1667,
  population: 2000,
  bbox: null,
};
const OPTIONS = { minCityPopulation: 5000, maxNearestKm: 8 };

describe('CityResolver', () => {
  const resolver = new CityResolver([LIMASSOL, GERMASOGEIA, PAREKKLISIA], OPTIONS);

  it('gives the LARGEST town whose box contains the point (suburbs become the city)', () => {
    expect(resolver.resolve(34.72, 33.09)).toEqual({
      cityId: 1,
      cityName: 'Limassol',
      method: 'CITY_AREA',
    });
  });

  it('uses the nearest small place outside big-town boxes, within the distance limit', () => {
    expect(resolver.resolve(34.74, 33.17)).toEqual({
      cityId: 3,
      cityName: 'Parekklisia',
      method: 'NEAREST',
    });
  });

  it('falls back to the search area city, or null, when nothing is close', () => {
    expect(resolver.resolve(35.2, 33.9, 1)).toEqual({
      cityId: 1,
      cityName: 'Limassol',
      method: 'FALLBACK',
    });
    expect(resolver.resolve(35.2, 33.9)).toBeNull();
    expect(resolver.resolve(null, null, 2)).toEqual({
      cityId: 2,
      cityName: 'Germasógeia',
      method: 'FALLBACK',
    });
  });

  it('measures distance correctly', () => {
    // Limassol -> Nicosia is about 65 km in a straight line.
    expect(distanceKm(34.6841, 33.0379, 35.1753, 33.3642)).toBeGreaterThan(60);
    expect(distanceKm(34.6841, 33.0379, 35.1753, 33.3642)).toBeLessThan(66);
  });
});

describe('normalizePlaceFields', () => {
  it('cleans every field in one pass', () => {
    const fields = normalizePlaceFields(
      {
        name: ' Sense House of Beauty Ltd ',
        website: 'https://n1432904.alteg.io/company/1?fbclid=x',
        phone: '+357 99 427260',
        lat: 34.72,
        lng: 33.09,
      },
      {
        countryCode: 'CY',
        cities: new CityResolver([LIMASSOL, GERMASOGEIA], OPTIONS),
        fallbackCityId: null,
      },
    );
    expect(fields).toEqual({
      name: 'Sense House of Beauty Ltd',
      nameNormalized: 'sense house of beauty',
      website: 'https://n1432904.alteg.io/company/1',
      websiteDomain: null,
      websitePlatform: 'BOOKING',
      phoneRaw: '+357 99 427260',
      phoneE164: '+35799427260',
      phoneValid: true,
      city: { cityId: 1, cityName: 'Limassol', method: 'CITY_AREA' },
    });
  });
});