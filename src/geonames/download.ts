import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import AdmZip from 'adm-zip';

const BASE_URL = 'https://download.geonames.org/export/dump/';

/** Local cache folder (git-ignored). */
export const GEONAMES_DATA_DIR = path.join(process.cwd(), 'data', 'geonames');

/** Re-download cached files older than this unless --refresh is given. */
const MAX_AGE_DAYS = 30;

function isFresh(filePath: string): boolean {
  if (!existsSync(filePath)) return false;
  const ageMs = Date.now() - statSync(filePath).mtimeMs;
  return ageMs < MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
}

/** Downloads a GeoNames dump file into the cache (or reuses a fresh copy). */
export async function ensureGeonamesFile(fileName: string, refresh: boolean): Promise<string> {
  mkdirSync(GEONAMES_DATA_DIR, { recursive: true });
  const target = path.join(GEONAMES_DATA_DIR, fileName);
  if (!refresh && isFresh(target)) return target;

  const response = await fetch(`${BASE_URL}${fileName}`);
  if (!response.ok) {
    throw new Error(`Download of ${fileName} failed: HTTP ${response.status}`);
  }
  writeFileSync(target, Buffer.from(await response.arrayBuffer()));
  return target;
}

/** Reads "<CC>.txt" out of the country zip file as UTF-8 text. */
export function readCountryDump(zipPath: string, countryCode: string): string {
  const entry = new AdmZip(zipPath).getEntry(`${countryCode}.txt`);
  if (!entry) throw new Error(`${countryCode}.txt not found inside ${zipPath}`);
  return entry.getData().toString('utf8');
}