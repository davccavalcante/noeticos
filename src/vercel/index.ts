/**
 * Packaged NoeticOS middleware for the Vercel AI SDK, v6 `LanguageModelV3Middleware`
 * shape.
 *
 * This module imports nothing from `ai` on purpose: the local
 * {@link MiddlewareCallOptionsLike} and {@link GenerateResultLike} shapes are
 * structural mirrors of the SDK call options and generate result, and the real types
 * satisfy them. Index signatures let every field the middleware does not touch pass
 * through untouched, so the same code keeps working as the SDK adds fields.
 *
 * The middleware closes the two-phase NoeticOS loop per model call:
 * `transformParams` obtains a recommendation and applies the per-call tunables, and
 * `wrapGenerate` (for `generateText` traffic) or `wrapStream` (for `streamText`
 * traffic) measures the call and reports the outcome under the same `executionId`.
 */

import type { ExecutionOutcome, NoeticOS, TaskKind } from '../types.js';

/** Best-effort prompt extraction stops once this many characters are collected. */
const PROMPT_CHAR_CAP = 4000;
/** Recursion guard for prompt walking; anything deeper is not message-shaped. */
const PROMPT_MAX_DEPTH = 6;

type FinishReason = NonNullable<ExecutionOutcome['finishReason']>;

/**
 * Structural mirror of the SDK per-call options. Only the fields the middleware reads
 * or writes are named; the index signature carries everything else through untouched.
 */
interface MiddlewareCallOptionsLike {
  temperature?: number;
  topP?: number;
  maxOutputTokens?: number;
  prompt?: unknown;
  providerOptions?: Record<string, Record<string, unknown>>;
  [key: string]: unknown;
}

/** Structural mirror of the SDK generate result, reduced to the reported signals. */
interface GenerateResultLike {
  usage?: { inputTokens?: number; outputTokens?: number };
  finishReason?: string;
  [key: string]: unknown;
}

/**
 * Structural mirror of one SDK stream part. Only the terminal `'finish'` part is
 * inspected; it carries the aggregate usage and the finish reason for the whole
 * streamed response, per the `LanguageModelV3StreamPart` contract.
 */
interface StreamPartLike {
  type?: unknown;
  usage?: { inputTokens?: number; outputTokens?: number };
  finishReason?: unknown;
  [key: string]: unknown;
}

/**
 * Structural mirror of the SDK stream result: `doStream` resolves to an object
 * whose `stream` is a web `ReadableStream` of parts. Everything else passes
 * through untouched.
 */
interface StreamResultLike {
  stream: ReadableStream<unknown>;
  [key: string]: unknown;
}

/**
 * The middleware object returned by {@link noeticosMiddleware}, structurally
 * compatible with the Vercel AI SDK `LanguageModelV3Middleware` contract.
 */
export interface NoeticosMiddleware {
  readonly middlewareVersion: 'v3';
  transformParams(input: { params: MiddlewareCallOptionsLike }): Promise<MiddlewareCallOptionsLike>;
  wrapGenerate(input: {
    doGenerate: () => PromiseLike<GenerateResultLike>;
    params: MiddlewareCallOptionsLike;
  }): Promise<GenerateResultLike>;
  wrapStream(input: {
    doStream: () => PromiseLike<StreamResultLike>;
    params: MiddlewareCallOptionsLike;
  }): Promise<StreamResultLike>;
}

/**
 * Best-effort prompt text extraction from the SDK prompt value, tolerant of any
 * shape: plain strings are taken as is, arrays are walked entry by entry, and
 * message-like objects contribute their `content` and `text` fields recursively.
 * Collection stops at {@link PROMPT_CHAR_CAP} characters, the text is classifier
 * input only and is never stored by the engine.
 */
function extractPromptText(prompt: unknown): string | undefined {
  const collected: string[] = [];
  let length = 0;
  const visit = (node: unknown, depth: number): void => {
    if (node === null || node === undefined || depth > PROMPT_MAX_DEPTH) {
      return;
    }
    if (length >= PROMPT_CHAR_CAP) {
      return;
    }
    if (typeof node === 'string') {
      collected.push(node);
      length += node.length + 1;
      return;
    }
    if (Array.isArray(node)) {
      const entries: readonly unknown[] = node;
      for (const entry of entries) {
        if (length >= PROMPT_CHAR_CAP) {
          return;
        }
        visit(entry, depth + 1);
      }
      return;
    }
    if (typeof node === 'object') {
      const record = node as Record<string, unknown>;
      visit(record.content, depth + 1);
      visit(record.text, depth + 1);
    }
  };
  visit(prompt, 0);
  if (collected.length === 0) {
    return undefined;
  }
  const joined = collected.join('\n');
  return joined.length > PROMPT_CHAR_CAP ? joined.slice(0, PROMPT_CHAR_CAP) : joined;
}

function executionIdOf(params: MiddlewareCallOptionsLike): string | undefined {
  const value = params.providerOptions?.noeticos?.executionId;
  return typeof value === 'string' ? value : undefined;
}

function finiteOrUndefined(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function mapFinishReason(raw: string): FinishReason {
  switch (raw) {
    case 'stop':
    case 'length':
    case 'tool-calls':
    case 'content-filter':
    case 'error':
      return raw;
    default:
      return 'other';
  }
}

/**
 * Creates a NoeticOS middleware for the Vercel AI SDK.
 *
 * `transformParams` classifies the call (using `options.kind` when asserted,
 * otherwise the best-effort prompt text), asks `runtime` for a recommendation, and
 * applies only the per-call tunables: `temperature` and `topP` are written when the
 * recommendation carries them, values the recommendation does not carry are never
 * overridden. The `executionId` is stashed under `providerOptions.noeticos` so the
 * outcome can be correlated later.
 *
 * `wrapGenerate` measures latency around the inner call with `options.clock`
 * (defaulting to the platform wall clock), then reports token usage and the mapped
 * finish reason on success, or `error: true` with `finishReason: 'error'` before
 * rethrowing on failure. The result is returned untouched.
 *
 * `wrapStream` closes the same loop for `streamText` traffic: the returned stream
 * is wrapped part-for-part (parts reach the consumer untouched), the terminal
 * `'finish'` part contributes usage and finish reason, and the outcome is reported
 * when the stream completes, with latency measured from the call to stream
 * completion. A stream that errors (or a `doStream` call that rejects) reports an
 * error outcome and propagates the failure; a cancelled stream reports what was
 * observed so far. Every path reports exactly once, so streamed executions never
 * leak pending entries.
 *
 * @example
 * ```ts
 * import { createNoeticOS } from '@takk/noeticos';
 * import { noeticosMiddleware } from '@takk/noeticos/vercel';
 * import { wrapLanguageModel } from 'ai';
 *
 * const runtime = createNoeticOS();
 * const model = wrapLanguageModel({
 *   model: baseModel,
 *   middleware: noeticosMiddleware(runtime, { agentId: 'support-bot' }),
 * });
 * ```
 *
 * `maxTurns`, `retryBudget`, and `contextShare` in a recommendation are agent-loop
 * parameters: the host application consumes them from `runtime.recommend()` when it
 * drives its own loop, they are not per-call concerns and are never written into the
 * SDK call options.
 */
export function noeticosMiddleware(
  runtime: NoeticOS,
  options: { agentId: string; kind?: TaskKind; clock?: () => number },
): NoeticosMiddleware {
  const agentId = options.agentId;
  const kind = options.kind;
  const clock = options.clock ?? (() => Date.now());
  return {
    middlewareVersion: 'v3',
    transformParams({ params }): Promise<MiddlewareCallOptionsLike> {
      const prompt = extractPromptText(params.prompt);
      const recommendation = runtime.recommend({
        agentId,
        ...(kind === undefined ? {} : { kind }),
        ...(prompt === undefined ? {} : { prompt }),
      });
      const next: MiddlewareCallOptionsLike = { ...params };
      const temperature = recommendation.parameters.temperature;
      if (typeof temperature === 'number') {
        next.temperature = temperature;
      }
      const topP = recommendation.parameters.topP;
      if (typeof topP === 'number') {
        next.topP = topP;
      }
      next.providerOptions = {
        ...params.providerOptions,
        noeticos: { executionId: recommendation.executionId },
      };
      return Promise.resolve(next);
    },
    async wrapGenerate({ doGenerate, params }): Promise<GenerateResultLike> {
      const executionId = executionIdOf(params);
      if (executionId === undefined) {
        // transformParams was bypassed, for example because another middleware
        // rebuilt providerOptions or the middleware list was reordered. Without the
        // id the outcome cannot be attributed to its recommendation and report()
        // would discard it anyway, so the call proceeds unreported.
        return await doGenerate();
      }
      const startedAt = clock();
      try {
        const result = await doGenerate();
        // Wall clocks may step backwards between samples; latency is clamped so a
        // negative duration cannot poison the learned quantiles.
        const latencyMs = Math.max(0, clock() - startedAt);
        const inputTokens = finiteOrUndefined(result.usage?.inputTokens);
        const outputTokens = finiteOrUndefined(result.usage?.outputTokens);
        const finishReason =
          typeof result.finishReason === 'string'
            ? mapFinishReason(result.finishReason)
            : undefined;
        runtime.report({
          executionId,
          latencyMs,
          ...(inputTokens === undefined ? {} : { inputTokens }),
          ...(outputTokens === undefined ? {} : { outputTokens }),
          ...(finishReason === undefined ? {} : { finishReason }),
        });
        return result;
      } catch (error) {
        runtime.report({
          executionId,
          error: true,
          finishReason: 'error',
          latencyMs: Math.max(0, clock() - startedAt),
        });
        throw error;
      }
    },
    async wrapStream({ doStream, params }): Promise<StreamResultLike> {
      const executionId = executionIdOf(params);
      if (executionId === undefined) {
        // Same contract as wrapGenerate: without the stashed id the outcome cannot
        // be attributed, so the call proceeds unreported.
        return await doStream();
      }
      const startedAt = clock();
      let result: StreamResultLike;
      try {
        result = await doStream();
      } catch (error) {
        runtime.report({
          executionId,
          error: true,
          finishReason: 'error',
          latencyMs: Math.max(0, clock() - startedAt),
        });
        throw error;
      }
      // Aggregate signals harvested from the terminal 'finish' part.
      let inputTokens: number | undefined;
      let outputTokens: number | undefined;
      let finishReason: FinishReason | undefined;
      const inspectPart = (part: unknown): void => {
        if (typeof part !== 'object' || part === null) {
          return;
        }
        const record = part as StreamPartLike;
        if (record.type !== 'finish') {
          return;
        }
        inputTokens = finiteOrUndefined(record.usage?.inputTokens);
        outputTokens = finiteOrUndefined(record.usage?.outputTokens);
        if (typeof record.finishReason === 'string') {
          finishReason = mapFinishReason(record.finishReason);
        }
      };
      let reported = false;
      const reportOnce = (outcome: Omit<ExecutionOutcome, 'executionId'>): void => {
        if (reported) {
          return;
        }
        reported = true;
        runtime.report({ executionId, ...outcome });
      };
      const successOutcome = (): Omit<ExecutionOutcome, 'executionId'> => ({
        latencyMs: Math.max(0, clock() - startedAt),
        ...(inputTokens === undefined ? {} : { inputTokens }),
        ...(outputTokens === undefined ? {} : { outputTokens }),
        ...(finishReason === undefined ? {} : { finishReason }),
      });
      const inner: unknown = result.stream;
      if (
        typeof inner !== 'object' ||
        inner === null ||
        typeof (inner as ReadableStream<unknown>).getReader !== 'function'
      ) {
        // A non-stream result violates the structural contract (for example another
        // middleware replaced the stream). Nothing can be observed, but the pending
        // entry must still drain, so the latency-only outcome is reported.
        reportOnce(successOutcome());
        return result;
      }
      const reader = (inner as ReadableStream<unknown>).getReader();
      // An identity wrap instead of a bare pipeThrough(TransformStream): parts pass
      // through untouched, but pull() owns the read so the completion, error, and
      // cancel paths can each report exactly once. A plain TransformStream has no
      // error hook, and a stream that errors mid-flight would leak its pending
      // entry, the exact defect this wrapper exists to prevent.
      const stream = new ReadableStream<unknown>({
        pull: async (controller): Promise<void> => {
          let step: ReadableStreamReadResult<unknown>;
          try {
            step = await reader.read();
          } catch (error) {
            reportOnce({
              error: true,
              finishReason: 'error',
              latencyMs: Math.max(0, clock() - startedAt),
            });
            controller.error(error);
            return;
          }
          if (step.done) {
            reportOnce(successOutcome());
            controller.close();
            return;
          }
          inspectPart(step.value);
          controller.enqueue(step.value);
        },
        cancel: async (reason: unknown): Promise<void> => {
          // The consumer abandoned the stream. The execution still ran, so what was
          // observed up to this point is reported; without a finish part the reason
          // maps to 'other' rather than inventing an error.
          reportOnce({
            latencyMs: Math.max(0, clock() - startedAt),
            ...(finishReason === undefined ? { finishReason: 'other' } : { finishReason }),
          });
          await reader.cancel(reason);
        },
      });
      return { ...result, stream };
    },
  };
}
