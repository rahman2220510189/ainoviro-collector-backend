import { readFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

const cityRadiusSchema = z.object({
  /** Smallest half-side of a city box, in km (villages, unknown population). */
  minKm: z.number().positive(),
  /** Largest half-side of a city box, in km. */
  maxKm: z.number().positive(),
  /** half-side km = kmPerSqrtPopulation * sqrt(population), clamped to [minKm, maxKm]. */
  kmPerSqrtPopulation: z.number().positive(),
});

const countryConfigSchema = z.object({
  /** Use GeoNames admin2 areas as an extra tree level (country -> admin1 -> admin2 -> city). */
  useAdmin2: z.boolean(),
  /** Unicode script of local names, e.g. "Greek". Used to pick name_local. */
  localScript: z.string().min(1).optional(),
  /** Languages for search keywords in this country (Phase 1). */
  keywordLanguages: z.array(z.string().min(2).max(8)).min(1),
  cityRadius: cityRadiusSchema,
});

const countriesFileSchema = z.object({
  version: z.literal(1),
  countries: z.record(z.string().regex(/^[A-Z]{2}$/, 'country key must be 2 uppercase letters'), countryConfigSchema),
});

export type CountryConfig = z.infer<typeof countryConfigSchema>;
export type CityRadius = z.infer<typeof cityRadiusSchema>;

/** Works from both src/geonames (tsx) and dist/geonames (compiled). */
export const COUNTRIES_CONFIG_PATH = path.join(__dirname, '../../seed/countries.json');

/** Returns the config for one country, or throws a clear error if it is missing. */
export function loadCountryConfig(
  countryCode: string,
  filePath: string = COUNTRIES_CONFIG_PATH,
): CountryConfig {
  const text = readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '');
  const file = countriesFileSchema.parse(JSON.parse(text) as unknown);
  const config = file.countries[countryCode];
  if (!config) {
    throw new Error(
      `No settings for country "${countryCode}". Add it to seed/countries.json first.`,
    );
  }
  return config;
}