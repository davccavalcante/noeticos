/**
 * Unit tests for src/audit/DecisionLog and the src/state backends.
 */

import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DecisionLog } from '../../src/audit/DecisionLog.js';
import { NoeticosError } from '../../src/errors.js';
import { fileState } from '../../src/state/file.js';
import { memoryState } from '../../src/state/memory.js';
import type { DecisionEntry, StateSnapshot } from '../../src/types.js';

const draft = (agentId: string, reasoning = 'because'): Omit<DecisionEntry, 'seq'> => ({
  timestamp: 1718000000000,
  type: 'canary.started',
  agentId,
  taskClass: 'factual-qa',
  parameter: 'temperature',
  from: 0.4,
  to: 0.7,
  reasoning,
  evidence: { meanCanary: 0.8 },
});

const sampleSnapshot = (): StateSnapshot => ({
  version: 1,
  savedAt: 1718000000000,
  agents: { 'agent-a': { bandits: [{ value: 0.4, pulls: 3 }] } },
});

const rejectionOf = async (promise: Promise<unknown>): Promise<unknown> =>
  promise.then(
    () => {
      throw new Error('expected the promise to reject');
    },
    (cause: unknown) => cause,
  );

const tempDirs: string[] = [];

const makeTempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'noeticos-unit-'));
  tempDirs.push(dir);
  return dir;
};

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe('DecisionLog', () => {
  it('starts seq at 1 and increments per append', () => {
    const log = new DecisionLog();
    const first = log.append(draft('agent-a'));
    const second = log.append(draft('agent-a'));
    expect(first.seq).toBe(1);
    expect(second.seq).toBe(2);
    expect(log.totalAppended).toBe(2);
    expect(log.size).toBe(2);
  });

  it('freezes entries so mutation throws in strict mode', () => {
    const log = new DecisionLog();
    const entry = log.append(draft('agent-a', 'original'));
    expect(Object.isFrozen(entry)).toBe(true);
    expect(() => {
      (entry as unknown as { reasoning: string }).reasoning = 'tampered';
    }).toThrow(TypeError);
    expect(entry.reasoning).toBe('original');
  });

  it('evicts the oldest entries beyond capacity while seq keeps counting', () => {
    const log = new DecisionLog(3);
    for (let i = 1; i <= 5; i += 1) {
      log.append(draft('agent-a', `entry ${i}`));
    }
    expect(log.size).toBe(3);
    expect(log.totalAppended).toBe(5);
    expect(log.list().map((entry) => entry.seq)).toEqual([3, 4, 5]);
    expect(log.append(draft('agent-a')).seq).toBe(6);
    expect(log.list().map((entry) => entry.seq)).toEqual([4, 5, 6]);
    expect(log.totalAppended).toBe(6);
  });

  it('filters by agentId and limits to the most recent N in chronological order', () => {
    const log = new DecisionLog();
    log.append(draft('agent-a'));
    log.append(draft('agent-b'));
    log.append(draft('agent-a'));
    log.append(draft('agent-b'));
    log.append(draft('agent-a'));
    expect(log.list().map((entry) => entry.seq)).toEqual([1, 2, 3, 4, 5]);
    const filtered = log.list({ agentId: 'agent-a' });
    expect(filtered.map((entry) => entry.seq)).toEqual([1, 3, 5]);
    expect(filtered.every((entry) => entry.agentId === 'agent-a')).toBe(true);
    expect(log.list({ agentId: 'agent-a', limit: 2 }).map((entry) => entry.seq)).toEqual([3, 5]);
    expect(log.list({ limit: 2 }).map((entry) => entry.seq)).toEqual([4, 5]);
  });

  it('preserves the seq counter across toJSON/fromJSON and never reuses numbers', () => {
    const log = new DecisionLog(2);
    for (let i = 0; i < 4; i += 1) {
      log.append(draft('agent-a'));
    }
    const restored = DecisionLog.fromJSON(structuredClone(log.toJSON()), 2);
    expect(restored.totalAppended).toBe(4);
    expect(restored.list().map((entry) => entry.seq)).toEqual([3, 4]);
    expect(restored.list().every((entry) => Object.isFrozen(entry))).toBe(true);
    expect(restored.append(draft('agent-a')).seq).toBe(5);

    // The counter dominates restored entry seqs even when the serialized counter lags.
    const crafted = DecisionLog.fromJSON({
      seq: 1,
      entries: [{ ...draft('agent-x'), seq: 7 }],
    });
    expect(crafted.append(draft('agent-x')).seq).toBe(8);
  });
});

describe('memoryState', () => {
  it('resolves undefined before any save', async () => {
    await expect(memoryState().load()).resolves.toBeUndefined();
  });

  it('roundtrips the latest snapshot', async () => {
    const backend = memoryState();
    const snapshot = sampleSnapshot();
    await backend.save(snapshot);
    await expect(backend.load()).resolves.toEqual(snapshot);
    const replacement: StateSnapshot = { version: 1, savedAt: 1718000001000, agents: {} };
    await backend.save(replacement);
    await expect(backend.load()).resolves.toEqual(replacement);
  });
});

describe('fileState', () => {
  it('saves atomically, creating parents and leaving no .tmp file behind', async () => {
    const dir = makeTempDir();
    const path = join(dir, 'nested', 'state.json');
    await fileState({ path }).save(sampleSnapshot());
    expect(existsSync(path)).toBe(true);
    expect(existsSync(`${path}.tmp`)).toBe(false);
    expect(readdirSync(join(dir, 'nested'))).toEqual(['state.json']);
  });

  it('roundtrips a saved snapshot through load', async () => {
    const dir = makeTempDir();
    const backend = fileState({ path: join(dir, 'state.json') });
    const snapshot = sampleSnapshot();
    await backend.save(snapshot);
    await expect(backend.load()).resolves.toEqual(snapshot);
  });

  it('resolves undefined when the file does not exist', async () => {
    const dir = makeTempDir();
    await expect(fileState({ path: join(dir, 'absent.json') }).load()).resolves.toBeUndefined();
  });

  it('rejects corrupted JSON with ERR_STATE_LOAD', async () => {
    const dir = makeTempDir();
    const path = join(dir, 'state.json');
    writeFileSync(path, '{"version": 1, "agents": ', 'utf8');
    const error = await rejectionOf(fileState({ path }).load());
    expect(error).toBeInstanceOf(NoeticosError);
    expect(error).toMatchObject({ code: 'ERR_STATE_LOAD' });
  });

  it('rejects unsupported or missing snapshot versions with ERR_STATE_VERSION', async () => {
    const dir = makeTempDir();
    const wrongVersion = join(dir, 'wrong-version.json');
    writeFileSync(wrongVersion, JSON.stringify({ version: 2, savedAt: 1, agents: {} }), 'utf8');
    const versionError = await rejectionOf(fileState({ path: wrongVersion }).load());
    expect(versionError).toBeInstanceOf(NoeticosError);
    expect(versionError).toMatchObject({ code: 'ERR_STATE_VERSION' });

    const missingVersion = join(dir, 'missing-version.json');
    writeFileSync(missingVersion, JSON.stringify({ savedAt: 1, agents: {} }), 'utf8');
    const missingError = await rejectionOf(fileState({ path: missingVersion }).load());
    expect(missingError).toBeInstanceOf(NoeticosError);
    expect(missingError).toMatchObject({ code: 'ERR_STATE_VERSION' });
  });
});
