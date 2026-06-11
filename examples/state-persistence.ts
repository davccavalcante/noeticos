/**
 * state-persistence: learned state surviving a process restart via fileState.
 *
 * The first engine learns from traffic and flushes a StateSnapshot to disk; a
 * second engine constructed on the same path restores the learned profiles and
 * continues where the first one stopped.
 *
 * Snapshot facts worth knowing:
 * - Saves are atomic: the snapshot is written to `path + '.tmp'`, then renamed.
 * - StateSnapshot version 1 carries aggregate statistics only (arm counts, mean
 *   rewards, confidence bounds, quantile markers). Prompt content is never
 *   serialized; there is nothing sensitive to encrypt in the file by design.
 * - Persistence is best-effort: a failing backend never breaks recommendations.
 * - Restore is asynchronous after construction; `flush()` awaits it, which makes
 *   `await engine.flush()` the simplest way to wait for the restore to finish.
 *
 * Run (in a project with @takk/noeticos installed): node --import tsx state-persistence.ts
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNoeticOS, fileState } from '@takk/noeticos';

async function main(): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'noeticos-example-'));
  const statePath = join(dir, 'noeticos-state.json');

  // Engine 1: learn something, then persist and close.
  const first = createNoeticOS({ seed: 7, state: fileState({ path: statePath }) });
  for (let i = 0; i < 60; i += 1) {
    const rec = first.recommend({ agentId: 'support-agent', kind: 'extraction' });
    const maxTurns = typeof rec.parameters.maxTurns === 'number' ? rec.parameters.maxTurns : 32;
    first.report({
      executionId: rec.executionId,
      latencyMs: 250 * maxTurns, // the workload pays per turn
      costUsd: 0.0005 * maxTurns,
      finishReason: 'stop',
      qualityScore: 0.9,
    });
  }
  const before = first.profileOf('support-agent', 'extraction');
  console.log('executions learned by engine 1:', before[0]?.executions ?? 0);
  await first.close(); // close() flushes the snapshot to disk

  // The file on disk is a single JSON document with aggregate statistics only.
  const raw = await readFile(statePath, 'utf8');
  const snapshot = JSON.parse(raw) as { version: number; savedAt: number };
  console.log('snapshot version on disk:', snapshot.version);

  // Engine 2: same path, fresh process in real life. The snapshot is restored
  // asynchronously after construction; flush() awaits that restore.
  const second = createNoeticOS({ seed: 7, state: fileState({ path: statePath }) });
  await second.flush();

  const restored = second.profileOf('support-agent', 'extraction');
  console.log('executions restored by engine 2:', restored[0]?.executions ?? 0);
  for (const dimension of restored[0]?.profiles ?? []) {
    console.log(
      `  restored ${dimension.parameter}: current=${String(dimension.current)} phase=${dimension.phase}`,
    );
  }

  await second.close();
  await rm(dir, { recursive: true, force: true });
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
