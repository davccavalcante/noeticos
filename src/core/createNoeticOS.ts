/**
 * NoeticOS engine assembly.
 *
 * Wires the task classifier, the per-parameter bandits, the safe canary rollout judge,
 * the quantile trackers, the decision log, and the optional state backend behind the
 * {@link NoeticOS} contract. The safety invariant from types.ts governs every path
 * here: exploration happens only inside the deterministic canary cohort, the canary
 * differs from the baseline in exactly one parameter at a time, and every promotion or
 * rollback is appended to the decision log with the statistical evidence behind it.
 */

import { DecisionLog } from '../audit/DecisionLog.js';
import { DEFAULT_PARAMETER_SPACE } from '../bandit/defaults.js';
import { ParameterBandit, type ParameterBanditJson } from '../bandit/ParameterBandit.js';
import { computeReward, resolveWeights, totalTokensOf } from '../bandit/reward.js';
import { DEFAULT_TASK_KINDS, TaskClassifier } from '../classify/TaskClassifier.js';
import { NoeticosError } from '../errors.js';
import { SafeRollout, type SafeRolloutSnapshot } from '../rollout/SafeRollout.js';
import { P2Quantile, type P2QuantileJSON } from '../stats/P2Quantile.js';
import { Rng } from '../stats/Rng.js';
import type {
  Classification,
  ClassProfile,
  DecisionEntry,
  ExecutionOutcome,
  NoeticOS,
  NoeticOSOptions,
  ObjectiveWeights,
  ParameterName,
  ParameterProfile,
  ParameterValue,
  QualityFloor,
  Recommendation,
  RuntimeSnapshot,
  StateBackend,
  StateSnapshot,
  TaskDescriptor,
  TaskKind,
  TelemetryEvent,
  TelemetryListener,
  ToolCallOutcome,
} from '../types.js';

/** Fixed focus rotation order, also the order of dimensions in recommendations. */
const PARAMETER_ORDER: readonly ParameterName[] = [
  'model',
  'temperature',
  'topP',
  'maxTurns',
  'retryBudget',
  'contextShare',
];

const DEFAULT_CANARY_SHARE = 0.1;
const DEFAULT_MIN_SAMPLES_PER_ARM = 8;
const DEFAULT_PROMOTION_CONFIDENCE = 0.95;
const DEFAULT_SEED = 7;
const DEFAULT_MAX_AGENTS = 1000;
const DEFAULT_MAX_PENDING_EXECUTIONS = 10000;
/** Cohort hash space; the canary bucket is the lowest `canaryShare` fraction of it. */
const COHORT_BUCKETS = 10000;
/** Minimum identical consecutive tool calls that count as a loop. */
const LOOP_THRESHOLD = 3;

/** FNV-1a 32-bit offset basis. */
const FNV_OFFSET_BASIS = 0x811c9dc5;
/** FNV-1a 32-bit prime. */
const FNV_PRIME = 0x01000193;

/**
 * FNV-1a hash over the UTF-16 code units of `text`, two bytes per unit, low byte
 * first, matching the byte order used by {@link Rng.fork}.
 */
function fnv1a(text: string): number {
  let hash = FNV_OFFSET_BASIS;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    hash ^= code & 0xff;
    hash = Math.imul(hash, FNV_PRIME) >>> 0;
    hash ^= code >>> 8;
    hash = Math.imul(hash, FNV_PRIME) >>> 0;
  }
  return hash >>> 0;
}

/** One tunable dimension after merging the caller space, defaults, and constraints. */
interface ResolvedDimension {
  readonly parameter: ParameterName;
  readonly values: readonly ParameterValue[];
  readonly baseline: ParameterValue;
  readonly locked: boolean;
}

function resolveDimensions(options: NoeticOSOptions): readonly ResolvedDimension[] {
  const space = options.parameters;
  const locked = new Set<ParameterName>(options.constraints?.locked ?? []);
  const overrides = options.constraints?.baseline ?? {};
  const dimensions: ResolvedDimension[] = [];
  for (const parameter of PARAMETER_ORDER) {
    let values: readonly ParameterValue[];
    let defaultBaseline: ParameterValue | undefined;
    if (parameter === 'model') {
      const candidates = space?.model;
      if (candidates === undefined || candidates.length === 0) {
        continue;
      }
      values = candidates.map((candidate) => candidate.id);
      defaultBaseline = values[0];
    } else {
      values = space?.[parameter] ?? DEFAULT_PARAMETER_SPACE[parameter];
      defaultBaseline = values[Math.floor(values.length / 2)];
    }
    if (values.length === 0 || defaultBaseline === undefined) {
      throw NoeticosError.invalid(`parameter '${parameter}' declares no candidate values`);
    }
    if (new Set(values).size !== values.length) {
      throw NoeticosError.invalid(`parameter '${parameter}' declares duplicate candidate values`);
    }
    const baseline = overrides[parameter] ?? defaultBaseline;
    const isLocked = locked.has(parameter);
    if (!isLocked && !values.includes(baseline)) {
      throw NoeticosError.invalid(
        `baseline ${String(baseline)} of parameter '${parameter}' is not a declared value`,
      );
    }
    dimensions.push({ parameter, values, baseline, locked: isLocked });
  }
  return dimensions;
}

/** The single-parameter experiment currently running for one agent and class. */
interface Experiment {
  readonly focus: ParameterName;
  readonly candidate: ParameterValue;
}

interface TuningTrack {
  readonly bandits: ReadonlyMap<ParameterName, ParameterBandit>;
  rollout: SafeRollout;
  readonly costP5: P2Quantile;
  readonly costP95: P2Quantile;
  readonly latencyP5: P2Quantile;
  readonly latencyP95: P2Quantile;
  /**
   * Per-track total-token band (input plus output), the cost proxy band used when an
   * outcome reports tokens but no `costUsd`. Kept separate from the dollar band so
   * the two units are never normalized against each other.
   */
  readonly tokenP5: P2Quantile;
  readonly tokenP95: P2Quantile;
  executions: number;
  /** Index into the active parameter rotation where the next experiment starts. */
  focusIndex: number;
  experiment: Experiment | undefined;
  /**
   * Bumped whenever an experiment starts or ends, so reports from a previous
   * experiment cannot feed evidence into the current one.
   */
  epoch: number;
}

interface AgentRecord {
  readonly tracks: Map<TaskKind, TuningTrack>;
  frozen: boolean;
}

interface PendingExecution {
  readonly agentId: string;
  readonly taskClass: TaskKind;
  readonly cohort: 'baseline' | 'canary';
  readonly focus: ParameterName | undefined;
  readonly servedValue: ParameterValue | undefined;
  readonly epoch: number;
}

/** Serialized track payload stored opaquely inside {@link StateSnapshot.agents}. */
interface TrackJson {
  readonly bandits: readonly ParameterBanditJson[];
  readonly rollout: SafeRolloutSnapshot;
  readonly costP5: P2QuantileJSON;
  readonly costP95: P2QuantileJSON;
  readonly latencyP5: P2QuantileJSON;
  readonly latencyP95: P2QuantileJSON;
  /** Optional for backward compatibility: pre-token-band snapshots restore fresh. */
  readonly tokenP5?: P2QuantileJSON;
  readonly tokenP95?: P2QuantileJSON;
  readonly executions: number;
  readonly focusIndex: number;
  readonly experiment?: Experiment;
}

interface AgentJson {
  readonly frozen: boolean;
  readonly tracks: Readonly<Record<string, TrackJson>>;
}

function detectLoop(
  toolCalls: readonly ToolCallOutcome[] | undefined,
): { readonly toolName: string; readonly repeats: number } | undefined {
  if (toolCalls === undefined || toolCalls.length < LOOP_THRESHOLD) {
    return undefined;
  }
  let best: { toolName: string; repeats: number } | undefined;
  let runName = '';
  let runHash: string | undefined;
  let runLength = 0;
  for (const call of toolCalls) {
    // Hashes must match when present; two absent hashes match by name alone.
    if (runLength > 0 && call.name === runName && call.argumentsHash === runHash) {
      runLength += 1;
    } else {
      runName = call.name;
      runHash = call.argumentsHash;
      runLength = 1;
    }
    if (runLength >= LOOP_THRESHOLD && (best === undefined || runLength > best.repeats)) {
      best = { toolName: runName, repeats: runLength };
    }
  }
  return best;
}

class EngineCore {
  private readonly clock: () => number;
  private readonly weights: ObjectiveWeights;
  private readonly dimensions: readonly ResolvedDimension[];
  private readonly activeParameters: readonly ParameterName[];
  private readonly canaryShare: number;
  private readonly minSamplesPerArm: number;
  private readonly promotionConfidence: number;
  private readonly qualityFloor: QualityFloor | undefined;
  private readonly maxAgents: number;
  private readonly maxPending: number;
  private readonly backend: StateBackend | undefined;
  private readonly rng: Rng;
  private readonly classifier = new TaskClassifier();
  private readonly log = new DecisionLog();
  private readonly trackedAgents = new Map<string, AgentRecord>();
  private readonly pending = new Map<string, PendingExecution>();
  private readonly listeners = new Set<TelemetryListener>();
  private readonly restored: Promise<void>;
  private executionCounter = 0;
  private closed = false;

  constructor(options: NoeticOSOptions) {
    this.weights = resolveWeights(options.objective);
    this.dimensions = resolveDimensions(options);
    this.activeParameters = this.dimensions
      .filter((dimension) => !dimension.locked)
      .map((dimension) => dimension.parameter);
    this.canaryShare = options.canaryShare ?? DEFAULT_CANARY_SHARE;
    if (!Number.isFinite(this.canaryShare) || this.canaryShare < 0 || this.canaryShare > 1) {
      throw NoeticosError.invalid(`canaryShare must be in [0, 1], got ${this.canaryShare}`);
    }
    this.minSamplesPerArm = options.minSamplesPerArm ?? DEFAULT_MIN_SAMPLES_PER_ARM;
    if (!Number.isInteger(this.minSamplesPerArm) || this.minSamplesPerArm < 1) {
      throw NoeticosError.invalid(
        `minSamplesPerArm must be a positive integer, got ${this.minSamplesPerArm}`,
      );
    }
    this.promotionConfidence = options.promotionConfidence ?? DEFAULT_PROMOTION_CONFIDENCE;
    if (!(this.promotionConfidence > 0 && this.promotionConfidence < 1)) {
      throw NoeticosError.invalid(
        `promotionConfidence must be strictly between 0 and 1, got ${this.promotionConfidence}`,
      );
    }
    this.maxAgents = options.maxAgents ?? DEFAULT_MAX_AGENTS;
    if (!Number.isInteger(this.maxAgents) || this.maxAgents < 1) {
      throw NoeticosError.invalid(`maxAgents must be a positive integer, got ${this.maxAgents}`);
    }
    this.maxPending = options.maxPendingExecutions ?? DEFAULT_MAX_PENDING_EXECUTIONS;
    if (!Number.isInteger(this.maxPending) || this.maxPending < 1) {
      throw NoeticosError.invalid(
        `maxPendingExecutions must be a positive integer, got ${this.maxPending}`,
      );
    }
    this.qualityFloor = options.qualityFloor;
    this.backend = options.state;
    this.clock = options.clock ?? (() => Date.now());
    this.rng = new Rng(options.seed ?? DEFAULT_SEED);
    this.restored = this.restore();
  }

  recommend(task: TaskDescriptor): Recommendation {
    const classification = this.classifier.classify(task);
    const taskClass = classification.kind;
    const executionId = this.nextExecutionId();
    const record = this.ensureAgent(task.agentId);
    if (record === undefined) {
      return this.degradedRecommendation(task.agentId, taskClass, classification, executionId);
    }
    const track = this.ensureTrack(record, taskClass);
    if (!record.frozen && track.experiment === undefined) {
      this.startExperiment(task.agentId, taskClass, track);
    }
    const experiment = track.experiment;
    const bucket = fnv1a(executionId) % COHORT_BUCKETS;
    const canary =
      experiment !== undefined && !record.frozen && bucket / COHORT_BUCKETS < this.canaryShare;
    const parameters: Partial<Record<ParameterName, ParameterValue>> = {};
    for (const dimension of this.dimensions) {
      const bandit = track.bandits.get(dimension.parameter);
      const promoted = bandit === undefined ? dimension.baseline : bandit.current;
      parameters[dimension.parameter] =
        canary && experiment !== undefined && dimension.parameter === experiment.focus
          ? experiment.candidate
          : promoted;
    }
    const focusBandit = experiment === undefined ? undefined : track.bandits.get(experiment.focus);
    const focusPromoted = focusBandit?.current;
    const servedValue =
      experiment === undefined ? undefined : canary ? experiment.candidate : focusPromoted;
    let reasoning: string;
    if (canary && experiment !== undefined) {
      reasoning =
        `canary cohort for ${taskClass}: testing ${experiment.focus}=` +
        `${String(experiment.candidate)} against promoted ${String(focusPromoted)}`;
    } else if (record.frozen) {
      reasoning = `tuning is frozen for this agent: serving promoted values for ${taskClass}`;
    } else if (experiment !== undefined) {
      reasoning =
        `baseline cohort for ${taskClass}: serving promoted values while ` +
        `${experiment.focus} is under canary`;
    } else {
      reasoning = `serving promoted values for ${taskClass}: no parameter has a candidate left`;
    }
    this.evictPendingIfFull();
    this.pending.set(executionId, {
      agentId: task.agentId,
      taskClass,
      cohort: canary ? 'canary' : 'baseline',
      focus: experiment?.focus,
      servedValue,
      epoch: track.epoch,
    });
    const recommendation: Recommendation = {
      executionId,
      agentId: task.agentId,
      taskClass,
      classification,
      parameters,
      cohort: canary ? 'canary' : 'baseline',
      ...(experiment === undefined ? {} : { focus: experiment.focus }),
      reasoning,
    };
    this.emit({ type: 'recommendation.issued', recommendation, timestamp: this.clock() });
    return recommendation;
  }

  report(outcome: ExecutionOutcome): void {
    const pending = this.pending.get(outcome.executionId);
    if (pending === undefined) {
      // Unknown ids are ignored on purpose: late, replayed, or fabricated reports
      // carry no trustworthy cohort attribution, and learning from them would let a
      // single stray report corrupt the arm statistics and the canary verdict.
      return;
    }
    this.pending.delete(outcome.executionId);
    const record = this.trackedAgents.get(pending.agentId);
    const track = record?.tracks.get(pending.taskClass);
    if (record === undefined || track === undefined) {
      return;
    }
    const loop = detectLoop(outcome.toolCalls);
    if (loop !== undefined) {
      this.emit({
        type: 'loop.detected',
        executionId: outcome.executionId,
        agentId: pending.agentId,
        repeats: loop.repeats,
        toolName: loop.toolName,
        timestamp: this.clock(),
      });
    }
    if (outcome.costUsd !== undefined && Number.isFinite(outcome.costUsd)) {
      track.costP5.observe(outcome.costUsd);
      track.costP95.observe(outcome.costUsd);
    }
    if (outcome.latencyMs !== undefined && Number.isFinite(outcome.latencyMs)) {
      track.latencyP5.observe(outcome.latencyMs);
      track.latencyP95.observe(outcome.latencyMs);
    }
    const totalTokens = totalTokensOf(outcome);
    if (totalTokens !== undefined) {
      track.tokenP5.observe(totalTokens);
      track.tokenP95.observe(totalTokens);
    }
    const { reward, quality } = computeReward({
      outcome,
      weights: this.weights,
      costP5: track.costP5.estimate(),
      costP95: track.costP95.estimate(),
      latencyP5: track.latencyP5.estimate(),
      latencyP95: track.latencyP95.estimate(),
      tokenP5: track.tokenP5.estimate(),
      tokenP95: track.tokenP95.estimate(),
      ...(loop === undefined ? {} : { loopRepeats: loop.repeats }),
    });
    track.executions += 1;
    // Freeze semantics: a frozen track learns nothing. Outcomes that arrive while
    // the agent is frozen are excluded from BOTH the bandit and the rollout
    // experiment. The freeze exists because the statistics destabilized, so feeding
    // the anomalous window into the discounted arm means would steer learning with
    // exactly the data the freeze quarantines, and recording baseline outcomes into
    // the live experiment would contaminate the baseline side of any post-release
    // verdict (the council measured promotions judged against frozen-window
    // baselines). The quantile trackers above keep observing on purpose: they only
    // normalize cost and latency against a wide P5..P95 band and recover quickly,
    // while pausing them would distort the very first rewards after release.
    if (!record.frozen) {
      if (pending.focus !== undefined && pending.servedValue !== undefined) {
        track.bandits.get(pending.focus)?.record(pending.servedValue, reward);
      }
      const experiment = track.experiment;
      if (experiment !== undefined && pending.epoch === track.epoch) {
        if (pending.cohort === 'canary') {
          track.rollout.recordCanary(reward, quality);
          // Look-budget accounting: the promotion judge runs ONLY when a canary
          // outcome was just recorded, so the number of looks equals the number of
          // canary trials, at most 4 * minSamplesPerArm via the futility budget.
          // Evaluating after baseline reports too would spend hundreds of looks per
          // experiment (the council measured 306 to 312 against a budget of 32)
          // while the Bonferroni correction inside the judge only accounts for the
          // canary-trial budget. Baseline reports cannot change the canary trial
          // count, the only quantity the sample, promotion, and futility gates key
          // on, so no verdict is delayed by skipping them; guardrail checks fire on
          // the next canary outcome exactly as the look budget intends.
          this.settleExperiment(pending.agentId, pending.taskClass, track, experiment);
        } else {
          track.rollout.recordBaseline(reward, quality);
        }
      }
    }
    this.emit({
      type: 'outcome.recorded',
      executionId: outcome.executionId,
      agentId: pending.agentId,
      taskClass: pending.taskClass,
      reward,
      timestamp: this.clock(),
    });
  }

  profileOf(agentId: string, taskClass?: TaskKind): readonly ClassProfile[] {
    const record = this.trackedAgents.get(agentId);
    if (record === undefined) {
      return [];
    }
    const profiles: ClassProfile[] = [];
    for (const [kind, track] of record.tracks) {
      if (taskClass === undefined || kind === taskClass) {
        profiles.push(this.classProfile(agentId, kind, track));
      }
    }
    return profiles;
  }

  decisions(filter?: { agentId?: string; limit?: number }): readonly DecisionEntry[] {
    return this.log.list(filter);
  }

  agentIds(): readonly string[] {
    return [...this.trackedAgents.keys()];
  }

  inspect(): RuntimeSnapshot {
    const profiles: ClassProfile[] = [];
    for (const [agentId, record] of this.trackedAgents) {
      for (const [kind, track] of record.tracks) {
        profiles.push(this.classProfile(agentId, kind, track));
      }
    }
    return {
      agents: profiles,
      decisions: this.log.totalAppended,
      pendingExecutions: this.pending.size,
    };
  }

  on(listener: TelemetryListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async flush(): Promise<void> {
    if (this.backend === undefined) {
      return;
    }
    // Wait for the startup restore so an early flush cannot clobber the previous
    // snapshot with a still-empty engine.
    await this.restored;
    const agents: Record<string, unknown> = {};
    for (const [agentId, record] of this.trackedAgents) {
      agents[agentId] = this.serializeAgent(record);
    }
    const snapshot: StateSnapshot = { version: 1, savedAt: this.clock(), agents };
    try {
      await this.backend.save(snapshot);
    } catch {
      // Persistence is best-effort by contract: a failing backend never breaks the
      // engine, in-memory state stays authoritative.
    }
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    await this.flush();
    this.listeners.clear();
  }

  freeze(agentId: string, reason: string): void {
    const record = this.ensureAgent(agentId);
    if (record === undefined || record.frozen) {
      return;
    }
    record.frozen = true;
    if (record.tracks.size === 0) {
      this.appendDecision(this.frozenEntry(agentId, 'unknown', undefined, reason));
      return;
    }
    for (const [taskClass, track] of record.tracks) {
      this.appendDecision(this.frozenEntry(agentId, taskClass, track, reason));
    }
  }

  release(agentId: string): void {
    const record = this.trackedAgents.get(agentId);
    if (record === undefined || !record.frozen) {
      return;
    }
    record.frozen = false;
    // The frozen window is statistically suspect by definition, so any experiment
    // that was mid-flight when the freeze hit is abandoned: the rollout is reset
    // and the epoch advances so reports still in flight from before the release
    // cannot feed evidence into the next experiment. Post-release comparisons
    // therefore start from clean baseline and canary sides. The release is audited
    // symmetrically with the freeze: one 'tuning.released' decision entry per known
    // task class (the entry is captured BEFORE the reset so it can name the
    // abandoned experiment), plus the 'tuning.released' telemetry event.
    if (record.tracks.size === 0) {
      this.appendDecision(this.releasedEntry(agentId, 'unknown', undefined));
    }
    for (const [taskClass, track] of record.tracks) {
      this.appendDecision(this.releasedEntry(agentId, taskClass, track));
      track.rollout.reset();
      track.experiment = undefined;
      track.epoch += 1;
    }
    this.emit({ type: 'tuning.released', agentId, timestamp: this.clock() });
  }

  private nextExecutionId(): string {
    this.executionCounter += 1;
    const draw = Math.floor(this.rng.next() * 4294967296);
    return `nx-${this.executionCounter}-${draw.toString(36)}`;
  }

  private ensureAgent(agentId: string): AgentRecord | undefined {
    const existing = this.trackedAgents.get(agentId);
    if (existing !== undefined) {
      return existing;
    }
    if (this.trackedAgents.size >= this.maxAgents) {
      this.emit({
        type: 'limit.reached',
        scope: 'agents',
        detail: `agent capacity of ${this.maxAgents} reached, '${agentId}' is not tracked`,
        timestamp: this.clock(),
      });
      return undefined;
    }
    const record: AgentRecord = { tracks: new Map(), frozen: false };
    this.trackedAgents.set(agentId, record);
    return record;
  }

  private ensureTrack(record: AgentRecord, taskClass: TaskKind): TuningTrack {
    const existing = record.tracks.get(taskClass);
    if (existing !== undefined) {
      return existing;
    }
    const track = this.createTrack();
    record.tracks.set(taskClass, track);
    return track;
  }

  private createTrack(): TuningTrack {
    const bandits = new Map<ParameterName, ParameterBandit>();
    for (const dimension of this.dimensions) {
      if (!dimension.locked) {
        bandits.set(
          dimension.parameter,
          new ParameterBandit(dimension.parameter, dimension.values, dimension.baseline),
        );
      }
    }
    return {
      bandits,
      rollout: this.createRollout(),
      costP5: new P2Quantile(0.05),
      costP95: new P2Quantile(0.95),
      latencyP5: new P2Quantile(0.05),
      latencyP95: new P2Quantile(0.95),
      tokenP5: new P2Quantile(0.05),
      tokenP95: new P2Quantile(0.95),
      executions: 0,
      focusIndex: 0,
      experiment: undefined,
      epoch: 0,
    };
  }

  private createRollout(): SafeRollout {
    return new SafeRollout({
      minSamples: this.minSamplesPerArm,
      promotionConfidence: this.promotionConfidence,
      ...(this.qualityFloor === undefined ? {} : { qualityFloor: this.qualityFloor }),
    });
  }

  private startExperiment(agentId: string, taskClass: TaskKind, track: TuningTrack): void {
    const count = this.activeParameters.length;
    if (count === 0) {
      return;
    }
    for (let step = 0; step < count; step += 1) {
      const index = (track.focusIndex + step) % count;
      const parameter = this.activeParameters[index];
      const bandit = parameter === undefined ? undefined : track.bandits.get(parameter);
      if (parameter === undefined || bandit === undefined) {
        continue;
      }
      const candidate = bandit.candidate();
      if (candidate === undefined) {
        continue;
      }
      track.experiment = { focus: parameter, candidate };
      track.focusIndex = (index + 1) % count;
      track.epoch += 1;
      this.appendDecision({
        timestamp: this.clock(),
        type: 'canary.started',
        agentId,
        taskClass,
        parameter,
        from: bandit.current,
        to: candidate,
        reasoning:
          `started canary for ${parameter}: candidate ${String(candidate)} versus ` +
          `promoted ${String(bandit.current)}`,
        evidence: { canaryShare: this.canaryShare, minSamples: this.minSamplesPerArm },
      });
      return;
    }
    // Every active parameter has exhausted its candidates, the track is stable.
  }

  private settleExperiment(
    agentId: string,
    taskClass: TaskKind,
    track: TuningTrack,
    experiment: Experiment,
  ): void {
    const verdict = track.rollout.evaluate();
    if (verdict.action === 'continue') {
      return;
    }
    const bandit = track.bandits.get(experiment.focus);
    if (bandit === undefined) {
      return;
    }
    const promoted = bandit.current;
    if (verdict.action === 'promote') {
      bandit.promote(experiment.candidate);
      this.appendDecision({
        timestamp: this.clock(),
        type: 'canary.promoted',
        agentId,
        taskClass,
        parameter: experiment.focus,
        from: promoted,
        to: experiment.candidate,
        reasoning: verdict.reasoning,
        evidence: verdict.evidence,
      });
    } else {
      this.appendDecision({
        timestamp: this.clock(),
        type: 'canary.rolledback',
        agentId,
        taskClass,
        parameter: experiment.focus,
        from: experiment.candidate,
        to: promoted,
        reasoning: verdict.reasoning,
        evidence: verdict.evidence,
      });
    }
    track.rollout.reset();
    track.experiment = undefined;
    track.epoch += 1;
  }

  private evictPendingIfFull(): void {
    if (this.pending.size < this.maxPending) {
      return;
    }
    for (const oldestId of this.pending.keys()) {
      this.pending.delete(oldestId);
      this.emit({
        type: 'limit.reached',
        scope: 'pending',
        detail:
          `pending capacity of ${this.maxPending} reached, ` +
          `evicted oldest execution '${oldestId}'`,
        timestamp: this.clock(),
      });
      break;
    }
  }

  private degradedRecommendation(
    agentId: string,
    taskClass: TaskKind,
    classification: Classification,
    executionId: string,
  ): Recommendation {
    // Degraded mode: agents beyond `maxAgents` receive the static baseline defaults,
    // no track is created, no pending entry is kept, and their reports are ignored,
    // so the engine stays memory-bounded no matter how many agent ids appear.
    const parameters: Partial<Record<ParameterName, ParameterValue>> = {};
    for (const dimension of this.dimensions) {
      parameters[dimension.parameter] = dimension.baseline;
    }
    const recommendation: Recommendation = {
      executionId,
      agentId,
      taskClass,
      classification,
      parameters,
      cohort: 'baseline',
      reasoning:
        `agent capacity of ${this.maxAgents} reached: serving static default ` +
        'parameters without learning',
    };
    this.emit({ type: 'recommendation.issued', recommendation, timestamp: this.clock() });
    return recommendation;
  }

  private classProfile(agentId: string, taskClass: TaskKind, track: TuningTrack): ClassProfile {
    const profiles: ParameterProfile[] = [];
    for (const parameter of PARAMETER_ORDER) {
      const bandit = track.bandits.get(parameter);
      if (bandit !== undefined) {
        profiles.push(this.parameterProfile(track, bandit));
      }
    }
    return { agentId, taskClass, executions: track.executions, profiles };
  }

  private parameterProfile(track: TuningTrack, bandit: ParameterBandit): ParameterProfile {
    let total = 0;
    for (const arm of bandit.stats(2)) {
      total += arm.pulls;
    }
    const arms = bandit.stats(Math.max(2, total));
    const phase = arms.some((arm) => arm.pulls < 1)
      ? 'learning'
      : track.experiment?.focus === bandit.parameter
        ? 'canary'
        : 'stable';
    return { parameter: bandit.parameter, current: bandit.current, arms, phase };
  }

  private frozenEntry(
    agentId: string,
    taskClass: TaskKind,
    track: TuningTrack | undefined,
    reason: string,
  ): Omit<DecisionEntry, 'seq'> {
    const parameter = track?.experiment?.focus ?? 'temperature';
    const value = this.promotedValue(track, parameter);
    return {
      timestamp: this.clock(),
      type: 'drift.frozen',
      agentId,
      taskClass,
      parameter,
      from: value,
      to: value,
      reasoning: reason,
      evidence: { executions: track?.executions ?? 0 },
    };
  }

  private releasedEntry(
    agentId: string,
    taskClass: TaskKind,
    track: TuningTrack | undefined,
  ): Omit<DecisionEntry, 'seq'> {
    const experiment = track?.experiment;
    const parameter = experiment?.focus ?? 'temperature';
    const value = this.promotedValue(track, parameter);
    return {
      timestamp: this.clock(),
      type: 'tuning.released',
      agentId,
      taskClass,
      parameter,
      from: value,
      to: value,
      reasoning:
        experiment === undefined
          ? 'tuning released: experiments may start again'
          : `tuning released: the in-flight ${parameter} experiment (candidate ` +
            `${String(experiment.candidate)}) spanned the frozen window, so it was ` +
            'abandoned and its rollout statistics reset',
      evidence: { executions: track?.executions ?? 0 },
    };
  }

  private promotedValue(track: TuningTrack | undefined, parameter: ParameterName): ParameterValue {
    const bandit = track?.bandits.get(parameter);
    if (bandit !== undefined) {
      return bandit.current;
    }
    const dimension = this.dimensions.find((entry) => entry.parameter === parameter);
    return dimension === undefined ? 0 : dimension.baseline;
  }

  private appendDecision(entry: Omit<DecisionEntry, 'seq'>): void {
    const recorded = this.log.append(entry);
    this.emit({ type: 'decision.recorded', entry: recorded });
  }

  private emit(event: TelemetryEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // Listener failures are swallowed so a misbehaving observer cannot crash
        // the engine or starve other listeners.
      }
    }
  }

  private serializeAgent(record: AgentRecord): AgentJson {
    const tracks: Record<string, TrackJson> = {};
    for (const [taskClass, track] of record.tracks) {
      tracks[taskClass] = {
        bandits: [...track.bandits.values()].map((bandit) => bandit.toJSON()),
        rollout: track.rollout.toJSON(),
        costP5: track.costP5.toJSON(),
        costP95: track.costP95.toJSON(),
        latencyP5: track.latencyP5.toJSON(),
        latencyP95: track.latencyP95.toJSON(),
        tokenP5: track.tokenP5.toJSON(),
        tokenP95: track.tokenP95.toJSON(),
        executions: track.executions,
        focusIndex: track.focusIndex,
        ...(track.experiment === undefined ? {} : { experiment: track.experiment }),
      };
    }
    return { frozen: record.frozen, tracks };
  }

  private async restore(): Promise<void> {
    if (this.backend === undefined) {
      return;
    }
    let snapshot: StateSnapshot | undefined;
    try {
      snapshot = await this.backend.load();
    } catch {
      // A backend that cannot load simply yields a fresh engine.
      return;
    }
    if (snapshot === undefined || snapshot.version !== 1) {
      return;
    }
    const agents: unknown = snapshot.agents;
    if (typeof agents !== 'object' || agents === null) {
      return;
    }
    for (const [agentId, rawAgent] of Object.entries(agents as Record<string, unknown>)) {
      if (this.trackedAgents.size >= this.maxAgents) {
        return;
      }
      if (this.trackedAgents.has(agentId)) {
        // The restore runs asynchronously after construction; agents that already
        // produced live traffic win over the snapshot.
        continue;
      }
      try {
        const record = this.restoreAgent(rawAgent);
        if (record !== undefined) {
          this.trackedAgents.set(agentId, record);
        }
      } catch {
        // Corrupt agent payloads are skipped so one bad entry cannot block startup.
      }
    }
  }

  private restoreAgent(raw: unknown): AgentRecord | undefined {
    if (typeof raw !== 'object' || raw === null) {
      return undefined;
    }
    const data = raw as { readonly frozen?: unknown; readonly tracks?: unknown };
    const record: AgentRecord = { tracks: new Map(), frozen: data.frozen === true };
    if (typeof data.tracks !== 'object' || data.tracks === null) {
      return record;
    }
    for (const [rawKind, rawTrack] of Object.entries(data.tracks as Record<string, unknown>)) {
      const taskClass = DEFAULT_TASK_KINDS.find((kind) => kind === rawKind);
      if (taskClass === undefined) {
        continue;
      }
      try {
        const track = this.restoreTrack(rawTrack);
        if (track !== undefined) {
          record.tracks.set(taskClass, track);
        }
      } catch {
        // Corrupt tracks are skipped, the pair simply starts learning from scratch.
      }
    }
    return record;
  }

  private restoreTrack(raw: unknown): TuningTrack | undefined {
    if (typeof raw !== 'object' || raw === null) {
      return undefined;
    }
    const data = raw as Partial<TrackJson>;
    if (!Array.isArray(data.bandits)) {
      return undefined;
    }
    const restoredBandits = new Map<ParameterName, ParameterBandit>();
    for (const banditJson of data.bandits) {
      const bandit = ParameterBandit.fromJSON(banditJson as ParameterBanditJson);
      restoredBandits.set(bandit.parameter, bandit);
    }
    // Reconcile with the configured space: dimensions that are now locked or inactive
    // are dropped, newly active dimensions start fresh, restored learning wins.
    const bandits = new Map<ParameterName, ParameterBandit>();
    for (const dimension of this.dimensions) {
      if (dimension.locked) {
        continue;
      }
      bandits.set(
        dimension.parameter,
        restoredBandits.get(dimension.parameter) ??
          new ParameterBandit(dimension.parameter, dimension.values, dimension.baseline),
      );
    }
    const experiment = this.restoreExperiment(data.experiment, bandits);
    const rollout =
      experiment === undefined
        ? this.createRollout()
        : SafeRollout.fromJSON(data.rollout as SafeRolloutSnapshot);
    const executions =
      typeof data.executions === 'number' &&
      Number.isInteger(data.executions) &&
      data.executions >= 0
        ? data.executions
        : 0;
    const count = this.activeParameters.length;
    const rawIndex =
      typeof data.focusIndex === 'number' &&
      Number.isInteger(data.focusIndex) &&
      data.focusIndex >= 0
        ? data.focusIndex
        : 0;
    return {
      bandits,
      rollout,
      costP5: P2Quantile.fromJSON(data.costP5 as P2QuantileJSON),
      costP95: P2Quantile.fromJSON(data.costP95 as P2QuantileJSON),
      latencyP5: P2Quantile.fromJSON(data.latencyP5 as P2QuantileJSON),
      latencyP95: P2Quantile.fromJSON(data.latencyP95 as P2QuantileJSON),
      // The token band joined the snapshot after version 1 shipped its first
      // payloads; older snapshots simply restore a fresh band and re-learn it.
      tokenP5:
        data.tokenP5 === undefined ? new P2Quantile(0.05) : P2Quantile.fromJSON(data.tokenP5),
      tokenP95:
        data.tokenP95 === undefined ? new P2Quantile(0.95) : P2Quantile.fromJSON(data.tokenP95),
      executions,
      focusIndex: count === 0 ? 0 : rawIndex % count,
      experiment,
      epoch: 0,
    };
  }

  private restoreExperiment(
    raw: unknown,
    bandits: ReadonlyMap<ParameterName, ParameterBandit>,
  ): Experiment | undefined {
    if (typeof raw !== 'object' || raw === null) {
      return undefined;
    }
    const data = raw as { readonly focus?: unknown; readonly candidate?: unknown };
    const focus = PARAMETER_ORDER.find((parameter) => parameter === data.focus);
    if (focus === undefined || !bandits.has(focus)) {
      return undefined;
    }
    const candidate = data.candidate;
    if (typeof candidate !== 'string' && typeof candidate !== 'number') {
      return undefined;
    }
    return { focus, candidate };
  }
}

/**
 * The engine core rides on the runtime object itself instead of a module-level
 * registry. The build inlines this module into every entry bundle
 * (`splitting: false`), so module-level state such as a WeakMap exists once per
 * entry: `freezeTuning` imported from one entry could never find an engine
 * created through another (or through the CJS twin of the same entry).
 * `Symbol.for` resolves to the same symbol in every copy of this module, and
 * the property is non-enumerable so spreads, JSON, and structured clones never
 * carry it, a cloned runtime still fails {@link engineOf} on purpose.
 */
const ENGINE: unique symbol = Symbol.for('@takk/noeticos:engine');

interface EngineCarrier {
  readonly [ENGINE]?: EngineCore;
}

function engineOf(runtime: NoeticOS): EngineCore {
  const core = (runtime as EngineCarrier)[ENGINE];
  if (core === undefined) {
    throw NoeticosError.invalid('runtime was not created by createNoeticOS');
  }
  return core;
}

/**
 * Creates a {@link NoeticOS} engine. See {@link NoeticOSOptions} for defaults.
 *
 * When a state backend is configured the previous snapshot is restored
 * asynchronously after construction; corrupt entries are skipped one by one so a
 * damaged snapshot can never prevent startup.
 */
export function createNoeticOS(options?: NoeticOSOptions): NoeticOS {
  const core = new EngineCore(options ?? {});
  const runtime: NoeticOS = {
    recommend: (task) => core.recommend(task),
    report: (outcome) => core.report(outcome),
    profileOf: (agentId, taskClass) => core.profileOf(agentId, taskClass),
    decisions: (filter) => core.decisions(filter),
    agents: () => core.agentIds(),
    inspect: () => core.inspect(),
    on: (listener) => core.on(listener),
    flush: () => core.flush(),
    close: () => core.close(),
  };
  Object.defineProperty(runtime, ENGINE, { value: core });
  return runtime;
}

/**
 * Pauses tuning for every task class of `agentId` on the given engine: recommend
 * serves the promoted baseline values only and no new experiment starts until
 * {@link releaseTuning} is called. The freeze is recorded as a `'drift.frozen'`
 * decision entry per known task class carrying the given reason.
 *
 * @throws NoeticosError with code `ERR_INVALID_INPUT` when `runtime` was not
 *   created by {@link createNoeticOS}.
 */
export function freezeTuning(runtime: NoeticOS, agentId: string, reason: string): void {
  engineOf(runtime).freeze(agentId, reason);
}

/**
 * Reverses {@link freezeTuning}: experiments may start again for `agentId`. Any
 * experiment that was mid-flight when the freeze hit is abandoned and its rollout
 * statistics are reset, so post-release comparisons never mix frozen-window
 * evidence into a verdict. The release is audited symmetrically with the freeze:
 * one `'tuning.released'` decision entry is appended per known task class
 * (mirroring `'drift.frozen'`), and a `'tuning.released'` telemetry event is
 * emitted. Releasing an agent that is not frozen is a no-op.
 *
 * @throws NoeticosError with code `ERR_INVALID_INPUT` when `runtime` was not
 *   created by {@link createNoeticOS}.
 */
export function releaseTuning(runtime: NoeticOS, agentId: string): void {
  engineOf(runtime).release(agentId);
}
