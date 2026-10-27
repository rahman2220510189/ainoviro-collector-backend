/**
 * Role/generic mailboxes (flagged, not removed; spec §9). Matched against the
 * part before "@" with any "+tag" removed, exactly or as a prefix followed by a
 * separator/digits ("info.limassol@", "sales2@").
 */
const GENERIC_WORDS = (
  'info contact contacts hello hi office sales support admin enquiries enquiry inquiries ' +
  'inquiry booking bookings book reservations reservation reception mail email team service ' +
  'services customerservice customercare care marketing hr jobs careers accounts accounting ' +
  'billing finance orders order shop store help general studio salon spa clinic webmaster ' +
  'web press media events management manager frontdesk appointments secretary grammateia ' +
  'plirofories kratiseis'
).split(' ');
const GENERIC_PATTERN = new RegExp(`^(?:${GENERIC_WORDS.join('|')})(?:$|[._-]|\\d)`);

export function isGenericLocalPart(email: string): boolean {
  const local = (email.split('@')[0] ?? '').split('+')[0] ?? '';
  return GENERIC_PATTERN.test(local);
}

/**
 * Mailboxes for data protection, legal or complaints (step 7.4): published so people can
 * exercise their rights, not to receive offers. A sales email there invites complaints,
 * so such an address is never chosen as primary when another one exists, and a lead whose
 * only address is one of these is held for review.
 */
const ROLE_WORDS = (
  'privacy dpo gdpr dataprotection data-protection data\\.protection dataprivacy ' +
  'legal compliance complaints complaint unsubscribe optout opt-out'
).split(' ');
const ROLE_PATTERN = new RegExp(`^(?:${ROLE_WORDS.join('|')})(?:$|[._-]|\\d)`);

/** The same test for Postgres, applied to a whole normalized address ("dpo@x.cy"). */
export const ROLE_ADDRESS_SQL = `^(?:${ROLE_WORDS.join('|')})(?:@|[._+-]|[0-9])`;

export function isRoleAddress(email: string): boolean {
  const local = (email.split('@')[0] ?? '').split('+')[0] ?? '';
  return ROLE_PATTERN.test(local);
}

/** Email domain equals the website's domain, or one is a subdomain of the other. */
export function isOwnDomain(emailDomain: string, websiteDomain: string | null): boolean {
  if (!websiteDomain) return false;
  const site = websiteDomain.replace(/^www\./, '');
  return (
    emailDomain === site || emailDomain.endsWith(`.${site}`) || site.endsWith(`.${emailDomain}`)
  );
}

export interface RankableEmail {
  isOwnDomain: boolean;
  emailType: 'GENERIC' | 'PERSONAL';
  mxValid: boolean | null;
  /** Normalized address, when known: data-protection/legal mailboxes rank last but one. */
  normalized?: string;
}

/**
 * Primary email per place (spec §9): own-domain first, then non-generic, then
 * the rest. Ties: a working mail server (MX) first, then the order found on the
 * site (contact page before footer). A data-protection/legal mailbox (privacy@, dpo@)
 * only wins when nothing else works. Returns the index of the best email.
 */
export function pickPrimaryIndex(emails: RankableEmail[]): number {
  if (emails.length === 0) return -1;
  const score = (e: RankableEmail): number =>
    (e.isOwnDomain ? 100 : 0) +
    (e.emailType === 'PERSONAL' ? 10 : 0) +
    (e.mxValid === false ? -1000 : e.mxValid ? 1 : 0) +
    (e.normalized && isRoleAddress(e.normalized) ? -500 : 0);
  let best = 0;
  emails.forEach((email, i) => {
    const current = emails[best];
    if (current && score(email) > score(current)) best = i;
  });
  return best;
}
