/**
 * Bandit over one parameter dimension: one {@link UcbArm} per declared
 * candidate value, plus the promoted value currently served to the baseline
 * cohort. All tie-breaks follow declaration order for determinism.
 */

import { NoeticosError } from '../errors.js';
import type { ArmStats, ParameterName, ParameterValue } from '../types.js';
import { UcbArm, type UcbArmJson } from './UcbArm.js';

/** Serialized form of a {@link ParameterBandit}. */
export interface ParameterBanditJson {
  readonly parameter: ParameterName;
  readonly current: ParameterValue;
  readonly arms: readonly UcbArmJson[];
}

export class ParameterBandit {
  readonly parameter: ParameterName;
  private arms: readonly UcbArm[];
  private currentValue: ParameterValue;

  constructor(
    parameter: ParameterName,
    values: readonly ParameterValue[],
    baseline: ParameterValue,
  ) {
    if (values.length === 0) {
      throw NoeticosError.invalid(`parameter '${parameter}' declares no candidate values`);
    }
    if (new Set(values).size !== values.length) {
      throw NoeticosError.invalid(`parameter '${parameter}' declares duplicate candidate values`);
    }
    if (!values.includes(baseline)) {
      throw NoeticosError.invalid(
        `baseline ${String(baseline)} of parameter '${parameter}' is not a declared value`,
      );
    }
    this.parameter = parameter;
    this.arms = values.map((value) => new UcbArm(value));
    this.currentValue = baseline;
  }

  /** Value currently served to the baseline cohort. */
  get current(): ParameterValue {
    return this.currentValue;
  }

  /**
   * Highest discounted mean among arms with at least one effective pull,
   * falling back to the promoted current value when no arm qualifies.
   */
  best(): ParameterValue {
    let bestArm: UcbArm | undefined;
    for (const arm of this.arms) {
      if (arm.pulls >= 1 && (bestArm === undefined || arm.meanReward > bestArm.meanReward)) {
        bestArm = arm;
      }
    }
    return bestArm === undefined ? this.currentValue : bestArm.value;
  }

  /**
   * Exploration pick for the canary cohort: the first arm with less than one
   * effective pull in declaration order (never pulled, or fully decayed: its
   * information has expired), otherwise the arm with the highest upper
   * confidence bound. The expired-arm fast path mirrors the maximal-radius
   * convention in {@link UcbArm.bounds}: below one effective pull the bound is
   * anchored at the stale discounted mean, so ranking expired arms by their
   * upper bounds would starve a formerly-bad arm forever (the council's
   * stale-arm probe measured 6 of 10 seeds never rediscovering a flipped
   * optimum because the expired arm kept losing the mean-anchored comparison).
   * The promoted current value is excluded, a canary equal to the baseline
   * would carry no information. Undefined when only one value exists.
   */
  candidate(): ParameterValue | undefined {
    if (this.arms.length <= 1) {
      return undefined;
    }
    for (const arm of this.arms) {
      if (arm.pulls < 1 && arm.value !== this.currentValue) {
        return arm.value;
      }
    }
    const total = this.totalPulls();
    let pick: UcbArm | undefined;
    let pickUpper = Number.NEGATIVE_INFINITY;
    for (const arm of this.arms) {
      if (arm.value === this.currentValue) {
        continue;
      }
      const { upper } = arm.bounds(total);
      if (upper > pickUpper) {
        pick = arm;
        pickUpper = upper;
      }
    }
    return pick?.value;
  }

  /**
   * Feeds one observed reward to the arm of `value`. Unknown values are ignored
   * entirely (no decay tick either, a report without a declared arm carries no
   * trustworthy time step).
   *
   * Discounted UCB in the Garivier-Moulines sense: the discount tick applies to
   * EVERY arm of this bandit, not only the observed one. Idle arms decay their
   * effective counts, which widens their confidence bounds over time and re-opens
   * their upper bounds for exploration. Without the global tick an arm last pulled
   * thousands of executions ago keeps its frozen statistics forever, so a flipped
   * optimum is never re-challenged. The tick alone is not sufficient: once an
   * arm's count decays below one effective pull its bound collapses to the
   * stale mean plus the maximal radius, so {@link candidate} additionally
   * re-explores expired arms in declaration order.
   */
  record(value: ParameterValue, reward: number): void {
    const target = this.arms.find((candidate) => candidate.value === value);
    if (target === undefined) {
      return;
    }
    for (const arm of this.arms) {
      arm.decay();
    }
    target.observe(reward);
  }

  stats(totalPulls: number): ArmStats[] {
    return this.arms.map((arm) => {
      const { lower, upper } = arm.bounds(totalPulls);
      return {
        value: arm.value,
        pulls: arm.pulls,
        meanReward: arm.meanReward,
        lowerBound: lower,
        upperBound: upper,
      };
    });
  }

  /** Makes `value` the new baseline after a winning canary. */
  promote(value: ParameterValue): void {
    this.assertDeclared(value);
    this.currentValue = value;
  }

  /** Restores `value` as the baseline after a failed canary. */
  rollbackTo(value: ParameterValue): void {
    this.assertDeclared(value);
    this.currentValue = value;
  }

  toJSON(): ParameterBanditJson {
    return {
      parameter: this.parameter,
      current: this.currentValue,
      arms: this.arms.map((arm) => arm.toJSON()),
    };
  }

  static fromJSON(json: ParameterBanditJson): ParameterBandit {
    const bandit = new ParameterBandit(
      json.parameter,
      json.arms.map((arm) => arm.value),
      json.current,
    );
    bandit.arms = json.arms.map((arm) => UcbArm.fromJSON(arm));
    return bandit;
  }

  private totalPulls(): number {
    let total = 0;
    for (const arm of this.arms) {
      total += arm.pulls;
    }
    return total;
  }

  private assertDeclared(value: ParameterValue): void {
    if (!this.arms.some((arm) => arm.value === value)) {
      throw NoeticosError.invalid(
        `value ${String(value)} is not a declared arm of parameter '${this.parameter}'`,
      );
    }
  }
}
