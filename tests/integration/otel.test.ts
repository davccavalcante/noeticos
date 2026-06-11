/**
 * Integration tests for the OpenTelemetry GenAI ingestion bridge: structural span
 * parsing into task descriptors, outcomes, and deployed parameters, plus the full
 * recommend-then-report live pattern against a real engine.
 */

import { describe, expect, it } from 'vitest';
import type { ExecutionOutcome, TelemetryEvent } from '../../src/index.js';
import { createNoeticOS } from '../../src/index.js';
import type { GenAISpanLike } from '../../src/otel/index.js';
import { outcomeFromSpan, parametersFromSpan, taskFromSpan } from '../../src/otel/index.js';

function must<T>(value: T | undefined, label: string): T {
  if (value === undefined) {
    throw new Error(`expected ${label} to be defined`);
  }
  return value;
}

describe('taskFromSpan', () => {
  it('resolves the agent id through the documented fallback chain', () => {
    const everything: GenAISpanLike = {
      attributes: {
        'gen_ai.agent.name': 'named-agent',
        'gen_ai.agent.id': 'agent-id-7',
        'service.name': 'span-service',
      },
    };
    expect(taskFromSpan(everything, 'fallback-bot').agentId).toBe('named-agent');

    const idAndService: GenAISpanLike = {
      attributes: { 'gen_ai.agent.id': 'agent-id-7', 'service.name': 'span-service' },
    };
    expect(taskFromSpan(idAndService, 'fallback-bot').agentId).toBe('agent-id-7');

    const serviceOnly: GenAISpanLike = { attributes: { 'service.name': 'span-service' } };
    expect(taskFromSpan(serviceOnly, 'fallback-bot').agentId).toBe('span-service');

    expect(taskFromSpan({}, 'fallback-bot').agentId).toBe('fallback-bot');
    expect(taskFromSpan({}).agentId).toBe('otel-agent');
  });

  it('derives promptLength and toolsAvailable without ever extracting content', () => {
    const span: GenAISpanLike = {
      attributes: {
        'gen_ai.usage.input_tokens': 100,
        'gen_ai.request.tools.count': 3,
      },
    };
    const task = taskFromSpan(span, 'fallback-bot');
    expect(task.promptLength).toBe(400);
    expect(task.toolsAvailable).toBe(3);
    expect(Object.keys(task)).not.toContain('prompt');

    const sparse = taskFromSpan({}, 'fallback-bot');
    expect(Object.keys(sparse)).toEqual(['agentId']);
  });
});

describe('outcomeFromSpan', () => {
  it('computes latency from numeric and string OTLP nanosecond timestamps', () => {
    const numeric: GenAISpanLike = {
      startTimeUnixNano: 1_000_000_000,
      endTimeUnixNano: 1_250_000_000,
    };
    expect(outcomeFromSpan('exec-1', numeric).latencyMs).toBe(250);

    const text: GenAISpanLike = {
      startTimeUnixNano: '2000000000',
      endTimeUnixNano: '2750000000',
    };
    expect(outcomeFromSpan('exec-1', text).latencyMs).toBe(750);

    const skewed: GenAISpanLike = {
      startTimeUnixNano: 2_000_000_000,
      endTimeUnixNano: 1_000_000_000,
    };
    expect(Object.keys(outcomeFromSpan('exec-1', skewed))).not.toContain('latencyMs');
  });

  it('extracts tokens, cost with its llm fallback, and turns', () => {
    const span: GenAISpanLike = {
      attributes: {
        'gen_ai.usage.input_tokens': 150,
        'gen_ai.usage.output_tokens': 80,
        'gen_ai.usage.cost': 0.004,
        'gen_ai.agent.turns': 4,
      },
    };
    const outcome = outcomeFromSpan('exec-1', span);
    expect(outcome.inputTokens).toBe(150);
    expect(outcome.outputTokens).toBe(80);
    expect(outcome.costUsd).toBe(0.004);
    expect(outcome.turns).toBe(4);

    const fallback: GenAISpanLike = {
      attributes: { 'llm.usage.cost': 0.01, 'gen_ai.conversation.turns': 2 },
    };
    expect(outcomeFromSpan('exec-1', fallback).costUsd).toBe(0.01);
    expect(outcomeFromSpan('exec-1', fallback).turns).toBe(2);
  });

  it('maps every documented finish reason and lets status code 2 win as error', () => {
    const table: ReadonlyArray<{
      raw: string;
      expected: NonNullable<ExecutionOutcome['finishReason']>;
    }> = [
      { raw: 'stop', expected: 'stop' },
      { raw: 'length', expected: 'length' },
      { raw: 'max_tokens', expected: 'length' },
      { raw: 'tool_calls', expected: 'tool-calls' },
      { raw: 'tool_use', expected: 'tool-calls' },
      { raw: 'content_filter', expected: 'content-filter' },
      { raw: 'paused', expected: 'other' },
    ];
    for (const { raw, expected } of table) {
      const outcome = outcomeFromSpan('exec-1', {
        attributes: { 'gen_ai.response.finish_reasons': [raw] },
      });
      expect(outcome.finishReason).toBe(expected);
      expect(outcome.error).toBeUndefined();
    }

    const stringForm = outcomeFromSpan('exec-1', {
      attributes: { 'gen_ai.response.finish_reasons': 'stop' },
    });
    expect(stringForm.finishReason).toBe('stop');

    const failed = outcomeFromSpan('exec-1', {
      status: { code: 2 },
      attributes: { 'gen_ai.response.finish_reasons': ['stop'] },
    });
    expect(failed.finishReason).toBe('error');
    expect(failed.error).toBe(true);
  });

  it('maps tool spans to outcomes with a deterministic arguments hash', () => {
    const search: GenAISpanLike = {
      attributes: {
        'gen_ai.tool.name': 'search',
        'gen_ai.tool.call.arguments': '{"query":"noeticos"}',
      },
    };
    const sameArguments: GenAISpanLike = {
      attributes: {
        'gen_ai.tool.name': 'search',
        'gen_ai.tool.call.arguments': '{"query":"noeticos"}',
      },
    };
    const otherArguments: GenAISpanLike = {
      attributes: {
        'gen_ai.tool.name': 'search',
        'gen_ai.tool.call.arguments': '{"query":"keymesh"}',
      },
    };
    const failedNamedBySpan: GenAISpanLike = { name: 'db.query', status: { code: 2 } };
    const anonymous: GenAISpanLike = {};

    const outcome = outcomeFromSpan('exec-1', {}, [
      search,
      sameArguments,
      otherArguments,
      failedNamedBySpan,
      anonymous,
    ]);
    const calls = must(outcome.toolCalls, 'tool calls');
    expect(calls.length).toBe(5);

    const [a, b, c, d, e] = calls;
    expect(must(a, 'call a').name).toBe('search');
    expect(must(a, 'call a').ok).toBe(true);
    expect(must(a, 'call a').argumentsHash).toMatch(/^[0-9a-f]{8}$/);
    expect(must(b, 'call b').argumentsHash).toBe(must(a, 'call a').argumentsHash);
    expect(must(c, 'call c').argumentsHash).not.toBe(must(a, 'call a').argumentsHash);
    expect(must(d, 'call d').name).toBe('db.query');
    expect(must(d, 'call d').ok).toBe(false);
    expect(Object.keys(must(d, 'call d'))).not.toContain('argumentsHash');
    expect(must(e, 'call e').name).toBe('tool');
  });

  it('omits every field a sparse span cannot support', () => {
    const outcome = outcomeFromSpan('exec-sparse', {});
    expect(Object.keys(outcome)).toEqual(['executionId']);
    expect(outcome.executionId).toBe('exec-sparse');
  });
});

describe('parametersFromSpan', () => {
  it('extracts the deployed model, temperature, and topP when present', () => {
    const span: GenAISpanLike = {
      attributes: {
        'gen_ai.request.model': 'frontier-xl',
        'gen_ai.request.temperature': 0.2,
        'gen_ai.request.top_p': 0.9,
      },
    };
    expect(parametersFromSpan(span)).toEqual({
      model: 'frontier-xl',
      temperature: 0.2,
      topP: 0.9,
    });
  });

  it('returns an empty record for spans without request attributes', () => {
    expect(parametersFromSpan({})).toEqual({});
    const wrongTypes: GenAISpanLike = {
      attributes: { 'gen_ai.request.model': 42, 'gen_ai.request.temperature': '0.7' },
    };
    expect(parametersFromSpan(wrongTypes)).toEqual({});
  });
});

describe('live pattern', () => {
  it('closes the two-phase loop from a span: recommend, report, pending drains', () => {
    const engine = createNoeticOS({ clock: () => 0, seed: 7 });
    const events: TelemetryEvent[] = [];
    engine.on((event) => {
      events.push(event);
    });

    const span: GenAISpanLike = {
      name: 'chat completion',
      attributes: {
        'service.name': 'span-service',
        'gen_ai.usage.input_tokens': 150,
        'gen_ai.usage.output_tokens': 80,
        'gen_ai.usage.cost': 0.004,
        'gen_ai.response.finish_reasons': ['stop'],
        'gen_ai.request.tools.count': 2,
      },
      startTimeUnixNano: 1_000_000_000,
      endTimeUnixNano: 1_450_000_000,
    };
    const toolSpans: readonly GenAISpanLike[] = [
      { attributes: { 'gen_ai.tool.name': 'search', 'gen_ai.tool.call.arguments': '{"q":1}' } },
      { attributes: { 'gen_ai.tool.name': 'render' }, status: { code: 2 } },
    ];

    const recommendation = engine.recommend(taskFromSpan(span, 'fallback-bot'));
    expect(recommendation.agentId).toBe('span-service');
    expect(engine.inspect().pendingExecutions).toBe(1);

    const outcome = outcomeFromSpan(recommendation.executionId, span, toolSpans);
    expect(outcome.latencyMs).toBe(450);
    engine.report(outcome);

    expect(engine.inspect().pendingExecutions).toBe(0);
    const profile = must(engine.profileOf('span-service')[0], 'profile');
    expect(profile.executions).toBe(1);
    const recorded = events.filter(
      (event): event is Extract<TelemetryEvent, { type: 'outcome.recorded' }> =>
        event.type === 'outcome.recorded',
    );
    expect(recorded.length).toBe(1);
    expect(must(recorded[0], 'outcome event').executionId).toBe(recommendation.executionId);
    expect(must(recorded[0], 'outcome event').reward).toBeGreaterThanOrEqual(0);
    expect(must(recorded[0], 'outcome event').reward).toBeLessThanOrEqual(1);
  });
});
