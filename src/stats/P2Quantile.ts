/**
 * Online quantile estimation with the P-squared algorithm.
 *
 * Reference:
 * - Jain, R., Chlamtac, I. (1985). The P2 algorithm for dynamic calculation of
 *   quantiles and histograms without storing observations. Communications of the ACM,
 *   28(10), 1076-1085.
 */

import { NoeticosError } from '../errors';

/** Serialized form of a {@link P2Quantile}, produced by {@link P2Quantile.toJSON}. */
export interface P2QuantileJSON {
  /** The quantile being estimated, in (0, 1). */
  readonly quantile: number;
  /** Number of samples observed so far. */
  readonly count: number;
  /** Raw samples held before marker initialization. Empty once `count >= 5`. */
  readonly buffer: readonly number[];
  /** The five marker heights. Empty until `count >= 5`, then exactly 5 entries. */
  readonly heights: readonly number[];
  /** The five 1-based marker positions. Empty until `count >= 5`, then exactly 5 entries. */
  readonly positions: readonly number[];
}

/**
 * Reads an array element that the algorithm invariants guarantee to exist. The throw is
 * unreachable in correct operation and exists to satisfy checked index access without
 * masking a corrupted state behind NaN.
 */
function at(values: readonly number[], index: number): number {
  const value = values[index];
  if (value === undefined) {
    throw new NoeticosError(
      `P2Quantile internal marker index ${index} out of range`,
      'ERR_INTERNAL',
    );
  }
  return value;
}

/**
 * Streaming estimator for a single quantile without storing observations.
 *
 * The P-squared algorithm of Jain and Chlamtac (1985) maintains five markers: the
 * minimum, the running estimates of the p/2, p, and (1 + p)/2 quantiles, and the
 * maximum. Each new observation shifts the marker positions, and any marker that
 * drifts one full position away from its desired location is moved with the
 * piecewise-parabolic (hence P-squared) interpolation formula, falling back to linear
 * interpolation whenever the parabolic prediction would break the monotonicity of the
 * marker heights. Memory is O(1) and each observation costs O(1).
 *
 * The first four samples are kept in a sorted buffer and {@link P2Quantile.estimate}
 * answers exactly from it; from the fifth sample on, the buffer is converted into the
 * initial markers and the streaming approximation takes over.
 */
export class P2Quantile {
  private readonly targetQuantile: number;
  /** Desired position increments per observation, [0, p/2, p, (1 + p)/2, 1]. */
  private readonly markerIncrements: readonly number[];
  private sampleCount = 0;
  private buffer: number[] = [];
  private heights: number[] = [];
  private positions: number[] = [];

  /**
   * @param quantile The quantile to estimate, strictly between 0 and 1. The extremes
   *   are rejected because they degenerate the marker layout; track them with a plain
   *   running minimum or maximum instead.
   * @throws NoeticosError with code `ERR_INVALID_INPUT` when `quantile` is out of range.
   */
  constructor(quantile: number) {
    if (!Number.isFinite(quantile) || quantile <= 0 || quantile >= 1) {
      throw NoeticosError.invalid(
        `P2Quantile requires a quantile strictly between 0 and 1, got ${quantile}`,
      );
    }
    this.targetQuantile = quantile;
    this.markerIncrements = [0, quantile / 2, quantile, (1 + quantile) / 2, 1];
  }

  /**
   * Feeds one sample into the estimator.
   *
   * @param value Finite sample value.
   * @throws NoeticosError with code `ERR_INVALID_INPUT` when `value` is not finite.
   */
  observe(value: number): void {
    if (!Number.isFinite(value)) {
      throw NoeticosError.invalid(`P2Quantile.observe requires a finite number, got ${value}`);
    }
    if (this.sampleCount < 5) {
      this.buffer.push(value);
      this.sampleCount += 1;
      if (this.sampleCount === 5) {
        this.buffer.sort((a, b) => a - b);
        this.heights = [...this.buffer];
        this.positions = [1, 2, 3, 4, 5];
        this.buffer = [];
      }
      return;
    }
    this.sampleCount += 1;

    // Step 1 of Jain and Chlamtac: locate the cell and stretch the extreme markers.
    let cell: number;
    if (value < at(this.heights, 0)) {
      this.heights[0] = value;
      cell = 0;
    } else if (value >= at(this.heights, 4)) {
      this.heights[4] = Math.max(at(this.heights, 4), value);
      cell = 3;
    } else {
      cell = 0;
      while (cell < 3 && value >= at(this.heights, cell + 1)) {
        cell += 1;
      }
    }

    // Step 2: shift the actual positions of every marker above the cell. The last
    // marker is always shifted, keeping positions[4] === sampleCount.
    for (let i = cell + 1; i < 5; i += 1) {
      this.positions[i] = at(this.positions, i) + 1;
    }

    // Step 3: move each interior marker at most one position toward its desired
    // location, desired_i = 1 + (count - 1) * increment_i. Computing the desired
    // position from the count instead of accumulating increments avoids floating
    // point drift over long streams.
    for (let i = 1; i <= 3; i += 1) {
      const desired = 1 + (this.sampleCount - 1) * at(this.markerIncrements, i);
      const position = at(this.positions, i);
      const previous = at(this.positions, i - 1);
      const next = at(this.positions, i + 1);
      const offset = desired - position;
      if ((offset >= 1 && next - position > 1) || (offset <= -1 && previous - position < -1)) {
        const direction = offset >= 1 ? 1 : -1;
        const parabolic = this.parabolicHeight(i, direction);
        if (at(this.heights, i - 1) < parabolic && parabolic < at(this.heights, i + 1)) {
          this.heights[i] = parabolic;
        } else {
          this.heights[i] = this.linearHeight(i, direction);
        }
        this.positions[i] = position + direction;
      }
    }
  }

  /**
   * Current estimate of the target quantile.
   *
   * - 0 samples: returns NaN, there is nothing to estimate yet.
   * - 1 to 4 samples: exact value from the sorted buffer, using linear interpolation
   *   between order statistics at rank (n - 1) * quantile (the common type 7 definition
   *   of Hyndman and Fan 1996).
   * - 5 or more samples: the height of the middle marker, the P-squared approximation.
   */
  estimate(): number {
    if (this.sampleCount === 0) {
      return Number.NaN;
    }
    if (this.sampleCount < 5) {
      const sorted = [...this.buffer].sort((a, b) => a - b);
      const rank = (sorted.length - 1) * this.targetQuantile;
      const lowerIndex = Math.floor(rank);
      const upperIndex = Math.ceil(rank);
      const lowerValue = at(sorted, lowerIndex);
      const upperValue = at(sorted, upperIndex);
      return lowerValue + (rank - lowerIndex) * (upperValue - lowerValue);
    }
    return at(this.heights, 2);
  }

  /** Serializes the full estimator state for persistence. */
  toJSON(): P2QuantileJSON {
    return {
      quantile: this.targetQuantile,
      count: this.sampleCount,
      buffer: [...this.buffer],
      heights: [...this.heights],
      positions: [...this.positions],
    };
  }

  /**
   * Restores an estimator from a {@link P2QuantileJSON} snapshot.
   *
   * Round-trips exactly: the buffer, heights, and positions are the complete state.
   * The snapshot is validated against the algorithm invariants, marker arrays of
   * length 5 with non-decreasing heights and strictly increasing integer positions
   * spanning 1 to count, so a corrupted snapshot fails loudly instead of producing
   * silently wrong estimates.
   *
   * @throws NoeticosError with code `ERR_INVALID_INPUT` when the snapshot is malformed.
   */
  static fromJSON(json: P2QuantileJSON): P2Quantile {
    const instance = new P2Quantile(json.quantile);
    if (!Number.isInteger(json.count) || json.count < 0) {
      throw NoeticosError.invalid(
        `P2Quantile.fromJSON requires a non-negative integer count, got ${json.count}`,
      );
    }
    if (json.buffer.some((value) => !Number.isFinite(value))) {
      throw NoeticosError.invalid('P2Quantile.fromJSON buffer must contain only finite numbers');
    }
    if (json.count < 5) {
      if (json.buffer.length !== json.count) {
        throw NoeticosError.invalid(
          `P2Quantile.fromJSON buffer length ${json.buffer.length} does not match count ${json.count}`,
        );
      }
      instance.sampleCount = json.count;
      instance.buffer = [...json.buffer];
      return instance;
    }
    if (json.heights.length !== 5 || json.positions.length !== 5) {
      throw NoeticosError.invalid(
        'P2Quantile.fromJSON requires exactly 5 marker heights and 5 marker positions',
      );
    }
    for (let i = 0; i < 5; i += 1) {
      const height = at(json.heights, i);
      const position = at(json.positions, i);
      if (!Number.isFinite(height)) {
        throw NoeticosError.invalid('P2Quantile.fromJSON heights must be finite numbers');
      }
      if (!Number.isInteger(position)) {
        throw NoeticosError.invalid('P2Quantile.fromJSON positions must be integers');
      }
      if (i > 0 && height < at(json.heights, i - 1)) {
        throw NoeticosError.invalid('P2Quantile.fromJSON heights must be non-decreasing');
      }
      if (i > 0 && position <= at(json.positions, i - 1)) {
        throw NoeticosError.invalid('P2Quantile.fromJSON positions must be strictly increasing');
      }
    }
    if (at(json.positions, 0) !== 1 || at(json.positions, 4) !== json.count) {
      throw NoeticosError.invalid(
        'P2Quantile.fromJSON positions must start at 1 and end at the sample count',
      );
    }
    instance.sampleCount = json.count;
    instance.heights = [...json.heights];
    instance.positions = [...json.positions];
    return instance;
  }

  /**
   * Piecewise-parabolic prediction for marker `i` moved by `direction` (+1 or -1),
   * equation (1) of Jain and Chlamtac 1985. All position differences are at least 1
   * because positions are strictly increasing integers, so no division is by zero.
   */
  private parabolicHeight(i: number, direction: number): number {
    const heightPrev = at(this.heights, i - 1);
    const heightCur = at(this.heights, i);
    const heightNext = at(this.heights, i + 1);
    const posPrev = at(this.positions, i - 1);
    const posCur = at(this.positions, i);
    const posNext = at(this.positions, i + 1);
    return (
      heightCur +
      (direction / (posNext - posPrev)) *
        (((posCur - posPrev + direction) * (heightNext - heightCur)) / (posNext - posCur) +
          ((posNext - posCur - direction) * (heightCur - heightPrev)) / (posCur - posPrev))
    );
  }

  /**
   * Linear fallback used when the parabolic prediction would leave the open interval
   * between the neighbor heights, preserving monotonicity of the markers.
   */
  private linearHeight(i: number, direction: number): number {
    const heightCur = at(this.heights, i);
    const heightTarget = at(this.heights, i + direction);
    const posCur = at(this.positions, i);
    const posTarget = at(this.positions, i + direction);
    return heightCur + (direction * (heightTarget - heightCur)) / (posTarget - posCur);
  }
}
