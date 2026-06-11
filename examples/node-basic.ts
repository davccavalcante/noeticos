/**
 * node-basic: the minimal NoeticOS integration, the two-phase loop.
 *
 * Phase 1: `recommend(task)` returns the parameters the agent should run with.
 * Phase 2: `report(outcome)` tells the engine what happened, under the same
 * `executionId`, and the bandits learn from it.
 *
 * This example simulates a small agent so it runs offline and deterministically:
 * the synthetic workload rewards low temperature for factual answering, which the
 * engine discovers through canary experiments and promotes on evidence.
 *
 * Run (in a project with @takk/noeticos installed): node --import tsx node-basic.ts
 */

import { createNoeticOS } from '@takk/noeticos';
import type { Recommendation } from '@takk/noeticos';

/** Deterministic stand-in for a real agent run: quality degrades with temperature. */
function runFakeAgent(recommendation: Recommendation): {
  latencyMs: number;
  costUsd: number;
  turns: number;
  qualityScore: number;
} {
  const temperature =
    typeof recommendation.parameters.temperature === 'number'
      ? recommendation.parameters.temperature
      : 0.4;
  return {
    latencyMs: 800 + Math.round(temperature * 400),
    costUsd: 0.002,
    turns: 3,
    qualityScore: Math.max(0, Math.min(1, 0.95 - temperature * 0.3)),
  };
}

async function main(): Promise<void> {
  // Objective presets: 'balanced' | 'cost' | 'latency' | 'quality'.
  // 'cost' weighs quality/cost/latency at 0.35/0.5/0.15.
  const runtime = createNoeticOS({ objective: 'cost', seed: 7 });

  // Watch every decision the engine records, with its evidence.
  const unsubscribe = runtime.on((event) => {
    if (event.type === 'decision.recorded') {
      const entry = event.entry;
      console.log(
        `[decision] ${entry.type} ${entry.taskClass} ${entry.parameter}: ` +
          `${String(entry.from)} -> ${String(entry.to)} (${entry.reasoning})`,
      );
    }
  });

  for (let i = 0; i < 400; i += 1) {
    // Phase 1: ask. Passing `kind` skips the classifier; passing `prompt`
    // instead lets the engine classify (the prompt is never stored).
    const recommendation = runtime.recommend({
      agentId: 'support-agent',
      kind: 'factual-qa',
    });

    const result = runFakeAgent(recommendation);

    // Phase 2: report under the same executionId. Every field except the id is
    // optional; missing signals simply contribute nothing to the reward.
    runtime.report({
      executionId: recommendation.executionId,
      latencyMs: result.latencyMs,
      costUsd: result.costUsd,
      turns: result.turns,
      finishReason: 'stop',
      qualityScore: result.qualityScore,
    });
  }
  unsubscribe();

  // What did the engine learn for this agent and task class?
  for (const profile of runtime.profileOf('support-agent', 'factual-qa')) {
    console.log(`\nprofile ${profile.agentId}/${profile.taskClass} (${profile.executions} executions)`);
    for (const dimension of profile.profiles) {
      console.log(`  ${dimension.parameter}: current=${String(dimension.current)} phase=${dimension.phase}`);
    }
  }

  // The append-only audit trail, newest last.
  const decisions = runtime.decisions({ agentId: 'support-agent', limit: 5 });
  console.log(`\nlast ${decisions.length} decisions:`);
  for (const entry of decisions) {
    console.log(`  #${entry.seq} ${entry.type} ${entry.parameter} ${String(entry.from)} -> ${String(entry.to)}`);
  }

  await runtime.close();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
