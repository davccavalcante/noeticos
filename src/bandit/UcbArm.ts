/**
 * One arm of a UCB1-tuned bandit with exponential discounting in the
 * Garivier-Moulines sense: the discount tick is shared by every arm of the
 * owning bandit (see ParameterBandit.record), so idle arms decay their
 * effective counts too, their confidence bounds re-open over time, and the
 * statistics keep tracking non-stationary workloads instead of freezing on
 * historical behavior.
 *
 * Reference: Garivier, A., Moulines, E. (2011). On upper-confidence bound
 * policies for switching bandit problems. Algorithmic Learning Theory (ALT).
 */

import type { ParameterValue } from '../types.js';

/** Discount applied to the effective count and moments before each observation. */
const DISCOUNT = 0.995;

/** Serialized form of a {@link UcbArm}. */
export interface UcbArmJson {
  readonly value: ParameterValue;
  readonly pulls: number;
  readonly sum: number;
  readonly sumSq: number;
}

export class UcbArm {
  readonly value: ParameterValue;
  private effectivePulls = 0;
  private sum = 0;
  private sumSq = 0;

  constructor(value: ParameterValue) {
    this.value = value;
  }

  /** Effective observation count after discounting. */
  get pulls(): number {
    return this.effectivePulls;
  }

  /** Discounted mean reward, 0 before the first observation. */
  get meanReward(): number {
    return this.effectivePulls > 0 ? this.sum / this.effectivePulls : 0;
  }

  /**
   * Applies one discount tick without an observation. Idle arms receive this on
   * every observation into a sibling arm, which shrinks their effective counts
   * (the discounted mean is untouched, sum and count scale together) and widens
   * their confidence radii until they are worth re-exploring.
   */
  decay(): void {
    this.effectivePulls *= DISCOUNT;
    this.sum *= DISCOUNT;
    this.sumSq *= DISCOUNT;
  }

  /** Adds one observation after the caller has applied the shared discount tick. */
  observe(reward: number): void {
    this.effectivePulls += 1;
    this.sum += reward;
    this.sumSq += reward * reward;
  }

  /** Discount tick plus observation, the per-arm view of one recorded reward. */
  record(reward: number): void {
    this.decay();
    this.observe(reward);
  }

  /**
   * UCB1-tuned confidence bounds around the discounted mean. An arm with less
   * than one effective pull gets the maximal radius of 1 so it is always worth
   * exploring.
   */
  bounds(totalPulls: number): { lower: number; upper: number } {
    const n = this.effectivePulls;
    const mean = this.meanReward;
    if (n < 1) {
      return { lower: mean - 1, upper: mean + 1 };
    }
    const logTotal = Math.log(Math.max(totalPulls, 2));
    // Discounted variance from the discounted first and second moments.
    const variance = Math.max(0, this.sumSq / n - mean * mean);
    const radius = Math.sqrt(
      (logTotal / n) * Math.min(0.25, variance + Math.sqrt((2 * logTotal) / n)),
    );
    return { lower: mean - radius, upper: mean + radius };
  }

  toJSON(): UcbArmJson {
    return {
      value: this.value,
      pulls: this.effectivePulls,
      sum: this.sum,
      sumSq: this.sumSq,
    };
  }

  static fromJSON(json: UcbArmJson): UcbArm {
    const arm = new UcbArm(json.value);
    arm.effectivePulls = json.pulls;
    arm.sum = json.sum;
    arm.sumSq = json.sumSq;
    return arm;
  }
}
