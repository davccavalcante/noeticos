/**
 * Integration tests for the packaged Vercel AI SDK middleware: transformParams applies
 * the recommendation and stashes the execution id, wrapGenerate and wrapStream close
 * the loop with a report on success and on failure, and prompt extraction tolerates
 * arbitrary shapes.
 */

import { describe, expect, it } from 'vitest';
import type {
  ExecutionOutcome,
  NoeticOS,
  Recommendation,
  TelemetryEvent,
} from '../../src/index.js';
import { createNoeticOS } from '../../src/index.js';
import { noeticosMiddleware } from '../../src/vercel/index.js';

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

function observed(engine: NoeticOS): TelemetryEvent[] {
  const events: TelemetryEvent[] = [];
  engine.on((event) => {
    events.push(event);
  });
  return events;
}

function lastRecommendation(events: readonly TelemetryEvent[]): Recommendation {
  const issued = eventsOf(events, 'recommendation.issued');
  return must(issued[issued.length - 1], 'an issued recommendation').recommendation;
}

describe('transformParams', () => {
  it('applies recommended tunables, keeps unmanaged fields, and stashes the id', async () => {
    const engine = createNoeticOS({ clock: () => 0, seed: 7 });
    const events = observed(engine);
    const middleware = noeticosMiddleware(engine, { agentId: 'sdk-agent', kind: 'summarization' });

    const params = {
      prompt: 'Condense the quarterly report into one paragraph',
      maxOutputTokens: 256,
      temperature: 99,
      topP: 99,
      custom: 'marker',
      providerOptions: { upstream: { keep: true } },
    };
    const next = await middleware.transformParams({ params });
    const recommendation = lastRecommendation(events);

    expect(next.temperature).toBe(recommendation.parameters.temperature);
    expect(next.topP).toBe(recommendation.parameters.topP);
    expect(typeof next.temperature).toBe('number');
    expect(typeof next.topP).toBe('number');

    expect(next.maxOutputTokens).toBe(256);
    expect(next.custom).toBe('marker');
    expect(next.prompt).toBe(params.prompt);
    expect(next.providerOptions?.upstream).toEqual({ keep: true });

    const stash = must(next.providerOptions?.noeticos, 'noeticos provider options');
    expect(stash.executionId).toBe(recommendation.executionId);

    // The original params object is never mutated.
    expect(params.temperature).toBe(99);
    expect(Object.keys(params.providerOptions)).toEqual(['upstream']);
  });
});

describe('wrapGenerate', () => {
  it('reports usage tokens and finish reason on success and drains pending', async () => {
    const engine = createNoeticOS({ clock: () => 0, seed: 7 });
    const events = observed(engine);
    const middleware = noeticosMiddleware(engine, {
      agentId: 'sdk-agent',
      kind: 'planning',
      clock: () => 0,
    });

    const params = await middleware.transformParams({ params: {} });
    expect(engine.inspect().pendingExecutions).toBe(1);

    const generated = {
      usage: { inputTokens: 120, outputTokens: 40 },
      finishReason: 'stop',
      text: 'plan ready',
    };
    const result = await middleware.wrapGenerate({
      doGenerate: () => Promise.resolve(generated),
      params,
    });

    expect(result).toBe(generated);
    expect(engine.inspect().pendingExecutions).toBe(0);
    const recorded = eventsOf(events, 'outcome.recorded');
    expect(recorded.length).toBe(1);
    const outcomeEvent = must(recorded[0], 'outcome event');
    expect(outcomeEvent.executionId).toBe(lastRecommendation(events).executionId);
    expect(typeof outcomeEvent.reward).toBe('number');
    expect(outcomeEvent.reward).toBeGreaterThanOrEqual(0);
    expect(outcomeEvent.reward).toBeLessThanOrEqual(1);
  });

  it('rethrows the original error and still reports an error outcome', async () => {
    const engine = createNoeticOS({ clock: () => 0, seed: 7 });
    const events = observed(engine);
    const middleware = noeticosMiddleware(engine, {
      agentId: 'sdk-agent',
      kind: 'planning',
      clock: () => 0,
    });

    const params = await middleware.transformParams({ params: {} });
    const failure = new Error('provider exploded');
    await expect(
      middleware.wrapGenerate({ doGenerate: () => Promise.reject(failure), params }),
    ).rejects.toBe(failure);

    expect(engine.inspect().pendingExecutions).toBe(0);
    const recorded = eventsOf(events, 'outcome.recorded');
    expect(recorded.length).toBe(1);
    expect(must(recorded[0], 'outcome event').executionId).toBe(
      lastRecommendation(events).executionId,
    );
  });

  it('passes calls through unreported when the execution id stash is missing', async () => {
    const engine = createNoeticOS({ clock: () => 0, seed: 7 });
    const events = observed(engine);
    const middleware = noeticosMiddleware(engine, { agentId: 'sdk-agent', kind: 'planning' });

    const generated = { finishReason: 'stop' };
    const result = await middleware.wrapGenerate({
      doGenerate: () => Promise.resolve(generated),
      params: { prompt: 'plain prompt without a transformParams pass' },
    });

    expect(result).toBe(generated);
    expect(events).toEqual([]);
    expect(engine.inspect().pendingExecutions).toBe(0);
  });
});

describe('wrapStream', () => {
  function streamOf(parts: readonly unknown[]): ReadableStream<unknown> {
    return new ReadableStream<unknown>({
      start(controller): void {
        for (const part of parts) {
          controller.enqueue(part);
        }
        controller.close();
      },
    });
  }

  async function drain(stream: ReadableStream<unknown>): Promise<unknown[]> {
    const reader = stream.getReader();
    const parts: unknown[] = [];
    for (;;) {
      const step = await reader.read();
      if (step.done) {
        return parts;
      }
      parts.push(step.value);
    }
  }

  /** Engine facade recording every report so the outcome payload can be asserted. */
  function recordingRuntime(engine: NoeticOS): { runtime: NoeticOS; reports: ExecutionOutcome[] } {
    const reports: ExecutionOutcome[] = [];
    const runtime: NoeticOS = {
      ...engine,
      report: (outcome) => {
        reports.push(outcome);
        engine.report(outcome);
      },
    };
    return { runtime, reports };
  }

  it('reports usage and finish reason from the finish part and drains pending over N calls', async () => {
    const engine = createNoeticOS({ clock: () => 0, seed: 7 });
    const events = observed(engine);
    const { runtime, reports } = recordingRuntime(engine);
    const middleware = noeticosMiddleware(runtime, {
      agentId: 'stream-agent',
      kind: 'planning',
      clock: () => 0,
    });

    const calls = 5;
    for (let call = 0; call < calls; call += 1) {
      const params = await middleware.transformParams({ params: {} });
      expect(engine.inspect().pendingExecutions).toBe(1);
      const parts = [
        { type: 'text-delta', delta: 'partial ' },
        { type: 'text-delta', delta: 'answer' },
        { type: 'finish', usage: { inputTokens: 200, outputTokens: 50 }, finishReason: 'stop' },
      ];
      const result = await middleware.wrapStream({
        doStream: () => Promise.resolve({ stream: streamOf(parts), marker: 'kept' }),
        params,
      });
      expect(result.marker).toBe('kept');
      // Parts reach the consumer untouched, in order.
      expect(await drain(result.stream)).toEqual(parts);
      expect(engine.inspect().pendingExecutions).toBe(0);
    }

    expect(reports.length).toBe(calls);
    for (const outcome of reports) {
      expect(outcome.inputTokens).toBe(200);
      expect(outcome.outputTokens).toBe(50);
      expect(outcome.finishReason).toBe('stop');
      expect(outcome.error).toBeUndefined();
    }
    const recorded = eventsOf(events, 'outcome.recorded');
    expect(recorded.length).toBe(calls);
    for (const event of recorded) {
      expect(event.reward).toBeGreaterThanOrEqual(0);
      expect(event.reward).toBeLessThanOrEqual(1);
    }
  });

  it('reports an error outcome and propagates a mid-stream failure', async () => {
    const engine = createNoeticOS({ clock: () => 0, seed: 7 });
    const events = observed(engine);
    const { runtime, reports } = recordingRuntime(engine);
    const middleware = noeticosMiddleware(runtime, { agentId: 'stream-agent', kind: 'planning' });

    const params = await middleware.transformParams({ params: {} });
    const failing = new ReadableStream<unknown>({
      start(controller): void {
        controller.enqueue({ type: 'text-delta', delta: 'partial' });
        controller.error(new Error('stream exploded'));
      },
    });
    const result = await middleware.wrapStream({
      doStream: () => Promise.resolve({ stream: failing }),
      params,
    });
    await expect(drain(result.stream)).rejects.toThrow('stream exploded');

    expect(engine.inspect().pendingExecutions).toBe(0);
    expect(reports.length).toBe(1);
    expect(must(reports[0], 'error report').error).toBe(true);
    expect(must(reports[0], 'error report').finishReason).toBe('error');
    expect(eventsOf(events, 'outcome.recorded').length).toBe(1);
  });

  it('reports an error outcome and rethrows when doStream itself rejects', async () => {
    const engine = createNoeticOS({ clock: () => 0, seed: 7 });
    const { runtime, reports } = recordingRuntime(engine);
    const middleware = noeticosMiddleware(runtime, { agentId: 'stream-agent', kind: 'planning' });

    const params = await middleware.transformParams({ params: {} });
    const failure = new Error('provider refused to stream');
    await expect(
      middleware.wrapStream({ doStream: () => Promise.reject(failure), params }),
    ).rejects.toBe(failure);
    expect(engine.inspect().pendingExecutions).toBe(0);
    expect(reports.length).toBe(1);
    expect(must(reports[0], 'error report').error).toBe(true);
  });

  it('passes streams through unreported when the execution id stash is missing', async () => {
    const engine = createNoeticOS({ clock: () => 0, seed: 7 });
    const events = observed(engine);
    const middleware = noeticosMiddleware(engine, { agentId: 'stream-agent', kind: 'planning' });

    const parts = [{ type: 'finish', usage: { inputTokens: 9, outputTokens: 9 } }];
    const result = await middleware.wrapStream({
      doStream: () => Promise.resolve({ stream: streamOf(parts) }),
      params: { prompt: 'no transformParams pass' },
    });
    expect(await drain(result.stream)).toEqual(parts);
    expect(events).toEqual([]);
    expect(engine.inspect().pendingExecutions).toBe(0);
  });
});

describe('prompt extraction', () => {
  it('classifies plain string prompts', async () => {
    const engine = createNoeticOS({ clock: () => 0, seed: 7 });
    const events = observed(engine);
    const middleware = noeticosMiddleware(engine, { agentId: 'classifier-agent' });

    await middleware.transformParams({
      params: { prompt: 'Translate this contract into French' },
    });
    expect(lastRecommendation(events).taskClass).toBe('translation');
  });

  it('walks arrays of messages whose content is a list of parts', async () => {
    const engine = createNoeticOS({ clock: () => 0, seed: 7 });
    const events = observed(engine);
    const middleware = noeticosMiddleware(engine, { agentId: 'classifier-agent' });

    await middleware.transformParams({
      params: {
        prompt: [
          { role: 'system', content: 'You are a precise assistant.' },
          {
            role: 'user',
            content: [{ type: 'text', text: 'Translate the release notes into Spanish' }],
          },
        ],
      },
    });
    expect(lastRecommendation(events).taskClass).toBe('translation');
  });

  it('tolerates garbage prompt shapes, including cyclic objects', async () => {
    const engine = createNoeticOS({ clock: () => 0, seed: 7 });
    const events = observed(engine);
    const middleware = noeticosMiddleware(engine, { agentId: 'classifier-agent' });

    await middleware.transformParams({ params: { prompt: 42 } });
    expect(lastRecommendation(events).taskClass).toBe('unknown');
    expect(lastRecommendation(events).classification.signals).toEqual(['fallback']);

    const cyclic: { content?: unknown; text?: unknown } = { text: 12 };
    cyclic.content = cyclic;
    const next = await middleware.transformParams({ params: { prompt: cyclic } });
    expect(lastRecommendation(events).taskClass).toBe('unknown');
    expect(typeof next.providerOptions?.noeticos?.executionId).toBe('string');
  });
});
