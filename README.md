# NoeticOS NPM

[![npm version](https://img.shields.io/npm/v/%40takk%2Fnoeticos?color=blue)](https://www.npmjs.com/package/@takk/noeticos)
[![license](https://img.shields.io/badge/license-Apache_2.0-blue.svg)](./LICENSE)
[![types](https://img.shields.io/badge/types-TypeScript-blue)](./SPEC.md)
[![node](https://img.shields.io/badge/node-%E2%89%A520-success)](./package.json)
[![tests](https://img.shields.io/badge/tests-159%20passing-brightgreen)](./SPEC.md)
[![coverage](https://img.shields.io/badge/coverage-92%25-brightgreen)](./SPEC.md)
[![runtime deps](https://img.shields.io/badge/runtime%20deps-0-success)](./package.json)

<p align="center">
  <img src="https://raw.githubusercontent.com/davccavalcante/noeticos/main/assets/noeticos.png" alt="NoeticOS" width="500">
</p>

[![Star History Chart](https://api.star-history.com/svg?repos=davccavalcante/noeticos&type=timeline&legend=top-left)](https://www.star-history.com/#davccavalcante/noeticos&type=timeline&legend=top-left)

> NoeticOS: the JIT compiler for agents. Adaptive runtime tuning for production agents, with a deterministic canary cohort, statistical promotion gates, and a complete decision audit log.

Model routers decide which model to call. NoeticOS learns the remaining runtime parameters per task class, while the agent keeps serving traffic: it classifies every task (10 task kinds plus an unknown fallback, with explicit `kind` override), learns the optimal `model`, `temperature`, `topP`, `maxTurns`, `retryBudget`, and `contextShare` per (agent, task class) pair with discounted UCB1-tuned bandits, explores only through a deterministic canary cohort (default 10% of traffic) that differs from the baseline in exactly one parameter at a time, promotes a candidate only with statistical evidence (Welch t test with an exact tail, Bonferroni alpha spending across the look budget, plus confidence-bound separation), rolls back early on harm (exact one-sided binomial tail test and a Wilson quality floor) and on futility, and records every decision in an append-only audit log with numeric evidence and human-readable reasoning.

The core safety invariant: exploration never touches baseline traffic.

The gap is real. Every agent framework ships static configuration: Hermes Agent v0.16.0 exposes `agent.max_turns` (default 90) and `api_max_retries` (3) in `config.yaml`, with no temperature knob and no adaptive tuning; Vercel AI SDK 6, Genkit middleware (May 2026), Mastra, and LangGraph all configure per call, statically or by hand-written rules; model routers (Martian, Not Diamond, RouteLLM, Portkey) decide one dimension, the model, and stop there. Meanwhile the production failure mode is well documented: agents burning 12 to 50 dollars in tool loops because `maxTurns` was hardcoded too high, or failing tasks because it was hardcoded too low. Bandit-based runtime tuning exists in research (AutoRAG-HP, ComRAG, EDT); as of June 2026 we found no shipping npm package that does it.

**Core promise:** zero runtime dependencies, two-function integration (`recommend` then `report`), ergonomic TypeScript types, ESM + CJS dual distribution, neutral builds for web and edge, SLSA provenance on every release.

---

## See it work

The package ships a deterministic demonstration. One seed yields one byte-identical transcript: the engine clock is pinned and all workload noise flows from a single seeded stream, so the run below is reproducible exactly.

```bash
npx @takk/noeticos simulate --executions 2400 --seed 7
# from a source checkout: node --import tsx src/cli/index.ts simulate --executions 2400 --seed 7
```

```
decision canary.started factual-qa temperature 0.4 -> 0
decision canary.started creative-writing temperature 0.4 -> 0
decision canary.started extraction temperature 0.4 -> 0
decision canary.promoted factual-qa temperature 0.4 -> 0
decision canary.started factual-qa topP 1 -> 0.9
decision canary.rolledback factual-qa topP 0.9 -> 1
decision canary.started factual-qa maxTurns 32 -> 8
[... 7 more decision lines ...]
decision canary.started extraction maxTurns 32 -> 8
decision canary.promoted extraction maxTurns 32 -> 8
[... 9 more decision lines ...]
--- summary ---
executions: 2400
decisions: 25 (2 promoted, 9 rolled back)
canary share observed: 0.115
per-kind promoted parameters:
factual-qa: temperature=0 topP=1 maxTurns=32 retryBudget=1 contextShare=0.6
creative-writing: temperature=0.4 topP=1 maxTurns=32 retryBudget=1 contextShare=0.6
extraction: temperature=0.4 topP=1 maxTurns=8 retryBudget=1 contextShare=0.6
counterfactual: identical workload and noise, static baseline versus tuned
static baseline: cost=$17.6000 quality=0.879
noeticos tuned: cost=$8.0000 quality=0.925
delta: cost -54.5% quality +5.3%
```

Read the transcript as the product. The engine found that factual question answering wants temperature 0 and promoted it on evidence. It tried `topP` 0.9, found no improvement, and rolled it back instead of guessing. It discovered that the extraction workload pays per agent turn, promoted `maxTurns` 8, and cut the counterfactual bill by 54.5%, on this synthetic workload, while quality went up 5.3%. Nine candidates were rolled back; none of them ever ran on baseline traffic.

---

## Install

```bash
pnpm add @takk/noeticos
# or: npm install @takk/noeticos
# or: yarn add @takk/noeticos
# or: bun add @takk/noeticos
```

Zero runtime dependencies. The sibling bridges (`@takk/keymesh`, `@takk/modelchain`, `@takk/behavioralai`) are optional peer dependencies and are never imported at runtime; the bridges are structural.

---

## Quickstart

Execution flows in two phases correlated by an `executionId`: ask before the task, report after it.

```ts
import { createNoeticOS, type Recommendation } from '@takk/noeticos';

const runtime = createNoeticOS({ objective: 'cost' });

// Stand-in for your agent loop: run the task with the recommended parameters
// (temperature, topP, maxTurns, ...) and measure what happened.
async function runAgent(
  prompt: string,
  parameters: Recommendation['parameters'],
): Promise<{ latencyMs: number; costUsd: number; turns: number }> {
  void prompt;
  void parameters;
  return { latencyMs: 1840, costUsd: 0.004, turns: 12 };
}

const prompt = 'Summarize this incident thread for the on-call engineer.';

// Phase 1: recommend. Synchronous and allocation-light, safe on the hot path.
const rec = runtime.recommend({ agentId: 'support-agent', prompt });

// rec.taskClass      -> 'summarization' (classifier, or pass kind to override)
// rec.parameters     -> { temperature: 0.4, topP: 1, maxTurns: 32, retryBudget: 1, contextShare: 0.6 }
// rec.cohort         -> 'baseline' | 'canary'
// rec.reasoning      -> human-readable explanation of the choice

const result = await runAgent(prompt, rec.parameters);

// Phase 2: report. Missing fields simply contribute nothing to the reward.
runtime.report({
  executionId: rec.executionId,
  latencyMs: result.latencyMs,
  costUsd: result.costUsd,
  turns: result.turns,
  finishReason: 'stop',
  qualityScore: 0.92, // optional explicit signal; otherwise quality is derived implicitly
});
```

That is the whole integration. Profiles, decisions, and telemetry are available at any time through `profileOf`, `decisions`, `inspect`, and `on`. A complete runnable version is in [examples/node-basic.ts](./examples/node-basic.ts).

---

## Objective presets

The reward of one execution combines three terms under the active weights. Pick a preset or pass custom `ObjectiveWeights` (normalized to sum to 1).

| Preset | quality | cost | latency |
|---|---|---|---|
| `balanced` (default) | 0.5 | 0.25 | 0.25 |
| `cost` | 0.35 | 0.5 | 0.15 |
| `latency` | 0.35 | 0.15 | 0.5 |
| `quality` | 0.7 | 0.15 | 0.15 |

Custom weights must each be finite and non-negative; any individual negative or non-finite weight throws `NoeticosError` `ERR_INVALID_INPUT` even when the sum is positive.

Cost and latency are normalized against running per-class P5..P95 bands. When `costUsd` is absent but token counts are present, the cost term normalizes total tokens (input plus output) against a dedicated per-(agent, task class) token quantile band, so token-only deployments still learn cost; dollars and tokens never share a band. The token band is persisted in snapshots as optional `tokenP5`/`tokenP95` (older snapshots restore a fresh band).

---

## Tunable parameters

Each dimension is a discrete arm grid. Override any grid through `parameters`, pin values through `constraints.baseline`, and exclude dimensions through `constraints.locked`.

| Parameter | Default grid | Meaning |
|---|---|---|
| `model` | none (tuned only when candidates are declared) | Provider model id, passed through verbatim |
| `temperature` | `[0, 0.2, 0.4, 0.7, 1.0]` | Sampling temperature |
| `topP` | `[0.9, 1.0]` | Nucleus sampling |
| `maxTurns` | `[8, 16, 32, 64]` | Maximum agent loop turns |
| `retryBudget` | `[0, 1, 3]` | Retries allowed per execution |
| `contextShare` | `[0.4, 0.6, 0.8]` | Fraction of the context window the agent may fill before trimming |

Engine defaults: `canaryShare` 0.1, `minSamplesPerArm` 8, `promotionConfidence` 0.95, `seed` 7, `maxAgents` 1000, `maxPendingExecutions` 10000.

---

## The safety invariant

NoeticOS never explores on baseline traffic. Formally, for every recommendation:

1. A baseline-cohort recommendation carries exactly the currently promoted parameter set, nothing else, ever.
2. A canary-cohort recommendation differs from the promoted set in exactly one parameter, the experiment `focus`, so any reward difference is attributable to that one parameter.
3. Cohort assignment is deterministic (a seeded hash over the execution id), not best-effort sampling.
4. A candidate becomes baseline only through `canary.promoted`, which requires statistical evidence at the configured confidence; every promotion and rollback is an append-only `DecisionEntry` carrying that evidence.

This is not a documentation aspiration. Benchmark scenario S7 replays 1000 executions across a live promotion boundary and asserts zero violations in CI, permanently. See [SPEC.md](./SPEC.md) for the formal contract and the full benchmark suite.

---

## Vercel AI SDK middleware

`@takk/noeticos/vercel` ships a structural `LanguageModelV3Middleware`: it imports nothing from `ai`, so it compiles and runs with or without the SDK installed, and the real SDK types satisfy it as-is.

```ts
import { createNoeticOS } from '@takk/noeticos';
import { noeticosMiddleware } from '@takk/noeticos/vercel';
import { wrapLanguageModel } from 'ai';

const runtime = createNoeticOS({ objective: 'balanced' });

const model = wrapLanguageModel({
  model: baseModel, // any LanguageModelV3
  middleware: noeticosMiddleware(runtime, { agentId: 'support-agent' }),
});
```

`transformParams` obtains a recommendation and applies the per-call tunables (`temperature`, `topP`); `wrapGenerate` (`generateText`) and `wrapStream` (`streamText`) measure the call and report token usage, latency, and the finish reason under the same `executionId`, including the error path; `wrapStream` reads usage and finishReason from the terminal finish stream part, passes every part through untouched, and reports exactly once on completion, error, or cancellation, so streamed executions never leak pending entries. `maxTurns`, `retryBudget`, and `contextShare` are agent-loop parameters, not per-call options: consume them from `runtime.recommend()` where you drive your own loop. See [examples/vercel-ai-sdk-middleware.ts](./examples/vercel-ai-sdk-middleware.ts).

---

## OpenTelemetry GenAI ingestion

`@takk/noeticos/otel` reads plain span-shaped objects following the GenAI semantic conventions, with no OpenTelemetry package import. It accepts spans exported by hermes-otel, telemetry recorded by the Vercel AI SDK (`experimental_telemetry`), or any flattened OTLP JSON payload.

```ts
import { createNoeticOS } from '@takk/noeticos';
import { outcomeFromSpan, parametersFromSpan, taskFromSpan } from '@takk/noeticos/otel';

const runtime = createNoeticOS();

// Live: recommend before the model call, report from the finished span.
const rec = runtime.recommend(taskFromSpan(span, 'support-agent'));
// ... execute with rec.parameters ...
runtime.report(outcomeFromSpan(rec.executionId, span, toolSpans));

// Drift check: what production actually ran versus what NoeticOS would recommend.
const deployed = parametersFromSpan(span); // { model, temperature, topP }
```

Privacy by design: prompt and completion content is never extracted from spans. Only aggregate signals (token counts, latency, finish reasons, tool names, and a deterministic hash of tool arguments for loop detection) reach the engine. See [examples/otel-ingest.ts](./examples/otel-ingest.ts).

---

## The serve bridge

`noeticos serve` exposes one shared engine over local HTTP so non-Node runtimes can drive it: `POST /recommend`, `POST /report`, `GET /profiles`, `GET /decisions`, `GET /healthz`. It binds `127.0.0.1` by default and refuses to start on a non-loopback host without `--token` (exit 1; `--insecure-no-token` overrides with a loud warning). POST endpoints require `Content-Type: application/json` (415 otherwise). Request bodies are capped at 1 MB. `--token` bearer auth covers every endpoint except `GET /healthz` and is compared in constant time. OPTIONS preflight answers 204 with CORS headers only when both `--token` and `--cors-origin` are set (403 otherwise, no CORS headers). `--state` enables persistence.

```bash
noeticos serve --port 4377 --token secret --state ./noeticos-state.json
```

```bash
curl -s -X POST http://127.0.0.1:4377/recommend \
  -H "Authorization: Bearer secret" \
  -H "Content-Type: application/json" \
  -d '{"agentId":"support-agent","kind":"summarization"}'
# -> {"executionId":"nx-1-...","parameters":{"temperature":0.4,...},"cohort":"baseline",...}

curl -s -X POST http://127.0.0.1:4377/report \
  -H "Authorization: Bearer secret" \
  -H "Content-Type: application/json" \
  -d '{"executionId":"nx-1-...","latencyMs":1840,"costUsd":0.004,"turns":12,"finishReason":"stop"}'
# -> {"ok":true}
```

This is the integration path for the Hermes Agent ecosystem, whose gateway runs on Python: a shell hook or gateway webhook posts to `/recommend` before a session and to `/report` after it, then rewrites `config.yaml` from the recommendation. The full recipe, including the honest constraints of that bridge, is in [examples/hermes-bridge.md](./examples/hermes-bridge.md).

---

## Family integrations

NoeticOS is a sibling of `@takk/keymesh` (key lifecycle), `@takk/modelchain` (model routing), and `@takk/behavioralai` (behavioral observability). Route with `@takk/modelchain`, rotate with `@takk/keymesh`, observe with `@takk/behavioralai`, tune with NoeticOS.

```ts
import { behavioralaiBridge, keymeshBridge, modelchainBridge } from '@takk/noeticos/integrations';
```

The shared safety theme: never run canary experiments while the world shifts for reasons unrelated to the parameter under test.

- `behavioralaiBridge(runtime, engine)` freezes tuning for an agent when the observability sibling reports critical drift, and releases it on recovery. Warnings intentionally change nothing; the rollout guardrails already absorb mild degradation.
- `keymeshBridge(runtime, client, { agentIds })` freezes tuning on `circuit.open` and `all.exhausted` (credentials in flux invalidate reward comparability) and releases on `key.rotated`.
- `modelchainBridge(runtime).preferredModelFor(agentId, kind)` is the read side: it feeds the learned model id into a routing strategy and returns `undefined` whenever the model dimension is inactive, so routing always has a fallback.

All bridges are structural: the siblings are optional peers, the published engine objects satisfy the local interfaces directly, and nothing is imported at runtime. See [examples/integrations-family.ts](./examples/integrations-family.ts).

---

## State and persistence

Learned state is in-memory by default. `memoryState()` and `fileState({ path })` implement the `StateBackend` contract; file saves are atomic (write to `path + '.tmp'`, then rename). `StateSnapshot` version 1 carries aggregate statistics only: arm counts, mean rewards, confidence bounds, and decision metadata. Prompt content is never written to a snapshot. Persistence is best-effort by contract: a failing backend never breaks recommendation traffic. See [examples/state-persistence.ts](./examples/state-persistence.ts).

---

## CLI

```bash
noeticos help        # first line "noeticos 1.0.0" is a CI contract
noeticos version     # prints 1.0.0; aliases --version, -v
noeticos simulate    # deterministic synthetic workload demonstrating that tuning pays
noeticos inspect     # human-readable view of a saved state snapshot
noeticos serve       # local HTTP bridge for non-Node runtimes
```

---

## Quality

- 159 tests across 12 files, verified on Node 22 and Node 24 (CI also runs Node 20).
- Coverage: 92.16% statements, 84.00% branches, 97.46% functions, 92.15% lines.
- Lint clean (Biome), typecheck clean (TypeScript strict with `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, `useUnknownInCatchVariables`), `publint` clean, `attw` all green.
- Bundle sizes (brotli): core 11.15 kB ESM / 11.29 kB CJS, `/otel` 863 B, `/vercel` 981 B, `/integrations` 595 B, `/web` 10.54 kB, `/edge` 10.54 kB.
- A 9-scenario tuning-quality benchmark runs in CI as a permanent contract: flat-landscape no-false-promotions, temperature convergence, harmful-candidate rollback, objective sensitivity, loop penalty, model-dimension cost win, the safety invariant, cohort distribution at 20000 draws, and a two-point flat landscape. Scenario S1 caught and forced the fix of a real multiple-peeking defect during development (promotions tested at full alpha on every report); scenario S9 caught and forced the fix of a zero-variance defect (all-identical canary windows under discrete rewards promoted pure noise; the gate now uses an exact t tail and falls back to an exact binomial test on zero-variance small samples). Both fixes are structurally enforced and the benchmark defends them forever.

See [SPEC.md](./SPEC.md) for the formal specification, the statistical procedures, the full public surface, and the stability promise.

---

## FAQ

**Does NoeticOS send data anywhere?**
No. Zero runtime dependencies, zero network calls of its own, zero telemetry to the author. It is a self-hosted library: the only I/O it can perform is the state file you explicitly configure and the `serve` listener you explicitly start (which binds `127.0.0.1` by default). See [PRIVACY.md](./PRIVACY.md).

**How is this different from a model router?**
A router (Martian, Not Diamond, RouteLLM, Portkey) decides one dimension: which model. NoeticOS learns up to six dimensions per (agent, task class), and the model dimension is optional. It answers the question routers do not ask: not just which model, but how to run the agent on this class of task. The two compose: `modelchainBridge` feeds the learned model preference into routing.

**What happens with low traffic?**
Slow convergence, by design. One experiment needs at least `minSamplesPerArm` (8) canary samples and concludes within the futility budget of 4x that, so at the default 10% canary share an experiment resolves within roughly 320 executions of its (agent, task class). Until then the defaults act as sane priors, baseline traffic always receives the current promoted values, and an experiment that cannot find evidence ends in a futility rollback, never a blind promotion. Low traffic delays learning; it never endangers the baseline.

**Can I lock parameters?**
Yes, at three levels. `constraints.locked` removes a dimension from tuning entirely (always served at its baseline, never canaried). `constraints.baseline` overrides the starting values. `freezeTuning(runtime, agentId, reason)` pauses all experiments for an agent at runtime, recorded as a `drift.frozen` decision with your reason (frozen tracks record nothing into bandits or the rollout), and `releaseTuning` resumes them: it abandons any in-flight experiment, resets its rollout statistics so post-release comparisons start clean, and records one `tuning.released` decision per known task class.

**Does the decision log help with the EU AI Act?**
NoeticOS is not a compliance product and does not by itself make a system compliant. What it contributes is an append-only decision log in which every runtime parameter change carries a timestamp, the numeric statistical evidence, and human-readable reasoning, plus state snapshots that contain aggregate statistics only. Teams assembling record-keeping and logging documentation under the EU AI Act can use the decision log as supporting evidence that runtime changes were controlled, evidence-gated, and reconstructible, provided they ship the entries to durable storage (see the next question). Treat it as one input to a compliance process, not the process.

**Is the decision log persisted with the learned state?**
No. The decision log is in-memory only, capacity 1000 entries with a monotonic `seq` across evictions, and `flush()` does not write it: a `StateSnapshot` carries learned aggregate statistics, never log entries, so a process restart starts an empty log. For a durable audit trail, subscribe to `decision.recorded` telemetry and ship every entry to your own store.

**Does the classifier work for non-English prompts?**
Not well, by design honesty: the built-in heuristics are English-first keyword and structure signals. Non-English prompts classify as `unknown` and tune under the unknown class until you pass `kind` explicitly, which is the supported path for non-English workloads (the engine then learns per task class exactly as it does for English traffic).

**What happens during warmup?**
Recommendations are never blocked. Before learning starts, the baseline cohort receives the configured baselines (the middle of each grid by default, or your `constraints.baseline` overrides) and only the canary cohort pays the exploration cost. A parameter profile reports `phase: 'learning'` until every arm has samples, then `'canary'` and `'stable'`.

**Is it deterministic? Can I replay decisions?**
Cohort assignment is fully deterministic: a seeded PRNG generates execution ids and a hash maps each id to a cohort bucket, so two engines with the same seed and call sequence produce identical cohort sequences (benchmark scenario S8 asserts this). `noeticos simulate` transcripts are byte-identical per seed. Every decision in the log carries the evidence needed to re-derive it.

**Do I have to send prompts to the engine?**
No. The classifier accepts prompt text as a local-only signal, but works from `kind`, `promptLength`, `toolsAvailable`, and `metadata` alone. Prompt content is never stored beyond classification, never serialized into snapshots or decisions, and never extracted from OTel spans.

**What if I never call `report()`?**
The engine still serves the promoted values; it just learns nothing. Unreported recommendations are evicted FIFO once `maxPendingExecutions` is reached, with a `limit.reached` telemetry event. Unknown or late execution ids in `report()` are ignored by design, so a stray report cannot corrupt the statistics.

**Which runtimes are supported?**
Node >= 20 for the core and the CLI. `@takk/noeticos/web` and `@takk/noeticos/edge` are neutral builds (no `fileState`, no Node built-ins) for browsers, Cloudflare Workers, Vercel Edge, Deno, and Bun.

---

## Contributing

See [.github/CONTRIBUTING.md](./.github/CONTRIBUTING.md) for the contributor guide. Substantive proposals open a GitHub Issue first; trivial fixes can go straight to a PR. All commits require DCO sign-off (`git commit -s`). Non-trivial contributions are governed by the [Contributor License Agreement](./CLA.md).

## Community and support

- **Issues and feature requests.** Open a GitHub issue at [`davccavalcante/noeticos/issues`](https://github.com/davccavalcante/noeticos/issues). Include the package version, a minimal reproduction, expected versus actual behavior, and, where relevant, the related `DecisionEntry` records or the `runtime.inspect()` snapshot.
- **Security disclosures.** Do NOT open public issues for vulnerabilities. Follow [`SECURITY.md`](./SECURITY.md): contact `davcavalcante@proton.me` (or `say@takk.ag`) with the `[SECURITY]` prefix.
- **Code of Conduct.** This project follows the [Contributor Covenant 2.1](./CODE_OF_CONDUCT.md). Participation in any project space (issues, PRs, discussions) implies agreement.
- **Contributions.** All non-trivial contributions go through the [Contributor License Agreement](./CLA.md). Tests, lint, typecheck, and build must be green before review (`pnpm verify`).

---

## Author

Created by **David C Cavalcante** (Takk Innovate Studio): [davcavalcante@proton.me](mailto:davcavalcante@proton.me) (preferred) | [say@takk.ag](mailto:say@takk.ag) (Takk relay) | [linkedin.com/in/hellodav](https://linkedin.com/in/hellodav) | [x.com/davccavalcante](https://x.com/davccavalcante) | [noeticos.takk.ag](https://noeticos.takk.ag/)

NoeticOS is the adaptive runtime layer of a broader portfolio of NPM packages targeting Massive Intelligence (IM) native infrastructure for 2026-2030, built at Takk Innovate Studio. Adjacent research by the author, the MAIC, HIM (Hybrid Intelligence Model), and NHE (Non-Human Entity) frameworks on Massive Intelligence (IM) ecosystems, is published independently of this codebase: [PhilPapers profile](https://philpeople.org/profiles/david-cortes-cavalcante) | [Hugging Face](https://huggingface.co/TeleologyHI) | [takk.ag](https://takk.ag).

---

## Sponsors

Join the journey as the portfolio continues to ship Massive Intelligence (IM) native infrastructure. Your support is the cornerstone of this work.

- Sponsor on GitHub: [github.com/sponsors/davccavalcante](https://github.com/sponsors/davccavalcante)
- Other channels are listed in [.github/FUNDING.yml](./.github/FUNDING.yml)

---

## Privacy

NoeticOS runs entirely inside your own process and infrastructure. It makes no outbound calls to the author, collects no telemetry, and ships no analytics. Prompt content is classifier input only and is never stored; snapshots carry aggregate statistics exclusively. See [PRIVACY.md](./PRIVACY.md) for the full data-handling notice.

---

## License

Licensed under the **Apache License 2.0**. See [LICENSE](./LICENSE) for the full text and [NOTICE](./NOTICE) for attribution. You may use, modify, and distribute the code under the terms of that license, including its patent grant and attribution requirements.
