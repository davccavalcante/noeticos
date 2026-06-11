/**
 * Integration tests for the sibling-package bridges, driven by fake in-memory emitters
 * that satisfy the structural bridge shapes, plus a compile-time proof that the
 * published declaration types of `@takk/behavioralai`, `@takk/keymesh`, and
 * `@takk/modelchain` satisfy those shapes as-is.
 */

import type { BehavioralAI } from '@takk/behavioralai';
import type { KeymeshExtras } from '@takk/keymesh';
import type { ModelchainRouter, ModelSnapshot, RoutingStrategy } from '@takk/modelchain';
import { describe, expect, it } from 'vitest';
import type { NoeticOS, TaskKind } from '../../src/index.js';
import { createNoeticOS } from '../../src/index.js';
import type {
  BehavioralAILike,
  BehavioralTelemetryEventLike,
  KeymeshCredentialEventType,
  KeymeshEventLike,
  KeymeshLike,
  ModelchainBridge,
} from '../../src/integrations/index.js';
import {
  behavioralaiBridge,
  keymeshBridge,
  modelchainBridge,
} from '../../src/integrations/index.js';

function must<T>(value: T | undefined, label: string): T {
  if (value === undefined) {
    throw new Error(`expected ${label} to be defined`);
  }
  return value;
}

interface FakeBehavioral extends BehavioralAILike {
  emit(event: BehavioralTelemetryEventLike): void;
  listenerCount(): number;
}

function createFakeBehavioral(): FakeBehavioral {
  const listeners = new Set<(event: BehavioralTelemetryEventLike) => void>();
  return {
    on(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    emit(event) {
      for (const listener of [...listeners]) {
        listener(event);
      }
    },
    listenerCount() {
      return listeners.size;
    },
  };
}

interface FakeKeymesh extends KeymeshLike {
  emit(type: KeymeshCredentialEventType): void;
  handlerCount(type: KeymeshCredentialEventType): number;
}

function createFakeKeymesh(): FakeKeymesh {
  const handlers = new Map<KeymeshCredentialEventType, Set<(event: KeymeshEventLike) => void>>();
  const bucketOf = (type: KeymeshCredentialEventType): Set<(event: KeymeshEventLike) => void> => {
    const existing = handlers.get(type);
    if (existing !== undefined) {
      return existing;
    }
    const created = new Set<(event: KeymeshEventLike) => void>();
    handlers.set(type, created);
    return created;
  };
  return {
    on(event, handler) {
      bucketOf(event).add(handler);
    },
    off(event, handler) {
      bucketOf(event).delete(handler);
    },
    emit(type) {
      for (const handler of [...bucketOf(type)]) {
        handler({ type });
      }
    },
    handlerCount(type) {
      return bucketOf(type).size;
    },
  };
}

/** Engine with a canary share high enough that frozen tuning is observable quickly. */
function createEngine(): NoeticOS {
  return createNoeticOS({ clock: () => 0, seed: 7, canaryShare: 0.5 });
}

function warm(engine: NoeticOS, agentId: string, kind: TaskKind, cycles: number): void {
  for (let cycle = 0; cycle < cycles; cycle += 1) {
    const recommendation = engine.recommend({ agentId, kind });
    engine.report({
      executionId: recommendation.executionId,
      qualityScore: 0.7 + (cycle % 2 === 0 ? 0.02 : -0.02),
    });
  }
}

function canaryWithin(
  engine: NoeticOS,
  agentId: string,
  kind: TaskKind,
  attempts: number,
): boolean {
  for (let cycle = 0; cycle < attempts; cycle += 1) {
    if (engine.recommend({ agentId, kind }).cohort === 'canary') {
      return true;
    }
  }
  return false;
}

function allBaseline(engine: NoeticOS, agentId: string, kind: TaskKind, attempts: number): boolean {
  for (let cycle = 0; cycle < attempts; cycle += 1) {
    if (engine.recommend({ agentId, kind }).cohort !== 'baseline') {
      return false;
    }
  }
  return true;
}

function frozenDecisionsOf(engine: NoeticOS, agentId: string): readonly string[] {
  return engine
    .decisions({ agentId })
    .filter((entry) => entry.type === 'drift.frozen')
    .map((entry) => entry.reasoning);
}

describe('behavioralaiBridge', () => {
  it('freezes tuning on critical drift and records the feature in the reasoning', () => {
    const engine = createEngine();
    const behavioral = createFakeBehavioral();
    behavioralaiBridge(engine, behavioral);
    warm(engine, 'support-agent', 'planning', 10);

    behavioral.emit({
      kind: 'drift.detected',
      agentId: 'support-agent',
      severity: 'critical',
      feature: 'latencyMs',
    });

    expect(allBaseline(engine, 'support-agent', 'planning', 100)).toBe(true);
    const reasons = frozenDecisionsOf(engine, 'support-agent');
    expect(reasons.length).toBeGreaterThanOrEqual(1);
    expect(must(reasons[0], 'frozen reasoning')).toContain('latencyMs');
  });

  it('ignores warning severity and events without an agent id', () => {
    const engine = createEngine();
    const behavioral = createFakeBehavioral();
    behavioralaiBridge(engine, behavioral);
    warm(engine, 'support-agent', 'planning', 10);

    behavioral.emit({
      kind: 'drift.detected',
      agentId: 'support-agent',
      severity: 'warning',
      feature: 'costUsd',
    });
    behavioral.emit({ kind: 'drift.detected', severity: 'critical', feature: 'errorRate' });

    expect(frozenDecisionsOf(engine, 'support-agent')).toEqual([]);
    expect(canaryWithin(engine, 'support-agent', 'planning', 100)).toBe(true);
  });

  it('releases tuning when the agent recovers', () => {
    const engine = createEngine();
    const behavioral = createFakeBehavioral();
    behavioralaiBridge(engine, behavioral);
    warm(engine, 'support-agent', 'planning', 10);

    behavioral.emit({
      kind: 'drift.detected',
      agentId: 'support-agent',
      severity: 'critical',
      feature: 'toolFailureRate',
    });
    expect(allBaseline(engine, 'support-agent', 'planning', 50)).toBe(true);

    behavioral.emit({ kind: 'drift.recovered', agentId: 'support-agent' });
    expect(canaryWithin(engine, 'support-agent', 'planning', 200)).toBe(true);
  });

  it('stops reacting once the returned unsubscribe runs', () => {
    const engine = createEngine();
    const behavioral = createFakeBehavioral();
    const detach = behavioralaiBridge(engine, behavioral);
    warm(engine, 'support-agent', 'planning', 10);

    expect(behavioral.listenerCount()).toBe(1);
    detach();
    expect(behavioral.listenerCount()).toBe(0);

    behavioral.emit({
      kind: 'drift.detected',
      agentId: 'support-agent',
      severity: 'critical',
      feature: 'latencyMs',
    });
    expect(frozenDecisionsOf(engine, 'support-agent')).toEqual([]);
    expect(canaryWithin(engine, 'support-agent', 'planning', 100)).toBe(true);
  });
});

describe('keymeshBridge', () => {
  const agentIds = ['agent-a', 'agent-b'] as const;

  function warmBoth(engine: NoeticOS): void {
    for (const agentId of agentIds) {
      warm(engine, agentId, 'planning', 10);
    }
  }

  it('freezes every configured agent when a circuit opens', () => {
    const engine = createEngine();
    const keymesh = createFakeKeymesh();
    keymeshBridge(engine, keymesh, { agentIds: [...agentIds] });
    warmBoth(engine);

    keymesh.emit('circuit.open');

    for (const agentId of agentIds) {
      expect(allBaseline(engine, agentId, 'planning', 50)).toBe(true);
      const reasons = frozenDecisionsOf(engine, agentId);
      expect(reasons.length).toBeGreaterThanOrEqual(1);
      expect(must(reasons[0], 'frozen reasoning')).toContain('circuit.open');
    }
  });

  it('freezes every configured agent when the key pool is exhausted', () => {
    const engine = createEngine();
    const keymesh = createFakeKeymesh();
    keymeshBridge(engine, keymesh, { agentIds: [...agentIds] });
    warmBoth(engine);

    keymesh.emit('all.exhausted');

    for (const agentId of agentIds) {
      expect(allBaseline(engine, agentId, 'planning', 50)).toBe(true);
      expect(must(frozenDecisionsOf(engine, agentId)[0], 'frozen reasoning')).toContain(
        'all.exhausted',
      );
    }
  });

  it('releases every configured agent when a rotation lands on a healthy key', () => {
    const engine = createEngine();
    const keymesh = createFakeKeymesh();
    keymeshBridge(engine, keymesh, { agentIds: [...agentIds] });
    warmBoth(engine);

    keymesh.emit('circuit.open');
    for (const agentId of agentIds) {
      expect(allBaseline(engine, agentId, 'planning', 50)).toBe(true);
    }

    keymesh.emit('key.rotated');
    for (const agentId of agentIds) {
      expect(canaryWithin(engine, agentId, 'planning', 200)).toBe(true);
    }
  });

  it('unsubscribes every handler through the returned disposer', () => {
    const engine = createEngine();
    const keymesh = createFakeKeymesh();
    const detach = keymeshBridge(engine, keymesh, { agentIds: [...agentIds] });
    warmBoth(engine);

    expect(keymesh.handlerCount('circuit.open')).toBe(1);
    expect(keymesh.handlerCount('all.exhausted')).toBe(1);
    expect(keymesh.handlerCount('key.rotated')).toBe(1);
    detach();
    expect(keymesh.handlerCount('circuit.open')).toBe(0);
    expect(keymesh.handlerCount('all.exhausted')).toBe(0);
    expect(keymesh.handlerCount('key.rotated')).toBe(0);

    keymesh.emit('circuit.open');
    expect(frozenDecisionsOf(engine, 'agent-a')).toEqual([]);
    expect(canaryWithin(engine, 'agent-a', 'planning', 100)).toBe(true);
  });
});

describe('modelchainBridge', () => {
  it('returns undefined while the model dimension is inactive', () => {
    const withoutCandidates = createEngine();
    const bridge = modelchainBridge(withoutCandidates);
    expect(bridge.preferredModelFor('router-agent', 'summarization')).toBeUndefined();
    warm(withoutCandidates, 'router-agent', 'summarization', 3);
    expect(bridge.preferredModelFor('router-agent', 'summarization')).toBeUndefined();

    const locked = createNoeticOS({
      clock: () => 0,
      seed: 7,
      parameters: { model: [{ id: 'fast-mini' }, { id: 'frontier-xl' }] },
      constraints: { locked: ['model'] },
    });
    const lockedBridge = modelchainBridge(locked);
    warm(locked, 'router-agent', 'summarization', 3);
    expect(lockedBridge.preferredModelFor('router-agent', 'summarization')).toBeUndefined();
  });

  it('surfaces the promoted model id once a candidate dominates the reward', () => {
    const engine = createNoeticOS({
      clock: () => 0,
      seed: 7,
      canaryShare: 0.5,
      minSamplesPerArm: 5,
      parameters: {
        model: [
          { id: 'fast-mini', tier: 'fast' },
          { id: 'frontier-xl', tier: 'frontier' },
        ],
      },
    });
    const bridge = modelchainBridge(engine);

    expect(bridge.preferredModelFor('router-agent', 'summarization')).toBeUndefined();
    warm(engine, 'router-agent', 'summarization', 1);
    expect(bridge.preferredModelFor('router-agent', 'summarization')).toBe('fast-mini');
    expect(bridge.preferredModelFor('router-agent', 'translation')).toBeUndefined();

    for (let cycle = 0; cycle < 200; cycle += 1) {
      const recommendation = engine.recommend({ agentId: 'router-agent', kind: 'summarization' });
      const quality =
        (recommendation.parameters.model === 'frontier-xl' ? 0.9 : 0.3) +
        (cycle % 2 === 0 ? 0.02 : -0.02);
      engine.report({ executionId: recommendation.executionId, qualityScore: quality });
    }

    const promotions = engine
      .decisions({ agentId: 'router-agent' })
      .filter((entry) => entry.type === 'canary.promoted' && entry.parameter === 'model');
    expect(promotions.length).toBeGreaterThanOrEqual(1);
    expect(must(promotions[0], 'model promotion').to).toBe('frontier-xl');
    expect(bridge.preferredModelFor('router-agent', 'summarization')).toBe('frontier-xl');

    const profile = must(engine.profileOf('router-agent', 'summarization')[0], 'profile');
    const modelProfile = must(
      profile.profiles.find((dimension) => dimension.parameter === 'model'),
      'model profile',
    );
    expect(bridge.preferredModelFor('router-agent', 'summarization')).toBe(
      String(modelProfile.current),
    );
  });
});

declare const publishedBehavioralEngine: BehavioralAI;
declare const publishedKeymeshClient: { readonly chat: unknown } & KeymeshExtras;
declare const publishedRouter: ModelchainRouter;

/**
 * Compile-time satisfaction proof, never invoked at runtime: the published declaration
 * types of the sibling packages must remain assignable to the structural bridge shapes,
 * and the bridge read side must keep plugging into a modelchain routing strategy. If a
 * sibling release breaks the structural contract, tsc fails this file in CI.
 */
function publishedTypesSatisfyBridgeShapes(bridge: ModelchainBridge): {
  behavioral: BehavioralAILike;
  keymesh: KeymeshLike;
  router: ModelchainRouter;
  strategy: RoutingStrategy;
} {
  const strategy: RoutingStrategy = {
    name: 'noeticos-preferred',
    select: (candidates: readonly ModelSnapshot[]): string | null => {
      const preferred = bridge.preferredModelFor('support-agent', 'summarization');
      const hit = candidates.find((candidate) => candidate.id === preferred);
      return hit === undefined ? null : hit.id;
    },
  };
  return {
    behavioral: publishedBehavioralEngine,
    keymesh: publishedKeymeshClient,
    router: publishedRouter,
    strategy,
  };
}

describe('published sibling types', () => {
  it('satisfy the structural bridge shapes at compile time', () => {
    expect(typeof publishedTypesSatisfyBridgeShapes).toBe('function');
  });
});
