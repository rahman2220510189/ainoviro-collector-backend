import { LOOP_LABEL, type LoopState } from './loop-health';
import type { HealthCounts, HealthSnapshot } from './snapshots';

/**
 * Warnings for the dashboard (step 7.5): problems that would otherwise stay silent for
 * days, such as emails being found while none of them becomes ready to download.
 * Pure function: everything it needs is passed in, so it is easy to test.
 */
export interface HealthAlert {
  level: 'error' | 'warning';
  code: string;
  title: string;
  detail: string;
  /** Page that shows the affected leads, when there is one. */
  href?: string;
}

export const REASON_TEXT: Record<string, string> = {
  EMAIL_SYNTAX: 'Email address is not valid',
  EMAIL_NO_MX: 'No mail server',
  EMAIL_MX_UNKNOWN: 'Mail server not checked yet',
  EMAIL_ROLE: 'Data-protection or legal address',
  NO_REAL_CITY: 'No real city',
  NO_CATEGORY: 'No category',
  PHONE_INVALID: 'No valid phone number',
};

export interface AlertInput {
  now: Date;
  /** null when the worker is not running (the page already shows that notice). */
  worker: { crawling: boolean; loops: LoopState[] } | null;
  current: HealthCounts;
  /** Snapshot about 24 hours old, if any. */
  dayAgo: HealthSnapshot | null;
  /** Snapshot about 6 hours old, if any. */
  sixHoursAgo: HealthSnapshot | null;
  websites: { waiting: number; lastCrawlAt: string | null };
}

/** A loop failing this many rounds in a row is a warning; LOOP_ERROR_AT an error. */
export const LOOP_WARN_AT = 3;
export const LOOP_ERROR_AT = 10;
/** Websites waiting but none crawled for this long: crawling is stuck. */
export const CRAWL_STALL_HOURS = 2;
/** At least this many new emails in a day before "none became ready" is suspicious. */
export const MIN_NEW_EMAILS = 20;
/** A reason must grow by this many leads AND this share in a day to be a spike. */
export const SPIKE_MIN_LEADS = 50;
export const SPIKE_MIN_SHARE = 0.3;
/** "Not checked yet" above this and not shrinking for 6 hours: checks get no answers. */
export const MX_UNKNOWN_STUCK = 100;

const fmt = (n: number): string => n.toLocaleString('en-GB');
const hoursSince = (iso: string, now: Date): number =>
  (now.getTime() - new Date(iso).getTime()) / 3_600_000;

export function computeAlerts(input: AlertInput): HealthAlert[] {
  const { now, worker, current, dayAgo, sixHoursAgo, websites } = input;
  const alerts: HealthAlert[] = [];

  // 1. Parts of the worker that keep failing.
  if (worker) {
    for (const loop of worker.loops) {
      if (loop.errors < LOOP_WARN_AT) continue;
      const label = LOOP_LABEL[loop.name] ?? loop.name;
      alerts.push({
        level: loop.errors >= LOOP_ERROR_AT ? 'error' : 'warning',
        code: `LOOP_FAILING_${loop.name.toUpperCase()}`,
        title: `${label} keeps failing`,
        detail:
          `${fmt(loop.errors)} failures in a row` +
          (loop.okAt ? `; last success ${new Date(loop.okAt).toLocaleString('en-GB')}` : '') +
          (loop.lastError ? `. Last error: ${loop.lastError}` : '.') +
          ' It retries by itself; if this stays, check the Render logs.',
      });
    }

    // 2. Websites waiting, but crawling stopped.
    if (
      worker.crawling &&
      websites.waiting > 0 &&
      websites.lastCrawlAt &&
      hoursSince(websites.lastCrawlAt, now) >= CRAWL_STALL_HOURS
    ) {
      alerts.push({
        level: 'warning',
        code: 'CRAWL_STALLED',
        title: 'Website crawling has stopped',
        detail: `${fmt(websites.waiting)} websites are waiting, but none was read for ${Math.floor(
          hoursSince(websites.lastCrawlAt, now),
        )} hours.`,
      });
    }
  }

  // 3. Emails found, but none became ready (the "stuck at 3" problem).
  if (dayAgo) {
    const newEmails = current.emailsTotal - dayAgo.emailsTotal;
    const exported = current.exportedTotal - dayAgo.exportedTotal;
    const becameReady = current.ready + exported - dayAgo.ready;
    if (newEmails >= MIN_NEW_EMAILS && becameReady <= 0) {
      const top = Object.entries(current.reasons).sort((a, b) => b[1] - a[1])[0];
      alerts.push({
        level: 'error',
        code: 'NOTHING_BECAME_READY',
        title: 'Emails are being found, but none became ready in 24 hours',
        detail:
          `${fmt(newEmails)} new emails since yesterday, 0 new leads ready to download.` +
          (top ? ` Most held leads: “${REASON_TEXT[top[0]] ?? top[0]}” (${fmt(top[1])}).` : '') +
          ' Open the held leads to see why.',
        href: top ? `/leads?needsReview=yes&reason=${top[0]}` : '/leads?needsReview=yes',
      });
    }

    // 4. A review reason that suddenly grew.
    for (const [reason, n] of Object.entries(current.reasons)) {
      const before = dayAgo.reasons[reason] ?? 0;
      const grew = n - before;
      if (grew >= SPIKE_MIN_LEADS && (before === 0 || grew / before >= SPIKE_MIN_SHARE)) {
        alerts.push({
          level: 'warning',
          code: `REASON_SPIKE_${reason}`,
          title: `More leads held for “${REASON_TEXT[reason] ?? reason}”`,
          detail: `${fmt(before)} → ${fmt(n)} in 24 hours. A sudden rise usually means a check is failing, not that the businesses changed.`,
          href: `/leads?needsReview=yes&reason=${reason}`,
        });
      }
    }
  }

  // 5. Mail-server checks get no answers.
  const unknown = current.reasons.EMAIL_MX_UNKNOWN ?? 0;
  if (
    sixHoursAgo &&
    unknown >= MX_UNKNOWN_STUCK &&
    unknown >= (sixHoursAgo.reasons.EMAIL_MX_UNKNOWN ?? 0)
  ) {
    alerts.push({
      level: 'warning',
      code: 'MX_CHECKS_STUCK',
      title: 'Mail-server checks are not getting answers',
      detail: `${fmt(unknown)} leads wait for a mail-server check, no fewer than 6 hours ago. The worker keeps asking; if this stays, the host’s DNS may be blocked.`,
      href: '/leads?needsReview=yes&reason=EMAIL_MX_UNKNOWN',
    });
  }

  // Errors first.
  return alerts.sort((a, b) => (a.level === b.level ? 0 : a.level === 'error' ? -1 : 1));
}
