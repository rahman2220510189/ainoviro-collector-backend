/**
 * Legal-form words removed from the END of a business name for matching
 * (after accents and dots are removed, so "Ε.Π.Ε." -> "επε", "S.A." -> "sa").
 * English, common EU forms, and Greek/Cypriot forms ("ΛΤΔ" is Cypriot "Ltd").
 * Italian "SpA" is deliberately missing: "Nails & Spa" must keep its last word.
 */
const LEGAL_SUFFIXES = new Set([
  'ltd', 'limited', 'llc', 'inc', 'incorporated', 'plc', 'co', 'company', 'corp', 'corporation',
  'gmbh', 'sa', 'srl', 'sarl', 'bv', 'nv', 'ag', 'lp', 'llp', 'pllc', 'oy', 'ab',
  'λτδ', 'λιμιτεδ', 'επε', 'οε', 'εε', 'αε', 'ικε', 'μεπε', 'αβεε', 'ατεε',
]);

/**
 * Matching form of a business name: accents removed, lowercase, punctuation
 * turned into spaces, trailing legal forms removed ("Anna Beauty Ltd." and
 * "ANNA BEAUTY" both become "anna beauty"). Never returns an empty string when
 * the input had letters: a name made only of legal words is kept as is.
 */
export function normalizeBusinessName(name: string): string {
  const words = name
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[.\u2019']/g, '')
    .replace(/[^\p{L}\p{N}&]+/gu, ' ')
    .trim()
    .split(' ')
    .filter((word) => word !== '');

  let end = words.length;
  while (end > 1 && LEGAL_SUFFIXES.has(words[end - 1] ?? '')) end -= 1;
  return words.slice(0, end).join(' ');
}