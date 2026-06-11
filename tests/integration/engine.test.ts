/**
 * End-to-end integration tests for the NoeticOS engine built by createNoeticOS.
 *
 * Every engine here runs with an injected zero clock and the fixed seed 7, so each
 * scenario, including the 500-cycle safety invariant run, is fully deterministic.
 */

import { describe, expect, it } from 'vitest';
import type {
  NoeticOS,
  ParameterName,
  ParameterValue,
  Recommendation,
  TaskKind,
  TelemetryEvent,
} from '../../src/index.js';
import {
  createNoeticOS,
  freezeTuning,
  memoryState,
  NoeticosError,
  releaseTuning,
} from '../../src/index.js';

/** Active dimensions of the default parameter space, the model dimension is inactive. */
const ACTIVE_DEFAULT_PARAMETERS: readonly ParameterName[] = [
  'temperature',
  'topP',
  'maxTurns',
  'retryBudget',
  'contextShare',
];

/** Documented default starting arm per dimension, the middle arm of each default list. */
const DEFAULT_BASELINE: ReadonlyMap<ParameterName, ParameterValue> = new Map<
  ParameterName,
  ParameterValue
>([
  ['temperature', 0.4],
  ['topP', 1],
  ['maxTurns', 32],
  ['retryBudget', 1],
  ['contextShare', 0.6],
]);

function must<T>(value: T | undefined, label: string): T {
  if (value === undefined) {
    throw new Error(`expected ${label} to be defined`);
  }
  return value;
}

function eventsOf<T extends TelemetryEvent['type']>(
  events: readonly TelemetryEvent[],
  type: T,
): Array<Extract<TelemetryEvent, { type: T }>> {
  return events.filter(
    (event): event is Extract<TelemetryEvent, { type: T }> => event.type === type,
  );
}

/**
 * The set of values the baseline cohort must receive right now: the engine defaults
 * before the first recommendation creates the track, the learned promoted values after.
 */
function promotedOf(
  engine: NoeticOS,
  agentId: string,
  kind: TaskKind,
): Map<ParameterName, ParameterValue> {
  const promoted = new Map(DEFAULT_BASELINE);
  const profile = engine.profileOf(agentId, kind)[0];
  if (profile !== undefined) {
    for (const dimension of profile.profiles) {
      promoted.set(dimension.parameter, dimension.current);
    }
  }
  return promoted;
}

/** Names of promoted parameters whose recommended value differs from the promoted one. */
function diffsAgainst(
  promoted: ReadonlyMap<ParameterName, ParameterValue>,
  recommendation: Recommendation,
): ParameterName[] {
  const diffs: ParameterName[] = [];
  for (const [parameter, value] of promoted) {
    if (recommendation.parameters[parameter] !== value) {
      diffs.push(parameter);
    }
  }
  return diffs;
}

/**
 * Deterministic synthetic outcome model: temperature 0 and maxTurns 8 are planted
 * optima, and the cycle parity adds a fixed jitter so reward variance stays positive
 * and the promotion t-test can resolve.
 */
function syntheticQuality(parameters: Recommendation['parameters'], cycle: number): number {
  let quality = 0.55;
  if (parameters.temperature === 0) {
    quality += 0.3;
  }
  if (parameters.maxTurns === 8) {
    quality += 0.1;
  }
  return quality + (cycle % 2 === 0 ? 0.02 : -0.02);
}

describe('two-phase execution flow', () => {
  it('issues a complete recommendation and report clears the pending execution', () => {
    const engine = createNoeticOS({ clock: () => 0, seed: 7 });
    const recommendation = engine.recommend({
      agentId: 'flow-agent',
      prompt: 'Summarize the incident report in three key points',
    });

    expect(recommendation.executionId).toMatch(/^nx-/);
    expect(recommendation.agentId).toBe('flow-agent');
    expect(recommendation.taskClass).toBe('summarization');
    expect(Object.keys(recommendation.parameters).sort()).toEqual(
      [...ACTIVE_DEFAULT_PARAMETERS].sort(),
    );
    expect(['baseline', 'canary']).toContain(recommendation.cohort);
    expect(recommendation.classification.kind).toBe(recommendation.taskClass);
    expect(recommendation.classification.signals.length).toBeGreaterThan(0);
    expect(recommendation.classification.confidence).toBeGreaterThan(0);
    expect(recommendation.classification.confidence).toBeLessThanOrEqual(1);

    expect(engine.inspect().pendingExecutions).toBe(1);
    engine.report({ executionId: recommendation.executionId, latencyMs: 120, qualityScore: 0.9 });
    expect(engine.inspect().pendingExecutions).toBe(0);
    expect(must(engine.profileOf('flow-agent', 'summarization')[0], 'profile').executions).toBe(1);
  });

  it('silently ignores reports carrying an unknown execution id', () => {
    const engine = createNoeticOS({ clock: () => 0, seed: 7 });
    const recommendation = engine.recommend({ agentId: 'flow-agent', kind: 'planning' });
    engine.report({ executionId: recommendation.executionId, qualityScore: 0.8 });
    const executionsBefore = must(
      engine.profileOf('flow-agent', 'planning')[0],
      'profile',
    ).executions;

    expect(() => {
      engine.report({ executionId: 'nx-999-doesnotexist', qualityScore: 0 });
    }).not.toThrow();

    expect(must(engine.profileOf('flow-agent', 'planning')[0], 'profile').executions).toBe(
      executionsBefore,
    );
    expect(engine.inspect().pendingExecutions).toBe(0);
  });
});

describe('classification routing', () => {
  it('lets an explicit kind override the classifier entirely', () => {
    const engine = createNoeticOS({ clock: () => 0, seed: 7 });
    const recommendation = engine.recommend({
      agentId: 'routing-agent',
      kind: 'translation',
      prompt: 'Refactor this TypeScript function:\n```\nfunction add(a, b) { return a + b; }\n```',
    });
    expect(recommendation.taskClass).toBe('translation');
    expect(recommendation.classification.confidence).toBe(1);
    expect(recommendation.classification.signals).toEqual(['explicit-kind']);
  });

  it('routes prompts through the task classifier when no kind is asserted', () => {
    const engine = createNoeticOS({ clock: () => 0, seed: 7 });
    const recommendation = engine.recommend({
      agentId: 'routing-agent',
      prompt: 'Refactor this TypeScript function:\n```\nfunction add(a, b) { return a + b; }\n```',
    });
    expect(recommendation.taskClass).toBe('code-generation');
    expect(recommendation.classification.signals).toContain('code-fence');
  });
});

describe('constraints', () => {
  it('locked parameters never appear in profiles, canaries, or decisions', () => {
    const engine = createNoeticOS({
      clock: () => 0,
      seed: 7,
      canaryShare: 0.5,
      constraints: { locked: ['temperature'] },
    });
    for (let cycle = 0; cycle < 50; cycle += 1) {
      const recommendation = engine.recommend({ agentId: 'locked-agent', kind: 'planning' });
      expect(recommendation.parameters.temperature).toBe(0.4);
      expect(recommendation.focus).not.toBe('temperature');
      engine.report({
        executionId: recommendation.executionId,
        qualityScore: 0.7 + (cycle % 2 === 0 ? 0.02 : -0.02),
      });
    }
    const profile = must(engine.profileOf('locked-agent', 'planning')[0], 'profile');
    expect(profile.profiles.map((dimension) => dimension.parameter)).not.toContain('temperature');
    const decisions = engine.decisions({ agentId: 'locked-agent' });
    expect(decisions.length).toBeGreaterThan(0);
    expect(decisions.every((entry) => entry.parameter !== 'temperature')).toBe(true);
  });

  it('baseline overrides set the starting current value of a dimension', () => {
    const engine = createNoeticOS({
      clock: () => 0,
      seed: 7,
      constraints: { baseline: { temperature: 1, maxTurns: 8 } },
    });
    engine.recommend({ agentId: 'baseline-agent', kind: 'extraction' });
    const profile = must(engine.profileOf('baseline-agent', 'extraction')[0], 'profile');
    const currentOf = (parameter: ParameterName): ParameterValue =>
      must(
        profile.profiles.find((dimension) => dimension.parameter === parameter),
        `${parameter} profile`,
      ).current;
    expect(currentOf('temperature')).toBe(1);
    expect(currentOf('maxTurns')).toBe(8);
    expect(currentOf('topP')).toBe(1);
  });
});

describe('safety invariant', () => {
  it('baseline always equals the promoted set and a canary differs in exactly the focus', () => {
    const agentId = 'safety-agent';
    const kind: TaskKind = 'summarization';
    const engine = createNoeticOS({
      clock: () => 0,
      seed: 7,
      canaryShare: 0.3,
      minSamplesPerArm: 4,
    });

    const violations: string[] = [];
    let canaries = 0;
    let baselines = 0;
    for (let cycle = 0; cycle < 500; cycle += 1) {
      const promoted = promotedOf(engine, agentId, kind);
      const recommendation = engine.recommend({ agentId, kind });
      if (Object.keys(recommendation.parameters).length !== promoted.size) {
        violations.push(`cycle ${cycle}: recommendation does not carry every active dimension`);
      }
      const diffs = diffsAgainst(promoted, recommendation);
      if (recommendation.cohort === 'baseline') {
        baselines += 1;
        if (diffs.length !== 0) {
          violations.push(
            `cycle ${cycle}: baseline cohort diverged from promoted on ${diffs.join(', ')}`,
          );
        }
      } else {
        canaries += 1;
        if (diffs.length !== 1) {
          violations.push(
            `cycle ${cycle}: canary changed ${diffs.length} parameters (${diffs.join(', ')})`,
          );
        } else if (diffs[0] !== recommendation.focus) {
          violations.push(
            `cycle ${cycle}: canary changed ${String(diffs[0])} but focus is ` +
              `${String(recommendation.focus)}`,
          );
        }
      }
      engine.report({
        executionId: recommendation.executionId,
        qualityScore: syntheticQuality(recommendation.parameters, cycle),
      });
    }

    expect(violations).toEqual([]);
    expect(canaries).toBeGreaterThan(0);
    expect(baselines).toBeGreaterThan(0);
    expect(canaries + baselines).toBe(500);

    // The run is not vacuous: the promoted set changed mid-run through real promotions
    // and learning converged onto the planted temperature optimum.
    const promotions = engine
      .decisions({ agentId })
      .filter((entry) => entry.type === 'canary.promoted');
    expect(promotions.length).toBeGreaterThanOrEqual(1);
    expect(promotedOf(engine, agentId, kind).get('temperature')).toBe(0);
  });
});

describe('freezeTuning and releaseTuning', () => {
  it('freeze stops canaries and decisions, release resumes exploration', () => {
    const agentId = 'freeze-agent';
    const engine = createNoeticOS({ clock: () => 0, seed: 7, canaryShare: 0.5 });
    for (let cycle = 0; cycle < 20; cycle += 1) {
      const recommendation = engine.recommend({ agentId, kind: 'planning' });
      engine.report({
        executionId: recommendation.executionId,
        qualityScore: 0.7 + (cycle % 2 === 0 ? 0.02 : -0.02),
      });
    }

    freezeTuning(engine, agentId, 'maintenance window');
    const frozenDecisions = engine
      .decisions({ agentId })
      .filter((entry) => entry.type === 'drift.frozen');
    expect(frozenDecisions.length).toBeGreaterThanOrEqual(1);
    expect(must(frozenDecisions[0], 'frozen decision').reasoning).toBe('maintenance window');

    const canaryStartsBefore = engine
      .decisions({ agentId })
      .filter((entry) => entry.type === 'canary.started').length;
    for (let cycle = 0; cycle < 100; cycle += 1) {
      expect(engine.recommend({ agentId, kind: 'planning' }).cohort).toBe('baseline');
    }
    const canaryStartsAfter = engine
      .decisions({ agentId })
      .filter((entry) => entry.type === 'canary.started').length;
    expect(canaryStartsAfter).toBe(canaryStartsBefore);

    const events: TelemetryEvent[] = [];
    engine.on((event) => {
      events.push(event);
    });
    releaseTuning(engine, agentId);
    // The release is audited symmetrically with the freeze: a 'tuning.released'
    // decision entry per known task class plus the telemetry event, and any
    // experiment that was mid-flight when the freeze hit is abandoned.
    const released = eventsOf(events, 'tuning.released');
    expect(released.length).toBe(1);
    expect(must(released[0], 'release event').agentId).toBe(agentId);
    const releasedDecisions = engine
      .decisions({ agentId })
      .filter((entry) => entry.type === 'tuning.released');
    expect(releasedDecisions.length).toBe(1);
    expect(must(releasedDecisions[0], 'release decision').taskClass).toBe('planning');
    expect(must(releasedDecisions[0], 'release decision').reasoning).toContain('tuning released');
    // Releasing an agent that is not frozen is a no-op: no second entry appears.
    releaseTuning(engine, agentId);
    expect(
      engine.decisions({ agentId }).filter((entry) => entry.type === 'tuning.released').length,
    ).toBe(1);
    let canarySeen = false;
    for (let cycle = 0; cycle < 200 && !canarySeen; cycle += 1) {
      canarySeen = engine.recommend({ agentId, kind: 'planning' }).cohort === 'canary';
    }
    expect(canarySeen).toBe(true);
  });

  it('quarantines frozen-window outcomes so they cannot contaminate post-release verdicts', () => {
    // Council P1 reconstruction (freeze contamination): on a FLAT landscape every
    // promotion is a false positive. 50 anomalous baseline outcomes (quality 0.1)
    // arrive while the agent is frozen; before the fix they were still recorded
    // into the live experiment's baseline side, so after release the unchanged
    // canary was compared against a contaminated baseline and promoted. The fix
    // skips rollout and bandit recording while frozen AND resets the rollout on
    // release, so the run must end with zero promotions.
    const agentId = 'freeze-contamination-agent';
    const engine = createNoeticOS({
      clock: () => 0,
      seed: 7,
      canaryShare: 0.3,
      minSamplesPerArm: 4,
    });
    // Seeded local mulberry32 stream (never the global RNG): iid flat quality in
    // [0.78, 0.82] for both cohorts, so no in-sample cohort difference is real.
    let noiseState = 2026 >>> 0;
    const uniform = (): number => {
      noiseState = (noiseState + 0x6d2b79f5) >>> 0;
      let t = noiseState;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t = (t + Math.imul(t ^ (t >>> 7), t | 61)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const runOne = (quality: number): void => {
      const recommendation = engine.recommend({ agentId, kind: 'planning' });
      engine.report({ executionId: recommendation.executionId, qualityScore: quality });
    };
    for (let cycle = 0; cycle < 40; cycle += 1) {
      runOne(0.78 + 0.04 * uniform());
    }
    freezeTuning(engine, agentId, 'anomaly window');
    for (let i = 0; i < 50; i += 1) {
      runOne(0.1);
    }
    releaseTuning(engine, agentId);
    for (let i = 0; i < 2000; i += 1) {
      runOne(0.78 + 0.04 * uniform());
    }
    const promotions = engine
      .decisions({ agentId })
      .filter((entry) => entry.type === 'canary.promoted');
    expect(promotions).toEqual([]);
  });
});

describe('token cost proxy', () => {
  it('token-only outcomes move the cost term away from neutral: the cheaper arm wins', () => {
    // Council P1 reconstruction (token cost truth): inputTokens and outputTokens
    // are documented as the cost proxy when costUsd is unknown, but the reward
    // path never read them, so token-only reporters (the middleware path) scored a
    // neutral 0.5 cost forever. Two arms with identical quality and latency where
    // one burns 4x the tokens must separate on the cost term alone.
    const agentId = 'token-cost-agent';
    const engine = createNoeticOS({
      clock: () => 0,
      seed: 7,
      canaryShare: 0.5,
      minSamplesPerArm: 4,
      objective: 'cost',
      parameters: { temperature: [0, 1] },
      constraints: { locked: ['topP', 'maxTurns', 'retryBudget', 'contextShare'] },
    });
    for (let cycle = 0; cycle < 400; cycle += 1) {
      const recommendation = engine.recommend({ agentId, kind: 'planning' });
      const expensive = recommendation.parameters.temperature === 1;
      engine.report({
        executionId: recommendation.executionId,
        qualityScore: 0.8 + (cycle % 2 === 0 ? 0.01 : -0.01),
        latencyMs: 500,
        inputTokens: expensive ? 4000 : 1000,
        outputTokens: expensive ? 1200 : 300,
      });
    }
    const profile = must(engine.profileOf(agentId, 'planning')[0], 'profile');
    const temperature = must(
      profile.profiles.find((dimension) => dimension.parameter === 'temperature'),
      'temperature profile',
    );
    const cheap = must(
      temperature.arms.find((arm) => arm.value === 0),
      'cheap arm',
    );
    const costly = must(
      temperature.arms.find((arm) => arm.value === 1),
      'costly arm',
    );
    expect(cheap.pulls).toBeGreaterThan(0);
    expect(costly.pulls).toBeGreaterThan(0);
    expect(cheap.meanReward).toBeGreaterThan(costly.meanReward);
  });
});

describe('capacity limits', () => {
  it('maxAgents serves untracked agents static defaults and emits limit.reached', () => {
    const engine = createNoeticOS({ clock: () => 0, seed: 7, maxAgents: 2 });
    const events: TelemetryEvent[] = [];
    engine.on((event) => {
      events.push(event);
    });

    engine.recommend({ agentId: 'agent-a', kind: 'planning' });
    engine.recommend({ agentId: 'agent-b', kind: 'planning' });
    const third = engine.recommend({ agentId: 'agent-c', kind: 'planning' });

    expect(engine.agents()).toEqual(['agent-a', 'agent-b']);
    expect(third.cohort).toBe('baseline');
    expect(third.parameters).toEqual({
      temperature: 0.4,
      topP: 1,
      maxTurns: 32,
      retryBudget: 1,
      contextShare: 0.6,
    });
    expect(third.reasoning).toContain('capacity');

    const limitEvents = eventsOf(events, 'limit.reached');
    expect(limitEvents.length).toBe(1);
    expect(must(limitEvents[0], 'limit event').scope).toBe('agents');
    expect(must(limitEvents[0], 'limit event').detail).toContain('agent-c');

    // The untracked agent keeps no pending entry, so its report is a no-op.
    expect(engine.inspect().pendingExecutions).toBe(2);
    engine.report({ executionId: third.executionId, qualityScore: 1 });
    expect(engine.inspect().pendingExecutions).toBe(2);
    expect(engine.profileOf('agent-c')).toEqual([]);
  });

  it('maxPendingExecutions caps unreported recommendations and emits pending limits', () => {
    const engine = createNoeticOS({ clock: () => 0, seed: 7, maxPendingExecutions: 5 });
    const events: TelemetryEvent[] = [];
    engine.on((event) => {
      events.push(event);
    });

    for (let cycle = 0; cycle < 10; cycle += 1) {
      engine.recommend({ agentId: 'pending-agent', kind: 'planning' });
    }

    expect(engine.inspect().pendingExecutions).toBeLessThanOrEqual(5);
    expect(engine.inspect().pendingExecutions).toBe(5);
    const limitEvents = eventsOf(events, 'limit.reached');
    expect(limitEvents.length).toBe(5);
    expect(limitEvents.every((event) => event.scope === 'pending')).toBe(true);
  });
});

describe('telemetry', () => {
  it('mirrors every call and decision, survives throwing listeners, and detaches', () => {
    const agentId = 'telemetry-agent';
    const engine = createNoeticOS({
      clock: () => 0,
      seed: 7,
      canaryShare: 0.3,
      minSamplesPerArm: 4,
    });

    let throwCount = 0;
    engine.on(() => {
      throwCount += 1;
      throw new Error('listener failure');
    });
    const events: TelemetryEvent[] = [];
    const unsubscribe = engine.on((event) => {
      events.push(event);
    });

    const cycles = 80;
    for (let cycle = 0; cycle < cycles; cycle += 1) {
      const recommendation = engine.recommend({ agentId, kind: 'extraction' });
      engine.report({
        executionId: recommendation.executionId,
        qualityScore: syntheticQuality(recommendation.parameters, cycle),
      });
    }

    expect(eventsOf(events, 'recommendation.issued').length).toBe(cycles);
    expect(eventsOf(events, 'outcome.recorded').length).toBe(cycles);

    const recordedSeqs = eventsOf(events, 'decision.recorded').map((event) => event.entry.seq);
    const listedSeqs = engine.decisions().map((entry) => entry.seq);
    expect(listedSeqs.length).toBeGreaterThan(0);
    expect(recordedSeqs).toEqual(listedSeqs);
    expect(engine.inspect().decisions).toBe(listedSeqs.length);

    // The throwing listener ran on every event and never broke the engine.
    expect(throwCount).toBeGreaterThanOrEqual(events.length);

    unsubscribe();
    const deliveredBefore = events.length;
    const thrownBefore = throwCount;
    const recommendation = engine.recommend({ agentId, kind: 'extraction' });
    engine.report({ executionId: recommendation.executionId, qualityScore: 0.8 });
    expect(events.length).toBe(deliveredBefore);
    expect(throwCount).toBeGreaterThan(thrownBefore);
  });
});

describe('state roundtrip', () => {
  it('restores promoted values, executions, and statistics, but not the decision log', async () => {
    const agentId = 'roundtrip-agent';
    const kind: TaskKind = 'extraction';
    const backend = memoryState();
    const options = {
      clock: () => 0,
      seed: 7,
      canaryShare: 0.3,
      minSamplesPerArm: 4,
      state: backend,
    };

    const first = createNoeticOS(options);
    for (let cycle = 0; cycle < 300; cycle += 1) {
      const recommendation = first.recommend({ agentId, kind });
      first.report({
        executionId: recommendation.executionId,
        qualityScore: syntheticQuality(recommendation.parameters, cycle),
      });
    }
    await first.flush();

    const second = createNoeticOS(options);
    // flush awaits the startup restore, so the snapshot is fully loaded afterwards.
    await second.flush();

    const firstProfiles = first.profileOf(agentId, kind);
    const secondProfiles = second.profileOf(agentId, kind);
    expect(secondProfiles).toEqual(firstProfiles);
    expect(must(secondProfiles[0], 'restored profile').executions).toBe(300);
    expect(promotedOf(second, agentId, kind)).toEqual(promotedOf(first, agentId, kind));

    // The decision log is not part of the snapshot: the restored engine starts with an
    // empty log and a fresh sequence, while bandits, rollout state, and quantiles are
    // persisted inside the per-agent track payload asserted below.
    expect(first.inspect().decisions).toBeGreaterThan(0);
    expect(second.inspect().decisions).toBe(0);
    expect(second.decisions()).toEqual([]);
    freezeTuning(second, agentId, 'probe of the fresh decision sequence');
    expect(must(second.decisions()[0], 'first decision of the restored engine').seq).toBe(1);

    const snapshot = must(await backend.load(), 'persisted snapshot');
    expect(snapshot.version).toBe(1);
    expect(snapshot.savedAt).toBe(0);
    const agentPayload = snapshot.agents[agentId];
    if (typeof agentPayload !== 'object' || agentPayload === null) {
      throw new Error('expected an agent payload object in the snapshot');
    }
    const tracks = (agentPayload as Record<string, unknown>).tracks;
    if (typeof tracks !== 'object' || tracks === null) {
      throw new Error('expected a tracks record in the agent payload');
    }
    const track = (tracks as Record<string, unknown>)[kind];
    if (typeof track !== 'object' || track === null) {
      throw new Error('expected a serialized track for the learned task class');
    }
    expect(Object.keys(track)).toEqual(
      expect.arrayContaining([
        'bandits',
        'rollout',
        'costP5',
        'costP95',
        'latencyP5',
        'latencyP95',
        'executions',
        'focusIndex',
      ]),
    );
  });
});

describe('objective validation', () => {
  it('rejects custom objective weights that sum to zero', () => {
    let caught: unknown;
    try {
      createNoeticOS({ objective: { quality: 0, cost: 0, latency: 0 } });
    } catch (error) {
      caught = error;
    }
    if (!(caught instanceof NoeticosError)) {
      throw new Error('expected createNoeticOS to throw a NoeticosError');
    }
    expect(caught.code).toBe('ERR_INVALID_INPUT');
    expect(caught.message).toContain('objective weights');
  });
});
