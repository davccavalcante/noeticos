/**
 * Public surface of `@takk/noeticos` (NoeticOS), adaptive runtime intelligence for
 * Massive Intelligence (IM) agents. Everything exported here is covered by the
 * SemVer stability promise of the 1.x line.
 */

export { DEFAULT_PARAMETER_SPACE } from './bandit/defaults.js';
export type { RewardContext } from './bandit/reward.js';
export { computeReward, OBJECTIVE_PRESETS, resolveWeights } from './bandit/reward.js';
export { DEFAULT_TASK_KINDS, TaskClassifier } from './classify/TaskClassifier.js';
export { createNoeticOS, freezeTuning, releaseTuning } from './core/createNoeticOS.js';
export { NoeticosError } from './errors.js';
export { fileState } from './state/file.js';
export { memoryState } from './state/memory.js';
export type {
  ArmStats,
  Classification,
  ClassProfile,
  DecisionEntry,
  DecisionType,
  ExecutionOutcome,
  ModelCandidate,
  NoeticOS,
  NoeticOSOptions,
  ObjectivePreset,
  ObjectiveWeights,
  ParameterConstraints,
  ParameterName,
  ParameterProfile,
  ParameterSpace,
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
} from './types.js';
