/**
 * Keeps a free hosted backend (Render free plan) from falling asleep during working hours.
 * A free service sleeps after 15 minutes without incoming requests, and the worker inside
 * it sleeps too. Every 10 minutes, inside the configured hours, the server calls its own
 * public address (/health). Outside those hours it stops, so the service can sleep and the
 * free database compute hours last the month.
 *
 * A sleeping service cannot wake itself: the first request of the day (an uptime monitor,
 * or anyone opening the website) wakes it, and from then on it stays awake until the end
 * of the window.
 *
 *   KEEP_AWAKE_HOURS=8-22         local hours, start inclusive, end exclusive ("22-6" wraps)
 *   KEEP_AWAKE_TZ=Asia/Dhaka      time zone of those hours
 *   KEEP_AWAKE_URL=https://...    defaults to Render's RENDER_EXTERNAL_URL
 */
const EVERY_MS = 10 * 60_000;

export interface KeepAwakeConfig {
  url: string;
  startHour: number;
  endHour: number;
  timeZone: string;
}

export function parseHours(value: string): { startHour: number; endHour: number } | null {
  const m = /^\s*(\d{1,2})\s*-\s*(\d{1,2})\s*$/.exec(value);
  if (!m) return null;
  const startHour = Number(m[1]);
  const endHour = Number(m[2]);
  if (startHour > 23 || endHour > 24 || startHour === endHour) return null;
  return { startHour, endHour };
}

/** Hour of the day (0-23) in a time zone. */
export function hourIn(timeZone: string, now = new Date()): number {
  const text = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    hourCycle: 'h23',
  }).format(now);
  return Number(text) % 24;
}

export function insideWindow(hour: number, startHour: number, endHour: number): boolean {
  return startHour < endHour
    ? hour >= startHour && hour < endHour
    : hour >= startHour || hour < endHour;
}

export function keepAwakeConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): KeepAwakeConfig | null {
  const hours = parseHours(env.KEEP_AWAKE_HOURS ?? '');
  const url = (env.KEEP_AWAKE_URL ?? env.RENDER_EXTERNAL_URL ?? '').replace(/\/+$/, '');
  if (!hours || !/^https?:\/\//.test(url)) return null;
  const timeZone = env.KEEP_AWAKE_TZ || 'Asia/Dhaka';
  try {
    hourIn(timeZone);
  } catch {
    return null;
  }
  return { url, timeZone, ...hours };
}

/** Starts the timer; returns a function that stops it. */
export function startKeepAwake(
  config: KeepAwakeConfig,
  log: (msg: string) => void,
  fetchFn: typeof fetch = fetch,
): () => void {
  const tick = async (): Promise<void> => {
    if (!insideWindow(hourIn(config.timeZone), config.startHour, config.endHour)) return;
    try {
      await fetchFn(`${config.url}/health`, { signal: AbortSignal.timeout(30_000) });
    } catch (err) {
      log(`keep-awake call failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  const timer = setInterval(() => void tick(), EVERY_MS);
  timer.unref();
  log(
    `keep-awake on: ${config.url}/health every 10 min, ${config.startHour}:00-${config.endHour}:00 ${config.timeZone}`,
  );
  return () => clearInterval(timer);
}
