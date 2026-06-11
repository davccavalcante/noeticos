/**
 * Unit tests for src/rollout/SafeRollout: sample gating, quality floor, early
 * rollback, promotion, futility, reset, and serialization.
 */

import { describe, expect, it } from 'vitest';
import { SafeRollout } from '../../src/rollout/SafeRollout.js';

/** Alternating rewards around a mean, deterministic and with non-zero variance. */
const jittered = (mean: number, index: number): number =>
  index % 2 === 0 ? mean - 0.01 : mean + 0.01;

describe('SafeRollout', () => {
  it('continues while canary trials stay below minSamples', () => {
    const rollout = new SafeRollout({ minSamples: 5, promotionConfidence: 0.95 });
    expect(rollout.evaluate().action).toBe('continue');
    for (let i = 0; i < 4; i += 1) {
      rollout.recordBaseline(0.6, 1);
      rollout.recordCanary(0.6, 1);
    }
    const decision = rollout.evaluate();
    expect(decision.action).toBe('continue');
    expect(decision.reasoning).toBe('collecting canary evidence');
    expect(decision.evidence.canaryTrials).toBe(4);
    expect(decision.evidence.minSamples).toBe(5);
  });

  it('rolls back immediately when the Wilson upper bound falls below the quality floor', () => {
    const rollout = new SafeRollout({
      minSamples: 5,
      promotionConfidence: 0.95,
      qualityFloor: { minSuccessRate: 0.8 },
    });
    for (let i = 0; i < 10; i += 1) {
      rollout.recordBaseline(0.9, 1);
      rollout.recordCanary(0.1, 0);
    }
    const decision = rollout.evaluate();
    expect(decision.action).toBe('rollback');
    expect(decision.reasoning).toBe(
      'canary success rate upper confidence bound is below the required quality floor',
    );
    expect(decision.evidence.canarySuccessRate).toBe(0);
    expect(decision.evidence.requiredFloor).toBe(0.8);
    expect(decision.evidence.trials).toBe(10);
    expect(decision.evidence.wilsonUpperBound).toBeGreaterThan(0);
    expect(decision.evidence.wilsonUpperBound).toBeLessThan(0.8);
  });

  it('rolls back early when the canary is significantly worse on success rate', () => {
    const rollout = new SafeRollout({ minSamples: 8, promotionConfidence: 0.95 });
    for (let i = 0; i < 20; i += 1) {
      // Baseline: 19 successes, 1 failure.
      rollout.recordBaseline(i === 0 ? 0.1 : 0.8, i === 0 ? 0 : 1);
    }
    for (let i = 0; i < 8; i += 1) {
      // Canary: 1 success, 7 failures.
      rollout.recordCanary(i === 0 ? 0.7 : 0.1, i === 0 ? 1 : 0);
    }
    const decision = rollout.evaluate();
    expect(decision.action).toBe('rollback');
    expect(decision.reasoning).toBe('canary significantly worse on success rate');
    expect(decision.evidence.canaryFailures).toBe(7);
    expect(decision.evidence.canaryTrials).toBe(8);
    // Laplace-smoothed baseline failure rate: (1 + 1) / (20 + 2).
    expect(decision.evidence.baselineFailureRate).toBeCloseTo(1 / 11, 12);
    expect(decision.evidence.p).toBeLessThan(0.001);
  });

  it('promotes when canary rewards clearly beat the baseline', () => {
    const rollout = new SafeRollout({ minSamples: 8, promotionConfidence: 0.95 });
    for (let i = 0; i < 12; i += 1) {
      rollout.recordBaseline(jittered(0.5, i), 1);
      rollout.recordCanary(jittered(0.8, i), 1);
    }
    const decision = rollout.evaluate();
    expect(decision.action).toBe('promote');
    expect(decision.reasoning).toBe(
      'canary mean reward significantly exceeds the baseline mean reward',
    );
    expect(decision.evidence.meanCanary).toBeCloseTo(0.8, 9);
    expect(decision.evidence.meanBaseline).toBeCloseTo(0.5, 9);
    const meanCanary = decision.evidence.meanCanary ?? Number.NaN;
    const meanBaseline = decision.evidence.meanBaseline ?? Number.NaN;
    expect(meanCanary).toBeGreaterThan(meanBaseline);
    expect(decision.evidence.p).toBeLessThan(1 - 0.95);
    expect(decision.evidence.t).toBeGreaterThan(0);
  });

  it('refuses the t path for a zero-variance small canary instead of promoting on noise', () => {
    // Council P0 reconstruction: two-point rewards (0.725 at quality 0.95 with
    // probability 0.8, 0.4 at quality 0.3 otherwise), IDENTICAL on both sides, so
    // any promotion is a false positive. An 8/8 all-high canary (P = 0.8^8 = 0.168
    // under the null) reports zero sample variance; before the zero-variance guard
    // its lower confidence bound degenerated to its mean (tCritical * sqrt(0/8) = 0)
    // and the bound-separation gate promoted this exact configuration. The guard
    // must route it to the binomial fallback, which correctly finds 8/8 successes
    // unremarkable against an 80 percent baseline, and the experiment continues.
    const rollout = new SafeRollout({ minSamples: 8, promotionConfidence: 0.95 });
    for (let i = 0; i < 72; i += 1) {
      // Baseline: 58 high, 14 low, the same mixture the canary draws from.
      if (i < 58) {
        rollout.recordBaseline(0.725, 0.95);
      } else {
        rollout.recordBaseline(0.4, 0.3);
      }
    }
    for (let i = 0; i < 8; i += 1) {
      rollout.recordCanary(0.725, 0.95);
    }
    const decision = rollout.evaluate();
    expect(decision.action).toBe('continue');
  });

  it('refuses the t path for a zero-variance small baseline as well', () => {
    // The guard is symmetric: a degenerate baseline side would make its upper
    // confidence bound collapse to its mean, which is just as exploitable.
    const rollout = new SafeRollout({ minSamples: 8, promotionConfidence: 0.95 });
    for (let i = 0; i < 10; i += 1) {
      rollout.recordBaseline(0.5, 1);
      rollout.recordCanary(jittered(0.8, i), 1);
    }
    const decision = rollout.evaluate();
    expect(decision.action).toBe('continue');
  });

  it('promotes a dominant zero-variance canary through the exact binomial fallback', () => {
    // Sensitivity is preserved on the fallback path: a deterministic canary that
    // turns a 60 percent success baseline into 13/13 successes is promotable.
    // alphaPerLook = 0.05 / 32 = 0.0015625 and the smoothed baseline success rate
    // is (12 + 1) / (20 + 2) = 0.5909, so P(X >= 13 | 13, 0.5909) = 0.5909^13
    // = 0.00107 < 0.0015625.
    const rollout = new SafeRollout({ minSamples: 8, promotionConfidence: 0.95 });
    for (let i = 0; i < 20; i += 1) {
      if (i < 12) {
        rollout.recordBaseline(0.6, 1);
      } else {
        rollout.recordBaseline(0.1, 0);
      }
    }
    for (let i = 0; i < 13; i += 1) {
      rollout.recordCanary(0.9, 1);
    }
    const decision = rollout.evaluate();
    expect(decision.action).toBe('promote');
    expect(decision.reasoning).toBe(
      'canary success rate significantly exceeds the baseline success rate',
    );
    expect(decision.evidence.canarySuccesses).toBe(13);
    expect(decision.evidence.baselineSuccessRate).toBeCloseTo(13 / 22, 12);
    expect(decision.evidence.p).toBeCloseTo((13 / 22) ** 13, 12);
    expect(decision.evidence.p).toBeLessThan(0.05 / 32);
  });

  it('never promotes equal distributions and rolls back on futility at the budget', () => {
    const rollout = new SafeRollout({ minSamples: 5, promotionConfidence: 0.95 });
    for (let i = 0; i < 19; i += 1) {
      rollout.recordBaseline(jittered(0.5, i), 1);
      rollout.recordCanary(jittered(0.5, i), 1);
      const decision = rollout.evaluate();
      expect(decision.action).toBe('continue');
    }
    rollout.recordBaseline(jittered(0.5, 19), 1);
    rollout.recordCanary(jittered(0.5, 19), 1);
    const final = rollout.evaluate();
    expect(final.action).toBe('rollback');
    expect(final.reasoning).toBe('no significant improvement within the trial budget');
    expect(final.evidence.canaryTrials).toBe(20);
    expect(final.evidence.trialBudget).toBe(20);
    expect(final.evidence.meanCanary).toBeCloseTo(0.5, 9);
    expect(final.evidence.meanBaseline).toBeCloseTo(0.5, 9);
  });

  it('reset clears both sides while keeping the configured thresholds', () => {
    const rollout = new SafeRollout({
      minSamples: 3,
      promotionConfidence: 0.95,
      qualityFloor: { minSuccessRate: 0.9 },
    });
    for (let i = 0; i < 6; i += 1) {
      rollout.recordBaseline(0.9, 1);
      rollout.recordCanary(0.05, 0);
    }
    expect(rollout.evaluate().action).toBe('rollback');
    rollout.reset();
    const after = rollout.evaluate();
    expect(after.action).toBe('continue');
    expect(after.evidence.canaryTrials).toBe(0);
    const snapshot = rollout.toJSON();
    expect(snapshot.minSamples).toBe(3);
    expect(snapshot.promotionConfidence).toBe(0.95);
    expect(snapshot.qualityFloor).toEqual({ minSuccessRate: 0.9 });
    expect(snapshot.baseline.trials).toBe(0);
    expect(snapshot.canary.trials).toBe(0);
  });

  it('preserves the decision evaluate() would make across a mid-experiment roundtrip', () => {
    const original = new SafeRollout({ minSamples: 8, promotionConfidence: 0.95 });
    for (let i = 0; i < 6; i += 1) {
      original.recordBaseline(jittered(0.5, i), 1);
      original.recordCanary(jittered(0.8, i), 1);
    }
    const restored = SafeRollout.fromJSON(structuredClone(original.toJSON()));
    expect(restored.evaluate()).toEqual(original.evaluate());
    expect(restored.evaluate().action).toBe('continue');

    for (let i = 6; i < 12; i += 1) {
      for (const rollout of [original, restored]) {
        rollout.recordBaseline(jittered(0.5, i), 1);
        rollout.recordCanary(jittered(0.8, i), 1);
      }
    }
    const decision = original.evaluate();
    expect(restored.evaluate()).toEqual(decision);
    expect(decision.action).toBe('promote');
  });

  it('preserves a quality floor verdict across a roundtrip', () => {
    const original = new SafeRollout({
      minSamples: 3,
      promotionConfidence: 0.95,
      qualityFloor: { minSuccessRate: 0.9 },
    });
    for (let i = 0; i < 5; i += 1) {
      original.recordBaseline(0.9, 1);
      original.recordCanary(0.1, 0);
    }
    const restored = SafeRollout.fromJSON(structuredClone(original.toJSON()));
    expect(restored.evaluate()).toEqual(original.evaluate());
    expect(restored.evaluate().action).toBe('rollback');
  });
});
