/**
 * Export profiles (spec §12): each profile is only a list of columns and how to fill
 * them from an ExportLead. Adding a profile = adding an entry here, nothing else.
 */

/** Everything an export row can show about one business. */
export interface ExportLead {
  placeId: number;
  emailId: number;
  businessName: string;
  email: string;
  extraEmails: string[];
  emailType: string;
  emailOwnDomain: boolean;
  /** E.164 or null. */
  phone: string | null;
  website: string | null;
  address: string | null;
  city: string | null;
  countryCode: string;
  lat: number | null;
  lng: number | null;
  /** Display name of the category of the primary subcategory. */
  category: string | null;
  /** Subcategory display names, primary first. */
  subcategories: string[];
  /** Data sources, e.g. ["google_places"]. */
  sources: string[];
  rating: number | null;
  ratingCount: number | null;
  score: number;
  status: string;
  firstSeenAt: Date;
}

export interface ExportColumn {
  header: string;
  value: (lead: ExportLead) => string | number | null;
}

export interface ExportProfile {
  name: string;
  description: string;
  columns: ExportColumn[];
}

const regionNames = new Intl.DisplayNames(['en'], { type: 'region' });

/** "CY" -> "Cyprus". */
export function countryName(code: string): string {
  try {
    return regionNames.of(code.toUpperCase()) ?? code;
  } catch {
    return code;
  }
}

/**
 * mailer_v1 notes: "Cyprus | Nail Salon;Beauty Salon | google_places", plus
 * " | extra_emails=a@x.com;b@y.com" when the business has more addresses.
 */
export function mailerNotes(lead: ExportLead): string {
  const parts = [
    countryName(lead.countryCode),
    lead.subcategories.join(';'),
    lead.sources.join(';'),
  ];
  if (lead.extraEmails.length > 0) parts.push(`extra_emails=${lead.extraEmails.join(';')}`);
  return parts.join(' | ');
}

const iso = (d: Date): string => d.toISOString();

export const EXPORT_PROFILES: Record<string, ExportProfile> = {
  mailer_v1: {
    name: 'mailer_v1',
    description: 'Default: the 7 columns the mailer imports.',
    columns: [
      { header: 'business_name', value: (l) => l.businessName },
      { header: 'email', value: (l) => l.email },
      { header: 'phone', value: (l) => l.phone },
      { header: 'website', value: (l) => l.website },
      { header: 'city', value: (l) => l.city },
      { header: 'category', value: (l) => l.category },
      { header: 'notes', value: mailerNotes },
    ],
  },
  legacy_9col: {
    name: 'legacy_9col',
    description: 'Old 9-column format.',
    columns: [
      { header: 'name', value: (l) => l.businessName },
      { header: 'email', value: (l) => l.email },
      { header: 'phone', value: (l) => l.phone },
      { header: 'businessName', value: (l) => l.businessName },
      { header: 'website', value: (l) => l.website },
      { header: 'category', value: (l) => l.category },
      { header: 'source', value: (l) => l.sources.join(';') },
      { header: 'status', value: (l) => l.status.toLowerCase() },
      { header: 'createdAt', value: (l) => iso(l.firstSeenAt) },
    ],
  },
  full: {
    name: 'full',
    description: 'Every field, for checking and analysis.',
    columns: [
      { header: 'place_id', value: (l) => l.placeId },
      { header: 'business_name', value: (l) => l.businessName },
      { header: 'email', value: (l) => l.email },
      { header: 'extra_emails', value: (l) => l.extraEmails.join(';') },
      { header: 'email_type', value: (l) => l.emailType.toLowerCase() },
      { header: 'email_own_domain', value: (l) => (l.emailOwnDomain ? 'yes' : 'no') },
      { header: 'phone', value: (l) => l.phone },
      { header: 'website', value: (l) => l.website },
      { header: 'address', value: (l) => l.address },
      { header: 'city', value: (l) => l.city },
      { header: 'country', value: (l) => countryName(l.countryCode) },
      { header: 'lat', value: (l) => l.lat },
      { header: 'lng', value: (l) => l.lng },
      { header: 'category', value: (l) => l.category },
      { header: 'subcategories', value: (l) => l.subcategories.join(';') },
      { header: 'source', value: (l) => l.sources.join(';') },
      { header: 'rating', value: (l) => l.rating },
      { header: 'rating_count', value: (l) => l.ratingCount },
      { header: 'score', value: (l) => l.score },
      { header: 'status', value: (l) => l.status.toLowerCase() },
      { header: 'first_seen_at', value: (l) => iso(l.firstSeenAt) },
    ],
  },
};

export const PROFILE_NAMES = Object.keys(EXPORT_PROFILES) as [string, ...string[]];

/** Header and rows of a profile for the given leads. */
export function renderRows(
  profile: ExportProfile,
  leads: ExportLead[],
): { header: string[]; rows: (string | number | null)[][] } {
  return {
    header: profile.columns.map((c) => c.header),
    rows: leads.map((lead) => profile.columns.map((c) => c.value(lead))),
  };
}

/** ainoviro_leads_{YYYY-MM-DD}_{country}_{count}.csv */
export function exportFilename(date: Date, countryCode: string, count: number): string {
  return `ainoviro_leads_${date.toISOString().slice(0, 10)}_${countryCode.toUpperCase()}_${count}.csv`;
}