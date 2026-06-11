/**
 * Numerically stable online mean and variance.
 *
 * References:
 * - Welford, B. P. (1962). Note on a method for calculating corrected sums of squares
 *   and products. Technometrics, 4(3), 419-420.
 * - Knuth, D. E. (1998). The Art of Computer Programming, Volume 2: Seminumerical
 *   Algorithms, 3rd edition, Section 4.2.2.
 * - Chan, T. F., Golub, G. H., LeVeque, R. J. (1983). Algorithms for computing the
 *   sample variance: analysis and recommendations. The American Statistician, 37(3),
 *   242-247.
 */

import { NoeticosError } from '../errors';

/** Serialized form of a {@link Welford} accumulator, produced by {@link Welford.toJSON}. */
export interface WelfordJSON {
  /** Number of samples observed so far. */
  readonly count: number;
  /** Running mean of the observed samples, 0 when no samples were observed. */
  readonly mean: number;
  /** Running sum of squared deviations from the mean, the M2 aggregate of Welford 1962. */
  readonly m2: number;
}

/**
 * One-pass accumulator for count, mean, variance, and standard deviation.
 *
 * Welford's recurrence updates the mean and the sum of squared deviations (M2) per
 * observation without storing samples:
 *
 *   mean_n = mean_(n-1) + (x_n - mean_(n-1)) / n
 *   M2_n   = M2_(n-1) + (x_n - mean_(n-1)) * (x_n - mean_n)
 *
 * Unlike the textbook sum-of-squares formula, the recurrence never subtracts two large
 * nearly equal quantities, so it stays accurate when the variance is small relative to
 * the magnitude of the values (Chan, Golub, LeVeque 1983 classify it among the stable
 * updating algorithms). Memory is O(1) and every operation is O(1).
 */
export class Welford {
  private sampleCount = 0;
  private runningMean = 0;
  private sumSquaredDeviations = 0;

  /**
   * Feeds one sample into the accumulator.
   *
   * @param value Finite sample value.
   * @throws NoeticosError with code `ERR_INVALID_INPUT` when `value` is not finite.
   */
  observe(value: number): void {
    if (!Number.isFinite(value)) {
      throw NoeticosError.invalid(`Welford.observe requires a finite number, got ${value}`);
    }
    this.sampleCount += 1;
    const delta = value - this.runningMean;
    this.runningMean += delta / this.sampleCount;
    const deltaAfter = value - this.runningMean;
    this.sumSquaredDeviations += delta * deltaAfter;
  }

  /** Number of samples observed so far. */
  get count(): number {
    return this.sampleCount;
  }

  /** Mean of the observed samples, 0 when no samples were observed. */
  get mean(): number {
    return this.runningMean;
  }

  /**
   * Unbiased sample variance, M2 / (count - 1), applying Bessel's correction.
   *
   * Returns 0 when fewer than 2 samples were observed, since the sample variance is
   * undefined there and 0 is the safe value for downstream confidence-bound math.
   * The result is clamped at 0 to absorb any residual negative rounding noise.
   */
  get variance(): number {
    if (this.sampleCount < 2) {
      return 0;
    }
    return Math.max(0, this.sumSquaredDeviations / (this.sampleCount - 1));
  }

  /** Sample standard deviation, the square root of {@link Welford.variance}. */
  get stdDev(): number {
    return Math.sqrt(this.variance);
  }

  /** Serializes the full accumulator state for persistence. */
  toJSON(): WelfordJSON {
    return {
      count: this.sampleCount,
      mean: this.runningMean,
      m2: this.sumSquaredDeviations,
    };
  }

  /**
   * Restores an accumulator from a {@link WelfordJSON} snapshot.
   *
   * Round-trips exactly: `Welford.fromJSON(w.toJSON())` reproduces the internal state of
   * `w` bit for bit, because count, mean, and M2 are the complete state.
   *
   * @throws NoeticosError with code `ERR_INVALID_INPUT` when the snapshot is malformed.
   */
  static fromJSON(json: WelfordJSON): Welford {
    if (!Number.isInteger(json.count) || json.count < 0) {
      throw NoeticosError.invalid(
        `Welford.fromJSON requires a non-negative integer count, got ${json.count}`,
      );
    }
    if (!Number.isFinite(json.mean)) {
      throw NoeticosError.invalid(`Welford.fromJSON requires a finite mean, got ${json.mean}`);
    }
    if (!Number.isFinite(json.m2) || json.m2 < 0) {
      throw NoeticosError.invalid(
        `Welford.fromJSON requires a non-negative finite m2, got ${json.m2}`,
      );
    }
    const instance = new Welford();
    instance.sampleCount = json.count;
    instance.runningMean = json.mean;
    instance.sumSquaredDeviations = json.m2;
    return instance;
  }
}
