/**
 * Health of the worker's loops (step 7.5). Every loop reports each round as ok or failed;
 * the worker puts the snapshot into its heartbeat, so the dashboard can say "website
 * crawling has failed 12 times in a row" instead of the problem staying silent.
 */
export const LOOP_LABEL: Record<string, string> = {
  search: 'Google searches',
  overture: 'Free data (Overture)',
  refresh: 'Overture update',
  crawl: 'Website crawling',
  shop: 'Online-shop check',
  mx: 'Mail-server recheck',
  leads: 'Lead refresh',
  snapshot: 'Health snapshot',
};

export interface LoopState {
  name: string;
  /** Last round that worked (ISO). */
  okAt: string | null;
  /** Last round that failed (ISO). */
  errorAt: string | null;
  /** Failed rounds in a row; back to 0 after a good round. */
  errors: number;
  lastError: string | null;
  /** Times the loop stopped unexpectedly and was started again. */
  restarts: number;
}

const message = (err: unknown): string =>
  (err instanceof Error ? err.message : String(err)).replace(/\s+/g, ' ').slice(0, 300);

export class LoopHealth {
  private readonly states = new Map<string, LoopState>();

  constructor(private readonly now: () => Date = () => new Date()) {}

  private get(name: string): LoopState {
    let s = this.states.get(name);
    if (!s) {
      s = { name, okAt: null, errorAt: null, errors: 0, lastError: null, restarts: 0 };
      this.states.set(name, s);
    }
    return s;
  }

  /** Registers a loop, so it is listed even before its first round. */
  register(name: string): void {
    this.get(name);
  }

  ok(name: string): void {
    const s = this.get(name);
    s.okAt = this.now().toISOString();
    s.errors = 0;
  }

  fail(name: string, err: unknown): void {
    const s = this.get(name);
    s.errorAt = this.now().toISOString();
    s.errors += 1;
    s.lastError = message(err);
  }

  restarted(name: string): void {
    this.get(name).restarts += 1;
  }

  snapshot(): LoopState[] {
    return [...this.states.values()].map((s) => ({ ...s }));
  }
}

/**
 * Keeps a loop alive: if it ever returns or throws while the worker is not stopping (a
 * bug, or an error outside its own try/catch), it is logged and started again after a
 * pause, instead of that part of the worker silently doing nothing until a restart.
 */
export async function supervise(
  name: string,
  run: () => Promise<void>,
  opts: {
    health: LoopHealth;
    stopped: () => boolean;
    onRestart: (err: unknown) => void;
    pause: (ms: number) => Promise<void>;
    pauseMs?: number;
  },
): Promise<void> {
  while (!opts.stopped()) {
    let error: unknown = new Error('loop ended unexpectedly');
    try {
      await run();
    } catch (err) {
      error = err;
    }
    if (opts.stopped()) return;
    opts.health.fail(name, error);
    opts.health.restarted(name);
    opts.onRestart(error);
    await opts.pause(opts.pauseMs ?? 30_000);
  }
}
