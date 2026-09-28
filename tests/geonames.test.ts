import { describe, expect, it } from 'vitest';
import type { CountryConfig } from '../src/geonames/config';
import { loadCountryConfig } from '../src/geonames/config';
import { buildLocationTree, cityBbox, pickLocalName } from '../src/geonames/build';
import { parseAdminCodes, parseCountryInfo, parseGeonamesFile } from '../src/geonames/parse';

// ---- Small hand-made GeoNames fixtures (no network) ------------------------

interface RowInput {
  id: number;
  name: string;
  alt?: string;
  lat?: string;
  lng?: string;
  fclass: string;
  fcode: string;
  admin1?: string;
  admin2?: string;
  population?: number;
}

/** Builds one 19-column country dump line. */
function row(r: RowInput): string {
  return [
    r.id, r.name, r.name, r.alt ?? '', r.lat ?? '34.7', r.lng ?? '33.0', r.fclass, r.fcode, 'CY', '',
    r.admin1 ?? '', r.admin2 ?? '', '', '', r.population ?? 0, '', '10', 'Asia/Nicosia', '2026-01-01',
  ].join('\t');
}

const COUNTRY_INFO =
  '#ISO\tISO3\t...\n' +
  'CY\tCYP\t196\tCY\tCyprus\tNicosia\t9250\t1189265\tEU\t.cy\tEUR\tEuro\t357\t####\t^(\\d{4})$\tel-CY,tr-CY,en\t146669\t\t\n';

const ADMIN1 = 'CY.04\tLimassol\tLimassol\t1001\nCY.05\tPaphos\tPaphos\t1002\nGR.01\tOther\tOther\t9999\n';

const DUMP = [
  row({ id: 146669, name: 'Cyprus', alt: 'Κύπρος,Kibris', fclass: 'A', fcode: 'PCLI', lat: '35', lng: '33' }),
  row({ id: 1001, name: 'Limassol District', fclass: 'A', fcode: 'ADM1', admin1: '04' }),
  row({ id: 2001, name: 'Limassol', alt: 'Lemesos,Λεμεσός', fclass: 'P', fcode: 'PPLA', admin1: '04', population: 160000 }),
  row({ id: 2002, name: 'Pissouri', fclass: 'P', fcode: 'PPL', admin1: '04', lat: '34.67', lng: '32.70' }),
  row({ id: 2003, name: 'Old Quarter', fclass: 'P', fcode: 'PPLX', admin1: '04' }),
  row({ id: 2004, name: 'Ruins', fclass: 'P', fcode: 'PPLH', admin1: '04' }),
  row({ id: 2005, name: 'Nowhere Village', fclass: 'P', fcode: 'PPL', admin1: '' }),
  row({ id: 3001, name: 'Some Mountain', fclass: 'T', fcode: 'MT', admin1: '04' }),
].join('\n');

const CONFIG: CountryConfig = {
  useAdmin2: false,
  localScript: 'Greek',
  keywordLanguages: ['en', 'el'],
  cityRadius: { minKm: 1.5, maxKm: 15, kmPerSqrtPopulation: 0.02 },
};

function buildFixtureTree(config: CountryConfig = CONFIG) {
  return buildLocationTree({
    countryCode: 'CY',
    countryInfo: parseCountryInfo(COUNTRY_INFO, 'CY'),
    admin1: parseAdminCodes(ADMIN1, 'CY'),
    admin2: null,
    rows: parseGeonamesFile(DUMP),
    config,
  });
}

// ---- Tests ------------------------------------------------------------------

describe('GeoNames parsing', () => {
  it('parses dump rows, admin codes (own country only) and country info', () => {
    const rows = parseGeonamesFile(DUMP);
    const limassol = rows.find((r) => r.geonameId === 2001);
    expect(limassol).toMatchObject({ featureCode: 'PPLA', admin1Code: '04', population: 160000, lat: 34.7 });
    expect(limassol?.alternateNames).toEqual(['Lemesos', 'Λεμεσός']);

    const admin1 = parseAdminCodes(ADMIN1, 'CY');
    expect([...admin1.keys()]).toEqual(['04', '05']);
    expect(parseCountryInfo(COUNTRY_INFO, 'CY')).toEqual({ name: 'Cyprus', population: 1189265, geonameId: 146669 });
  });
});

describe('buildLocationTree', () => {
  it('builds country -> regions -> cities and skips non-city features', () => {
    const tree = buildFixtureTree();

    expect(tree.country).toMatchObject({ name: 'Cyprus', type: 'COUNTRY', nameLocal: 'Κύπρος' });
    expect(tree.regions.map((r) => r.name)).toEqual(['Limassol', 'Paphos']);
    expect(tree.cities.map((c) => c.name).sort()).toEqual(['Limassol', 'Nowhere Village', 'Pissouri']);
    expect(tree.stats).toEqual({ skippedNotPopulated: 3, skippedExcludedCodes: 2, skippedNoCoordinates: 0 });
  });

  it('attaches cities to their region, or to the country when the region is unknown', () => {
    const tree = buildFixtureTree();
    const parentOf = (name: string) => tree.cities.find((c) => c.name === name)?.parentGeonamesId;
    expect(parentOf('Limassol')).toBe(1001);
    expect(parentOf('Nowhere Village')).toBe(146669);
  });

  it('picks the Greek alternate name as name_local', () => {
    expect(pickLocalName(['Lemesos', 'Λεμεσός'], 'Greek')).toBe('Λεμεσός');
    expect(pickLocalName(['Lemesos'], 'Greek')).toBeNull();
    expect(pickLocalName(['Λεμεσός'], undefined)).toBeNull();
  });

  it('makes region and country boxes cover all their cities', () => {
    const tree = buildFixtureTree();
    const region = tree.regions.find((r) => r.name === 'Limassol');
    for (const city of tree.cities.filter((c) => c.parentGeonamesId === 1001)) {
      expect(region?.bbox?.south).toBeLessThanOrEqual(city.bbox?.south ?? 0);
      expect(region?.bbox?.north).toBeGreaterThanOrEqual(city.bbox?.north ?? 0);
    }
    expect(tree.country.bbox).not.toBeNull();
    expect(tree.regions.find((r) => r.name === 'Paphos')?.bbox).toBeNull(); // no cities
  });

  it('supports a deeper admin2 level (country -> admin1 -> admin2 -> city)', () => {
    const admin2 = parseAdminCodes('CY.04.X1\tWest Limassol\tWest Limassol\t1101\n', 'CY');
    const rows = parseGeonamesFile(
      [
        row({ id: 146669, name: 'Cyprus', fclass: 'A', fcode: 'PCLI' }),
        row({ id: 2101, name: 'Deep Town', fclass: 'P', fcode: 'PPL', admin1: '04', admin2: 'X1' }),
      ].join('\n'),
    );
    const tree = buildLocationTree({
      countryCode: 'CY',
      countryInfo: parseCountryInfo(COUNTRY_INFO, 'CY'),
      admin1: parseAdminCodes(ADMIN1, 'CY'),
      admin2,
      rows,
      config: { ...CONFIG, useAdmin2: true },
    });
    expect(tree.regions.find((r) => r.geonamesId === 1101)?.parentGeonamesId).toBe(1001);
    expect(tree.cities[0]?.parentGeonamesId).toBe(1101);
  });
});

describe('cityBbox', () => {
  const radius = CONFIG.cityRadius;

  it('uses the minimum size for unknown population and caps large cities', () => {
    const small = cityBbox(35, 33, 0, radius);
    const huge = cityBbox(35, 33, 50_000_000, radius);
    expect((small.north - small.south) / 2).toBeCloseTo(1.5 / 111.32, 5);
    expect((huge.north - huge.south) / 2).toBeCloseTo(15 / 111.32, 5);
  });

  it('is wider in degrees of longitude than latitude away from the equator', () => {
    const box = cityBbox(35, 33, 160000, radius);
    expect(box.east - box.west).toBeGreaterThan(box.north - box.south);
  });
});

describe('seed/countries.json', () => {
  it('has a valid Cyprus config and a clear error for unknown countries', () => {
    expect(loadCountryConfig('CY').keywordLanguages).toEqual(['en', 'el']);
    expect(() => loadCountryConfig('ZZ')).toThrow(/Add it to seed\/countries.json/);
  });
});