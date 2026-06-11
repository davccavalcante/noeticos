/**
 * Bridges between NoeticOS and its sibling packages `@takk/behavioralai`,
 * `@takk/modelchain`, and `@takk/keymesh`.
 *
 * The siblings are optional peer dependencies, so this module never imports them. Each
 * bridge talks to its sibling through a structural local interface
 * ({@link BehavioralAILike}, {@link KeymeshLike}) whose member and field names mirror the
 * published declaration files of the real packages, which means the real engine objects
 * satisfy the structural shapes as-is, no adapter and no runtime dependency.
 *
 * Shared safety theme: NoeticOS must not run canary experiments while the world around
 * the agent shifts for reasons unrelated to the parameter under test. The bridges
 * translate sibling signals about such shifts into {@link freezeTuning} and
 * {@link releaseTuning} calls, keeping every canary verdict attributable to exactly one
 * cause. All bridges expect a runtime created by `createNoeticOS`; the freeze and
 * release helpers reject foreign runtime objects.
 */

import { freezeTuning, releaseTuning } from '../core/createNoeticOS.js';
import type { NoeticOS, TaskKind } from '../types.js';

/**
 * Minimal structural view of one `@takk/behavioralai` telemetry event.
 *
 * Field names mirror the published `TelemetryEvent` declaration of `@takk/behavioralai`:
 * the discriminant is `kind` (for example `'drift.detected'` or `'drift.recovered'`),
 * and `agentId`, `severity`, and `feature` are optional context fields. Real events
 * carry more fields; the bridge needs only these.
 */
export interface BehavioralTelemetryEventLike {
  /** Event discriminant, for example `'drift.detected'` or `'drift.recovered'`. */
  readonly kind: string;
  /** Id of the observed agent, present on agent-scoped events. */
  readonly agentId?: string;
  /** Severity of a drift finding: `'info'`, `'warning'`, or `'critical'`. */
  readonly severity?: string;
  /** Behavioral feature that drifted or recovered, for example `'latencyMs'`. */
  readonly feature?: string;
}

/**
 * Structural subscription surface of a `@takk/behavioralai` engine. The published
 * `BehavioralAI` interface satisfies this shape directly.
 */
export interface BehavioralAILike {
  /** Subscribes a telemetry listener and returns its unsubscribe function. */
  on(listener: (event: BehavioralTelemetryEventLike) => void): () => void;
}

/** Options for {@link behavioralaiBridge}. */
export interface BehavioralaiBridgeOptions {
  /**
   * Release tuning automatically when the behavioral engine reports recovery for a
   * frozen agent. Defaults to true; pass false to keep the freeze until an operator
   * calls {@link releaseTuning} manually.
   */
  readonly releaseOnRecovery?: boolean;
}

/**
 * Connects a `@takk/behavioralai` engine to NoeticOS tuning: critical behavioral drift
 * freezes tuning for the drifting agent, recovery releases it.
 *
 * Contract, in terms of the published behavioralai telemetry events (discriminated by
 * `kind`):
 * - `kind === 'drift.detected'` with `severity === 'critical'` for agent X calls
 *   {@link freezeTuning} for X with a reason naming the drifted feature.
 * - `severity === 'warning'` (and `'info'`) changes nothing on purpose: tuning
 *   continues, because the rollout guardrails (quality floor checks and automatic
 *   rollback) already absorb mild degradation, and freezing on every warning would
 *   starve the bandit of the very samples it needs to keep learning.
 * - `kind === 'drift.recovered'` for agent X calls {@link releaseTuning} for X, unless
 *   `options.releaseOnRecovery` is `false`.
 * - Events without an `agentId` are ignored.
 *
 * Safety rationale: never tune while the agent is behaviorally drifting. During an
 * active drift, NoeticOS would read drift-induced reward movement as evidence about the
 * canary parameter, and the behavioral engine would read the canary's parameter change
 * as further drift, so the two engines disagree about cause and effect. Freezing the
 * agent until recovery breaks that loop and keeps both audit trails truthful.
 *
 * Returns the unsubscribe function of the underlying telemetry subscription.
 *
 * @example
 * ```ts
 * import { createBehavioralAI } from '@takk/behavioralai';
 * import { createNoeticOS } from '@takk/noeticos';
 * import { behavioralaiBridge } from '@takk/noeticos/integrations';
 *
 * const behavioral = createBehavioralAI({ sensitivity: 'balanced' });
 * const runtime = createNoeticOS();
 *
 * // The published engine satisfies BehavioralAILike structurally, no adapter needed.
 * const detach = behavioralaiBridge(runtime, behavioral, { releaseOnRecovery: true });
 *
 * // Agent loop: behavioral.observe({ agentId: 'support-agent', latencyMs: 1840 })
 * // next to runtime.recommend() and runtime.report(). A 'drift.detected' event with
 * // severity 'critical' for 'support-agent' now freezes its tuning with a reason
 * // naming the drifted feature; the matching 'drift.recovered' event releases it.
 *
 * detach(); // stop forwarding behavioral events
 * ```
 */
export function behavioralaiBridge(
  runtime: NoeticOS,
  behavioral: BehavioralAILike,
  options?: BehavioralaiBridgeOptions,
): () => void {
  const releaseOnRecovery = options?.releaseOnRecovery !== false;
  return behavioral.on((event) => {
    if (event.agentId === undefined) {
      return;
    }
    if (event.kind === 'drift.detected' && event.severity === 'critical') {
      const feature = event.feature ?? 'unattributed behavior';
      freezeTuning(
        runtime,
        event.agentId,
        `critical behavioral drift on '${feature}' reported by behavioralai: ` +
          `tuning is paused until the agent's behavior recovers`,
      );
      return;
    }
    // 'warning' and 'info' findings intentionally change nothing: tuning continues,
    // the rollout guardrails already absorb mild degradation.
    if (event.kind === 'drift.recovered' && releaseOnRecovery) {
      releaseTuning(runtime, event.agentId);
    }
  });
}

/**
 * Read-side view produced by {@link modelchainBridge}: the model the bandit currently
 * serves to the baseline cohort of one agent and task class.
 */
export interface ModelchainBridge {
  /**
   * Returns the learned model id for the pair, or `undefined` when the `model`
   * dimension is not active: no model candidates were configured, the dimension is
   * locked, or the pair has not been observed yet.
   */
  preferredModelFor(agentId: string, kind: TaskKind): string | undefined;
}

/**
 * Pure read-side bridge into `@takk/modelchain`: exposes the model id NoeticOS has
 * learned for an agent and task class so a modelchain routing strategy can prefer it.
 *
 * Contract: `preferredModelFor(agentId, kind)` looks up `runtime.profileOf(agentId,
 * kind)`, finds the `'model'` parameter profile, and returns its current promoted value
 * as a string. It returns `undefined` when the model dimension is inactive, so callers
 * can always fall back to their own routing. The bridge never subscribes, never writes,
 * and is safe to call on every request.
 *
 * @example
 * ```ts
 * import { createModelchain } from '@takk/modelchain';
 * import { createNoeticOS } from '@takk/noeticos';
 * import { modelchainBridge } from '@takk/noeticos/integrations';
 *
 * const runtime = createNoeticOS({
 *   parameters: {
 *     model: [
 *       { id: 'fast-mini', tier: 'fast' },
 *       { id: 'frontier-xl', tier: 'frontier' },
 *     ],
 *   },
 * });
 * const learned = modelchainBridge(runtime);
 *
 * // Property names below follow the published modelchain contract: models carry
 * // { id, provider, cost, keys }, a custom strategy implements { name, select },
 * // and select receives ModelSnapshot candidates and returns a model id or null.
 * const router = createModelchain({
 *   models: [
 *     {
 *       id: 'fast-mini',
 *       provider: adapter,
 *       cost: { costPer1kInput: 0.1, costPer1kOutput: 0.4 },
 *       keys: apiKey,
 *     },
 *     {
 *       id: 'frontier-xl',
 *       provider: adapter,
 *       cost: { costPer1kInput: 3, costPer1kOutput: 15 },
 *       keys: apiKey,
 *     },
 *   ],
 *   strategy: {
 *     name: 'noeticos-preferred',
 *     select: (candidates) => {
 *       const preferred = learned.preferredModelFor('support-agent', 'summarization');
 *       const hit = candidates.find((candidate) => candidate.id === preferred);
 *       return hit?.id ?? candidates[0]?.id ?? null;
 *     },
 *   },
 * });
 *
 * await router.complete({ prompt: 'Summarize the incident.', task: 'summarization' });
 * ```
 */
export function modelchainBridge(runtime: NoeticOS): ModelchainBridge {
  return {
    preferredModelFor(agentId: string, kind: TaskKind): string | undefined {
      for (const classProfile of runtime.profileOf(agentId, kind)) {
        for (const dimension of classProfile.profiles) {
          if (dimension.parameter === 'model') {
            return String(dimension.current);
          }
        }
      }
      return undefined;
    },
  };
}

/**
 * Credential lifecycle events the keymesh bridge reacts to, named exactly after the
 * published `@takk/keymesh` telemetry event types:
 *
 * - `'circuit.open'`: a key was pulled from service after consecutive failures, the
 *   operational form of a revoked or rejected credential.
 * - `'all.exhausted'`: rotation failure, every key in the pool was tried and none is
 *   eligible.
 * - `'key.rotated'`: successful rotation, traffic moved to a healthy key.
 */
export type KeymeshCredentialEventType = 'circuit.open' | 'all.exhausted' | 'key.rotated';

/** Minimal structural view of one `@takk/keymesh` telemetry event. */
export interface KeymeshEventLike {
  /** Event discriminant, for example `'circuit.open'` or `'key.rotated'`. */
  readonly type: string;
}

/**
 * Structural subscription surface of a keymesh client. The published keymesh client
 * extras (`KeymeshExtras`) satisfy this shape directly: keymesh subscribes per event
 * name and `on` returns void, unsubscription goes through `off`, so the bridge composes
 * its disposer from `off` instead of expecting an unsubscribe return value.
 */
export interface KeymeshLike {
  /** Subscribes a handler to one telemetry event type. */
  on(event: KeymeshCredentialEventType, handler: (event: KeymeshEventLike) => void): void;
  /** Removes a previously subscribed handler from one telemetry event type. */
  off(event: KeymeshCredentialEventType, handler: (event: KeymeshEventLike) => void): void;
}

/** Options for {@link keymeshBridge}. */
export interface KeymeshBridgeOptions {
  /** Agents whose tuning follows the credential pool of this keymesh client. */
  readonly agentIds: readonly string[];
}

/**
 * Connects a `@takk/keymesh` credential pool to NoeticOS tuning: while provider
 * credentials are in flux, tuning for the configured agents is frozen.
 *
 * Contract, in terms of the published keymesh telemetry event types:
 * - `'circuit.open'` (a key pulled from service, the operational form of a revoked
 *   credential) and `'all.exhausted'` (rotation failure, no eligible key left) call
 *   {@link freezeTuning} for every configured agent id with a reason naming the event
 *   type.
 * - `'key.rotated'` (successful rotation, a healthy key serves again) calls
 *   {@link releaseTuning} for the same agents.
 *
 * Why freeze: provider credentials in flux invalidate reward comparability. Latency,
 * error rate, and effective throughput shift with the credential, not with the
 * parameter under canary, so a promotion or rollback decided across a revocation or a
 * failed rotation would attribute the credential's effect to the parameter. Once a
 * rotation lands on a healthy key, comparability returns and tuning resumes.
 *
 * Returns a disposer that unsubscribes every handler the bridge registered.
 *
 * @example
 * ```ts
 * import { createKeymesh } from '@takk/keymesh';
 * import { createNoeticOS } from '@takk/noeticos';
 * import { keymeshBridge } from '@takk/noeticos/integrations';
 *
 * const client = createKeymesh({
 *   provider: adapter, // any keymesh provider adapter
 *   keys: ['key-a', 'key-b', 'key-c'],
 *   strategy: 'least-used',
 * });
 * const runtime = createNoeticOS();
 *
 * // Tuning for these agents now follows the credential pool: a key pulled from
 * // service ('circuit.open') or an exhausted pool ('all.exhausted') freezes them,
 * // a successful rotation ('key.rotated') releases them.
 * const detach = keymeshBridge(runtime, client, {
 *   agentIds: ['support-agent', 'research-agent'],
 * });
 *
 * detach(); // stop reacting to credential events
 * ```
 */
export function keymeshBridge(
  runtime: NoeticOS,
  keymesh: KeymeshLike,
  options: KeymeshBridgeOptions,
): () => void {
  const agentIds = [...options.agentIds];
  const freeze = (event: KeymeshEventLike): void => {
    for (const agentId of agentIds) {
      freezeTuning(
        runtime,
        agentId,
        `keymesh event '${event.type}': provider credentials in flux invalidate ` +
          `reward comparability, tuning is frozen until a rotation succeeds`,
      );
    }
  };
  const release = (): void => {
    for (const agentId of agentIds) {
      releaseTuning(runtime, agentId);
    }
  };
  keymesh.on('circuit.open', freeze);
  keymesh.on('all.exhausted', freeze);
  keymesh.on('key.rotated', release);
  return () => {
    keymesh.off('circuit.open', freeze);
    keymesh.off('all.exhausted', freeze);
    keymesh.off('key.rotated', release);
  };
}
