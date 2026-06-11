/**
 * Unit tests for src/bandit: objective weights, reward shaping, UcbArm, and
 * ParameterBandit.
 */

import { describe, expect, it } from 'vitest';
import { DEFAULT_PARAMETER_SPACE } from '../../src/bandit/defaults.js';
import { ParameterBandit } from '../../src/bandit/ParameterBandit.js';
import { computeReward, type RewardContext, resolveWeights } from '../../src/bandit/reward.js';
import { UcbArm } from '../../src/bandit/UcbArm.js';
import { NoeticosError } from '../../src/errors.js';
import type { ArmStats, ExecutionOutcome, ObjectiveWeights } from '../../src/types.js';

const grab = (fn: () => unknown): unknown => {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error('expected the call to throw');
};

const BALANCED: ObjectiveWeights = { quality: 0.5, cost: 0.25, latency: 0.25 };

const outcome = (overrides: Partial<ExecutionOutcome> = {}): ExecutionOutcome => ({
  executionId: 'exec-1',
  ...overrides,
});

const makeCtx = (o: ExecutionOutcome, overrides: Partial<RewardContext> = {}): RewardContext => ({
  outcome: o,
  weights: BALANCED,
  costP5: 1,
  costP95: 5,
  latencyP5: 100,
  latencyP95: 900,
  ...overrides,
});

describe('DEFAULT_PARAMETER_SPACE', () => {
  it('matches the documented default grids', () => {
    expect(DEFAULT_PARAMETER_SPACE).toEqual({
      temperature: [0, 0.2, 0.4, 0.7, 1.0],
      topP: [0.9, 1.0],
      maxTurns: [8, 16, 32, 64],
      retryBudget: [0, 1, 3],
      contextShare: [0.4, 0.6, 0.8],
    });
  });
});

describe('resolveWeights', () => {
  it('resolves presets to their documented weights', () => {
    expect(resolveWeights('balanced')).toEqual({ quality: 0.5, cost: 0.25, latency: 0.25 });
    expect(resolveWeights('cost')).toEqual({ quality: 0.35, cost: 0.5, latency: 0.15 });
    expect(resolveWeights('latency')).toEqual({ quality: 0.35, cost: 0.15, latency: 0.5 });
    expect(resolveWeights('quality')).toEqual({ quality: 0.7, cost: 0.15, latency: 0.15 });
    expect(resolveWeights()).toEqual({ quality: 0.5, cost: 0.25, latency: 0.25 });
  });

  it('normalizes custom weights to sum to 1', () => {
    expect(resolveWeights({ quality: 3, cost: 1, latency: 1 })).toEqual({
      quality: 0.6,
      cost: 0.2,
      latency: 0.2,
    });
    const normalized = resolveWeights({ quality: 1, cost: 1, latency: 2 });
    expect(normalized.quality + normalized.cost + normalized.latency).toBeCloseTo(1, 12);
    expect(normalized.latency).toBeCloseTo(0.5, 12);
  });

  it('rejects non-positive weight sums with a NoeticosError', () => {
    const zero = grab(() => resolveWeights({ quality: 0, cost: 0, latency: 0 }));
    expect(zero).toBeInstanceOf(NoeticosError);
    expect(zero).toMatchObject({ code: 'ERR_INVALID_INPUT' });
    const negative = grab(() => resolveWeights({ quality: -2, cost: 1, latency: 0.5 }));
    expect(negative).toBeInstanceOf(NoeticosError);
    expect(negative).toMatchObject({ code: 'ERR_INVALID_INPUT' });
  });

  it('rejects an individual negative weight even when the sum is positive', () => {
    // { quality: 2, cost: -0.5, latency: 0.5 } sums to 2 (> 0); before the fix it
    // normalized into a weight set that REWARDED expensive executions.
    const negative = grab(() => resolveWeights({ quality: 2, cost: -0.5, latency: 0.5 }));
    expect(negative).toBeInstanceOf(NoeticosError);
    expect(negative).toMatchObject({ code: 'ERR_INVALID_INPUT' });
    expect((negative as NoeticosError).message).toContain('cost');
  });

  it('rejects non-finite individual weights', () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const error = grab(() => resolveWeights({ quality: bad, cost: 1, latency: 1 }));
      expect(error).toBeInstanceOf(NoeticosError);
      expect(error).toMatchObject({ code: 'ERR_INVALID_INPUT' });
    }
  });
});

describe('computeReward', () => {
  it('lets an explicit qualityScore override every implicit signal', () => {
    const scored = computeReward(
      makeCtx(outcome({ error: true, finishReason: 'error', qualityScore: 0.9 })),
    );
    expect(scored.quality).toBe(0.9);
    // With no cost or latency, both norms are the neutral 0.5.
    expect(scored.reward).toBeCloseTo(0.5 * 0.9 + 0.25 * 0.5 + 0.25 * 0.5, 12);
  });

  it('derives each implicit quality penalty from the outcome', () => {
    expect(computeReward(makeCtx(outcome({ error: true }))).quality).toBe(0);
    expect(computeReward(makeCtx(outcome({ finishReason: 'error' }))).quality).toBe(0);
    expect(computeReward(makeCtx(outcome({ finishReason: 'length' }))).quality).toBeCloseTo(
      0.65,
      12,
    );
    expect(computeReward(makeCtx(outcome({ finishReason: 'content-filter' }))).quality).toBeCloseTo(
      0.5,
      12,
    );
    const failedTool = outcome({
      toolCalls: [
        { name: 'search', ok: true },
        { name: 'search', ok: false },
      ],
    });
    expect(computeReward(makeCtx(failedTool)).quality).toBeCloseTo(0.85, 12);
    expect(computeReward(makeCtx(outcome(), { loopRepeats: 2 })).quality).toBeCloseTo(0.8, 12);
    // The loop penalty caps at 0.4 even for many repeats.
    expect(computeReward(makeCtx(outcome(), { loopRepeats: 7 })).quality).toBeCloseTo(0.6, 12);
    // Penalties stack: truncation 0.35 plus tool failure 0.15.
    const stacked = outcome({ finishReason: 'length', toolCalls: [{ name: 'db', ok: false }] });
    expect(computeReward(makeCtx(stacked)).quality).toBeCloseTo(0.5, 12);
    // A clean completion keeps quality 1.
    expect(computeReward(makeCtx(outcome())).quality).toBe(1);
  });

  it('returns the neutral 0.5 normalization for missing or degenerate bands', () => {
    // Missing cost and latency.
    expect(computeReward(makeCtx(outcome({ qualityScore: 1 }))).reward).toBeCloseTo(0.75, 12);
    // Degenerate cost band p95 === p5, latency exactly mid-band.
    const degenerate = computeReward(
      makeCtx(outcome({ qualityScore: 1, costUsd: 7, latencyMs: 500 }), { costP5: 2, costP95: 2 }),
    );
    expect(degenerate.reward).toBeCloseTo(0.75, 12);
    // Inverted cost band p95 < p5 is degenerate too.
    const inverted = computeReward(
      makeCtx(outcome({ qualityScore: 1, costUsd: 3, latencyMs: 500 }), { costP5: 5, costP95: 1 }),
    );
    expect(inverted.reward).toBeCloseTo(0.75, 12);
  });

  it('normalizes token-only outcomes against the token band, never the cost band', () => {
    const tokenCtx = (input: number, output: number): RewardContext =>
      makeCtx(outcome({ qualityScore: 1, inputTokens: input, outputTokens: output }), {
        tokenP5: 1000,
        tokenP95: 5000,
      });
    const cheap = computeReward(tokenCtx(800, 200));
    const costly = computeReward(tokenCtx(4000, 1200));
    // 1000 total tokens sits at P5 (cost term 1), latency stays neutral at 0.5.
    expect(cheap.reward).toBeCloseTo(0.5 + 0.25 * 1 + 0.25 * 0.5, 12);
    expect(costly.reward).toBeLessThan(cheap.reward);
    expect(costly.reward).toBeCloseTo(0.5 + 0.25 * 0 + 0.25 * 0.5, 12);

    // Without a token band the token-only cost term stays neutral.
    const neutral = computeReward(makeCtx(outcome({ qualityScore: 1, inputTokens: 3000 })));
    expect(neutral.reward).toBeCloseTo(0.75, 12);

    // An explicit costUsd always wins over tokens and uses the dollar band: this
    // outcome is cheap in dollars (P5) even though its tokens sit at the band top.
    const dollars = computeReward(
      makeCtx(outcome({ qualityScore: 1, costUsd: 1, inputTokens: 5000, outputTokens: 0 }), {
        tokenP5: 1000,
        tokenP95: 5000,
      }),
    );
    expect(dollars.reward).toBeCloseTo(0.5 + 0.25 * 1 + 0.25 * 0.5, 12);

    // A single reported side counts alone.
    const oneSided = computeReward(
      makeCtx(outcome({ qualityScore: 1, outputTokens: 5000 }), {
        tokenP5: 1000,
        tokenP95: 5000,
      }),
    );
    expect(oneSided.reward).toBeCloseTo(0.5 + 0.25 * 0 + 0.25 * 0.5, 12);
  });

  it('rewards cheaper and faster executions and stays bounded in [0, 1]', () => {
    const fast = computeReward(makeCtx(outcome({ qualityScore: 1, costUsd: 1, latencyMs: 100 })));
    const slow = computeReward(makeCtx(outcome({ qualityScore: 1, costUsd: 5, latencyMs: 900 })));
    expect(fast.reward).toBeCloseTo(1, 12);
    expect(slow.reward).toBeCloseTo(0.5, 12);
    expect(fast.reward).toBeGreaterThan(slow.reward);

    const extreme = computeReward(
      makeCtx(outcome({ qualityScore: 7, costUsd: -10, latencyMs: 1e9 })),
    );
    expect(extreme.quality).toBe(1);
    expect(extreme.reward).toBeGreaterThanOrEqual(0);
    expect(extreme.reward).toBeLessThanOrEqual(1);

    const floor = computeReward(
      makeCtx(outcome({ qualityScore: -3, costUsd: 1e9, latencyMs: 1e9 })),
    );
    expect(floor.quality).toBe(0);
    expect(floor.reward).toBeGreaterThanOrEqual(0);
    expect(floor.reward).toBeLessThanOrEqual(1);
  });
});

describe('UcbArm', () => {
  it('tracks pulls and mean reward over simple sequences', () => {
    const arm = new UcbArm(0.4);
    expect(arm.pulls).toBe(0);
    expect(arm.meanReward).toBe(0);
    arm.record(0.7);
    expect(arm.pulls).toBe(1);
    expect(arm.meanReward).toBeCloseTo(0.7, 12);
    arm.record(0.7);
    arm.record(0.7);
    // Effective pulls are the discounted count 1 + d + d^2 with d = 0.995.
    expect(arm.pulls).toBeCloseTo(1 + 0.995 + 0.995 * 0.995, 9);
    expect(arm.meanReward).toBeCloseTo(0.7, 12);

    const mixed = new UcbArm(0.4);
    mixed.record(1);
    mixed.record(0);
    expect(mixed.meanReward).toBeCloseTo(0.995 / 1.995, 12);
  });

  it('shifts the discounted mean toward recent rewards', () => {
    const recentOnes = new UcbArm(1);
    for (let i = 0; i < 20; i += 1) {
      recentOnes.record(0);
    }
    for (let i = 0; i < 20; i += 1) {
      recentOnes.record(1);
    }
    // The undiscounted average would be exactly 0.5, recency must push it above.
    expect(recentOnes.meanReward).toBeGreaterThan(0.5);

    const recentZeros = new UcbArm(1);
    for (let i = 0; i < 20; i += 1) {
      recentZeros.record(1);
    }
    for (let i = 0; i < 20; i += 1) {
      recentZeros.record(0);
    }
    expect(recentZeros.meanReward).toBeLessThan(0.5);

    // Over a longer stream the recency shift is material, well above 0.55.
    const longArm = new UcbArm(1);
    for (let i = 0; i < 200; i += 1) {
      longArm.record(0);
    }
    for (let i = 0; i < 200; i += 1) {
      longArm.record(1);
    }
    expect(longArm.meanReward).toBeGreaterThan(0.55);
  });

  it('keeps radius 1 when unpulled and shrinks the radius as pulls grow', () => {
    const arm = new UcbArm(1);
    expect(arm.bounds(10)).toEqual({ lower: -1, upper: 1 });
    arm.record(0.5);
    arm.record(0.5);
    const earlyRadius = arm.bounds(arm.pulls).upper - arm.meanReward;
    for (let i = 0; i < 48; i += 1) {
      arm.record(0.5);
    }
    const lateRadius = arm.bounds(arm.pulls).upper - arm.meanReward;
    expect(earlyRadius).toBeGreaterThan(0);
    expect(lateRadius).toBeGreaterThan(0);
    expect(lateRadius).toBeLessThan(earlyRadius);
  });

  it('preserves mean and pulls across a toJSON/fromJSON roundtrip', () => {
    const arm = new UcbArm('model-fast');
    arm.record(0.9);
    arm.record(0.4);
    arm.record(0.6);
    const restored = UcbArm.fromJSON(structuredClone(arm.toJSON()));
    expect(restored.value).toBe('model-fast');
    expect(Math.abs(restored.pulls - arm.pulls)).toBeLessThan(1e-9);
    expect(Math.abs(restored.meanReward - arm.meanReward)).toBeLessThan(1e-9);
    expect(restored.bounds(3)).toEqual(arm.bounds(3));
  });
});

describe('ParameterBandit', () => {
  it('falls back to the promoted current value when nothing was pulled', () => {
    const bandit = new ParameterBandit('temperature', [0, 0.4, 0.7], 0.4);
    expect(bandit.best()).toBe(0.4);
    expect(bandit.current).toBe(0.4);
  });

  it('breaks mean ties by declaration order', () => {
    const bandit = new ParameterBandit('topP', [0.9, 1.0], 1.0);
    bandit.record(1.0, 0.8);
    bandit.record(0.9, 0.8);
    expect(bandit.best()).toBe(0.9);
  });

  it('prefers unpulled arms in order, then the highest upper bound excluding current', () => {
    const bandit = new ParameterBandit('retryBudget', [0, 1, 3], 0);
    expect(bandit.candidate()).toBe(1);
    bandit.record(1, 0.9);
    expect(bandit.candidate()).toBe(3);
    bandit.record(3, 0.1);
    // All non-current arms pulled: highest upper bound wins, the current arm with zero
    // pulls stays excluded.
    expect(bandit.candidate()).toBe(1);
  });

  it('returns undefined as candidate for single-value grids', () => {
    const bandit = new ParameterBandit('model', ['claude-x'], 'claude-x');
    expect(bandit.candidate()).toBeUndefined();
  });

  it('updates current through promote and rollbackTo, rejecting undeclared values', () => {
    const bandit = new ParameterBandit('contextShare', [0.4, 0.6, 0.8], 0.4);
    bandit.promote(0.6);
    expect(bandit.current).toBe(0.6);
    bandit.rollbackTo(0.4);
    expect(bandit.current).toBe(0.4);
    const promoteError = grab(() => bandit.promote(0.99));
    expect(promoteError).toBeInstanceOf(NoeticosError);
    expect(promoteError).toMatchObject({ code: 'ERR_INVALID_INPUT' });
    const rollbackError = grab(() => bandit.rollbackTo(0.99));
    expect(rollbackError).toBeInstanceOf(NoeticosError);
    expect(rollbackError).toMatchObject({ code: 'ERR_INVALID_INPUT' });
  });

  it('exposes one ArmStats per declared value in declaration order', () => {
    const bandit = new ParameterBandit('maxTurns', [8, 16, 32], 8);
    bandit.record(16, 0.9);
    const stats = bandit.stats(1);
    expect(stats.map((s) => s.value)).toEqual([8, 16, 32]);
    expect(stats.map((s) => s.pulls)).toEqual([0, 1, 0]);
    expect(stats.map((s) => s.meanReward)).toEqual([0, 0.9, 0]);
    for (const armStats of stats) {
      expect(armStats.lowerBound).toBeLessThanOrEqual(armStats.meanReward);
      expect(armStats.upperBound).toBeGreaterThanOrEqual(armStats.meanReward);
    }
  });

  it('decays idle arms on every record so stale arms reopen for exploration', () => {
    // Discounted UCB in the Garivier-Moulines sense: the discount tick is global
    // per bandit. Without it, an arm last pulled thousands of executions ago kept
    // its frozen effective count forever, its confidence radius never widened, and
    // a flipped optimum was never re-challenged (council stale-arm probe: 6 of 10
    // seeds never rediscovered the optimum within 16000 post-flip executions).
    const pick = (stats: readonly ArmStats[], value: number): ArmStats => {
      const found = stats.find((entry) => entry.value === value);
      if (found === undefined) {
        throw new Error(`missing arm ${value}`);
      }
      return found;
    };
    const bandit = new ParameterBandit('temperature', [0, 0.4, 1], 0.4);
    for (let i = 0; i < 200; i += 1) {
      bandit.record(0, 0.3);
    }
    const frozen = pick(bandit.stats(200), 0);
    // Effective pulls after k same-arm records: the geometric sum (1 - d^k) / (1 - d).
    expect(frozen.pulls).toBeCloseTo((1 - 0.995 ** 200) / 0.005, 6);

    for (let i = 0; i < 400; i += 1) {
      bandit.record(0.4, 0.62);
    }
    const decayed = pick(bandit.stats(600), 0);
    // Each of the 400 sibling records applied one decay tick to the idle arm.
    expect(decayed.pulls).toBeCloseTo(frozen.pulls * 0.995 ** 400, 6);
    // The discounted mean is untouched by pure decay, only the certainty shrinks.
    expect(decayed.meanReward).toBeCloseTo(0.3, 9);
  });

  it('widens the confidence radius of an idle arm as sibling records accumulate', () => {
    const radiusOf = (bandit: ParameterBandit, value: number, total: number): number => {
      const stats = bandit.stats(total).find((entry) => entry.value === value);
      if (stats === undefined) {
        throw new Error(`missing arm ${value}`);
      }
      return stats.upperBound - stats.meanReward;
    };
    const bandit = new ParameterBandit('temperature', [0, 0.4, 1], 0.4);
    for (let i = 0; i < 200; i += 1) {
      bandit.record(0, 0.3);
    }
    const before = radiusOf(bandit, 0, 200);
    for (let i = 0; i < 400; i += 1) {
      bandit.record(0.4, 0.62);
    }
    const after = radiusOf(bandit, 0, 600);
    expect(after).toBeGreaterThan(before);
  });

  it('re-explores an expired arm in declaration order instead of ranking its stale mean', () => {
    // Below one effective pull the confidence bound collapses to the stale
    // discounted mean plus the maximal radius, so a formerly bad arm would lose
    // the upper-bound comparison against fresher arms forever (council stale-arm
    // probe: with upper-bound ranking alone only 4 of 10 seeds rediscovered a
    // flipped optimum; with expired-arm re-exploration all 10 recover).
    const bandit = new ParameterBandit('temperature', [0, 0.4, 1], 0.4);
    bandit.record(1, 0.1);
    // Decay arm 1 (mean 0.1) below one effective pull via sibling records.
    for (let i = 0; i < 200; i += 1) {
      bandit.record(0.4, 0.62);
    }
    // Arm 0 is pulled last so it keeps a fresh count and a high mean: with
    // upper-bound ranking alone the bandit would keep picking 0 forever.
    for (let i = 0; i < 3; i += 1) {
      bandit.record(0, 0.9);
    }
    const expired = bandit.stats(204).find((entry) => entry.value === 1);
    expect(expired).toBeDefined();
    expect(expired?.pulls ?? 1).toBeLessThan(1);
    expect(expired?.pulls ?? 0).toBeGreaterThan(0);
    expect(bandit.candidate()).toBe(1);
  });

  it('preserves everything across a toJSON/fromJSON roundtrip', () => {
    const bandit = new ParameterBandit('temperature', [0, 0.4, 0.7], 0.4);
    bandit.record(0, 0.2);
    bandit.record(0.7, 0.9);
    bandit.promote(0.7);
    const restored = ParameterBandit.fromJSON(structuredClone(bandit.toJSON()));
    expect(restored.parameter).toBe('temperature');
    expect(restored.current).toBe(0.7);
    expect(restored.best()).toBe(bandit.best());
    expect(restored.candidate()).toBe(bandit.candidate());
    expect(restored.stats(2)).toEqual(bandit.stats(2));
  });
});
