import { MAX_PAGES } from '../adapters/google-places';

/** Used when there is no search history yet for these keywords. */
export const DEFAULT_AVERAGE_PAGES = 2;

export type CostVerdict = 'FITS' | 'MAY_NOT_FIT' | 'DOES_NOT_FIT';

export interface CostEstimate {
  /** One page per task: the least it can cost. */
  minimum: number;
  /** Tasks x average pages seen in past searches (or the default). */
  estimated: number;
  /** Every task using all 3 pages. Splits of dense areas come on top. */
  maximumWithoutSplits: number;
  averagePages: number;
  freeRemaining: number;
  /** FITS: even the maximum fits; MAY_NOT_FIT: the estimate fits, the maximum does not;
   *  DOES_NOT_FIT: the job will pause when free requests run out (resume next month). */
  verdict: CostVerdict;
}

export function estimateCost(input: { tasksToRun: number; averagePages: number; freeRemaining: number }): CostEstimate {
  const averagePages = Math.min(Math.max(input.averagePages, 1), MAX_PAGES);
  const minimum = input.tasksToRun;
  const estimated = Math.ceil(input.tasksToRun * averagePages);
  const maximumWithoutSplits = input.tasksToRun * MAX_PAGES;
  const verdict: CostVerdict =
    maximumWithoutSplits <= input.freeRemaining
      ? 'FITS'
      : estimated <= input.freeRemaining
        ? 'MAY_NOT_FIT'
        : 'DOES_NOT_FIT';
  return {
    minimum,
    estimated,
    maximumWithoutSplits,
    averagePages: Math.round(averagePages * 100) / 100,
    freeRemaining: input.freeRemaining,
    verdict,
  };
}