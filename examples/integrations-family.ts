/**
 * integrations-family: all three sibling bridges wired against one engine.
 *
 * Route with @takk/modelchain, rotate with @takk/keymesh, observe with
 * @takk/behavioralai, tune with NoeticOS. Every bridge is structural: the
 * siblings are optional peer dependencies, nothing is imported from them at
 * runtime, and the published engine objects satisfy the local interfaces as-is.
 *
 * With the real siblings installed the wiring is identical, only the fakes
 * below are replaced by real engines (types shown for reference):
 *
 * ```ts
 * import { createBehavioralAI } from '@takk/behavioralai';
 * import { createKeymesh } from '@takk/keymesh';
 * import { createModelchain } from '@takk/modelchain';
 * ```
 *
 * This example uses structural fakes so it runs with zero extra installs.
 *
 * Run (in a project with @takk/noeticos installed): node --import tsx integrations-family.ts
 */

import { createNoeticOS } from '@takk/noeticos';
import {
  behavioralaiBridge,
  keymeshBridge,
  modelchainBridge,
} from '@takk/noeticos/integrations';
import type {
  BehavioralAILike,
  BehavioralTelemetryEventLike,
  KeymeshCredentialEventType,
  KeymeshEventLike,
  KeymeshLike,
} from '@takk/noeticos/integrations';

/** Structural fake of the observability sibling's telemetry surface. */
class FakeBehavioral implements BehavioralAILike {
  private readonly listeners = new Set<(event: BehavioralTelemetryEventLike) => void>();

  on(listener: (event: BehavioralTelemetryEventLike) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  emit(event: BehavioralTelemetryEventLike): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}

/** Structural fake of the keymesh client extras: per-event-name on/off. */
class FakeKeymesh implements KeymeshLike {
  private readonly handlers = new Map<
    KeymeshCredentialEventType,
    Set<(event: KeymeshEventLike) => void>
  >();

  on(event: KeymeshCredentialEventType, handler: (event: KeymeshEventLike) => void): void {
    const set = this.handlers.get(event) ?? new Set();
    set.add(handler);
    this.handlers.set(event, set);
  }

  off(event: KeymeshCredentialEventType, handler: (event: KeymeshEventLike) => void): void {
    this.handlers.get(event)?.delete(handler);
  }

  emit(event: KeymeshCredentialEventType): void {
    for (const handler of this.handlers.get(event) ?? []) {
      handler({ type: event });
    }
  }
}

async function main(): Promise<void> {
  // Declare model candidates so the model dimension is active; the bandit only
  // tunes the model when candidates exist.
  const runtime = createNoeticOS({
    seed: 7,
    objective: 'cost',
    parameters: {
      model: [
        { id: 'fast-mini', tier: 'fast' },
        { id: 'frontier-xl', tier: 'frontier' },
      ],
    },
  });

  // Bridge 1: behavioral observability. Critical drift freezes tuning for the
  // drifting agent (warnings intentionally change nothing); recovery releases it.
  const behavioral = new FakeBehavioral();
  const detachBehavioral = behavioralaiBridge(runtime, behavioral, { releaseOnRecovery: true });

  // Bridge 2: credential lifecycle. A key pulled from service or an exhausted
  // pool invalidates reward comparability, so tuning freezes until a rotation lands.
  const keymesh = new FakeKeymesh();
  const detachKeymesh = keymeshBridge(runtime, keymesh, { agentIds: ['support-agent'] });

  // Bridge 3: model routing, pure read side.
  const learned = modelchainBridge(runtime);

  // Generate some traffic so profiles exist.
  for (let i = 0; i < 50; i += 1) {
    const rec = runtime.recommend({ agentId: 'support-agent', kind: 'summarization' });
    runtime.report({
      executionId: rec.executionId,
      latencyMs: 900,
      costUsd: rec.parameters.model === 'fast-mini' ? 0.001 : 0.004,
      finishReason: 'stop',
      qualityScore: 0.85,
    });
  }

  // The learned model preference, ready to feed into a routing strategy.
  // Returns undefined whenever the model dimension is inactive, so routing
  // always has its own fallback.
  console.log('preferred model:', learned.preferredModelFor('support-agent', 'summarization'));

  // Simulate a critical drift finding: tuning freezes, recorded as drift.frozen.
  behavioral.emit({
    kind: 'drift.detected',
    agentId: 'support-agent',
    severity: 'critical',
    feature: 'latencyMs',
  });
  const frozen = runtime
    .decisions({ agentId: 'support-agent' })
    .filter((entry) => entry.type === 'drift.frozen');
  console.log('drift.frozen entries after critical drift:', frozen.length);

  // Recovery releases tuning automatically (releaseOnRecovery defaults to true).
  behavioral.emit({ kind: 'drift.recovered', agentId: 'support-agent' });

  // Credential events drive the same freeze/release mechanics.
  keymesh.emit('circuit.open'); // freeze: a key was pulled from service
  keymesh.emit('key.rotated'); // release: a healthy key serves again

  detachBehavioral();
  detachKeymesh();
  await runtime.close();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
