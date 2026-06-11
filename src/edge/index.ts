/**
 * Edge runtime entry point (Cloudflare Workers, Vercel Edge, Deno, Bun): the full
 * NoeticOS surface except `fileState`, the Node file backend, so edge bundles never
 * advertise an export that needs `node:fs`. The lists below are explicit on purpose,
 * a wildcard re-export would silently leak future Node-only exports into edge builds.
 */

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
  RewardContext,
  RuntimeSnapshot,
  StateBackend,
  StateSnapshot,
  TaskDescriptor,
  TaskKind,
  TelemetryEvent,
  TelemetryListener,
  ToolCallOutcome,
} from '../index.js';
export {
  computeReward,
  createNoeticOS,
  DEFAULT_PARAMETER_SPACE,
  DEFAULT_TASK_KINDS,
  freezeTuning,
  memoryState,
  NoeticosError,
  OBJECTIVE_PRESETS,
  releaseTuning,
  resolveWeights,
  TaskClassifier,
} from '../index.js';
