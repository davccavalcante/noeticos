/**
 * vercel-ai-sdk-middleware: NoeticOS as a Vercel AI SDK middleware.
 *
 * `noeticosMiddleware` returns a structural `LanguageModelV3Middleware`: it
 * imports nothing from `ai`, so this example compiles and runs without the SDK
 * installed, and the real SDK types satisfy it as-is.
 *
 * In a real application the wiring is one call (SDK v6):
 *
 * ```ts
 * import { wrapLanguageModel } from 'ai';
 *
 * const model = wrapLanguageModel({
 *   model: baseModel, // any LanguageModelV3, e.g. from a provider package
 *   middleware: noeticosMiddleware(runtime, { agentId: 'support-agent' }),
 * });
 * // then use `model` with generateText / streamText as usual
 * ```
 *
 * Below, the two middleware hooks are exercised directly against a fake model
 * call, which is exactly what `wrapLanguageModel` does internally:
 * - `transformParams` asks the engine for a recommendation, applies the learned
 *   `temperature` and `topP`, and stashes the executionId under
 *   `providerOptions.noeticos`.
 * - `wrapGenerate` measures the call and reports the outcome, so the loop closes
 *   without any further code.
 *
 * Note: `maxTurns`, `retryBudget`, and `contextShare` are agent-loop parameters,
 * not per-call options. Consume them from `runtime.recommend()` where you drive
 * your own loop; the middleware never writes them into SDK call options.
 *
 * Run (in a project with @takk/noeticos installed): node --import tsx vercel-ai-sdk-middleware.ts
 */

import { createNoeticOS } from '@takk/noeticos';
import { noeticosMiddleware } from '@takk/noeticos/vercel';

async function main(): Promise<void> {
  const runtime = createNoeticOS({ objective: 'balanced', seed: 7 });

  const middleware = noeticosMiddleware(runtime, {
    agentId: 'support-agent',
    // kind: 'summarization', // optional: skip the classifier with an asserted kind
  });

  // The same prompt shape the SDK passes through call options.
  const params = {
    prompt: [
      {
        role: 'user',
        content: [{ type: 'text', text: 'Summarize this incident thread for the on-call engineer.' }],
      },
    ],
    maxOutputTokens: 512,
  };

  // 1. transformParams: the engine classifies the call and applies tunables.
  const transformed = await middleware.transformParams({ params });
  console.log('temperature applied:', transformed.temperature);
  console.log('topP applied:', transformed.topP);
  console.log('executionId stashed:', transformed.providerOptions?.noeticos?.executionId);

  // 2. wrapGenerate: the inner model call is measured and reported automatically.
  const result = await middleware.wrapGenerate({
    params: transformed,
    doGenerate: async () => ({
      // Structural mirror of the SDK generate result; only these fields are read.
      usage: { inputTokens: 640, outputTokens: 210 },
      finishReason: 'stop',
    }),
  });
  console.log('finishReason:', result.finishReason);

  // The outcome arrived at the engine under the stashed executionId.
  console.log('pending executions after report:', runtime.inspect().pendingExecutions);

  await runtime.close();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
