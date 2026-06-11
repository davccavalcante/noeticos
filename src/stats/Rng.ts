/**
 * Deterministic 32-bit pseudo-random number generator with labeled forking.
 *
 * References:
 * - Ettinger, T. (2017). mulberry32, a 32-bit-state generator placed in the public
 *   domain, widely distributed through the JavaScript PRNG collection of bryc
 *   (github.com/bryc/code). Passes the gjrand statistical test battery over its full
 *   2^32 period.
 * - Fowler, G., Noll, L. C., Vo, K.-P. The FNV non-cryptographic hash algorithm,
 *   FNV-1a variant, documented in the IETF draft draft-eastlake-fnv.
 */

import { NoeticosError } from '../errors';

/** Serialized form of an {@link Rng}, produced by {@link Rng.toJSON}. */
export interface RngJSON {
  /** Current internal seed, an unsigned 32-bit integer. */
  readonly state: number;
}

/** FNV-1a 32-bit offset basis. */
const FNV_OFFSET_BASIS = 0x811c9dc5;
/** FNV-1a 32-bit prime. */
const FNV_PRIME = 0x01000193;
/** mulberry32 state increment, the 32-bit golden-ratio-derived Weyl constant. */
const MULBERRY_INCREMENT = 0x6d2b79f5;

/**
 * mulberry32: a deterministic generator whose entire state is one unsigned 32-bit
 * integer, advanced by a Weyl sequence and tempered with two multiply-xorshift rounds.
 *
 * Properties relevant to NoeticOS:
 * - Fully deterministic: the same seed always yields the same sequence, on every
 *   JavaScript runtime, because all arithmetic is exact 32-bit integer math via
 *   `Math.imul` and unsigned shifts.
 * - Period 2^32 with equidistributed output over the period.
 * - The whole state is the seed itself, so persistence is a single integer and
 *   `fromJSON(rng.toJSON())` resumes the stream exactly where it left off.
 *
 * This generator is statistical, not cryptographic. Never use it for secrets.
 */
export class Rng {
  private state: number;

  /**
   * @param seed Any finite number. It is coerced to an unsigned 32-bit integer with
   *   `>>> 0` (ToUint32), so seeds that differ only above 32 bits collide by design.
   * @throws NoeticosError with code `ERR_INVALID_INPUT` when `seed` is not finite.
   */
  constructor(seed: number) {
    if (!Number.isFinite(seed)) {
      throw NoeticosError.invalid(`Rng requires a finite seed, got ${seed}`);
    }
    this.state = seed >>> 0;
  }

  /**
   * Advances the generator one step and returns a number in [0, 1).
   *
   * The result is `mix(state) / 2^32`, an exact multiple of 2^-32, so 0 is a possible
   * output and 1 is not.
   */
  next(): number {
    this.state = (this.state + MULBERRY_INCREMENT) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t = (t + Math.imul(t ^ (t >>> 7), t | 61)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /**
   * Derives an independently seeded child generator from this generator and a label.
   *
   * The child seed is the FNV-1a hash of a well-defined byte stream: the four bytes of
   * the current parent state in little-endian order, followed by each UTF-16 code unit
   * of `label` as two bytes (low byte first). Mixing the parent state into the hash
   * keeps children of different parents apart even when labels collide, and FNV-1a's
   * per-byte avalanche keeps children of the same parent apart for similar labels.
   *
   * Forking is a pure read: it never advances the parent stream, and two forks with
   * the same label from the same parent state are identical generators.
   */
  fork(label: string): Rng {
    let hash = FNV_OFFSET_BASIS;
    for (let shift = 0; shift < 32; shift += 8) {
      hash ^= (this.state >>> shift) & 0xff;
      hash = Math.imul(hash, FNV_PRIME) >>> 0;
    }
    for (let i = 0; i < label.length; i += 1) {
      const code = label.charCodeAt(i);
      hash ^= code & 0xff;
      hash = Math.imul(hash, FNV_PRIME) >>> 0;
      hash ^= code >>> 8;
      hash = Math.imul(hash, FNV_PRIME) >>> 0;
    }
    return new Rng(hash);
  }

  /** Serializes the current internal seed. The single integer is the complete state. */
  toJSON(): RngJSON {
    return { state: this.state };
  }

  /**
   * Restores a generator from an {@link RngJSON} snapshot, resuming the sequence at
   * exactly the next value the serialized generator would have produced.
   *
   * @throws NoeticosError with code `ERR_INVALID_INPUT` when the snapshot is malformed.
   */
  static fromJSON(json: RngJSON): Rng {
    if (!Number.isInteger(json.state) || json.state < 0 || json.state > 0xffffffff) {
      throw NoeticosError.invalid(
        `Rng.fromJSON requires an unsigned 32-bit integer state, got ${json.state}`,
      );
    }
    return new Rng(json.state);
  }
}
