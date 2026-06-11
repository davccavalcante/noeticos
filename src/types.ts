/**
 * Single contract file for `@takk/noeticos` (NoeticOS), the JIT compiler for agents.
 *
 * NoeticOS is adaptive runtime intelligence for Massive Intelligence (IM) agents: it
 * classifies each task, learns optimal runtime parameters per task class with
 * confidence-bound bandits, applies changes only through deterministic canary rollouts
 * with automatic rollback, and records every decision with its reasoning.
 *
 * Every other module in the package imports its public shapes from this file.
 *
 * Core safety invariant:
 * NoeticOS never explores on baseline traffic. Exploration happens exclusively inside
 * the deterministic canary cohort (a `canaryShare` fraction of executions), the canary
 * differs from the baseline in exactly one parameter at a time, and every promotion or
 * rollback is recorded as an append-only {@link DecisionEntry} carrying the statistical
 * evidence that justified it.
 */

/**
 * Default task taxonomy used by the built-in classifier.
 *
 * The taxonomy is extensible in minor releases: new kinds may be added without a major
 * version bump, so exhaustive switches over this type should keep a default branch.
 * `'unknown'` is the fallback when no classifier signal fires with enough confidence.
 */
export type TaskKind =
  | 'factual-qa'
  | 'creative-writing'
  | 'code-generation'
  | 'extraction'
  | 'summarization'
  | 'translation'
  | 'planning'
  | 'tool-execution'
  | 'conversation'
  | 'classification'
  | 'unknown';

/**
 * Description of one task an agent is about to execute, the input of
 * {@link NoeticOS.recommend}.
 *
 * Only `agentId` is required. The richer the descriptor, the better the classifier and
 * the learned profiles, but NoeticOS degrades gracefully with sparse input.
 */
export interface TaskDescriptor {
  /** Stable identifier of the agent executing the task. Profiles are keyed by it. */
  readonly agentId: string;
  /**
   * Caller-asserted task kind. When given, it overrides the classifier entirely and
   * the resulting {@link Classification} reports full confidence in this kind.
   */
  readonly kind?: TaskKind;
  /**
   * Raw prompt text used only as classifier input. It is never stored: snapshots,
   * decisions, and telemetry carry aggregate statistics only.
   */
  readonly prompt?: string;
  /** Prompt length in characters, an alternative signal when `prompt` is withheld. */
  readonly promptLength?: number;
  /** Number of tools available to the agent for this task, a classifier signal. */
  readonly toolsAvailable?: number;
  /** Free-form caller metadata, treated as opaque classifier signals. */
  readonly metadata?: Readonly<Record<string, string>>;
}

/**
 * Result of classifying a {@link TaskDescriptor} into a {@link TaskKind}.
 */
export interface Classification {
  /** The chosen task kind. */
  readonly kind: TaskKind;
  /** Classifier confidence in [0, 1]. Caller-asserted kinds report 1. */
  readonly confidence: number;
  /**
   * Human-readable names of the features that fired, in firing order, for
   * explainability. Example: `['keyword:translate', 'short-prompt']`.
   */
  readonly signals: readonly string[];
}

/**
 * The tunable runtime parameter dimensions NoeticOS can learn per agent and task class.
 *
 * The dimension set is extensible in minor releases: new parameter names may be added
 * without a major version bump, so exhaustive switches over this type should keep a
 * default branch and consumers must tolerate unknown members.
 */
export type ParameterName =
  | 'model'
  | 'temperature'
  | 'topP'
  | 'maxTurns'
  | 'retryBudget'
  | 'contextShare';

/**
 * Value of a tunable parameter: a model id for the `model` dimension, a number for
 * every other dimension.
 */
export type ParameterValue = string | number;

/**
 * One model the bandit may select for the `model` parameter dimension.
 */
export interface ModelCandidate {
  /** Provider-side model identifier, passed through verbatim in recommendations. */
  readonly id: string;
  /**
   * Optional capability tier hint used for reasoning strings and tie-breaking, not for
   * reward computation.
   */
  readonly tier?: 'fast' | 'balanced' | 'frontier';
}

/**
 * The discrete search space the bandit explores, one arm list per parameter dimension.
 *
 * Defaults applied when a dimension is omitted:
 * - `temperature`: [0, 0.2, 0.4, 0.7, 1.0]
 * - `topP`: [0.9, 1.0]
 * - `maxTurns`: [8, 16, 32, 64]
 * - `retryBudget`: [0, 1, 3]
 * - `contextShare`: [0.4, 0.6, 0.8]
 *
 * The `model` dimension is inactive unless candidates are declared, there is no default
 * model list. `contextShare` is the fraction of the model context window the agent may
 * fill before NoeticOS recommends trimming.
 */
export interface ParameterSpace {
  /** Sampling temperature arms. */
  readonly temperature?: readonly number[];
  /** Nucleus sampling arms. */
  readonly topP?: readonly number[];
  /** Maximum agent loop turn arms. */
  readonly maxTurns?: readonly number[];
  /** Retry budget arms, retries allowed per execution. */
  readonly retryBudget?: readonly number[];
  /** Context window fill fraction arms, each in (0, 1]. */
  readonly contextShare?: readonly number[];
  /** Model candidates. The dimension is tuned only when this list is non-empty. */
  readonly model?: readonly ModelCandidate[];
}

/**
 * Hard constraints on the search space.
 */
export interface ParameterConstraints {
  /**
   * Parameters that are never tuned. A locked parameter is always recommended at its
   * baseline value and never enters a canary.
   */
  readonly locked?: readonly ParameterName[];
  /**
   * Overrides for the default starting arm per parameter. The baseline cohort serves
   * these values until a canary promotion replaces them.
   */
  readonly baseline?: Partial<Readonly<Record<ParameterName, ParameterValue>>>;
}

/**
 * Named objective presets resolving to fixed {@link ObjectiveWeights}.
 */
export type ObjectivePreset = 'balanced' | 'cost' | 'latency' | 'quality';

/**
 * Relative importance of the three reward terms when scoring an execution.
 *
 * Preset values (quality / cost / latency):
 * - `balanced`: 0.5 / 0.25 / 0.25
 * - `cost`: 0.35 / 0.5 / 0.15
 * - `latency`: 0.35 / 0.15 / 0.5
 * - `quality`: 0.7 / 0.15 / 0.15
 *
 * Custom weights are normalized so the three terms sum to 1.
 */
export interface ObjectiveWeights {
  /** Weight of the quality term. */
  readonly quality: number;
  /** Weight of the cost term, higher means cheaper executions are rewarded more. */
  readonly cost: number;
  /** Weight of the latency term, higher means faster executions are rewarded more. */
  readonly latency: number;
}

/**
 * Hard quality guardrails for rollouts. A canary whose observed statistics violate a
 * floor is rolled back regardless of its composite reward, and a violating arm cannot
 * be promoted.
 */
export interface QualityFloor {
  /** Minimum acceptable success rate in [0, 1] for the canary cohort. */
  readonly minSuccessRate?: number;
  /** Minimum acceptable mean quality score in [0, 1] for the canary cohort. */
  readonly minQualityScore?: number;
}

/**
 * Output of {@link NoeticOS.recommend}: the full parameter set the agent should run
 * with, plus the reasoning behind it.
 *
 * Execution flows in two phases correlated by `executionId`: the caller obtains a
 * recommendation, runs the task, then reports an {@link ExecutionOutcome} carrying the
 * same id.
 */
export interface Recommendation {
  /** Unique id correlating this recommendation with its later outcome report. */
  readonly executionId: string;
  /** Agent the recommendation was issued for. */
  readonly agentId: string;
  /** Task class the parameters were learned for. */
  readonly taskClass: TaskKind;
  /** The classification that selected `taskClass`, with confidence and signals. */
  readonly classification: Classification;
  /** Concrete parameter values to apply for this execution. */
  readonly parameters: Readonly<Partial<Record<ParameterName, ParameterValue>>>;
  /**
   * Cohort assignment. Baseline executions always receive the current stable values,
   * canary executions receive the candidate value for the single `focus` parameter.
   * The cohort set is extensible in minor releases: new cohort names may be added
   * without a major version bump, so consumers must handle unknown members with a
   * default branch.
   */
  readonly cohort: 'baseline' | 'canary';
  /**
   * The single parameter currently under canary for this agent and class. The canary
   * cohort differs from the baseline in exactly this one parameter, so any reward
   * difference is attributable to it.
   */
  readonly focus?: ParameterName;
  /** Human-readable explanation of why these parameters were chosen. */
  readonly reasoning: string;
}

/**
 * Outcome of one tool call inside an execution, used to derive the implicit quality
 * signal and to detect tool-call loops.
 */
export interface ToolCallOutcome {
  /** Tool name as invoked by the agent. */
  readonly name: string;
  /** Whether the tool call succeeded. */
  readonly ok: boolean;
  /**
   * Optional caller-computed hash of the call arguments. Repeated identical hashes for
   * the same tool indicate a loop. Raw arguments are never sent to NoeticOS.
   */
  readonly argumentsHash?: string;
}

/**
 * What actually happened during an execution, the input of {@link NoeticOS.report}.
 * All fields except `executionId` are optional, missing signals simply contribute
 * nothing to the reward.
 *
 * `qualityScore` in [0, 1] is the explicit quality signal and always wins. When it is
 * omitted, the quality term is derived implicitly:
 * 1. `error === true` or `finishReason === 'error'` yields quality 0.
 * 2. Otherwise quality starts at 1 and accumulates penalties, clamped to [0, 1]:
 *    0.35 for `finishReason === 'length'`, 0.5 for `finishReason === 'content-filter'`,
 *    0.15 when any tool call failed, and 0.1 per detected tool-call loop repeat,
 *    capped at 0.4.
 * 3. An execution with none of these signals counts as a clean completion, quality 1.
 *
 * The cost and latency terms are normalized against the running per-class statistics
 * and combined with the quality term using the active {@link ObjectiveWeights}.
 */
export interface ExecutionOutcome {
  /** Id of the {@link Recommendation} this outcome reports on. */
  readonly executionId: string;
  /** Wall-clock duration of the execution in milliseconds. */
  readonly latencyMs?: number;
  /** Total execution cost in USD. */
  readonly costUsd?: number;
  /** Input tokens consumed, a cost proxy when `costUsd` is unknown. */
  readonly inputTokens?: number;
  /** Output tokens produced, a cost proxy when `costUsd` is unknown. */
  readonly outputTokens?: number;
  /** Number of agent loop turns consumed. */
  readonly turns?: number;
  /** Per-tool-call outcomes, in call order. */
  readonly toolCalls?: readonly ToolCallOutcome[];
  /**
   * Why the final model response ended. The reason set is extensible in minor
   * releases: new reasons may be added without a major version bump, so consumers
   * must handle unknown members with a default branch (`'other'` is the catch-all
   * the built-in adapters map unrecognized provider reasons onto).
   */
  readonly finishReason?: 'stop' | 'length' | 'tool-calls' | 'content-filter' | 'error' | 'other';
  /** True when the execution failed outright. */
  readonly error?: boolean;
  /** Explicit quality signal in [0, 1], overrides the implicit derivation. */
  readonly qualityScore?: number;
  /** When the execution finished, epoch milliseconds. Defaults to the engine clock. */
  readonly timestamp?: number;
}

/**
 * Statistics of one bandit arm, one candidate value of one parameter.
 */
export interface ArmStats {
  /** The candidate parameter value this arm represents. */
  readonly value: ParameterValue;
  /** Number of executions that ran with this arm. */
  readonly pulls: number;
  /** Mean observed reward in [0, 1] across pulls. */
  readonly meanReward: number;
  /** Lower confidence bound of the mean reward. */
  readonly lowerBound: number;
  /** Upper confidence bound of the mean reward. */
  readonly upperBound: number;
}

/**
 * Learning state of a single parameter dimension for one agent and task class.
 */
export interface ParameterProfile {
  /** The parameter dimension this profile describes. */
  readonly parameter: ParameterName;
  /** The value currently served to the baseline cohort. */
  readonly current: ParameterValue;
  /** Per-arm statistics, one entry per candidate value in the space. */
  readonly arms: readonly ArmStats[];
  /**
   * Lifecycle phase: `'learning'` while arms still lack `minSamplesPerArm` canary
   * samples, `'canary'` while a candidate is being compared against the baseline,
   * `'stable'` once confidence bounds separate and a winner is locked in.
   */
  readonly phase: 'learning' | 'canary' | 'stable';
}

/**
 * Aggregate learning state for one agent and task class pair, the unit returned by
 * {@link NoeticOS.profileOf}.
 */
export interface ClassProfile {
  /** Agent the profile belongs to. */
  readonly agentId: string;
  /** Task class the profile was learned for. */
  readonly taskClass: TaskKind;
  /** Total executions observed for this pair. */
  readonly executions: number;
  /** One profile per tunable parameter dimension. */
  readonly profiles: readonly ParameterProfile[];
}

/**
 * The kinds of decisions NoeticOS records in its audit log. Every variant has an
 * emitting code path; the log never documents decisions the engine cannot make.
 *
 * - `'canary.started'`: a candidate value entered the canary cohort.
 * - `'canary.promoted'`: the candidate beat the baseline with sufficient confidence
 *   and became the new baseline value.
 * - `'canary.rolledback'`: the candidate underperformed or violated a
 *   {@link QualityFloor} and the baseline value was restored.
 * - `'drift.frozen'`: tuning was frozen for the agent (via `freezeTuning`) until
 *   statistics re-stabilize.
 * - `'tuning.released'`: a tuning freeze was lifted via `releaseTuning`; any
 *   in-flight experiment was abandoned and its rollout statistics reset.
 *
 * The union is extensible in minor releases: new decision kinds may be added without
 * a major version bump, so exhaustive switches over this type should keep a default
 * branch.
 */
export type DecisionType =
  | 'canary.started'
  | 'canary.promoted'
  | 'canary.rolledback'
  | 'drift.frozen'
  | 'tuning.released';

/**
 * One immutable entry in the append-only decision log. Entries are never edited or
 * deleted, `seq` increases monotonically per engine instance.
 */
export interface DecisionEntry {
  /** Monotonic sequence number of the entry within the engine instance. */
  readonly seq: number;
  /** When the decision was made, epoch milliseconds from the engine clock. */
  readonly timestamp: number;
  /** What kind of decision this is. */
  readonly type: DecisionType;
  /** Agent the decision applies to. */
  readonly agentId: string;
  /** Task class the decision applies to. */
  readonly taskClass: TaskKind;
  /** Parameter dimension the decision changed or evaluated. */
  readonly parameter: ParameterName;
  /** Value in effect before the decision. */
  readonly from: ParameterValue;
  /** Value in effect after the decision. */
  readonly to: ParameterValue;
  /** Human-readable explanation of why the decision was taken. */
  readonly reasoning: string;
  /**
   * The numeric statistics that justified the decision, for example mean rewards,
   * confidence bounds, and sample counts of the arms involved.
   */
  readonly evidence: Readonly<Record<string, number>>;
}

/**
 * Discriminated union of every event NoeticOS emits, discriminated on `type`.
 *
 * - `'recommendation.issued'`: a recommendation left {@link NoeticOS.recommend}.
 * - `'outcome.recorded'`: an outcome was matched to its recommendation and scored.
 * - `'decision.recorded'`: an entry was appended to the decision log.
 * - `'loop.detected'`: the same tool was called repeatedly with identical arguments.
 * - `'limit.reached'`: a capacity limit (`maxAgents` or `maxPendingExecutions`) was
 *   hit and the corresponding record was dropped or evicted.
 * - `'tuning.released'`: a tuning freeze was lifted via `releaseTuning`; any
 *   experiment that was mid-flight when the freeze hit was abandoned so
 *   post-release comparisons start from clean statistics.
 *
 * The union is extensible in minor releases: new event variants may be added without
 * a major version bump, so exhaustive switches over `type` should keep a default
 * branch.
 */
export type TelemetryEvent =
  | {
      readonly type: 'recommendation.issued';
      readonly recommendation: Recommendation;
      readonly timestamp: number;
    }
  | {
      readonly type: 'outcome.recorded';
      readonly executionId: string;
      readonly agentId: string;
      readonly taskClass: TaskKind;
      readonly reward: number;
      readonly timestamp: number;
    }
  | {
      readonly type: 'decision.recorded';
      readonly entry: DecisionEntry;
    }
  | {
      readonly type: 'loop.detected';
      readonly executionId: string;
      readonly agentId: string;
      readonly repeats: number;
      readonly toolName: string;
      readonly timestamp: number;
    }
  | {
      readonly type: 'limit.reached';
      readonly scope: 'agents' | 'pending';
      readonly detail: string;
      readonly timestamp: number;
    }
  | {
      readonly type: 'tuning.released';
      readonly agentId: string;
      readonly timestamp: number;
    };

/**
 * Subscriber for {@link TelemetryEvent}s. Listeners are invoked synchronously, a
 * listener that throws is caught and ignored so it cannot crash the engine.
 */
export type TelemetryListener = (event: TelemetryEvent) => void;

/**
 * Serialized learned state, the unit exchanged with a {@link StateBackend}.
 *
 * The `agents` payload is opaque to consumers and contains aggregate statistics only,
 * arm counts, mean rewards, confidence bounds, and decision metadata. Prompt content,
 * tool arguments, and any other raw task material are never written to a snapshot.
 */
export interface StateSnapshot {
  /** Snapshot schema version. Version 1 is the only version in the 1.x line. */
  readonly version: 1;
  /** When the snapshot was produced, epoch milliseconds from the engine clock. */
  readonly savedAt: number;
  /** Opaque per-agent learned state, keyed by agent id. */
  readonly agents: Readonly<Record<string, unknown>>;
}

/**
 * Persistence adapter for learned state. The engine treats persistence as best-effort:
 * a failing backend never breaks recommendation traffic.
 */
export interface StateBackend {
  /** Loads the last snapshot, or `undefined` when none exists yet. */
  load(): Promise<StateSnapshot | undefined>;
  /** Persists a snapshot, replacing any previous one. */
  save(snapshot: StateSnapshot): Promise<void>;
}

/**
 * Construction options for the NoeticOS engine.
 *
 * Defaults:
 * - `objective`: `'balanced'`
 * - `canaryShare`: 0.1
 * - `minSamplesPerArm`: 8
 * - `promotionConfidence`: 0.95
 * - `seed`: 7
 * - `maxAgents`: 1000
 * - `maxPendingExecutions`: 10000
 * - `clock`: the platform wall clock
 */
export interface NoeticOSOptions {
  /** Objective preset name or explicit weights. Custom weights are normalized. */
  readonly objective?: ObjectivePreset | ObjectiveWeights;
  /** Search space overrides, see {@link ParameterSpace} for per-dimension defaults. */
  readonly parameters?: ParameterSpace;
  /** Locked parameters and baseline value overrides. */
  readonly constraints?: ParameterConstraints;
  /** Hard quality guardrails enforced on every canary. */
  readonly qualityFloor?: QualityFloor;
  /** Fraction of executions assigned to the canary cohort, in [0, 1]. Default 0.1. */
  readonly canaryShare?: number;
  /** Minimum canary samples per arm before a promotion is considered. Default 8. */
  readonly minSamplesPerArm?: number;
  /**
   * Confidence level required for a canary promotion, the candidate lower bound must
   * exceed the baseline upper bound at this level. Default 0.95.
   */
  readonly promotionConfidence?: number;
  /** Seed for the deterministic PRNG driving cohort assignment. Default 7. */
  readonly seed?: number;
  /** Maximum number of tracked agents before eviction. Default 1000. */
  readonly maxAgents?: number;
  /** Maximum unreported recommendations kept in memory. Default 10000. */
  readonly maxPendingExecutions?: number;
  /** Optional persistence backend. Without it, learned state is in-memory only. */
  readonly state?: StateBackend;
  /**
   * Injectable time source returning epoch milliseconds, used for audit and telemetry
   * timestamps. Defaults to the platform wall clock, inject a fake in tests.
   */
  readonly clock?: () => number;
}

/**
 * The NoeticOS engine, the runtime that learns and serves per-agent, per-class
 * parameter profiles under the canary safety invariant documented at the top of this
 * module.
 */
export interface NoeticOS {
  /**
   * Classifies the task, assigns a cohort deterministically, and returns the full
   * parameter set the agent should run with. Synchronous and allocation-light, safe
   * on the hot path.
   */
  recommend(task: TaskDescriptor): Recommendation;
  /**
   * Reports what happened for a previously issued recommendation. The outcome is
   * scored into a reward and fed to the bandit of the matching agent and class.
   * Unknown execution ids are ignored.
   */
  report(outcome: ExecutionOutcome): void;
  /**
   * Returns the learned profiles for an agent, optionally narrowed to one task class.
   * The returned structures are immutable snapshots.
   */
  profileOf(agentId: string, taskClass?: TaskKind): readonly ClassProfile[];
  /**
   * Returns decision log entries, newest last, optionally filtered by agent and
   * truncated to `limit` most recent entries.
   */
  decisions(filter?: { agentId?: string; limit?: number }): readonly DecisionEntry[];
  /** Returns the ids of all tracked agents. */
  agents(): readonly string[];
  /** Returns an aggregate view of the engine state for dashboards and debugging. */
  inspect(): RuntimeSnapshot;
  /** Subscribes a telemetry listener and returns its unsubscribe function. */
  on(listener: TelemetryListener): () => void;
  /** Forces a save of the current learned state to the configured backend, if any. */
  flush(): Promise<void>;
  /** Flushes state, detaches listeners, and releases resources. Idempotent. */
  close(): Promise<void>;
}

/**
 * Aggregate view of a running engine returned by {@link NoeticOS.inspect}.
 */
export interface RuntimeSnapshot {
  /** Every learned agent and class profile currently in memory. */
  readonly agents: readonly ClassProfile[];
  /** Total decision log entries recorded. */
  readonly decisions: number;
  /** Recommendations issued and not yet reported. */
  readonly pendingExecutions: number;
}
