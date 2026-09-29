/**
 * CSV writing for exports (spec §12): UTF-8 with BOM so Excel shows Greek names
 * correctly, CRLF line endings, RFC 4180 quoting, and CSV-injection protection.
 */

/** Byte order mark: tells Excel the file is UTF-8. */
export const UTF8_BOM = '\uFEFF';

/** A phone number in E.164 form ("+35799123456"): digits only, never a formula. */
const E164 = /^\+[1-9]\d{6,14}$/;

/**
 * Cells starting with = + - @ (or tab / carriage return) could run as a formula when the
 * file is opened in Excel; a leading apostrophe makes them plain text. Plain E.164 phone
 * numbers are left as they are: they cannot carry a formula, and the mailer needs "+357...".
 */
export function protectCell(value: string): string {
  if (E164.test(value)) return value;
  return /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
}

/** One CSV cell: protected, and quoted when it contains a comma, quote or line break. */
export function csvCell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '';
  const text = protectCell(String(value));
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** A whole CSV file: BOM + header + rows, every line ending in CRLF. */
export function toCsv(header: string[], rows: (string | number | null)[][]): string {
  const lines = [header, ...rows].map((cells) => cells.map(csvCell).join(','));
  return `${UTF8_BOM}${lines.join('\r\n')}\r\n`;
}