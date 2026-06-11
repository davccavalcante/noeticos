/**
 * Canary rollout judge for a single parameter experiment.
 *
 * One {@link SafeRollout} instance compares a baseline arm against a candidate arm for
 * exactly one parameter of one agent and task class pair, and produces a
 * {@link RolloutDecision} with human-readable reasoning and the numeric evidence that
 * justified it.
 *
 * The verdict is asymmetric by design: rollback needs less evidence than promotion.
 * A promotion requires the canary mean reward to beat the baseline at the configured
 * confidence level, while a rollback fires on a quality floor violation, on a
 * significantly worse success rate, or on plain futility once the trial budget is
 * spent. Safety first, a missed improvement costs less than a regression served to
 * baseline traffic.
 */

import { binomialUpperTail, tCriticalAbove, tTailAbove, welchT } from '../stats/BinomialTest.js';
import { Welford } from '../stats/Welford.js';
import type { QualityFloor } from '../types.js';

/**
 * Verdict of one {@link SafeRollout.evaluate} call.
 */
export interface RolloutDecision {
  action: 'continue' | 'promote' | 'rollback';
  reasoning: string;
  evidence: Record<string, number>;
}

/**
 * Construction options for {@link SafeRollout}.
 */
export interface SafeRolloutOptions {
  /** Minimum canary trials before any verdict other than continue is considered. */
  readonly minSamples: number;
  /** Confidence level required for promotion, for example 0.95. */
  readonly promotionConfidence: number;
  /** Optional hard guardrail. A violating canary is rolled back regardless of reward. */
  readonly qualityFloor?: QualityFloor;
}

/**
 * Serialized state of one experiment side.
 */
export interface ArmSnapshot {
  readonly successes: number;
  readonly trials: number;
  readonly reward: ReturnType<Welford['toJSON']>;
}

/**
 * Serialized form of a {@link SafeRollout}, produced by `toJSON` and accepted by
 * `fromJSON`. Contains aggregate statistics only.
 */
export interface SafeRolloutSnapshot {
  readonly minSamples: number;
  readonly promotionConfidence: number;
  readonly qualityFloor?: QualityFloor;
  readonly baseline: ArmSnapshot;
  readonly canary: ArmSnapshot;
}

interface ArmState {
  successes: number;
  trials: number;
  reward: Welford;
}

/** z for a 95% Wilson score interval, fixed by the rollout contract. */
const WILSON_Z = 1.96;

/** Futility budget: the canary is abandoned after this multiple of `minSamples`. */
const FUTILITY_BUDGET_FACTOR = 4;

/** An execution counts as a success when its quality score reaches this threshold. */
const SUCCESS_QUALITY_THRESHOLD = 0.5;

/**
 * Below this trial count a zero sample variance is treated as a small-sample
 * artifact of a discrete reward distribution rather than as evidence that rewards
 * are truly deterministic, and the t machinery is refused. Two-point rewards make
 * this concrete: under a benign 80/20 mixture an all-identical canary window of 8
 * samples occurs with probability 0.8^8 = 17 percent, reports sample variance 0,
 * and would collapse its one-sided confidence radius to 0, letting the
 * bound-separation gate promote pure noise (the council measured a 15.2 percent
 * false-promotion rate per experiment from exactly this mechanism). At 30 or more
 * trials an all-identical sample is overwhelming evidence the arm really is
 * deterministic and the t path is allowed again.
 */
const ZERO_VARIANCE_TRUST_TRIALS = 30;

function makeArm(): ArmState {
  return { successes: 0, trials: 0, reward: new Welford() };
}

function record(arm: ArmState, reward: number, quality: number): void {
  arm.trials += 1;
  if (quality >= SUCCESS_QUALITY_THRESHOLD) {
    arm.successes += 1;
  }
  arm.reward.observe(reward);
}

function snapshotArm(arm: ArmState): ArmSnapshot {
  return { successes: arm.successes, trials: arm.trials, reward: arm.reward.toJSON() };
}

function restoreArm(snapshot: ArmSnapshot): ArmState {
  return {
    successes: snapshot.successes,
    trials: snapshot.trials,
    reward: Welford.fromJSON(snapshot.reward),
  };
}

/**
 * Wilson score interval upper bound for a binomial proportion. With no data the bound
 * is 1, an empty cohort can never be condemned by the floor check.
 */
function wilsonUpperBound(successes: number, trials: number, z: number): number {
  if (trials === 0) {
    return 1;
  }
  const rate = successes / trials;
  const z2 = z * z;
  const center = rate + z2 / (2 * trials);
  const margin = z * Math.sqrt((rate * (1 - rate)) / trials + z2 / (4 * trials * trials));
  return Math.min(1, (center + margin) / (1 + z2 / trials));
}

/**
 * Judges one canary experiment, baseline arm versus candidate arm, for a single
 * parameter of one agent and task class.
 *
 * Decision asymmetry, by design: promotion demands a statistically significant reward
 * win at `promotionConfidence`, while rollback triggers on weaker evidence, a quality
 * floor breach, a significantly worse success rate, or exhaustion of the trial budget
 * without improvement. The cheap failure mode is always restoring the baseline.
 */
export class SafeRollout {
  private readonly minSamples: number;
  private readonly promotionConfidence: number;
  private readonly qualityFloor: QualityFloor | undefined;
  private baseline: ArmState;
  private canary: ArmState;

  constructor(options: SafeRolloutOptions) {
    this.minSamples = options.minSamples;
    this.promotionConfidence = options.promotionConfidence;
    this.qualityFloor = options.qualityFloor;
    this.baseline = makeArm();
    this.canary = makeArm();
  }

  /** Records one baseline execution. Quality at or above 0.5 counts as a success. */
  recordBaseline(reward: number, quality: number): void {
    record(this.baseline, reward, quality);
  }

  /** Records one canary execution. Quality at or above 0.5 counts as a success. */
  recordCanary(reward: number, quality: number): void {
    record(this.canary, reward, quality);
  }

  /**
   * Evaluates the experiment and returns the current verdict. Checks run in a fixed
   * order: sample gate, quality floor, early rollback on success rate, reward
   * promotion test, futility budget, then continue.
   */
  evaluate(): RolloutDecision {
    const alpha = 1 - this.promotionConfidence;

    if (this.canary.trials < this.minSamples) {
      return {
        action: 'continue',
        reasoning: 'collecting canary evidence',
        evidence: {
          canaryTrials: this.canary.trials,
          minSamples: this.minSamples,
        },
      };
    }

    const floor = this.qualityFloor?.minSuccessRate;
    if (floor !== undefined) {
      const upper = wilsonUpperBound(this.canary.successes, this.canary.trials, WILSON_Z);
      if (upper < floor) {
        return {
          action: 'rollback',
          reasoning:
            'canary success rate upper confidence bound is below the required quality floor',
          evidence: {
            canarySuccessRate: this.canary.successes / this.canary.trials,
            requiredFloor: floor,
            trials: this.canary.trials,
            wilsonUpperBound: upper,
          },
        };
      }
    }

    const baselineFailures = this.baseline.trials - this.baseline.successes;
    const baselineFailureRate = (baselineFailures + 1) / (this.baseline.trials + 2);
    const canaryFailures = this.canary.trials - this.canary.successes;
    const pWorse = binomialUpperTail(canaryFailures, this.canary.trials, baselineFailureRate);
    if (pWorse < alpha) {
      return {
        action: 'rollback',
        reasoning: 'canary significantly worse on success rate',
        evidence: {
          canaryFailures,
          canaryTrials: this.canary.trials,
          baselineFailureRate,
          p: pWorse,
        },
      };
    }

    const meanCanary = this.canary.reward.mean;
    const meanBaseline = this.baseline.reward.mean;
    if (this.baseline.trials >= 2 && this.canary.trials >= 2 && meanCanary > meanBaseline) {
      // Sequential-evidence correction. The engine evaluates an experiment only when
      // a canary outcome is recorded, so one experiment examines this promotion test
      // at most once per canary trial up to the futility budget, that is at most
      // FUTILITY_BUDGET_FACTOR * minSamples looks. Testing each look at the full
      // alpha would promote pure noise (repeated peeking inflates the false
      // promotion rate far beyond 1 - promotionConfidence), so the alpha is spent
      // across the look budget (Bonferroni), keeping the whole experiment's false
      // promotion probability at or below 1 - promotionConfidence.
      const alphaPerLook = alpha / (FUTILITY_BUDGET_FACTOR * this.minSamples);
      const canaryVariance = this.canary.reward.variance;
      const baselineVariance = this.baseline.reward.variance;
      const zeroVarianceSmallSample =
        (canaryVariance === 0 && this.canary.trials < ZERO_VARIANCE_TRUST_TRIALS) ||
        (baselineVariance === 0 && this.baseline.trials < ZERO_VARIANCE_TRUST_TRIALS);
      if (zeroVarianceSmallSample) {
        // Zero sample variance on a small sample degenerates the t machinery: the
        // Welch statistic explodes and the affected side's confidence radius
        // collapses to exactly its mean, so the bound-separation gate below would
        // pass on noise (see ZERO_VARIANCE_TRUST_TRIALS). The promotion question
        // falls back to the exact binomial upper tail on the success indicator,
        // which captures precisely what a no-variance sample can still prove: that
        // its success rate beats the baseline's. The rewards driving the mean test
        // are clamped to [0, 1] by reward shaping, but no variance floor such as
        // the Bernoulli bound m * (1 - m) is applied to the t path instead, because
        // that worst-case floor would dwarf every realistic reward variance and
        // destroy true-effect sensitivity (benchmark scenario S2).
        const baselineSuccessRate = (this.baseline.successes + 1) / (this.baseline.trials + 2);
        const pBetter = binomialUpperTail(
          this.canary.successes,
          this.canary.trials,
          baselineSuccessRate,
        );
        if (pBetter < alphaPerLook) {
          return {
            action: 'promote',
            reasoning: 'canary success rate significantly exceeds the baseline success rate',
            evidence: {
              meanCanary,
              meanBaseline,
              canarySuccesses: this.canary.successes,
              canaryTrials: this.canary.trials,
              baselineSuccessRate,
              p: pBetter,
            },
          };
        }
      } else {
        const { t, df } = welchT(
          meanCanary,
          canaryVariance,
          this.canary.reward.count,
          meanBaseline,
          baselineVariance,
          this.baseline.reward.count,
        );
        if (Number.isFinite(t) && Number.isFinite(df) && df > 0) {
          const pPromote = tTailAbove(t, df);
          if (pPromote < alphaPerLook) {
            // The promotionConfidence contract: the canary mean's lower confidence
            // bound must exceed the baseline mean's upper confidence bound.
            // One-sided exact t bounds per arm at the spent alpha.
            const canaryLower =
              meanCanary -
              tCriticalAbove(alphaPerLook, this.canary.reward.count - 1) *
                Math.sqrt(canaryVariance / this.canary.reward.count);
            const baselineUpper =
              meanBaseline +
              tCriticalAbove(alphaPerLook, this.baseline.reward.count - 1) *
                Math.sqrt(baselineVariance / this.baseline.reward.count);
            if (canaryLower > baselineUpper) {
              return {
                action: 'promote',
                reasoning: 'canary mean reward significantly exceeds the baseline mean reward',
                evidence: {
                  meanCanary,
                  meanBaseline,
                  canaryLower,
                  baselineUpper,
                  t,
                  df,
                  p: pPromote,
                },
              };
            }
          }
        }
      }
    }

    if (this.canary.trials >= FUTILITY_BUDGET_FACTOR * this.minSamples) {
      return {
        action: 'rollback',
        reasoning: 'no significant improvement within the trial budget',
        evidence: {
          canaryTrials: this.canary.trials,
          trialBudget: FUTILITY_BUDGET_FACTOR * this.minSamples,
          meanCanary,
          meanBaseline,
        },
      };
    }

    return {
      action: 'continue',
      reasoning: 'evidence is not yet conclusive, the canary continues',
      evidence: {
        canaryTrials: this.canary.trials,
        baselineTrials: this.baseline.trials,
        meanCanary,
        meanBaseline,
      },
    };
  }

  /** Clears both arms while keeping the configured thresholds. */
  reset(): void {
    this.baseline = makeArm();
    this.canary = makeArm();
  }

  /** Serializes the experiment, aggregate statistics only. */
  toJSON(): SafeRolloutSnapshot {
    return {
      minSamples: this.minSamples,
      promotionConfidence: this.promotionConfidence,
      ...(this.qualityFloor === undefined ? {} : { qualityFloor: this.qualityFloor }),
      baseline: snapshotArm(this.baseline),
      canary: snapshotArm(this.canary),
    };
  }

  /** Restores an experiment from its serialized form. */
  static fromJSON(json: SafeRolloutSnapshot): SafeRollout {
    const rollout = new SafeRollout({
      minSamples: json.minSamples,
      promotionConfidence: json.promotionConfidence,
      ...(json.qualityFloor === undefined ? {} : { qualityFloor: json.qualityFloor }),
    });
    rollout.baseline = restoreArm(json.baseline);
    rollout.canary = restoreArm(json.canary);
    return rollout;
  }
}
