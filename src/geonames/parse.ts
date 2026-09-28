/**
 * Parsers for GeoNames dump files (tab-separated, UTF-8).
 * Format reference: https://download.geonames.org/export/dump/readme.txt
 */

/** One row of a country dump file (e.g. CY.txt). */
export interface GeonameRow {
  geonameId: number;
  name: string;
  asciiName: string;
  alternateNames: string[];
  lat: number | null;
  lng: number | null;
  /** "P" = populated place, "A" = administrative area, ... */
  featureClass: string;
  /** e.g. PPL, PPLA, PPLC, PPLX, ADM1, PCLI */
  featureCode: string;
  countryCode: string;
  admin1Code: string;
  admin2Code: string;
  /** 0 means unknown in GeoNames. */
  population: number;
}

export interface AdminCode {
  name: string;
  asciiName: string;
  geonameId: number;
}

export interface CountryInfo {
  name: string;
  population: number;
  geonameId: number;
}

function toNumberOrNull(value: string | undefined): number | null {
  if (value === undefined || value.trim() === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function lines(text: string): string[] {
  return text.replace(/^\uFEFF/, '').split(/\r?\n/);
}

/** Parses a country dump (19 tab-separated columns per row). */
export function parseGeonamesFile(text: string): GeonameRow[] {
  const rows: GeonameRow[] = [];
  for (const line of lines(text)) {
    if (line.trim() === '') continue;
    const c = line.split('\t');
    if (c.length < 15) continue;

    const geonameId = toNumberOrNull(c[0]);
    if (geonameId === null) continue;

    rows.push({
      geonameId,
      name: c[1] ?? '',
      asciiName: c[2] ?? '',
      alternateNames: (c[3] ?? '').split(',').filter((n) => n.trim() !== ''),
      lat: toNumberOrNull(c[4]),
      lng: toNumberOrNull(c[5]),
      featureClass: c[6] ?? '',
      featureCode: c[7] ?? '',
      countryCode: c[8] ?? '',
      admin1Code: c[10] ?? '',
      admin2Code: c[11] ?? '',
      population: toNumberOrNull(c[14]) ?? 0,
    });
  }
  return rows;
}

/**
 * Parses admin1CodesASCII.txt or admin2Codes.txt for one country.
 * Line format: "CY.04<TAB>name<TAB>ascii name<TAB>geonameid" (admin2: "CY.04.xyz").
 * Returned keys drop the country prefix: "04" (admin1) or "04.xyz" (admin2).
 */
export function parseAdminCodes(text: string, countryCode: string): Map<string, AdminCode> {
  const prefix = `${countryCode}.`;
  const result = new Map<string, AdminCode>();
  for (const line of lines(text)) {
    if (!line.startsWith(prefix)) continue;
    const [code, name, asciiName, geonameIdText] = line.split('\t');
    const geonameId = toNumberOrNull(geonameIdText);
    if (!code || !name || geonameId === null) continue;
    result.set(code.slice(prefix.length), { name, asciiName: asciiName ?? name, geonameId });
  }
  return result;
}

/** Reads one country's line from countryInfo.txt (comment lines start with "#"). */
export function parseCountryInfo(text: string, countryCode: string): CountryInfo {
  for (const line of lines(text)) {
    if (line.startsWith('#') || line.trim() === '') continue;
    const c = line.split('\t');
    if (c[0] !== countryCode) continue;
    const geonameId = toNumberOrNull(c[16]);
    if (!c[4] || geonameId === null) break;
    return { name: c[4], population: toNumberOrNull(c[7]) ?? 0, geonameId };
  }
  throw new Error(`Country ${countryCode} not found in countryInfo.txt`);
}