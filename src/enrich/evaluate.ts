import { emailDomain } from '../lib/email';
import { isGenericLocalPart, isOwnDomain, pickPrimaryIndex } from './classify';
import { extractEmailsFromPage, type EmailSource } from './extract';
import { isDisposableDomain, rejectReason, type RejectReason } from './filters';
import type { MxChecker } from './mx';

/** A site listing more addresses than this is probably a directory; keep the first ones. */
export const MAX_EMAILS_PER_SITE = 10;

export interface EvaluatedEmail {
  original: string;
  normalized: string;
  domain: string;
  source: EmailSource;
  sourceUrl: string;
  emailType: 'GENERIC' | 'PERSONAL';
  isOwnDomain: boolean;
  isFreeMail: boolean;
  isDisposable: boolean;
  mxValid: boolean | null;
  isPrimary: boolean;
}

export interface EvaluationContext {
  /** Own domain of the place's website, e.g. "shop.cy". */
  websiteDomain: string | null;
  /** gmail.com, cytanet.com.cy ... (from the free_email_domains table). */
  freeDomains: ReadonlySet<string>;
  mx: MxChecker;
}

export interface EvaluationResult {
  emails: EvaluatedEmail[];
  rejected: { email: string; reason: RejectReason }[];
  /** Found but dropped because of MAX_EMAILS_PER_SITE. */
  overLimit: number;
}

/**
 * From crawled pages to classified emails: extract from every page (in crawl
 * order, so the contact page beats the footer), drop false positives, classify
 * generic/personal, own domain, free-mail and disposable, check MX, and mark
 * exactly one primary.
 */
export async function evaluateSiteEmails(
  pages: { url: string; html: string }[],
  ctx: EvaluationContext,
): Promise<EvaluationResult> {
  const seen = new Set<string>();
  const rejected: EvaluationResult['rejected'] = [];
  const kept: Omit<EvaluatedEmail, 'mxValid' | 'isPrimary'>[] = [];

  for (const page of pages) {
    for (const found of extractEmailsFromPage(page.html, page.url)) {
      if (seen.has(found.normalized)) continue;
      seen.add(found.normalized);
      const reason = rejectReason(found.normalized);
      if (reason) {
        rejected.push({ email: found.normalized, reason });
        continue;
      }
      const domain = emailDomain(found.normalized);
      const ownDomain = isOwnDomain(domain, ctx.websiteDomain);
      const freeMail = ctx.freeDomains.has(domain);
      // Addresses hidden in page code are often those of the web designer, a plugin or a
      // tracking service; keep them only when they clearly belong to the business.
      if ((found.source === 'script' || found.source === 'attribute') && !ownDomain && !freeMail) {
        rejected.push({ email: found.normalized, reason: 'THIRD_PARTY_IN_CODE' });
        continue;
      }
      kept.push({
        original: found.original,
        normalized: found.normalized,
        domain,
        source: found.source,
        sourceUrl: found.sourceUrl,
        emailType: isGenericLocalPart(found.normalized) ? 'GENERIC' : 'PERSONAL',
        isOwnDomain: ownDomain,
        isFreeMail: freeMail,
        isDisposable: isDisposableDomain(domain),
      });
    }
  }

  const limited = kept.slice(0, MAX_EMAILS_PER_SITE);
  const emails: EvaluatedEmail[] = [];
  for (const email of limited) {
    emails.push({ ...email, mxValid: await ctx.mx.check(email.domain), isPrimary: false });
  }
  // A disposable address ranks like one without a mail server: last.
  const primary = pickPrimaryIndex(
    emails.map((e) => (e.isDisposable ? { ...e, mxValid: false } : e)),
  );
  const chosen = emails[primary];
  if (chosen) chosen.isPrimary = true;

  return { emails, rejected, overLimit: kept.length - limited.length };
}