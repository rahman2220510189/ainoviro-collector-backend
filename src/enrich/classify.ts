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
}

/**
 * Primary email per place (spec §9): own-domain first, then non-generic, then
 * the rest. Ties: a working mail server (MX) first, then the order found on the
 * site (contact page before footer). Returns the index of the best email.
 */
export function pickPrimaryIndex(emails: RankableEmail[]): number {
  if (emails.length === 0) return -1;
  const score = (e: RankableEmail): number =>
    (e.isOwnDomain ? 100 : 0) +
    (e.emailType === 'PERSONAL' ? 10 : 0) +
    (e.mxValid === false ? -1000 : e.mxValid ? 1 : 0);
  let best = 0;
  emails.forEach((email, i) => {
    const current = emails[best];
    if (current && score(email) > score(current)) best = i;
  });
  return best;
}