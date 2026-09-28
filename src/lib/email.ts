import { createHash } from 'node:crypto';

/**
 * The ONE email normalization rule used everywhere (suppression import now,
 * crawler and export later). Spec §11: trim, lowercase, strip "mailto:",
 * remove trailing punctuation.
 */

const LEADING_JUNK = /^[<("'[]+/;
const TRAILING_JUNK = /[.,;:!?'")\]}>]+$/;

// Practical address check: local@domain.tld (IDN domains in punycode "xn--" form are allowed).
const EMAIL_PATTERN =
  /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*\.(?:[a-z]{2,}|xn--[a-z0-9-]+)$/;

/** Returns the normalized email, or null if the value is not a usable address. */
export function normalizeEmail(raw: string): string | null {
  let value = raw.trim().replace(/^mailto:/i, '');
  // "mailto:a@b.com?subject=Hi" -> "a@b.com"
  value = value.split('?')[0] ?? '';
  value = value.replace(LEADING_JUNK, '').replace(TRAILING_JUNK, '').trim().toLowerCase();

  if (value.length > 254) return null;
  const [local] = value.split('@');
  if (!local || local.length > 64) return null;
  return EMAIL_PATTERN.test(value) ? value : null;
}

/** SHA-256 hex of a normalized email (used as the suppression key). */
export function hashEmail(normalizedEmail: string): string {
  return createHash('sha256').update(normalizedEmail).digest('hex');
}

/** Part after "@" of a normalized email. */
export function emailDomain(normalizedEmail: string): string {
  return normalizedEmail.slice(normalizedEmail.lastIndexOf('@') + 1);
}

// Loose pattern to FIND address-like substrings inside any text; each match is then
// checked by normalizeEmail. ":" is not allowed, so "mailto:" is never part of a match.
const CANDIDATE_PATTERN = /[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+\.[a-z0-9-]{2,}/gi;

/**
 * Finds every usable email inside a piece of text, normalized and de-duplicated,
 * in order of appearance. Handles markdown/HTML links whose visible text and
 * mailto target differ, "Name <a@b.com>", and several emails in one cell.
 */
export function extractEmails(text: string): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(CANDIDATE_PATTERN)) {
    const normalized = normalizeEmail(match[0]);
    if (normalized) found.add(normalized);
  }
  return [...found];
}