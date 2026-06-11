/**
 * `noeticos inspect`: human-readable view of a saved state snapshot.
 *
 * Loads the snapshot through the same file backend the engine uses, hydrates a
 * throwaway engine from it behind a write-blocking backend (saves are dropped, so the
 * file on disk is never touched), and prints the learned profiles. StateSnapshot
 * version 1 does not persist the decision log, so for snapshots produced by the 1.x
 * engine the per-class decision section is empty and prints `(none)`.
 */

import { createNoeticOS } from '../core/createNoeticOS.js';
import { fileState } from '../state/file.js';
import type { DecisionEntry, NoeticOS, StateSnapshot, TaskKind } from '../types.js';
import { parseArgs } from './args.js';

const SHOWN_DECISIONS = 5;

function fail(message: string): number {
  process.stderr.write(`noeticos inspect: ${message}\n`);
  return 2;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function lastDecisions(
  engine: NoeticOS,
  agentId: string,
  taskClass: TaskKind,
): readonly DecisionEntry[] {
  const entries = engine.decisions({ agentId }).filter((entry) => entry.taskClass === taskClass);
  return entries.slice(-SHOWN_DECISIONS);
}

/** Runs the inspect command and returns the process exit code. */
export async function runInspect(argv: readonly string[]): Promise<number> {
  const { positional, flags } = parseArgs(argv);
  const unexpected = positional[0];
  if (unexpected !== undefined) {
    return fail(`unexpected argument "${unexpected}"`);
  }
  for (const name of flags.keys()) {
    if (name !== 'state') {
      return fail(`unknown flag "--${name}"`);
    }
  }
  const statePath = flags.get('state');
  if (typeof statePath !== 'string' || statePath === '') {
    return fail('flag --state <path> is required');
  }

  let snapshot: StateSnapshot | undefined;
  try {
    snapshot = await fileState({ path: statePath }).load();
  } catch (error) {
    process.stderr.write(`noeticos inspect: ${describe(error)}\n`);
    return 1;
  }
  if (snapshot === undefined) {
    process.stdout.write(`no state found at ${statePath}\n`);
    return 0;
  }

  const loaded = snapshot;
  const engine = createNoeticOS({
    clock: () => loaded.savedAt,
    state: {
      load: () => Promise.resolve(loaded),
      // Read-only hydration: the engine flush goes nowhere, the file stays intact.
      save: () => Promise.resolve(),
    },
  });
  // flush waits for the asynchronous restore to finish; the save above is a no-op.
  await engine.flush();

  const lines: string[] = [];
  const savedAt = Number.isFinite(loaded.savedAt)
    ? new Date(loaded.savedAt).toISOString()
    : 'unknown';
  lines.push(`saved: ${savedAt}`);
  const agentIds = engine.agents();
  lines.push(`agents: ${agentIds.length}`);
  for (const agentId of agentIds) {
    for (const profile of engine.profileOf(agentId)) {
      lines.push('');
      lines.push(`agent ${agentId} / ${profile.taskClass}`);
      lines.push(`  executions: ${profile.executions}`);
      for (const parameter of profile.profiles) {
        const current = String(parameter.current);
        lines.push(`  ${parameter.parameter}: current=${current} phase=${parameter.phase}`);
      }
      lines.push('  last decisions:');
      const recent = lastDecisions(engine, agentId, profile.taskClass);
      if (recent.length === 0) {
        lines.push('    (none)');
      } else {
        for (const entry of recent) {
          const from = String(entry.from);
          const to = String(entry.to);
          lines.push(`    #${entry.seq} ${entry.type} ${entry.parameter} ${from} -> ${to}`);
        }
      }
    }
  }
  await engine.close();
  process.stdout.write(`${lines.join('\n')}\n`);
  return 0;
}
