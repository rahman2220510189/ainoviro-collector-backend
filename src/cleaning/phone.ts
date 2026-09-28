import { parsePhoneNumberFromString, type CountryCode } from 'libphonenumber-js/max';

export interface PhoneInfo {
  /** The number as the source gave it (trimmed), or null. */
  raw: string | null;
  /** E.164 (e.g. "+35799123456") only when the number is valid; otherwise null. */
  e164: string | null;
  valid: boolean;
}

/**
 * Parses a phone number with the place's country as the default region
 * ("99 123456" in Cyprus -> "+35799123456"). Uses the full ("max") metadata so
 * validity is checked against real number ranges, not just length.
 * Invalid or ambiguous numbers keep the raw value and get valid=false.
 */
export function normalizePhone(raw: string | null | undefined, countryCode: string): PhoneInfo {
  const trimmed = raw?.trim() || null;
  if (!trimmed) return { raw: null, e164: null, valid: false };
  try {
    const parsed = parsePhoneNumberFromString(trimmed, countryCode.toUpperCase() as CountryCode);
    if (parsed?.isValid()) return { raw: trimmed, e164: parsed.number, valid: true };
  } catch {
    // Unparseable input: treated as invalid below.
  }
  return { raw: trimmed, e164: null, valid: false };
}