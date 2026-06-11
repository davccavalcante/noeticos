/**
 * otel-ingest: feeding NoeticOS from OpenTelemetry GenAI semantic-convention spans.
 *
 * The `/otel` entry is structural: it reads plain span-shaped objects (OTLP JSON
 * field names, attributes flattened into a record) and imports no OpenTelemetry
 * package. The same functions accept spans exported by hermes-otel, telemetry
 * recorded by the Vercel AI SDK (`experimental_telemetry`), or any OTLP JSON
 * payload, live or replayed from an exported trace to warm profiles offline.
 *
 * Privacy by design: prompt and completion content is never extracted from spans.
 * `taskFromSpan` approximates the prompt length from input tokens and leaves the
 * prompt itself undefined; tool arguments are reduced to a deterministic hash so
 * loops stay detectable while the raw arguments never reach the engine.
 *
 * Run (in a project with @takk/noeticos installed): node --import tsx otel-ingest.ts
 */

import { createNoeticOS } from '@takk/noeticos';
import { outcomeFromSpan, parametersFromSpan, taskFromSpan } from '@takk/noeticos/otel';
import type { GenAISpanLike } from '@takk/noeticos/otel';

// A finished GenAI span as an OTel exporter would deliver it (attributes
// flattened into a record, timestamps in nanoseconds, number or string).
const span: GenAISpanLike = {
  name: 'chat anthropic',
  startTimeUnixNano: '1765900000000000000',
  endTimeUnixNano: '1765900001840000000', // 1840 ms later
  status: { code: 1 },
  attributes: {
    'gen_ai.agent.name': 'support-agent',
    'gen_ai.request.model': 'frontier-xl',
    'gen_ai.request.temperature': 0.7,
    'gen_ai.request.top_p': 1,
    'gen_ai.request.tools.count': 4,
    'gen_ai.usage.input_tokens': 640,
    'gen_ai.usage.output_tokens': 210,
    'gen_ai.usage.cost': 0.0042,
    'gen_ai.agent.turns': 3,
    'gen_ai.response.finish_reasons': ['stop'],
  },
};

// Tool spans nested under the request span. Identical name plus identical
// arguments hash three or more times in a row is what the engine counts as a loop.
const toolSpans: readonly GenAISpanLike[] = [
  {
    name: 'execute_tool search_kb',
    status: { code: 1 },
    attributes: {
      'gen_ai.tool.name': 'search_kb',
      'gen_ai.tool.call.arguments': '{"query":"incident 4711"}',
    },
  },
  {
    name: 'execute_tool fetch_ticket',
    status: { code: 2 }, // this tool call failed; it becomes ok: false
    attributes: { 'gen_ai.tool.name': 'fetch_ticket' },
  },
];

async function main(): Promise<void> {
  const runtime = createNoeticOS({ seed: 7 });

  // 1. Span to TaskDescriptor: agent id from gen_ai.agent.name (with fallbacks),
  //    prompt length approximated as input_tokens * 4, prompt itself never read.
  const task = taskFromSpan(span, 'fallback-agent');
  console.log('task:', task);

  // 2. The live pattern: recommend before the model call, report after it.
  const recommendation = runtime.recommend(task);
  console.log('recommended parameters:', recommendation.parameters);

  // 3. Span to ExecutionOutcome: latency from the OTLP timestamps, tokens and
  //    cost from gen_ai.usage.*, finish reason mapped, tool calls hashed.
  const outcome = outcomeFromSpan(recommendation.executionId, span, toolSpans);
  console.log('outcome:', outcome);
  runtime.report(outcome);

  // 4. Drift check: what production actually ran versus what NoeticOS would
  //    recommend for the same task. Useful before switching traffic over.
  const deployed = parametersFromSpan(span);
  console.log('deployed today:', deployed);
  console.log('recommended now:', recommendation.parameters);

  await runtime.close();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
