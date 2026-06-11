/**
 * Unit tests for src/stats: Welford, P2Quantile, Rng, and the statistical test helpers.
 */

import { describe, expect, it } from 'vitest';
import {
  binomialUpperTail,
  tCriticalAbove,
  tTailAbove,
  welchT,
  wilsonInterval,
} from '../../src/stats/BinomialTest.js';
import { P2Quantile } from '../../src/stats/P2Quantile.js';
import { Rng } from '../../src/stats/Rng.js';
import { Welford } from '../../src/stats/Welford.js';

/** Local deterministic mulberry32 generator with a fixed seed, never the global RNG. */
const mulberry32 = (seed: number): (() => number) => {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t = (t + Math.imul(t ^ (t >>> 7), t | 61)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

const at = (values: readonly number[], index: number): number => {
  const value = values[index];
  if (value === undefined) {
    throw new Error(`index ${index} out of range`);
  }
  return value;
};

/** Type 7 empirical quantile, the same definition P2Quantile uses below five samples. */
const empiricalQuantile = (values: readonly number[], quantile: number): number => {
  const sorted = [...values].sort((a, b) => a - b);
  const rank = (sorted.length - 1) * quantile;
  const lower = Math.floor(rank);
  const upper = Math.ceil(rank);
  return at(sorted, lower) + (rank - lower) * (at(sorted, upper) - at(sorted, lower));
};

const draws = (rng: Rng, count: number): number[] =>
  Array.from({ length: count }, () => rng.next());

describe('Welford', () => {
  it('matches hand-computed statistics on a small array', () => {
    const accumulator = new Welford();
    expect(accumulator.count).toBe(0);
    expect(accumulator.mean).toBe(0);
    expect(accumulator.variance).toBe(0);
    for (const value of [2, 4, 4, 4, 5, 5, 7, 9]) {
      accumulator.observe(value);
    }
    expect(accumulator.count).toBe(8);
    expect(accumulator.mean).toBeCloseTo(5, 12);
    // Squared deviations from 5: 9 + 1 + 1 + 1 + 0 + 0 + 4 + 16 = 32, over n - 1 = 7.
    expect(accumulator.variance).toBeCloseTo(32 / 7, 12);
    expect(accumulator.stdDev).toBeCloseTo(Math.sqrt(32 / 7), 12);
  });

  it('reports variance 0 for the single sample [5]', () => {
    const accumulator = new Welford();
    accumulator.observe(5);
    expect(accumulator.count).toBe(1);
    expect(accumulator.mean).toBe(5);
    expect(accumulator.variance).toBe(0);
    expect(accumulator.stdDev).toBe(0);
  });

  it('stays numerically stable with a large offset', () => {
    const offset = 1e9;
    const accumulator = new Welford();
    for (const delta of [4, 7, 13, 16]) {
      accumulator.observe(offset + delta);
    }
    expect(accumulator.mean).toBeCloseTo(offset + 10, 5);
    // Variance of [4, 7, 13, 16]: (36 + 9 + 9 + 36) / 3 = 30, unaffected by the offset.
    expect(accumulator.variance).toBeCloseTo(30, 6);
    expect(accumulator.stdDev).toBeCloseTo(Math.sqrt(30), 6);
  });

  it('continues correctly after a toJSON/fromJSON roundtrip', () => {
    const original = new Welford();
    for (const value of [0.3, 0.7, 0.45]) {
      original.observe(value);
    }
    const restored = Welford.fromJSON(structuredClone(original.toJSON()));
    for (const value of [0.9, 0.1]) {
      original.observe(value);
      restored.observe(value);
    }
    expect(restored.count).toBe(original.count);
    expect(restored.mean).toBe(original.mean);
    expect(restored.variance).toBe(original.variance);
    expect(restored.toJSON()).toEqual(original.toJSON());
  });
});

describe('P2Quantile', () => {
  it('is exact for fewer than five samples', () => {
    const empty = new P2Quantile(0.5);
    expect(Number.isNaN(empty.estimate())).toBe(true);

    const single = new P2Quantile(0.5);
    single.observe(7);
    expect(single.estimate()).toBe(7);

    const median = new P2Quantile(0.5);
    for (const value of [9, 1, 5]) {
      median.observe(value);
    }
    expect(median.estimate()).toBe(5);

    const interpolated = new P2Quantile(0.5);
    for (const value of [9, 1, 5, 3]) {
      interpolated.observe(value);
    }
    // Sorted [1, 3, 5, 9], rank 1.5 interpolates between 3 and 5.
    expect(interpolated.estimate()).toBe(4);

    const tail = new P2Quantile(0.95);
    for (const value of [10, 20]) {
      tail.observe(value);
    }
    expect(tail.estimate()).toBeCloseTo(19.5, 12);
  });

  it('estimates p50 and p95 of a seeded uniform stream within 5 percent', () => {
    const random = mulberry32(0xc0ffee);
    const samples: number[] = [];
    const p50 = new P2Quantile(0.5);
    const p95 = new P2Quantile(0.95);
    for (let i = 0; i < 2000; i += 1) {
      const value = random();
      samples.push(value);
      p50.observe(value);
      p95.observe(value);
    }
    const true50 = empiricalQuantile(samples, 0.5);
    const true95 = empiricalQuantile(samples, 0.95);
    expect(Math.abs(p50.estimate() - true50) / true50).toBeLessThan(0.05);
    expect(Math.abs(p95.estimate() - true95) / true95).toBeLessThan(0.05);
  });

  it('estimates p50 and p95 of a seeded skewed stream within 5 percent', () => {
    const random = mulberry32(424242);
    const samples: number[] = [];
    const p50 = new P2Quantile(0.5);
    const p95 = new P2Quantile(0.95);
    for (let i = 0; i < 2000; i += 1) {
      // Exponential via inverse CDF, a right-skewed distribution.
      const value = -Math.log(1 - random());
      samples.push(value);
      p50.observe(value);
      p95.observe(value);
    }
    const true50 = empiricalQuantile(samples, 0.5);
    const true95 = empiricalQuantile(samples, 0.95);
    expect(Math.abs(p50.estimate() - true50) / true50).toBeLessThan(0.05);
    expect(Math.abs(p95.estimate() - true95) / true95).toBeLessThan(0.05);
  });

  it('roundtrips mid-stream and continues identically', () => {
    const random = mulberry32(20260611);
    const head = Array.from({ length: 1000 }, () => random());
    const rest = Array.from({ length: 1000 }, () => random());
    const original = new P2Quantile(0.95);
    for (const value of head) {
      original.observe(value);
    }
    const restored = P2Quantile.fromJSON(structuredClone(original.toJSON()));
    for (const value of rest) {
      original.observe(value);
      restored.observe(value);
    }
    expect(restored.estimate()).toBe(original.estimate());
    expect(restored.toJSON()).toEqual(original.toJSON());
  });

  it('roundtrips while still buffering below five samples', () => {
    const original = new P2Quantile(0.5);
    for (const value of [3, 1, 4]) {
      original.observe(value);
    }
    const restored = P2Quantile.fromJSON(structuredClone(original.toJSON()));
    for (const value of [1, 5]) {
      original.observe(value);
      restored.observe(value);
    }
    expect(restored.estimate()).toBe(original.estimate());
    expect(restored.toJSON()).toEqual(original.toJSON());
  });
});

describe('Rng', () => {
  it('produces the same first 10 draws for the same seed', () => {
    expect(draws(new Rng(42), 10)).toEqual(draws(new Rng(42), 10));
  });

  it('produces different sequences for different seeds', () => {
    expect(draws(new Rng(1), 10)).not.toEqual(draws(new Rng(2), 10));
  });

  it('keeps every draw in [0, 1)', () => {
    for (const seed of [0, 7, 0xdeadbeef]) {
      const rng = new Rng(seed);
      let violations = 0;
      for (let i = 0; i < 1000; i += 1) {
        const value = rng.next();
        if (value < 0 || value >= 1) {
          violations += 1;
        }
      }
      expect(violations).toBe(0);
    }
  });

  it('forks deterministically by parent seed and label without advancing the parent', () => {
    expect(draws(new Rng(7).fork('canary'), 10)).toEqual(draws(new Rng(7).fork('canary'), 10));
    expect(draws(new Rng(7).fork('canary'), 10)).not.toEqual(
      draws(new Rng(7).fork('baseline'), 10),
    );
    expect(draws(new Rng(7).fork('canary'), 10)).not.toEqual(draws(new Rng(8).fork('canary'), 10));
    const parent = new Rng(7);
    parent.fork('canary');
    expect(parent.next()).toBe(new Rng(7).next());
  });

  it('resumes the sequence exactly after toJSON/fromJSON', () => {
    const original = new Rng(99);
    draws(original, 5);
    const restored = Rng.fromJSON(structuredClone(original.toJSON()));
    expect(draws(restored, 10)).toEqual(draws(original, 10));
  });
});

describe('binomialUpperTail', () => {
  it('matches hand-computed exact small cases', () => {
    // P(X >= 2 | n = 3, p = 0.5) = 3/8 + 1/8 = 0.5.
    expect(binomialUpperTail(2, 3, 0.5)).toBeCloseTo(0.5, 9);
    // P(X >= 1 | n = 2, p = 0.1) = 1 - 0.9^2 = 0.19.
    expect(binomialUpperTail(1, 2, 0.1)).toBeCloseTo(0.19, 9);
    // P(X >= 5 | n = 5, p = 0.5) = 1/32.
    expect(binomialUpperTail(5, 5, 0.5)).toBeCloseTo(0.03125, 9);
  });

  it('is monotonically decreasing in successes', () => {
    let previous = binomialUpperTail(0, 10, 0.3);
    expect(previous).toBe(1);
    for (let successes = 1; successes <= 10; successes += 1) {
      const tail = binomialUpperTail(successes, 10, 0.3);
      expect(tail).toBeLessThan(previous);
      previous = tail;
    }
  });

  it('handles boundary success counts and probabilities', () => {
    expect(binomialUpperTail(0, 5, 0.4)).toBe(1);
    expect(binomialUpperTail(-2, 5, 0.4)).toBe(1);
    expect(binomialUpperTail(6, 5, 0.4)).toBe(0);
    expect(binomialUpperTail(3, 5, 0)).toBe(0);
    expect(binomialUpperTail(3, 5, 1)).toBe(1);
  });
});

describe('wilsonInterval', () => {
  it('matches the textbook 8 of 10 interval at z = 1.96', () => {
    const { lower, upper } = wilsonInterval(8, 10, 1.96);
    expect(Math.abs(lower - 0.49)).toBeLessThan(0.01);
    expect(Math.abs(upper - 0.943)).toBeLessThan(0.01);
    expect(lower).toBeLessThan(upper);
  });

  it('keeps bounds inside [0, 1] and ordered at the extremes', () => {
    for (const [successes, trials] of [
      [0, 5],
      [5, 5],
      [1, 3],
    ] as const) {
      const { lower, upper } = wilsonInterval(successes, trials, 1.96);
      expect(lower).toBeGreaterThanOrEqual(0);
      expect(upper).toBeLessThanOrEqual(1);
      expect(lower).toBeLessThanOrEqual(upper);
    }
    expect(wilsonInterval(0, 0, 1.96)).toEqual({ lower: 0, upper: 1 });
  });
});

describe('welchT', () => {
  it('returns the neutral statistic for degenerate inputs', () => {
    expect(welchT(1, 1, 1, 0, 1, 10)).toEqual({ t: 0, df: 1 });
    expect(welchT(1, 1, 10, 0, 1, 1)).toEqual({ t: 0, df: 1 });
    expect(welchT(0.9, 0, 50, 0.4, 0, 50)).toEqual({ t: 0, df: 1 });
  });

  it('matches a hand-checked case with unequal variances', () => {
    // varA/nA = 0.5, varB/nB = 0.1, t = 2 / sqrt(0.6), Welch-Satterthwaite df below.
    const { t, df } = welchT(10, 4, 8, 8, 1, 10);
    expect(t).toBeCloseTo(2.581988897471611, 9);
    expect(df).toBeCloseTo(9.775862068965518, 6);
  });
});

describe('tTailAbove', () => {
  // The tail is EXACT (regularized incomplete beta), replacing the former
  // "conservative" normal-tail bound that in fact underestimated the true tail by
  // 5x to 15x at low degrees of freedom and silently overspent the promotion
  // alpha. The assertions below pin exactness against closed forms and standard
  // t-table values instead of the old approximation's behavior.
  it('decreases as t grows and stays within [0, 1]', () => {
    const tails = [0, 0.5, 1, 2, 3].map((t) => tTailAbove(t, 50));
    for (let i = 1; i < tails.length; i += 1) {
      expect(at(tails, i)).toBeLessThan(at(tails, i - 1));
    }
    for (const t of [-3, -1, 0, 1, 3]) {
      for (const df of [1, 5, 30, 200]) {
        const tail = tTailAbove(t, df);
        expect(tail).toBeGreaterThanOrEqual(0);
        expect(tail).toBeLessThanOrEqual(1);
      }
    }
  });

  it('matches the closed forms at df 1 and df 2', () => {
    // df = 1 is the Cauchy distribution: P(T > t) = 1/2 - atan(t) / pi.
    expect(tTailAbove(1, 1)).toBeCloseTo(0.25, 10);
    expect(tTailAbove(2, 1)).toBeCloseTo(0.5 - Math.atan(2) / Math.PI, 10);
    // df = 2 has the closed form P(T > t) = (1 - t / sqrt(2 + t^2)) / 2.
    expect(tTailAbove(2, 2)).toBeCloseTo((1 - 2 / Math.sqrt(6)) / 2, 10);
    expect(tTailAbove(3, 2)).toBeCloseTo((1 - 3 / Math.sqrt(11)) / 2, 10);
  });

  it('matches standard one-sided t-table values exactly', () => {
    // P(T > 0 | any df) = 1/2 by symmetry.
    expect(tTailAbove(0, 7)).toBeCloseTo(0.5, 10);
    // t_{0.05, 10} = 1.8125: hand-checked tail 0.0499968 (Simpson reference probe).
    expect(tTailAbove(1.8125, 10)).toBeCloseTo(0.05, 4);
    // t_{0.01, 7} = 2.998: hand-checked tail 0.0099993.
    expect(tTailAbove(2.998, 7)).toBeCloseTo(0.01, 4);
    // t_{0.025, 30} = 2.0423: hand-checked tail 0.0249986. The old bound switched
    // to the raw normal at df >= 30 and reported 0.025 at t = 1.96 instead.
    expect(tTailAbove(2.0423, 30)).toBeCloseTo(0.025, 4);
    // P(T > 2 | df = 10) = 0.0366940, independently verified by Simpson
    // integration of the t density (probe (d), agreement within 1e-8 relative).
    expect(tTailAbove(2, 10)).toBeCloseTo(0.036694, 6);
    // P(T > 3 | df = 7) = 0.0099711: the old bound reported 0.191x this value.
    expect(tTailAbove(3, 7)).toBeCloseTo(0.0099711, 6);
  });

  it('reports heavier tails for smaller df, converges to the normal, and is symmetric', () => {
    expect(tTailAbove(2, 1)).toBeGreaterThan(tTailAbove(2, 5));
    expect(tTailAbove(2, 5)).toBeGreaterThan(tTailAbove(2, 30));
    expect(tTailAbove(2, 30)).toBeGreaterThan(tTailAbove(2, 1000));
    // Large df converges to the standard normal tail: P(Z > 1.959964) = 0.025.
    expect(tTailAbove(1.959964, 1e6)).toBeCloseTo(0.025, 4);
    // Symmetry: P(T > -t) + P(T > t) = 1.
    expect(tTailAbove(-2, 7) + tTailAbove(2, 7)).toBeCloseTo(1, 10);
    expect(tTailAbove(-3.5, 4) + tTailAbove(3.5, 4)).toBeCloseTo(1, 10);
  });
});

describe('tCriticalAbove', () => {
  it('inverts the exact tail at standard table anchor points', () => {
    // One-sided critical values from standard t tables.
    expect(tCriticalAbove(0.05, 10)).toBeCloseTo(1.8125, 3);
    expect(tCriticalAbove(0.01, 7)).toBeCloseTo(2.998, 3);
    expect(tCriticalAbove(0.025, 30)).toBeCloseTo(2.0423, 3);
    // alpha >= 0.5 is already satisfied at t = 0.
    expect(tCriticalAbove(0.5, 9)).toBe(0);
  });

  it('round-trips through tTailAbove to full precision', () => {
    for (const [alpha, df] of [
      [0.005, 5],
      [0.001, 12],
      [0.05, 3],
      [0.0015625, 7],
    ] as const) {
      expect(tTailAbove(tCriticalAbove(alpha, df), df)).toBeCloseTo(alpha, 9);
    }
  });
});
