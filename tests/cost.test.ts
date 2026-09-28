import { describe, expect, it } from 'vitest';
import { estimateCost } from '../src/jobs/cost';

describe('estimateCost', () => {
  it('FITS when even 3 pages per task fit', () => {
    expect(estimateCost({ tasksToRun: 9, averagePages: 2, freeRemaining: 1000 })).toEqual({
      minimum: 9,
      estimated: 18,
      maximumWithoutSplits: 27,
      averagePages: 2,
      freeRemaining: 1000,
      verdict: 'FITS',
    });
  });

  it('MAY_NOT_FIT when the estimate fits but the maximum does not, DOES_NOT_FIT otherwise', () => {
    expect(estimateCost({ tasksToRun: 243, averagePages: 2, freeRemaining: 600 }).verdict).toBe('MAY_NOT_FIT');
    expect(estimateCost({ tasksToRun: 3429, averagePages: 2, freeRemaining: 1000 }).verdict).toBe('DOES_NOT_FIT');
  });

  it('keeps the average between 1 and 3 pages', () => {
    expect(estimateCost({ tasksToRun: 10, averagePages: 7, freeRemaining: 1000 }).estimated).toBe(30);
    expect(estimateCost({ tasksToRun: 10, averagePages: 0.2, freeRemaining: 1000 }).estimated).toBe(10);
  });
});