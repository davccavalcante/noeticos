# Changelog

All notable changes to `@takk/noeticos` are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html). Every entry carries a UTC timestamp.

## [1.0.0] - 2026-06-11T19:25:20Z

Initial stable release. NoeticOS: the JIT compiler for agents. Adaptive runtime intelligence for production Massive Intelligence (IM) agents: per-task-class parameter tuning with confidence-bound bandits, deterministic canary rollouts, automatic rollback, and a complete decision audit log. Zero runtime dependencies.

### Added

#### Core engine (`@takk/noeticos`)

- `createNoeticOS(options?)` factory behind the `NoeticOS` contract: `recommend` / `report` two-phase flow correlated by `executionId`, `profileOf`, `decisions`, `agents`, `inspect`, `on`, `flush`, `close`.
- Deterministic task classification into 10 task kinds plus an `unknown` fallback (`factual-qa`, `creative-writing`, `code-generation`, `extraction`, `summarization`, `translation`, `planning`, `tool-execution`, `conversation`, `classification`), explainable named signals, caller `kind` override at confidence 1. Exported as `TaskClassifier` and `DEFAULT_TASK_KINDS`.
- Discounted UCB1-tuned bandits (discount 0.995, applied as a global per-bandit tick in the Garivier-Moulines sense: every observation decays all arms, so idle arms lose effective count and stale optima are re-challenged) per parameter dimension per (agent, task class): `model` (only when `ModelCandidate[]` is declared), `temperature` `[0, 0.2, 0.4, 0.7, 1.0]`, `topP` `[0.9, 1.0]`, `maxTurns` `[8, 16, 32, 64]`, `retryBudget` `[0, 1, 3]`, `contextShare` `[0.4, 0.6, 0.8]`. Defaults exported as `DEFAULT_PARAMETER_SPACE`; constraints support `locked` dimensions and `baseline` overrides.
- Safe canary rollout: deterministic cohort assignment (default `canaryShare` 0.1) hashed from seeded execution ids, one-parameter-at-a-time experiments, promotion only on statistical evidence (Welch t test with an exact one-sided tail via the regularized incomplete beta function, Bonferroni alpha spending across the look budget with looks counted on canary outcomes only, confidence-bound separation with bisection-inverted exact critical values at `promotionConfidence` 0.95, and a zero-variance guard that refuses the t machinery for small all-identical samples and falls back to an exact binomial test on the success indicator), early rollback on an exact one-sided binomial tail test against the baseline failure rate, optional Wilson quality floor (z 1.96), futility rollback at 4x `minSamplesPerArm` (default 8). The core safety invariant: exploration never touches baseline traffic.
- Reward shaping: objective presets `balanced` / `cost` / `latency` / `quality` (0.5/0.25/0.25, 0.35/0.5/0.15, 0.35/0.15/0.5, 0.7/0.15/0.15 for quality/cost/latency), custom weights normalized (each weight must be finite and non-negative); cost and latency normalized against running per-class P5..P95 bands (P2 quantile estimators); token-based cost normalization through a dedicated per-class token band when `costUsd` is absent but token counts are present (dollars and tokens never share a band); implicit quality derivation from error state, finish reason, tool failures, and tool-call loop detection (3 or more consecutive identical calls), with explicit `qualityScore` always winning. Exported as `computeReward`, `OBJECTIVE_PRESETS`, `resolveWeights`.
- Append-only decision audit log: `canary.started`, `canary.promoted`, `canary.rolledback`, `drift.frozen`, `tuning.released` entries with timestamps, numeric evidence, and human-readable reasoning; monotonic sequence numbers; capacity 1000 with eviction-safe numbering. Every variant has an emitting code path.
- Telemetry: `recommendation.issued`, `outcome.recorded`, `decision.recorded`, `loop.detected`, `limit.reached`, `tuning.released`; synchronous listeners with isolated failures.
- Operational guards: `maxAgents` 1000 (degraded static-default recommendations beyond it), `maxPendingExecutions` 10000 (FIFO eviction), unknown execution ids ignored, injectable `clock`, seeded PRNG (`seed` 7).
- `freezeTuning(runtime, agentId, reason)` and `releaseTuning(runtime, agentId)` for operator and bridge control. Freezes are recorded as `drift.frozen` decisions and isolate the agent completely: frozen tracks record nothing into bandits or the rollout. Release abandons any in-flight experiment, resets its rollout statistics so post-release comparisons start clean, records one `tuning.released` decision per known task class, and emits the `tuning.released` telemetry event.
- `NoeticosError` with stable codes `ERR_INVALID_INPUT`, `ERR_STATE_LOAD`, `ERR_STATE_VERSION`.

#### State

- `memoryState()` and `fileState({ path })` backends behind the `StateBackend` contract; atomic file saves (temp file plus rename), lazy `node:` imports so the core stays runtime-neutral.
- `StateSnapshot` version 1: aggregate statistics only (arm counts, mean rewards, confidence bounds, quantile markers including the optional `tokenP5`/`tokenP95` token band, decision metadata), never prompt content. Asynchronous restore with per-entry corruption isolation (older snapshots without token fields restore a fresh token band); persistence is best-effort and never breaks recommendation traffic.

#### OpenTelemetry ingestion (`@takk/noeticos/otel`)

- Structural GenAI semantic-convention span readers, no OpenTelemetry package import: `taskFromSpan`, `outcomeFromSpan`, `parametersFromSpan`, type `GenAISpanLike`. Compatible with hermes-otel spans and Vercel AI SDK telemetry.
- Privacy by design: prompt and completion content is never extracted; tool-call arguments are reduced to a deterministic FNV-1a hash so loops stay detectable.

#### Vercel AI SDK middleware (`@takk/noeticos/vercel`)

- `noeticosMiddleware(runtime, { agentId, kind?, clock? })`: structural `LanguageModelV3Middleware`. `transformParams` applies recommended `temperature` and `topP` and stashes the `executionId` under `providerOptions.noeticos`; `wrapGenerate` (`generateText`) and `wrapStream` (`streamText`) measure and report, including the error path; `wrapStream` reads usage and the finish reason from the terminal finish stream part, passes every part through untouched, and reports exactly once on completion, error, or cancellation. `maxTurns`, `retryBudget`, and `contextShare` remain agent-loop parameters consumed via `recommend()`.

#### Family bridges (`@takk/noeticos/integrations`)

- `behavioralaiBridge`: critical behavioral drift freezes tuning for the drifting agent, recovery releases it; warnings change nothing by design.
- `keymeshBridge`: `circuit.open` and `all.exhausted` freeze tuning for the configured agents, `key.rotated` releases them; credentials in flux invalidate reward comparability.
- `modelchainBridge.preferredModelFor(agentId, kind)`: feeds the learned model id into routing, `undefined` whenever the model dimension is inactive.
- All bridges structural; siblings are optional peer dependencies and are never imported at runtime.

#### Web and edge builds

- `@takk/noeticos/web` and `@takk/noeticos/edge`: the full core surface except `fileState`, exported explicitly so Node-only exports can never leak into neutral builds. Runs in browsers, Cloudflare Workers, Vercel Edge, Deno, and Bun.

#### CLI

- Binary `noeticos` with `help`, `version`, `simulate`, `inspect`, `serve`. The first help line `noeticos 1.0.0` is a CI contract; `version` (aliases `--version`, `-v`) prints the package version.
- `simulate`: deterministic synthetic workload with byte-identical transcripts per seed, streaming decision lines, and a counterfactual cost and quality summary against the static baseline.
- `inspect`: human-readable snapshot view behind a write-blocking backend.
- `serve`: local HTTP bridge for non-Node runtimes (the Hermes Agent gateway pattern): `POST /recommend`, `POST /report`, `GET /profiles`, `GET /decisions`, `GET /healthz`; default `127.0.0.1:4377`; refuses to start on a non-loopback host without `--token` (`--insecure-no-token` overrides with a loud warning); optional `--token` bearer auth compared in constant time; `Content-Type: application/json` required on POST (415 otherwise); 1 MB body cap; OPTIONS preflight answered only when both `--token` and `--cors-origin` are set; `--state` persistence with periodic flush and clean shutdown.

#### Distribution

- Dual ESM + CJS bundles with separate `.d.ts` / `.d.cts` per entry point; `exports` map with split conditions; `sideEffects: false`.
- Zero runtime dependencies; `@takk/behavioralai`, `@takk/keymesh`, `@takk/modelchain` as optional peers.
- Bundle sizes (brotli): core 11.15 kB ESM / 11.29 kB CJS, `/otel` 863 B, `/vercel` 981 B, `/integrations` 595 B, `/web` 10.54 kB, `/edge` 10.54 kB.

### Quality

- 159 tests across 12 files, verified on Node 22 and Node 24 (CI matrix also includes Node 20). All offline and deterministic.
- Coverage: 92.16% statements, 84.00% branches, 97.46% functions, 92.15% lines.
- 9-scenario tuning-quality benchmark in CI as a permanent contract (flat-landscape no-false-promotions, temperature convergence, harmful-candidate rollback, objective sensitivity, loop penalty, model-dimension cost win, the safety invariant, cohort distribution at 20000 draws, two-point flat landscape). Scenario S1 caught a real multiple-peeking defect during development (promotions tested at full alpha on every report); scenario S9 caught a zero-variance defect (all-identical canary windows under discrete two-point rewards promoted pure noise at a measured 15.2% per-experiment rate). The promotion gate now spends alpha across canary-only looks, computes the exact t tail, and falls back to an exact binomial test on zero-variance small samples; the benchmark defends both fixes permanently.
- Lint clean (Biome), typecheck clean (TypeScript strict mode), `publint` clean, `attw` all green.

### Security

- Published with `--provenance` (SLSA attestation by GitHub Actions). Verify: `npm view @takk/noeticos --json | jq .dist.attestations`.
- No credential handling anywhere in the package; `serve` binds loopback by default, refuses non-loopback hosts without a token, compares bearer tokens in constant time, enforces `Content-Type: application/json` on POST, gates CORS preflight behind `--token` plus `--cors-origin`, and caps request bodies at 1 MB. See [SECURITY.md](./SECURITY.md) for the threat model.

### Licensing

- Apache License 2.0; `NOTICE` ships in the tarball alongside `LICENSE`.

### Engines

- Node `>=20.0.0`.
