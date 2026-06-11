/**
 * Reward shaping: collapses one execution outcome into a scalar reward in [0, 1]
 * under the active objective weights, together with the quality term used for
 * quality floor checks.
 */

import { NoeticosError } from '../errors.js';
import type { ExecutionOutcome, ObjectivePreset, ObjectiveWeights } from '../types.js';

/** Inputs required to score one execution outcome. */
export interface RewardContext {
  outcome: ExecutionOutcome;
  weights: ObjectiveWeights;
  /** 5th percentile of the running per-class cost distribution. */
  costP5: number;
  /** 95th percentile of the running per-class cost distribution. */
  costP95: number;
  /** 5th percentile of the running per-class latency distribution. */
  latencyP5: number;
  /** 95th percentile of the running per-class latency distribution. */
  latencyP95: number;
  /**
   * 5th percentile of the running per-class total-token distribution (input plus
   * output tokens). Used as the cost band only when `costUsd` is absent but token
   * counts are present, so token-only reporters (for example the Vercel middleware)
   * produce a real cost signal instead of the neutral 0.5 forever. Dollars and
   * tokens are never mixed in one band. Defaults to 0, a degenerate band that
   * yields the neutral score.
   */
  tokenP5?: number;
  /** 95th percentile of the running per-class total-token distribution. */
  tokenP95?: number;
  /** Detected tool-call loop repeats for this execution, penalizes implicit quality. */
  loopRepeats?: number;
}

/** Fixed objective weight presets, each summing to 1. */
export const OBJECTIVE_PRESETS: Record<ObjectivePreset, ObjectiveWeights> = {
  balanced: { quality: 0.5, cost: 0.25, latency: 0.25 },
  cost: { quality: 0.35, cost: 0.5, latency: 0.15 },
  latency: { quality: 0.35, cost: 0.15, latency: 0.5 },
  quality: { quality: 0.7, cost: 0.15, latency: 0.15 },
};

const TRUNCATION_PENALTY = 0.35;
const CONTENT_FILTER_PENALTY = 0.5;
const TOOL_FAILURE_PENALTY = 0.15;
const LOOP_PENALTY_PER_REPEAT = 0.1;
const LOOP_PENALTY_CAP = 0.4;

function clamp01(value: number): number {
  if (value < 0) {
    return 0;
  }
  if (value > 1) {
    return 1;
  }
  return value;
}

function implicitQuality(outcome: ExecutionOutcome, loopRepeats: number): number {
  if (outcome.error === true || outcome.finishReason === 'error') {
    return 0;
  }
  let quality = 1;
  if (outcome.finishReason === 'length') {
    quality -= TRUNCATION_PENALTY;
  }
  if (outcome.finishReason === 'content-filter') {
    quality -= CONTENT_FILTER_PENALTY;
  }
  if (outcome.toolCalls?.some((call) => !call.ok) === true) {
    quality -= TOOL_FAILURE_PENALTY;
  }
  if (loopRepeats > 0) {
    quality -= Math.min(LOOP_PENALTY_CAP, LOOP_PENALTY_PER_REPEAT * loopRepeats);
  }
  return clamp01(quality);
}

/**
 * Normalizes a value against its P5..P95 band. Returns 0.5 when the value is
 * missing or the band is degenerate, a neutral score that neither rewards nor
 * punishes the arm for an unobservable signal.
 */
function normalizeAgainstBand(value: number | undefined, p5: number, p95: number): number {
  if (value === undefined || !Number.isFinite(value) || !(p95 > p5)) {
    return 0.5;
  }
  return clamp01((value - p5) / (p95 - p5));
}

/**
 * Total tokens of one outcome (input plus output), or undefined when neither side
 * was reported. A single present side counts alone, so partial reporters still
 * contribute a usable cost proxy.
 */
export function totalTokensOf(outcome: ExecutionOutcome): number | undefined {
  const input =
    outcome.inputTokens !== undefined && Number.isFinite(outcome.inputTokens)
      ? outcome.inputTokens
      : undefined;
  const output =
    outcome.outputTokens !== undefined && Number.isFinite(outcome.outputTokens)
      ? outcome.outputTokens
      : undefined;
  if (input === undefined && output === undefined) {
    return undefined;
  }
  return (input ?? 0) + (output ?? 0);
}

/**
 * Scores one execution. The explicit `qualityScore` always wins; otherwise the
 * quality term is derived from error state, finish reason, tool failures, and
 * detected loops. Both returned numbers are in [0, 1].
 *
 * The cost term prefers `costUsd` normalized against the dollar band; when the
 * outcome carries no cost but does carry token counts, the total tokens are
 * normalized against the token band instead (tokens are the documented cost proxy).
 * The two bands are never mixed: a dollar value never meets a token percentile and
 * vice versa.
 */
export function computeReward(ctx: RewardContext): { reward: number; quality: number } {
  const quality =
    ctx.outcome.qualityScore !== undefined
      ? clamp01(ctx.outcome.qualityScore)
      : implicitQuality(ctx.outcome, ctx.loopRepeats ?? 0);
  const costUsd = ctx.outcome.costUsd;
  const costNorm =
    costUsd !== undefined && Number.isFinite(costUsd)
      ? normalizeAgainstBand(costUsd, ctx.costP5, ctx.costP95)
      : normalizeAgainstBand(totalTokensOf(ctx.outcome), ctx.tokenP5 ?? 0, ctx.tokenP95 ?? 0);
  const latencyNorm = normalizeAgainstBand(ctx.outcome.latencyMs, ctx.latencyP5, ctx.latencyP95);
  const reward =
    ctx.weights.quality * quality +
    ctx.weights.cost * (1 - costNorm) +
    ctx.weights.latency * (1 - latencyNorm);
  return { reward: clamp01(reward), quality };
}

/**
 * Resolves an objective preset name or custom weights into concrete weights.
 * Custom weights are normalized to sum to 1. Defaults to `'balanced'`.
 *
 * @throws NoeticosError with code `ERR_INVALID_INPUT` when any individual weight is
 *   negative or non-finite, or when the weights sum to zero. A negative weight would
 *   invert its term (rewarding worse quality, higher cost, or higher latency), which
 *   is never a sane objective.
 */
export function resolveWeights(objective?: ObjectivePreset | ObjectiveWeights): ObjectiveWeights {
  if (objective === undefined) {
    return OBJECTIVE_PRESETS.balanced;
  }
  if (typeof objective === 'string') {
    return OBJECTIVE_PRESETS[objective];
  }
  const terms = [
    ['quality', objective.quality],
    ['cost', objective.cost],
    ['latency', objective.latency],
  ] as const;
  for (const [name, value] of terms) {
    if (!Number.isFinite(value) || value < 0) {
      throw NoeticosError.invalid(
        `objective weight '${name}' must be a finite non-negative number, got ${value}`,
      );
    }
  }
  const sum = objective.quality + objective.cost + objective.latency;
  if (sum <= 0) {
    throw NoeticosError.invalid(`objective weights must sum to a positive number, got ${sum}`);
  }
  return {
    quality: objective.quality / sum,
    cost: objective.cost / sum,
    latency: objective.latency / sum,
  };
}
