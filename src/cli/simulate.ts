/**
 * `noeticos simulate`: a deterministic demonstration that tuning pays.
 *
 * Runs a synthetic three-kind workload against a real engine, streams every decision
 * as it is recorded, and closes with a counterfactual: the identical outcome model
 * replayed over the identical execution sequence, once with the static middle-of-grid
 * baseline and once with the final promoted parameters. With a fixed seed the whole
 * transcript is byte-identical across runs: the engine clock is pinned to zero and
 * all workload randomness flows from one local mulberry32 stream.
 */

import { DEFAULT_PARAMETER_SPACE } from '../bandit/defaults.js';
import { createNoeticOS } from '../core/createNoeticOS.js';
import type { NoeticOS, ObjectivePreset, ParameterName, ParameterValue } from '../types.js';
import { parseArgs } from './args.js';

/** Task kinds simulated, visited round-robin in this order. */
const SIM_KINDS = ['factual-qa', 'creative-writing', 'extraction'] as const;

type SimKind = (typeof SIM_KINDS)[number];

type SimParameters = Readonly<Partial<Record<ParameterName, ParameterValue>>>;

const AGENT_ID = 'sim-agent';
const DEFAULT_EXECUTIONS = 600;
const DEFAULT_SEED = 7;
const DEFAULT_CANARY_SHARE = 0.1;
const MIN_SAMPLES_PER_ARM = 6;
/** Standard deviation of the seeded gaussian noise added to every quality score. */
const NOISE_SIGMA = 0.05;

/** factual-qa ground truth: quality lost per 0.2 of temperature above the optimum 0. */
const FACTUAL_QUALITY_DROP = 0.08;
/** creative-writing ground truth: quality lost per temperature grid step below optimum. */
const CREATIVE_QUALITY_DROP = 0.1;
/** creative-writing is insensitive to temperature at or above this value. */
const CREATIVE_OPTIMAL_TEMPERATURE = 0.7;
/** extraction ground truth: flat quality, parameters only move cost and latency. */
const EXTRACTION_QUALITY = 0.9;
/** extraction cost per agent turn, so the grid minimum maxTurns of 8 is optimal. */
const EXTRACTION_COST_PER_TURN = 0.0005;
/** extraction latency per agent turn in milliseconds. */
const EXTRACTION_LATENCY_PER_TURN = 250;

const OBJECTIVES: readonly ObjectivePreset[] = ['balanced', 'cost', 'latency', 'quality'];

const VALID_FLAGS: ReadonlySet<string> = new Set([
  'executions',
  'seed',
  'objective',
  'canary-share',
]);

/** Parameters listed in the per-kind summary, in fixed order. */
const SUMMARY_PARAMETERS: readonly ParameterName[] = [
  'temperature',
  'topP',
  'maxTurns',
  'retryBudget',
  'contextShare',
];

function middleOfGrid(values: readonly number[]): number {
  return values[Math.floor(values.length / 2)] ?? 0;
}

/** The untuned reference configuration: the engine's default middle-of-grid baselines. */
const STATIC_BASELINE: SimParameters = {
  temperature: middleOfGrid(DEFAULT_PARAMETER_SPACE.temperature),
  topP: middleOfGrid(DEFAULT_PARAMETER_SPACE.topP),
  maxTurns: middleOfGrid(DEFAULT_PARAMETER_SPACE.maxTurns),
  retryBudget: middleOfGrid(DEFAULT_PARAMETER_SPACE.retryBudget),
  contextShare: middleOfGrid(DEFAULT_PARAMETER_SPACE.contextShare),
};

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

/** Noiseless synthetic result of one execution under the served parameters. */
interface SyntheticOutcome {
  readonly qualityBase: number;
  readonly costUsd: number;
  readonly latencyMs: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

function numberParameter(parameters: SimParameters, name: ParameterName, fallback: number): number {
  const value = parameters[name];
  return typeof value === 'number' ? value : fallback;
}

/**
 * Ground-truth outcome model, a pure function of task kind and served parameters:
 * - factual-qa: optimal temperature 0, quality drops 0.08 per 0.2 step above it,
 *   cost and latency flat.
 * - creative-writing: optimal temperature 0.7 or higher, quality drops 0.1 per
 *   temperature grid step below it, cost and latency flat.
 * - extraction: optimal maxTurns 8, every step above adds cost and latency
 *   proportional to the turn count, quality flat.
 */
function groundTruth(kind: SimKind, parameters: SimParameters): SyntheticOutcome {
  switch (kind) {
    case 'factual-qa': {
      const temperature = numberParameter(parameters, 'temperature', 0.4);
      return {
        qualityBase: 1 - FACTUAL_QUALITY_DROP * (temperature / 0.2),
        costUsd: 0.002,
        latencyMs: 900,
        inputTokens: 600,
        outputTokens: 220,
      };
    }
    case 'creative-writing': {
      const temperature = numberParameter(parameters, 'temperature', 0.4);
      const stepsBelow = DEFAULT_PARAMETER_SPACE.temperature.filter(
        (value) => temperature < value && value <= CREATIVE_OPTIMAL_TEMPERATURE,
      ).length;
      return {
        qualityBase: 1 - CREATIVE_QUALITY_DROP * stepsBelow,
        costUsd: 0.004,
        latencyMs: 1500,
        inputTokens: 350,
        outputTokens: 700,
      };
    }
    case 'extraction': {
      const maxTurns = numberParameter(parameters, 'maxTurns', 32);
      return {
        qualityBase: EXTRACTION_QUALITY,
        costUsd: EXTRACTION_COST_PER_TURN * maxTurns,
        latencyMs: EXTRACTION_LATENCY_PER_TURN * maxTurns,
        inputTokens: 80 * maxTurns,
        outputTokens: 40 * maxTurns,
      };
    }
  }
}

function kindAt(index: number): SimKind {
  return SIM_KINDS[index % SIM_KINDS.length] ?? 'factual-qa';
}

/** Final promoted values for one kind, straight from the learned profile. */
function promotedParameters(runtime: NoeticOS, kind: SimKind): SimParameters {
  const profile = runtime.profileOf(AGENT_ID, kind)[0];
  const parameters: Partial<Record<ParameterName, ParameterValue>> = {};
  if (profile !== undefined) {
    for (const entry of profile.profiles) {
      parameters[entry.parameter] = entry.current;
    }
  }
  return parameters;
}

function signedPercent(next: number, previous: number): string {
  const percent = previous === 0 ? 0 : ((next - previous) / previous) * 100;
  const magnitude = Math.abs(percent).toFixed(1);
  const sign = percent < 0 && magnitude !== '0.0' ? '-' : '+';
  return `${sign}${magnitude}%`;
}

function fail(message: string): number {
  process.stderr.write(`noeticos simulate: ${message}\n`);
  return 2;
}

type NumberRead =
  | { readonly ok: true; readonly value: number }
  | { readonly ok: false; readonly error: string };

function readNumber(
  flags: ReadonlyMap<string, string | boolean>,
  name: string,
  fallback: number,
): NumberRead {
  const raw = flags.get(name);
  if (raw === undefined) {
    return { ok: true, value: fallback };
  }
  if (typeof raw !== 'string') {
    return { ok: false, error: `flag --${name} requires a value` };
  }
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    return { ok: false, error: `flag --${name} expects a number, got "${raw}"` };
  }
  return { ok: true, value };
}

/** Runs the simulate command and returns the process exit code. */
export function runSimulate(argv: readonly string[]): number {
  const { positional, flags } = parseArgs(argv);
  const unexpected = positional[0];
  if (unexpected !== undefined) {
    return fail(`unexpected argument "${unexpected}"`);
  }
  for (const name of flags.keys()) {
    if (!VALID_FLAGS.has(name)) {
      return fail(`unknown flag "--${name}"`);
    }
  }
  const executionsRead = readNumber(flags, 'executions', DEFAULT_EXECUTIONS);
  if (!executionsRead.ok) {
    return fail(executionsRead.error);
  }
  const executions = executionsRead.value;
  if (!Number.isInteger(executions) || executions < 1) {
    return fail(`--executions expects a positive integer, got ${executions}`);
  }
  const seedRead = readNumber(flags, 'seed', DEFAULT_SEED);
  if (!seedRead.ok) {
    return fail(seedRead.error);
  }
  const seed = seedRead.value;
  const shareRead = readNumber(flags, 'canary-share', DEFAULT_CANARY_SHARE);
  if (!shareRead.ok) {
    return fail(shareRead.error);
  }
  const canaryShare = shareRead.value;
  if (canaryShare < 0 || canaryShare > 1) {
    return fail(`--canary-share expects a fraction in [0, 1], got ${canaryShare}`);
  }
  const objectiveRaw = flags.get('objective') ?? 'balanced';
  if (typeof objectiveRaw !== 'string') {
    return fail('flag --objective requires a value');
  }
  const objective = OBJECTIVES.find((preset) => preset === objectiveRaw);
  if (objective === undefined) {
    return fail(`--objective expects balanced | cost | latency | quality, got "${objectiveRaw}"`);
  }

  // One gaussian noise draw per execution, generated up front so the live run and
  // both counterfactual replays see the exact same noise sequence.
  const uniform = mulberry32(seed);
  const noise: number[] = [];
  for (let index = 0; index < executions; index += 1) {
    noise.push(gaussian(uniform) * NOISE_SIGMA);
  }

  const runtime = createNoeticOS({
    seed,
    objective,
    minSamplesPerArm: MIN_SAMPLES_PER_ARM,
    canaryShare,
    clock: () => 0,
  });

  let canaryCount = 0;
  let decisionCount = 0;
  let promotedCount = 0;
  let rolledBackCount = 0;
  const unsubscribe = runtime.on((event) => {
    if (event.type !== 'decision.recorded') {
      return;
    }
    const entry = event.entry;
    decisionCount += 1;
    if (entry.type === 'canary.promoted') {
      promotedCount += 1;
    } else if (entry.type === 'canary.rolledback') {
      rolledBackCount += 1;
    }
    const from = String(entry.from);
    const to = String(entry.to);
    process.stdout.write(
      `decision ${entry.type} ${entry.taskClass} ${entry.parameter} ${from} -> ${to}\n`,
    );
  });

  for (let index = 0; index < executions; index += 1) {
    const kind = kindAt(index);
    const recommendation = runtime.recommend({ agentId: AGENT_ID, kind });
    if (recommendation.cohort === 'canary') {
      canaryCount += 1;
    }
    const truth = groundTruth(kind, recommendation.parameters);
    runtime.report({
      executionId: recommendation.executionId,
      latencyMs: truth.latencyMs,
      costUsd: truth.costUsd,
      inputTokens: truth.inputTokens,
      outputTokens: truth.outputTokens,
      finishReason: 'stop',
      qualityScore: clamp01(truth.qualityBase + (noise[index] ?? 0)),
    });
  }
  unsubscribe();

  const tunedByKind = new Map<SimKind, SimParameters>();
  for (const kind of SIM_KINDS) {
    tunedByKind.set(kind, promotedParameters(runtime, kind));
  }

  // Counterfactual replay: identical kinds, identical noise, only parameters differ.
  let baselineCost = 0;
  let baselineQualitySum = 0;
  let tunedCost = 0;
  let tunedQualitySum = 0;
  for (let index = 0; index < executions; index += 1) {
    const kind = kindAt(index);
    const epsilon = noise[index] ?? 0;
    const baseline = groundTruth(kind, STATIC_BASELINE);
    baselineCost += baseline.costUsd;
    baselineQualitySum += clamp01(baseline.qualityBase + epsilon);
    const tuned = groundTruth(kind, tunedByKind.get(kind) ?? STATIC_BASELINE);
    tunedCost += tuned.costUsd;
    tunedQualitySum += clamp01(tuned.qualityBase + epsilon);
  }
  const baselineQuality = baselineQualitySum / executions;
  const tunedQuality = tunedQualitySum / executions;

  const summary: string[] = [];
  summary.push('--- summary ---');
  summary.push(`executions: ${executions}`);
  summary.push(
    `decisions: ${decisionCount} (${promotedCount} promoted, ${rolledBackCount} rolled back)`,
  );
  summary.push(`canary share observed: ${(canaryCount / executions).toFixed(3)}`);
  summary.push('per-kind promoted parameters:');
  for (const kind of SIM_KINDS) {
    const tuned = tunedByKind.get(kind) ?? STATIC_BASELINE;
    const rendered = SUMMARY_PARAMETERS.map(
      (name) => `${name}=${String(tuned[name] ?? STATIC_BASELINE[name] ?? 0)}`,
    ).join(' ');
    summary.push(`${kind}: ${rendered}`);
  }
  summary.push('counterfactual: identical workload and noise, static baseline versus tuned');
  summary.push(
    `static baseline: cost=$${baselineCost.toFixed(4)} quality=${baselineQuality.toFixed(3)}`,
  );
  summary.push(`noeticos tuned: cost=$${tunedCost.toFixed(4)} quality=${tunedQuality.toFixed(3)}`);
  const costDelta = signedPercent(tunedCost, baselineCost);
  const qualityDelta = signedPercent(tunedQuality, baselineQuality);
  summary.push(`delta: cost ${costDelta} quality ${qualityDelta}`);
  process.stdout.write(`${summary.join('\n')}\n`);
  return 0;
}
