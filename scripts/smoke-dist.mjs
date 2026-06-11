/**
 * Dist module-graph smoke. Run after `pnpm build` (wired into `pnpm verify`
 * and CI); it imports the built artifacts, not src.
 *
 * The build inlines the core module into every entry bundle
 * (`splitting: false` in tsup.config.ts), so each of dist/index.js,
 * dist/integrations/index.js, dist/web/index.js, dist/edge/index.js, and
 * each CJS twin, carries its own copy of the engine-lookup code. Engine
 * lookup must therefore never depend on module-level state: a WeakMap
 * registry here once made `freezeTuning` imported from one entry throw
 * ERR_INVALID_INPUT ("runtime was not created by createNoeticOS") on engines
 * created through another. The src test suite imports everything in one
 * module graph and can never catch that class of bug; this script crosses
 * the real bundle boundaries a consumer crosses.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

import * as edge from '../dist/edge/index.js';
import { createNoeticOS, freezeTuning, releaseTuning } from '../dist/index.js';
import { behavioralaiBridge, keymeshBridge } from '../dist/integrations/index.js';
import * as web from '../dist/web/index.js';

const require = createRequire(import.meta.url);
const cjs = require('../dist/index.cjs');

const agentId = 'smoke-agent';

function frozenCount(runtime) {
  return runtime.decisions({ agentId }).filter((entry) => entry.type === 'drift.frozen').length;
}

/**
 * Asserts that `freeze(runtime)` lands as a new drift.frozen decision on an
 * engine created by a different bundle copy, then releases so the next case
 * starts unfrozen (freeze is a no-op while already frozen).
 */
function expectFreezeAcrossBundles(runtime, freeze, release, label) {
  const before = frozenCount(runtime);
  freeze();
  assert.ok(frozenCount(runtime) > before, `${label}: freeze did not reach the engine`);
  release();
}

// Engine from the main ESM entry, with traffic so a real task class exists.
const runtime = createNoeticOS({ seed: 7 });
for (let i = 0; i < 5; i += 1) {
  const recommendation = runtime.recommend({ agentId, kind: 'summarization' });
  runtime.report({ executionId: recommendation.executionId, qualityScore: 0.8 });
}

// dist/integrations: both bridges call the freezeTuning copy inlined into
// their own bundle against the engine created by dist/index.js.
const behavioralListeners = new Set();
const behavioral = {
  on(listener) {
    behavioralListeners.add(listener);
    return () => behavioralListeners.delete(listener);
  },
  emit(event) {
    for (const listener of behavioralListeners) {
      listener(event);
    }
  },
};
const detachBehavioral = behavioralaiBridge(runtime, behavioral, { releaseOnRecovery: true });
expectFreezeAcrossBundles(
  runtime,
  () => behavioral.emit({ kind: 'drift.detected', agentId, severity: 'critical', feature: 'latencyMs' }),
  () => behavioral.emit({ kind: 'drift.recovered', agentId }),
  'behavioralaiBridge from dist/integrations on a dist/index.js engine',
);
detachBehavioral();

const keymeshHandlers = new Map();
const keymesh = {
  on(event, handler) {
    const set = keymeshHandlers.get(event) ?? new Set();
    set.add(handler);
    keymeshHandlers.set(event, set);
  },
  off(event, handler) {
    keymeshHandlers.get(event)?.delete(handler);
  },
  emit(event) {
    for (const handler of keymeshHandlers.get(event) ?? []) {
      handler({ type: event });
    }
  },
};
const detachKeymesh = keymeshBridge(runtime, keymesh, { agentIds: [agentId] });
expectFreezeAcrossBundles(
  runtime,
  () => keymesh.emit('circuit.open'),
  () => keymesh.emit('key.rotated'),
  'keymeshBridge from dist/integrations on a dist/index.js engine',
);
detachKeymesh();

// dist/web and dist/edge re-export freezeTuning from their own core copies.
expectFreezeAcrossBundles(
  runtime,
  () => web.freezeTuning(runtime, agentId, 'smoke: frozen from dist/web'),
  () => web.releaseTuning(runtime, agentId),
  'freezeTuning from dist/web on a dist/index.js engine',
);
expectFreezeAcrossBundles(
  runtime,
  () => edge.freezeTuning(runtime, agentId, 'smoke: frozen from dist/edge'),
  () => edge.releaseTuning(runtime, agentId),
  'freezeTuning from dist/edge on a dist/index.js engine',
);

// The CJS twin is a separate bundle even with code splitting, so cross-format
// engines must work in both directions.
expectFreezeAcrossBundles(
  runtime,
  () => cjs.freezeTuning(runtime, agentId, 'smoke: frozen from dist/index.cjs'),
  () => cjs.releaseTuning(runtime, agentId),
  'freezeTuning from dist/index.cjs on a dist/index.js engine',
);
const cjsRuntime = cjs.createNoeticOS({ seed: 7 });
expectFreezeAcrossBundles(
  cjsRuntime,
  () => freezeTuning(cjsRuntime, agentId, 'smoke: frozen from dist/index.js'),
  () => releaseTuning(cjsRuntime, agentId),
  'freezeTuning from dist/index.js on a dist/index.cjs engine',
);

// The guard itself must survive the fix: objects that are not engines,
// including shallow clones, which drop the non-enumerable attachment, are
// still rejected with ERR_INVALID_INPUT.
for (const foreign of [{}, { ...runtime }]) {
  assert.throws(
    () => freezeTuning(foreign, agentId, 'must be rejected'),
    (error) => error instanceof Error && error.code === 'ERR_INVALID_INPUT',
    'freezeTuning must reject objects not created by createNoeticOS',
  );
}

await runtime.close();
await cjsRuntime.close();
console.log(
  'dist smoke ok: freezeTuning/releaseTuning reach engines across bundle copies ' +
    '(integrations, web, edge, ESM<->CJS) and still reject foreign runtimes',
);
