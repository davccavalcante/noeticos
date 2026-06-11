import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { beforeAll, describe, expect, it, vi } from 'vitest';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const execFileAsync = promisify(execFile);

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

/**
 * Cross-bundle parity against the BUILT artifact.
 *
 * The build inlines shared modules into every entry bundle (splitting: false),
 * so module-level state exists once per bundle: a WeakMap registry in the core
 * module would make freezeTuning and the bridges from one entry unable to
 * recognize an engine created through another entry, while every test that
 * imports from src (single module graph) stays green. The engine therefore
 * carries its core on the runtime object under Symbol.for, which resolves to
 * the same symbol in every copy of the module. This suite builds dist/ and
 * proves the contract on the harshest combination, ESM core plus CJS
 * integrations, so the bug class can never ship again.
 */
describe('dist parity (cross-bundle internals)', () => {
  beforeAll(async () => {
    await execFileAsync(join(ROOT, 'node_modules', '.bin', 'tsup'), [], { cwd: ROOT });
  });

  it('freezes tuning through a bridge imported from a different built entry', async () => {
    const core = (await import(
      pathToFileURL(join(ROOT, 'dist', 'index.js')).href
    )) as typeof import('../../src/index.js');
    const require = createRequire(import.meta.url);
    const integrations = require(
      join(ROOT, 'dist', 'integrations', 'index.cjs'),
    ) as typeof import('../../src/integrations/index.js');

    const runtime = core.createNoeticOS({ seed: 7, clock: () => 0 });
    runtime.recommend({ agentId: 'agent-a', kind: 'factual-qa' });

    let handler:
      | ((event: { kind: string; agentId?: string; severity?: string }) => void)
      | undefined;
    const fakeBehavioral = {
      on(listener: (event: { kind: string; agentId?: string; severity?: string }) => void) {
        handler = listener;
        return () => {
          handler = undefined;
        };
      },
    };
    const off = integrations.behavioralaiBridge(runtime, fakeBehavioral);
    expect(handler).toBeDefined();
    handler?.({ kind: 'drift.detected', agentId: 'agent-a', severity: 'critical' });

    const frozen = runtime.decisions().filter((entry) => entry.type === 'drift.frozen');
    expect(frozen.length).toBeGreaterThan(0);
    off();
  });

  it('rejects a foreign object through a built entry with ERR_INVALID_INPUT', async () => {
    const core = (await import(
      pathToFileURL(join(ROOT, 'dist', 'index.js')).href
    )) as typeof import('../../src/index.js');
    const fake = { decisions: () => [] } as unknown as import('../../src/types.js').NoeticOS;
    expect(() => core.freezeTuning(fake, 'agent-x', 'reason')).toThrowError(
      expect.objectContaining({ code: 'ERR_INVALID_INPUT' }),
    );
  });
});
