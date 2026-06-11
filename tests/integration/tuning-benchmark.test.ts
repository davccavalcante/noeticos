/**
 * The permanent tuning-quality benchmark.
 *
 * Nine labeled synthetic scenarios with hard bounds that pin the engine's decision
 * quality in CI forever: a regression in tuning behavior (spurious promotions,
 * missed convergence, harmful candidates reaching baseline traffic, broken cohort
 * accounting) must fail this file. Every scenario is fully deterministic: the engine
 * runs on a fixed seed with a pinned clock, and all workload randomness flows from a
 * local mulberry32 stream through Box-Muller gaussian noise (sigma 0.04) over
 * declared ground-truth functions. Every bound was calibrated by running the
 * scenario on its pinned seed; the calibration figures are quoted next to each
 * assertion so future regressions can be compared against the original values.
 *
 * Engine fix pinned by S1: SafeRollout originally re-ran its Welch promotion test
 * after every report at the full alpha. With up to minSamples * 4 peeks per
 * experiment that promoted pure noise on a flat reward landscape (1 to 8 spurious
 * promotions per 3000 executions on every seed probed). The promotion gate now
 * spends alpha across the look budget and requires the documented confidence-bound
 * separation, which this benchmark verifies stays fixed.
 *
 * Engine fix pinned by S9: two-point reward distributions produce all-identical
 * canary windows whose zero sample variance collapsed the per-side t bound onto
 * the mean, letting the separation gate promote pure noise at 15.2 percent per
 * experiment. SafeRollout now refuses the t path for zero-variance small samples
 * and falls back to the exact binomial test on the success indicator; the
 * promotion evaluation additionally runs only when a canary outcome arrives, so
 * actual looks match the Bonferroni look budget instead of exceeding it tenfold.
 */

import { describe, expect, it, vi } from 'vitest';
import type {
  DecisionEntry,
  DecisionType,
  NoeticOS,
  NoeticOSOptions,
  ParameterName,
  ParameterValue,
  Recommendation,
  TaskKind,
  ToolCallOutcome,
} from '../../src/index.js';
import { createNoeticOS, DEFAULT_PARAMETER_SPACE } from '../../src/index.js';

vi.setConfig({ testTimeout: 60000 });

/** Standard deviation of the gaussian noise added to every explicit quality score. */
const NOISE_SIGMA = 0.04;

/** The default temperature grid, index distance doubles as "steps away" below. */
const TEMP_GRID = DEFAULT_PARAMETER_SPACE.temperature;

/** mulberry32 (Ettinger, public domain): deterministic 32-bit PRNG over [0, 1). */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t = (t + Math.imul(t ^ (t >>> 7), t | 61)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Standard normal draw via Box-Muller, consuming exactly two uniform draws. */
function gaussian(uniform: () => number): number {
  const u = 1 - uniform();
  const v = uniform();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function clamp01(value: number): number {
  if (value < 0) {
    return 0;
  }
  if (value > 1) {
    return 1;
  }
  return value;
}

type SimParameters = Readonly<Partial<Record<ParameterName, ParameterValue>>>;

function numberParameter(parameters: SimParameters, name: ParameterName, fallback: number): number {
  const value = parameters[name];
  return typeof value === 'number' ? value : fallback;
}

/** Grid index of the served temperature, the "steps away from 0" of S2 and S3. */
function temperatureSteps(parameters: SimParameters): number {
  const temperature = numberParameter(parameters, 'temperature', 0.4);
  const index = TEMP_GRID.indexOf(temperature);
  return index < 0 ? 2 : index;
}

/** Noiseless synthetic result of one execution under the served parameters. */
interface SyntheticOutcome {
  /** Ground-truth quality in [0, 1] before noise. */
  readonly quality: number;
  readonly costUsd: number;
  readonly latencyMs: number;
  readonly toolCalls?: readonly ToolCallOutcome[];
  /**
   * When true the report omits qualityScore so the engine derives quality
   * implicitly, the only path where the tool-call loop penalty applies (S5).
   */
  readonly implicit?: boolean;
  /**
   * When true the quality is reported exactly as declared, without the gaussian
   * noise. S9 uses this so its two-point reward mixture stays exactly two-point
   * and all-identical canary windows occur at their natural binomial rate.
   */
  readonly exact?: boolean;
}

type GroundTruth = (kind: TaskKind, parameters: SimParameters) => SyntheticOutcome;

interface ScenarioOptions {
  /** Seed shared by the engine PRNG and the outcome synthesizer stream. */
  readonly seed: number;
  /** Declared ground-truth function per task kind and served parameters. */
  readonly truth: GroundTruth;
  /** Engine option overrides merged over the benchmark defaults. */
  readonly engine?: NoeticOSOptions;
}

interface StepResult {
  readonly recommendation: Recommendation;
  /** Quality score actually reported, undefined on the implicit path. */
  readonly reportedQuality: number | undefined;
}

interface Scenario {
  readonly engine: NoeticOS;
  readonly agentId: string;
  /** Every decision entry recorded, in append order. */
  readonly decisions: readonly DecisionEntry[];
  /** Every loop.detected telemetry event observed. */
  readonly loops: readonly { repeats: number; toolName: string }[];
  /**
   * One full execution: recommend, synthesize the outcome from the ground truth
   * plus one seeded noise draw, report. `beforeReport` runs between the recommend
   * and the report so invariants can be checked against the pre-report state.
   */
  step(kind: TaskKind, beforeReport?: (recommendation: Recommendation) => void): StepResult;
}

/**
 * Builds one benchmark scenario: an engine with the benchmark defaults (pinned
 * clock, minSamplesPerArm 6) and a deterministic synthesizer over `truth`.
 */
function scenario(name: string, options: ScenarioOptions): Scenario {
  const engine = createNoeticOS({
    seed: options.seed,
    clock: () => 0,
    minSamplesPerArm: 6,
    ...options.engine,
  });
  const uniform = mulberry32(options.seed);
  const decisions: DecisionEntry[] = [];
  const loops: { repeats: number; toolName: string }[] = [];
  engine.on((event) => {
    if (event.type === 'decision.recorded') {
      decisions.push(event.entry);
    } else if (event.type === 'loop.detected') {
      loops.push({ repeats: event.repeats, toolName: event.toolName });
    }
  });
  const step = (
    kind: TaskKind,
    beforeReport?: (recommendation: Recommendation) => void,
  ): StepResult => {
    const recommendation = engine.recommend({ agentId: name, kind });
    beforeReport?.(recommendation);
    const truth = options.truth(recommendation.taskClass, recommendation.parameters);
    // The noise draw is consumed unconditionally so the uniform stream of the
    // pre-existing scenarios stays aligned with their original calibrations.
    const epsilon = gaussian(uniform) * NOISE_SIGMA;
    const reportedQuality =
      truth.implicit === true
        ? undefined
        : truth.exact === true
          ? clamp01(truth.quality)
          : clamp01(truth.quality + epsilon);
    engine.report({
      executionId: recommendation.executionId,
      costUsd: truth.costUsd,
      latencyMs: truth.latencyMs,
      finishReason: 'stop',
      ...(truth.toolCalls === undefined ? {} : { toolCalls: truth.toolCalls }),
      ...(reportedQuality === undefined ? {} : { qualityScore: reportedQuality }),
    });
    return { recommendation, reportedQuality };
  };
  return { engine, agentId: name, decisions, loops, step };
}

/** Decision entries of one type, optionally narrowed to one parameter. */
function decisionsOf(
  run: Scenario,
  type: DecisionType,
  parameter?: ParameterName,
): readonly DecisionEntry[] {
  return run.decisions.filter(
    (entry) => entry.type === type && (parameter === undefined || entry.parameter === parameter),
  );
}

/** Value currently promoted to the baseline cohort for one parameter dimension. */
function currentOf(run: Scenario, kind: TaskKind, parameter: ParameterName): ParameterValue {
  const profile = run.engine.profileOf(run.agentId, kind)[0];
  const dimension = profile?.profiles.find((entry) => entry.parameter === parameter);
  expect(dimension).toBeDefined();
  return dimension?.current ?? Number.NaN;
}

describe('tuning quality benchmark', () => {
  it('S1 flat-landscape: zero promotions and canary share in [0.07, 0.13] over 3000 executions', () => {
    // Every arm of every dimension yields the same expected reward, so any
    // promotion is a statistical false positive on noise. Futility rollbacks are
    // the expected and correct way for experiments to end here. Calibration
    // (seed 42): 0 promotions, 12 futility rollbacks, canary share 0.0997. Before
    // the SafeRollout sequential correction this scenario produced 1 to 8 false
    // promotions on every probed seed; zero is the defended bound.
    const run = scenario('flat-landscape', {
      seed: 42,
      truth: () => ({ quality: 0.8, costUsd: 0.003, latencyMs: 1000 }),
    });
    let canaries = 0;
    for (let index = 0; index < 3000; index += 1) {
      if (run.step('factual-qa').recommendation.cohort === 'canary') {
        canaries += 1;
      }
    }
    expect(decisionsOf(run, 'canary.promoted')).toHaveLength(0);
    expect(decisionsOf(run, 'canary.rolledback').length).toBeGreaterThanOrEqual(1);
    // 3000 draws at canaryShare 0.1 have sigma 0.0055; [0.07, 0.13] is 5.5 sigma.
    const share = canaries / 3000;
    expect(share).toBeGreaterThanOrEqual(0.07);
    expect(share).toBeLessThanOrEqual(0.13);
  });

  it('S2 temperature-convergence: factual-qa promotes temperature 0 within 1500 executions', () => {
    // Ground truth: quality 0.95 at temperature 0, dropping 0.08 per grid step
    // away, cost and latency flat. The reward gap between the 0.4 baseline and the
    // 0 optimum is 0.08 (balanced weights), four sigma of the noise, so the first
    // canary on temperature must find and promote 0. Calibration (seed 202): the
    // single promotion 0.4 -> 0 lands at execution 38 and survives the rest of the
    // run because every later temperature candidate is genuinely worse. (Before
    // the statistical-core fixes the promotion landed at execution 37; it moved by
    // one because promotion verdicts now run only when a canary outcome arrives,
    // so sensitivity is preserved while the look budget is honored.)
    const run = scenario('temperature-convergence', {
      seed: 202,
      truth: (_kind, parameters) => ({
        quality: 0.95 - 0.08 * temperatureSteps(parameters),
        costUsd: 0.002,
        latencyMs: 900,
      }),
    });
    for (let index = 0; index < 1500; index += 1) {
      run.step('factual-qa');
    }
    expect(currentOf(run, 'factual-qa', 'temperature')).toBe(0);
    const promotions = decisionsOf(run, 'canary.promoted', 'temperature');
    expect(promotions.length).toBeGreaterThanOrEqual(1);
    expect(promotions.some((entry) => entry.to === 0)).toBe(true);
  });

  it('S3 harmful-candidate-rollback: temperature 0 never reaches baseline and baseline quality stays >= 0.8', () => {
    // creative-writing where temperature 0 is sharply worse (quality 0.45, below
    // the 0.5 success threshold) while every other temperature scores 0.85. The
    // core safety invariant: exploration must never degrade baseline traffic, so
    // the harmful candidate is only ever served to the canary cohort and is rolled
    // back there. Calibration (seed 303): 1 rollback of candidate 0 (the first
    // temperature experiment), 0 promotions of 0, baseline mean quality 0.8500.
    const run = scenario('harmful-candidate', {
      seed: 303,
      truth: (_kind, parameters) => ({
        quality: numberParameter(parameters, 'temperature', 0.4) === 0 ? 0.45 : 0.85,
        costUsd: 0.004,
        latencyMs: 1200,
      }),
    });
    let baselineQualitySum = 0;
    let baselineCount = 0;
    for (let index = 0; index < 2500; index += 1) {
      const { recommendation, reportedQuality } = run.step('creative-writing');
      if (recommendation.cohort === 'baseline' && reportedQuality !== undefined) {
        baselineQualitySum += reportedQuality;
        baselineCount += 1;
      }
    }
    const promotedToZero = decisionsOf(run, 'canary.promoted', 'temperature').filter(
      (entry) => entry.to === 0,
    );
    expect(promotedToZero).toHaveLength(0);
    const rolledBackFromZero = decisionsOf(run, 'canary.rolledback', 'temperature').filter(
      (entry) => entry.from === 0,
    );
    expect(rolledBackFromZero.length).toBeGreaterThanOrEqual(1);
    expect(baselineCount).toBeGreaterThan(0);
    expect(baselineQualitySum / baselineCount).toBeGreaterThanOrEqual(0.8);
  });

  it('S4 objective-sensitivity: the cost objective promotes maxTurns 8 and the quality objective never degrades quality', () => {
    // Identical workload, two objectives. maxTurns 8 and 64 have equal quality but
    // 64 costs 4x more and is 3x slower (table below). Only maxTurns is tunable so
    // the comparison is sharp. The cost engine must promote 8 from the default 32
    // baseline. Observed quality-engine behavior, documented as calibrated
    // (seed 404): the quality engine also promotes maxTurns 8, because quality is
    // flat and the residual 0.3 cost-plus-latency weight decides; its baseline
    // mean quality is identical to the cost engine's (0.84995), so quality is
    // provably not demoted. The bound defends that ordering with a 0.005 epsilon.
    const COST_BY_TURNS: Readonly<Record<number, number>> = {
      8: 0.002,
      16: 0.003,
      32: 0.005,
      64: 0.008,
    };
    const LATENCY_BY_TURNS: Readonly<Record<number, number>> = {
      8: 600,
      16: 800,
      32: 1200,
      64: 1800,
    };
    const truth: GroundTruth = (_kind, parameters) => {
      const maxTurns = numberParameter(parameters, 'maxTurns', 32);
      return {
        quality: 0.85,
        costUsd: COST_BY_TURNS[maxTurns] ?? 0.005,
        latencyMs: LATENCY_BY_TURNS[maxTurns] ?? 1200,
      };
    };
    const locked: readonly ParameterName[] = ['temperature', 'topP', 'retryBudget', 'contextShare'];
    const runWith = (objective: 'cost' | 'quality') => {
      const run = scenario('objective-sensitivity', {
        seed: 404,
        truth,
        engine: { objective, constraints: { locked } },
      });
      let baselineQualitySum = 0;
      let baselineCount = 0;
      for (let index = 0; index < 2000; index += 1) {
        const { recommendation, reportedQuality } = run.step('extraction');
        if (recommendation.cohort === 'baseline' && reportedQuality !== undefined) {
          baselineQualitySum += reportedQuality;
          baselineCount += 1;
        }
      }
      return { run, baselineMeanQuality: baselineQualitySum / baselineCount };
    };
    const costEngine = runWith('cost');
    const qualityEngine = runWith('quality');
    expect(currentOf(costEngine.run, 'extraction', 'maxTurns')).toBe(8);
    const costPromotions = decisionsOf(costEngine.run, 'canary.promoted', 'maxTurns');
    expect(costPromotions.some((entry) => entry.to === 8)).toBe(true);
    expect(qualityEngine.baselineMeanQuality).toBeGreaterThanOrEqual(
      costEngine.baselineMeanQuality - 0.005,
    );
    expect(qualityEngine.baselineMeanQuality).toBeGreaterThanOrEqual(0.8);
  });

  it('S5 loop-penalty: loop.detected fires with repeats >= 3 and retryBudget 3 is never promoted', () => {
    // Executions served with retryBudget 3 carry five consecutive identical
    // name-plus-argumentsHash tool calls. No explicit qualityScore is reported in
    // this scenario, because the loop penalty only applies to the implicit quality
    // derivation: looping executions land at quality 0.6 versus 1.0 for clean
    // ones, so the looping arm must never win a canary. Calibration (seed 505):
    // 72 loop.detected events, all with repeats 5, candidate 3 rolled back three
    // times and never promoted, final promoted retryBudget 1. (Before the
    // statistical-core fixes the run produced 24 loop events and one rollback of
    // candidate 3; the global Garivier-Moulines decay tick now re-opens losing
    // arms for re-challenge, so the harmful candidate is re-tested and re-rejected
    // instead of staying frozen out, which is exactly the non-stationarity fix.)
    const LOOPED_CALLS: readonly ToolCallOutcome[] = Array.from({ length: 5 }, () => ({
      name: 'lookup',
      ok: true,
      argumentsHash: 'same-arguments',
    }));
    const run = scenario('loop-penalty', {
      seed: 505,
      truth: (_kind, parameters) => ({
        quality: 1,
        costUsd: 0.003,
        latencyMs: 1000,
        implicit: true,
        ...(numberParameter(parameters, 'retryBudget', 1) === 3 ? { toolCalls: LOOPED_CALLS } : {}),
      }),
      engine: { constraints: { locked: ['temperature', 'topP', 'maxTurns', 'contextShare'] } },
    });
    for (let index = 0; index < 1500; index += 1) {
      run.step('tool-execution');
    }
    expect(run.loops.length).toBeGreaterThanOrEqual(1);
    expect(run.loops.every((loop) => loop.repeats >= 3)).toBe(true);
    const promotedToThree = decisionsOf(run, 'canary.promoted', 'retryBudget').filter(
      (entry) => entry.to === 3,
    );
    expect(promotedToThree).toHaveLength(0);
    expect(currentOf(run, 'tool-execution', 'retryBudget')).not.toBe(3);
  });

  it('S6 model-dimension: the cost objective promotes fast-y over the frontier-x baseline within 2000 executions', () => {
    // Two model candidates: fast-y has quality 0.80 at a quarter of the cost of
    // frontier-x at quality 0.84, equal latency. The baseline is forced to
    // frontier-x via constraints so the engine must actively promote fast-y under
    // the cost objective. Calibration (seed 606): exactly one promotion,
    // frontier-x -> fast-y, and fast-y stays promoted because every later
    // frontier-x canary loses on reward and is rolled back.
    const run = scenario('model-dimension', {
      seed: 606,
      truth: (_kind, parameters) =>
        parameters.model === 'fast-y'
          ? { quality: 0.8, costUsd: 0.005, latencyMs: 1000 }
          : { quality: 0.84, costUsd: 0.02, latencyMs: 1000 },
      engine: {
        objective: 'cost',
        parameters: {
          model: [
            { id: 'frontier-x', tier: 'frontier' },
            { id: 'fast-y', tier: 'fast' },
          ],
        },
        constraints: {
          baseline: { model: 'frontier-x' },
          locked: ['temperature', 'topP', 'maxTurns', 'retryBudget', 'contextShare'],
        },
      },
    });
    for (let index = 0; index < 2000; index += 1) {
      run.step('factual-qa');
    }
    expect(currentOf(run, 'factual-qa', 'model')).toBe('fast-y');
    const promotions = decisionsOf(run, 'canary.promoted', 'model');
    expect(promotions.some((entry) => entry.to === 'fast-y')).toBe(true);
  });

  it('S7 safety-invariant: baseline always serves the promoted set and canary differs in exactly the focus parameter', () => {
    // The flagship invariant over 1000 executions of active learning on the S2
    // convergence landscape: every baseline recommendation carries exactly the
    // promoted parameter set of that moment, and every canary differs from it in
    // exactly one parameter, which must be the recommendation's focus. The tracked
    // promoted set starts from the explicit constraint baselines and is advanced
    // only by canary.promoted decisions; the check runs between recommend and
    // report so promotions triggered by a report can never excuse the
    // recommendation that preceded them. Zero violations allowed. Calibration
    // (seed 707): 0 violations across 1 promotion (temperature 0.4 -> 0).
    const initialBaseline: ReadonlyArray<readonly [ParameterName, ParameterValue]> = [
      ['temperature', 0.4],
      ['topP', 1],
      ['maxTurns', 32],
      ['retryBudget', 1],
      ['contextShare', 0.6],
    ];
    const baseline: Partial<Record<ParameterName, ParameterValue>> = {};
    for (const [parameter, value] of initialBaseline) {
      baseline[parameter] = value;
    }
    const run = scenario('safety-invariant', {
      seed: 707,
      truth: (_kind, parameters) => ({
        quality: 0.95 - 0.08 * temperatureSteps(parameters),
        costUsd: 0.002,
        latencyMs: 900,
      }),
      engine: { constraints: { baseline } },
    });
    const promotedNow = new Map<ParameterName, ParameterValue>(initialBaseline);
    run.engine.on((event) => {
      if (event.type === 'decision.recorded' && event.entry.type === 'canary.promoted') {
        promotedNow.set(event.entry.parameter, event.entry.to);
      }
    });
    let violations = 0;
    for (let index = 0; index < 1000; index += 1) {
      run.step('factual-qa', (recommendation) => {
        const tracked = [...promotedNow.keys()];
        const diffs = tracked.filter(
          (parameter) => recommendation.parameters[parameter] !== promotedNow.get(parameter),
        );
        if (recommendation.cohort === 'baseline') {
          if (diffs.length !== 0) {
            violations += 1;
          }
        } else if (diffs.length !== 1 || diffs[0] !== recommendation.focus) {
          violations += 1;
        }
      });
    }
    expect(violations).toBe(0);
    // The invariant must have been exercised across a promotion boundary.
    expect(decisionsOf(run, 'canary.promoted').length).toBeGreaterThanOrEqual(1);
  });

  it('S8 cohort-distribution: canary share in [0.085, 0.115] over 20000 recommends and identical cohort sequences per seed', () => {
    // One permanently active experiment (outcomes are never reported), so every
    // recommend rolls cohort assignment at canaryShare 0.1. Over 20000 draws the
    // binomial sigma is 0.00212, so [0.085, 0.115] is a 7 sigma corridor.
    // Calibration (seed 808): observed share 0.09955. The determinism contract:
    // two engines with the same seed produce identical cohort sequences for the
    // first 100 recommends.
    const build = (): NoeticOS =>
      createNoeticOS({
        seed: 808,
        clock: () => 0,
        minSamplesPerArm: 6,
        maxPendingExecutions: 20001,
      });
    const engine = build();
    const cohorts: string[] = [];
    let canaries = 0;
    for (let index = 0; index < 20000; index += 1) {
      const recommendation = engine.recommend({
        agentId: 'cohort-distribution',
        kind: 'factual-qa',
      });
      cohorts.push(recommendation.cohort);
      if (recommendation.cohort === 'canary') {
        canaries += 1;
      }
    }
    const share = canaries / 20000;
    expect(share).toBeGreaterThanOrEqual(0.085);
    expect(share).toBeLessThanOrEqual(0.115);

    const twin = build();
    const twinCohorts: string[] = [];
    for (let index = 0; index < 100; index += 1) {
      twinCohorts.push(
        twin.recommend({ agentId: 'cohort-distribution', kind: 'factual-qa' }).cohort,
      );
    }
    expect(cohorts.slice(0, 100)).toEqual(twinCohorts);
  });

  it('S9 flat-two-point: zero promotions over 3000 executions per seed on an identical two-point reward mixture', () => {
    // Council P0 reconstruction at benchmark scale: every arm of every dimension
    // draws quality from the SAME two-point mixture (0.95 with probability 0.8,
    // 0.3 otherwise), reported exactly (no gaussian noise), so any promotion is a
    // false positive. Two-point rewards defeat the t machinery specifically: an
    // all-identical canary window (probability 0.8^n) reports zero sample
    // variance, which before the zero-variance guard collapsed the canary lower
    // confidence bound onto its mean and let the bound-separation gate promote
    // pure noise (council measurement: 76 promotions in 499 experiments across 40
    // seeds, a 15.2 percent per-experiment false-promotion rate, against the
    // promised 5 percent). The full 40-seed protocol is too slow for CI and lives
    // in the acceptance probe (post-fix measurement: 6 promotions in 381
    // experiments, a 1.57 percent rate, within the promised 5 percent); CI pins
    // three seeds at exactly zero promotions, mirroring the S1 pattern. The
    // mixture stream is dedicated and seeded so the scenario stays fully
    // deterministic. Calibration (seeds 11, 42, 1337): 0 promotions each and
    // 12, 14, 13 rollbacks, canary shares 0.0970, 0.0997, 0.1073.
    for (const seed of [11, 42, 1337]) {
      const twoPoint = mulberry32(seed ^ 0x2f00d);
      const run = scenario(`flat-two-point-${seed}`, {
        seed,
        truth: () => ({
          quality: twoPoint() < 0.8 ? 0.95 : 0.3,
          costUsd: 0.003,
          latencyMs: 1000,
          exact: true,
        }),
      });
      for (let index = 0; index < 3000; index += 1) {
        run.step('factual-qa');
      }
      expect(decisionsOf(run, 'canary.promoted')).toHaveLength(0);
      expect(decisionsOf(run, 'canary.rolledback').length).toBeGreaterThanOrEqual(1);
    }
  });
});
