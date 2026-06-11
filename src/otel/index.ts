/**
 * OpenTelemetry GenAI semantic-convention ingestion, the input side of the NoeticOS
 * observability bridge.
 *
 * Everything in this module is structural: the functions read plain span-shaped
 * objects ({@link GenAISpanLike}) and import no OpenTelemetry package, so they accept
 * spans exported by hermes-otel, telemetry recorded by the Vercel AI SDK
 * (`experimental_telemetry`), or any OTLP JSON payload whose attribute list has been
 * flattened into a record.
 *
 * Privacy by design: prompt and completion content is never extracted. Span events,
 * which can carry message bodies under the GenAI conventions, are accepted by the span
 * type and deliberately ignored, and {@link taskFromSpan} always leaves
 * `TaskDescriptor.prompt` undefined. Only aggregate signals, token counts, latency,
 * finish reasons, and tool names, ever reach the engine.
 *
 * The live pattern recommends before the model call and reports after it:
 *
 * ```ts
 * import { createNoeticOS } from '@takk/noeticos';
 * import { outcomeFromSpan, taskFromSpan } from '@takk/noeticos/otel';
 *
 * const runtime = createNoeticOS();
 * // `span` and `toolSpans` come from the instrumentation of the current request:
 * // ingestion is live by design. Replaying an exported trace can warm the cost and
 * // latency quantile bands, but it is not historical credit assignment: a replayed
 * // outcome was produced under whatever parameters production actually ran, not
 * // under the freshly recommended ones, so treat replay as band warming only.
 * const rec = runtime.recommend(taskFromSpan(span, 'support-bot'));
 * // ... execute the task with rec.parameters ...
 * runtime.report(outcomeFromSpan(rec.executionId, span, toolSpans));
 * ```
 */

import type {
  ExecutionOutcome,
  ParameterName,
  ParameterValue,
  TaskDescriptor,
  ToolCallOutcome,
} from '../types.js';

/**
 * Minimal structural shape of an OpenTelemetry span carrying GenAI semantic
 * conventions. Field names follow the OTLP JSON encoding, `attributes` is the span
 * attribute list flattened into a record, and unknown extra fields are ignored.
 */
export interface GenAISpanLike {
  readonly name?: string;
  readonly attributes?: Readonly<Record<string, unknown>>;
  readonly startTimeUnixNano?: number | string;
  readonly endTimeUnixNano?: number | string;
  readonly status?: { readonly code?: number };
  readonly events?: ReadonlyArray<{
    readonly name?: string;
    readonly attributes?: Readonly<Record<string, unknown>>;
  }>;
}

type FinishReason = NonNullable<ExecutionOutcome['finishReason']>;

/** OTLP span status code meaning error (0 unset, 1 ok, 2 error). */
const STATUS_ERROR = 2;
/**
 * Prompt size heuristic: English text averages roughly four characters per token, so
 * `gen_ai.usage.input_tokens * 4` serves as a character-count proxy when the prompt
 * itself is withheld.
 */
const CHARS_PER_TOKEN = 4;
const NANOS_PER_MS = 1e6;

/** FNV-1a 32-bit offset basis. */
const FNV_OFFSET_BASIS = 0x811c9dc5;
/** FNV-1a 32-bit prime. */
const FNV_PRIME = 0x01000193;

/**
 * FNV-1a 32-bit hash over the UTF-16 code units of `text`, two bytes per unit, low
 * byte first, rendered as fixed-width lowercase hex. Deterministic across runtimes,
 * used to fingerprint tool-call arguments without ever transmitting them.
 */
function fnv1aHex(text: string): string {
  let hash = FNV_OFFSET_BASIS;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    hash ^= code & 0xff;
    hash = Math.imul(hash, FNV_PRIME) >>> 0;
    hash ^= code >>> 8;
    hash = Math.imul(hash, FNV_PRIME) >>> 0;
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function stringAttr(span: GenAISpanLike, key: string): string | undefined {
  const value = span.attributes?.[key];
  return typeof value === 'string' ? value : undefined;
}

function numberAttr(span: GenAISpanLike, key: string): number | undefined {
  const value = span.attributes?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** First string inside a value that may be a plain string or an attribute array. */
function firstString(value: unknown): string | undefined {
  if (typeof value === 'string') {
    return value;
  }
  if (Array.isArray(value)) {
    const entries: readonly unknown[] = value;
    for (const entry of entries) {
      if (typeof entry === 'string') {
        return entry;
      }
    }
  }
  return undefined;
}

/**
 * Parses an OTLP timestamp that may arrive as a number or a decimal string.
 * Nanosecond epochs exceed 2^53, so `Number` loses sub-microsecond precision on
 * string inputs; the error stays far below the millisecond rounding applied later.
 */
function parseNanos(value: number | string | undefined): number | undefined {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value === 'string' && value.trim() !== '') {
    // `Number('')` is 0, hence the emptiness check above.
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function latencyFromSpan(span: GenAISpanLike): number | undefined {
  const start = parseNanos(span.startTimeUnixNano);
  const end = parseNanos(span.endTimeUnixNano);
  if (start === undefined || end === undefined) {
    return undefined;
  }
  const ms = Math.round((end - start) / NANOS_PER_MS);
  // Clock-skewed exports can place the end before the start; a negative duration
  // would poison the latency quantiles, so it is treated as absent.
  return ms >= 0 ? ms : undefined;
}

function mapFinishReason(raw: string): FinishReason {
  switch (raw) {
    case 'stop':
      return 'stop';
    case 'length':
    case 'max_tokens':
      return 'length';
    case 'tool_calls':
    case 'tool_use':
      return 'tool-calls';
    case 'content_filter':
      return 'content-filter';
    default:
      return 'other';
  }
}

function toolCallFromSpan(span: GenAISpanLike): ToolCallOutcome {
  const name = stringAttr(span, 'gen_ai.tool.name') ?? span.name ?? 'tool';
  const args = span.attributes?.['gen_ai.tool.call.arguments'];
  return {
    name,
    ok: span.status?.code !== STATUS_ERROR,
    ...(args === undefined ? {} : { argumentsHash: fnv1aHex(String(args)) }),
  };
}

/**
 * Builds a {@link TaskDescriptor} from a GenAI span.
 *
 * The agent id is resolved in order from the `gen_ai.agent.name`, `gen_ai.agent.id`,
 * and `service.name` string attributes, then `fallbackAgentId`, then the literal
 * `'otel-agent'`. `toolsAvailable` comes from `gen_ai.request.tools.count` when
 * numeric.
 *
 * Privacy by design: prompt content is never read from the span, so
 * `TaskDescriptor.prompt` stays undefined. `promptLength` is approximated instead
 * from `gen_ai.usage.input_tokens` multiplied by four, a rough average of four
 * characters per token in English text, which keeps the length-based classifier
 * signals alive without moving any content.
 */
export function taskFromSpan(span: GenAISpanLike, fallbackAgentId?: string): TaskDescriptor {
  const agentId =
    stringAttr(span, 'gen_ai.agent.name') ??
    stringAttr(span, 'gen_ai.agent.id') ??
    stringAttr(span, 'service.name') ??
    fallbackAgentId ??
    'otel-agent';
  const inputTokens = numberAttr(span, 'gen_ai.usage.input_tokens');
  const toolsAvailable = numberAttr(span, 'gen_ai.request.tools.count');
  return {
    agentId,
    ...(inputTokens === undefined
      ? {}
      : { promptLength: Math.round(inputTokens * CHARS_PER_TOKEN) }),
    ...(toolsAvailable === undefined ? {} : { toolsAvailable }),
  };
}

/**
 * Builds an {@link ExecutionOutcome} for `executionId` from a finished GenAI span and,
 * optionally, the tool spans nested under it.
 *
 * - `latencyMs` is the end minus start time when both OTLP timestamps are present,
 *   accepted as number or string nanoseconds and rounded to milliseconds.
 * - `inputTokens` and `outputTokens` come from `gen_ai.usage.input_tokens` and
 *   `gen_ai.usage.output_tokens` when numeric.
 * - `costUsd` comes from `gen_ai.usage.cost`, falling back to `llm.usage.cost`.
 * - `finishReason` maps `gen_ai.response.finish_reasons` (array or string): `stop` to
 *   `'stop'`, `length` or `max_tokens` to `'length'`, `tool_calls` or `tool_use` to
 *   `'tool-calls'`, `content_filter` to `'content-filter'`, anything else to
 *   `'other'`. A span status code of 2 wins over the attribute and reports `'error'`
 *   together with `error: true`. When the span carries neither a finish reason nor an
 *   error status the field is omitted.
 * - `turns` comes from `gen_ai.agent.turns`, falling back to
 *   `gen_ai.conversation.turns`.
 * - `toolCalls` maps each tool span: name from `gen_ai.tool.name` (falling back to
 *   the span name, then `'tool'`), `ok` unless the tool span status code is 2, and
 *   `argumentsHash` as a deterministic FNV-1a fingerprint of the
 *   `gen_ai.tool.call.arguments` attribute when present, so tool loops stay
 *   detectable while the raw arguments never leave the process.
 */
export function outcomeFromSpan(
  executionId: string,
  span: GenAISpanLike,
  toolSpans?: readonly GenAISpanLike[],
): ExecutionOutcome {
  const failed = span.status?.code === STATUS_ERROR;
  const raw = firstString(span.attributes?.['gen_ai.response.finish_reasons']);
  const finishReason: FinishReason | undefined = failed
    ? 'error'
    : raw === undefined
      ? undefined
      : mapFinishReason(raw);
  const latencyMs = latencyFromSpan(span);
  const inputTokens = numberAttr(span, 'gen_ai.usage.input_tokens');
  const outputTokens = numberAttr(span, 'gen_ai.usage.output_tokens');
  const costUsd = numberAttr(span, 'gen_ai.usage.cost') ?? numberAttr(span, 'llm.usage.cost');
  const turns =
    numberAttr(span, 'gen_ai.agent.turns') ?? numberAttr(span, 'gen_ai.conversation.turns');
  const toolCalls = toolSpans?.map(toolCallFromSpan);
  return {
    executionId,
    ...(latencyMs === undefined ? {} : { latencyMs }),
    ...(costUsd === undefined ? {} : { costUsd }),
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(turns === undefined ? {} : { turns }),
    ...(toolCalls === undefined ? {} : { toolCalls }),
    ...(finishReason === undefined ? {} : { finishReason }),
    ...(failed ? { error: true } : {}),
  };
}

/**
 * Extracts the request parameters production actually ran with:
 * `gen_ai.request.model` (string), `gen_ai.request.temperature`, and
 * `gen_ai.request.top_p` (numbers).
 *
 * Use it to compare deployed configuration against what NoeticOS would recommend for
 * the same task, for example by diffing the result with
 * `runtime.recommend(taskFromSpan(span)).parameters` to spot drift before switching
 * traffic over to learned profiles.
 */
export function parametersFromSpan(
  span: GenAISpanLike,
): Readonly<Partial<Record<ParameterName, ParameterValue>>> {
  const model = stringAttr(span, 'gen_ai.request.model');
  const temperature = numberAttr(span, 'gen_ai.request.temperature');
  const topP = numberAttr(span, 'gen_ai.request.top_p');
  return {
    ...(model === undefined ? {} : { model }),
    ...(temperature === undefined ? {} : { temperature }),
    ...(topP === undefined ? {} : { topP }),
  };
}
