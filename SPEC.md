# @takk/noeticos - Technical Specification

**Version:** 1.0.0
**Status:** Stable
**License:** Apache-2.0

This document is the binding contract between `@takk/noeticos` (NoeticOS) and its consumers. Behavior described here is covered by SemVer: breaking changes require a major version bump and a deprecation cycle (see [SemVer policy](#7-stability-promise)).

---

## 1. Purpose

NoeticOS is adaptive runtime intelligence for production Massive Intelligence (IM) agents. It:

- **Classifies** every task into a task class (10 task kinds plus an unknown fallback, explicit `kind` override).
- **Learns** the optimal `model`, `temperature`, `topP`, `maxTurns`, `retryBudget`, and `contextShare` per (agent, task class) pair with discounted UCB1-tuned bandits.
- **Explores** only inside a deterministic canary cohort that differs from the baseline in exactly one parameter at a time.
- **Promotes** a candidate only with statistical evidence, and **rolls back** early on harm or futility.
- **Records** every decision in an append-only audit log with numeric evidence and human-readable reasoning.

It is library-shaped, not service-shaped: no central server, no SaaS dependency, zero runtime dependencies. The `noeticos serve` command is an optional local HTTP bridge over the same engine.

---

## 2. Public surface

### 2.1 Entry points

Six subpath exports, each with separate `import` (ESM) and `require` (CJS) conditions and matching `.d.ts` / `.d.cts` files:

| Subpath | Default | Use |
|---|---|---|
| `.` | `./dist/index.{js,cjs}` | Core engine, state backends, classifier, reward, errors, types |
| `./otel` | `./dist/otel/index.{js,cjs}` | OpenTelemetry GenAI semantic-convention span ingestion |
| `./vercel` | `./dist/vercel/index.{js,cjs}` | Vercel AI SDK `LanguageModelV3Middleware` (structural) |
| `./integrations` | `./dist/integrations/index.{js,cjs}` | Bridges to `@takk/behavioralai`, `@takk/keymesh`, `@takk/modelchain` |
| `./web` | `./dist/web/index.{js,cjs}` | Browser build: full core surface except `fileState` |
| `./edge` | `./dist/edge/index.{js,cjs}` | Edge build (Cloudflare Workers, Vercel Edge, Deno, Bun): same surface as `./web` |
| `./package.json` | `./package.json` | Manifest access for tooling |

A `noeticos` binary is exposed via `package.json#bin -> ./dist/cli/index.js`.

### 2.2 Core API (`.`)

#### `createNoeticOS(options?: NoeticOSOptions): NoeticOS`

Creates an engine. When a state backend is configured the previous snapshot is restored asynchronously after construction; corrupt entries are skipped one by one so a damaged snapshot can never prevent startup.

#### `NoeticOS`

```ts
interface NoeticOS {
  recommend(task: TaskDescriptor): Recommendation;          // synchronous, hot-path safe
  report(outcome: ExecutionOutcome): void;                  // unknown executionIds ignored
  profileOf(agentId: string, taskClass?: TaskKind): readonly ClassProfile[];
  decisions(filter?: { agentId?: string; limit?: number }): readonly DecisionEntry[];
  agents(): readonly string[];
  inspect(): RuntimeSnapshot;
  on(listener: TelemetryListener): () => void;              // returns unsubscribe
  flush(): Promise<void>;                                   // force-save to the backend
  close(): Promise<void>;                                   // flush + detach, idempotent
}
```

#### `NoeticOSOptions` and defaults

| Option | Default | Constraint |
|---|---|---|
| `objective` | `'balanced'` | preset name or `ObjectiveWeights` (custom weights normalized to sum 1) |
| `parameters` | per-dimension default grids (section 2.3) | non-empty, duplicate-free arm lists |
| `constraints` | none | `locked` dimensions and `baseline` overrides; a non-locked baseline must be a declared arm |
| `qualityFloor` | none | `minSuccessRate`, `minQualityScore` in [0, 1] |
| `canaryShare` | `0.1` | in [0, 1] |
| `minSamplesPerArm` | `8` | positive integer |
| `promotionConfidence` | `0.95` | strictly in (0, 1) |
| `seed` | `7` | drives the deterministic PRNG for execution ids and cohort assignment |
| `maxAgents` | `1000` | positive integer; beyond it, new agents get static defaults without learning |
| `maxPendingExecutions` | `10000` | positive integer; FIFO eviction with a `limit.reached` event |
| `state` | none | any `StateBackend`; persistence is best-effort |
| `clock` | platform wall clock | injectable epoch-milliseconds source |

Invalid options throw `NoeticosError` with code `ERR_INVALID_INPUT` synchronously.

#### Other core exports

| Export | Kind | Contract |
|---|---|---|
| `freezeTuning(runtime, agentId, reason)` | function | Pauses all experiments for the agent; recorded as `drift.frozen` per known task class with the reason. Throws `ERR_INVALID_INPUT` on a foreign runtime object. |
| `releaseTuning(runtime, agentId)` | function | Reverses `freezeTuning`; abandons any in-flight experiment, resets its rollout statistics so post-release comparisons start clean, appends one `tuning.released` decision entry per known task class (audit symmetry with `drift.frozen`), emits the `tuning.released` telemetry event, and is a no-op when the agent is not frozen. |
| `memoryState()` | function | In-memory `StateBackend`. |
| `fileState({ path })` | function | Node file `StateBackend`; atomic save (`path + '.tmp'` then rename); load errors carry `ERR_STATE_LOAD` or `ERR_STATE_VERSION`. Node built-ins are imported lazily so the core stays runtime-neutral. |
| `TaskClassifier` | class | Deterministic, dependency-free text and structure heuristics; `classify(task)` returns a `Classification` with named signals; caller-asserted kinds report confidence 1. |
| `DEFAULT_TASK_KINDS` | const | The 10 task kinds plus the `'unknown'` fallback, in declaration order. |
| `DEFAULT_PARAMETER_SPACE` | const | The default grids of section 2.3. |
| `computeReward(ctx: RewardContext)` | function | The reward composition of section 4.2; returns `{ reward, quality }`, both in [0, 1]. |
| `OBJECTIVE_PRESETS` | const | The four presets of section 4.2. |
| `resolveWeights(objective?)` | function | Preset name or custom weights to normalized `ObjectiveWeights`. Each custom weight must be finite and non-negative; any individual negative or non-finite weight throws `NoeticosError` `ERR_INVALID_INPUT` even when the sum is positive, and a non-positive sum throws as well. |
| `NoeticosError` | class | `Error` subclass with a stable machine-readable `code`; `NoeticosError.invalid(message)` builds an `ERR_INVALID_INPUT`. |

#### Exported types

`ArmStats`, `Classification`, `ClassProfile`, `DecisionEntry`, `DecisionType`, `ExecutionOutcome`, `ModelCandidate`, `NoeticOS`, `NoeticOSOptions`, `ObjectivePreset`, `ObjectiveWeights`, `ParameterConstraints`, `ParameterName`, `ParameterProfile`, `ParameterSpace`, `ParameterValue`, `QualityFloor`, `Recommendation`, `RewardContext`, `RuntimeSnapshot`, `StateBackend`, `StateSnapshot`, `TaskDescriptor`, `TaskKind`, `TelemetryEvent`, `TelemetryListener`, `ToolCallOutcome`.

Key unions:

```ts
type TaskKind =
  | 'factual-qa' | 'creative-writing' | 'code-generation' | 'extraction'
  | 'summarization' | 'translation' | 'planning' | 'tool-execution'
  | 'conversation' | 'classification' | 'unknown';

type ParameterName = 'model' | 'temperature' | 'topP' | 'maxTurns' | 'retryBudget' | 'contextShare';

type DecisionType =
  | 'canary.started' | 'canary.promoted' | 'canary.rolledback'
  | 'drift.frozen' | 'tuning.released';
```

`'tuning.released'`: a tuning freeze was lifted via `releaseTuning`; one entry per known task class, symmetric with `'drift.frozen'`. Every variant has an emitting code path; the log never documents decisions the engine cannot make.

`TelemetryEvent` is a discriminated union on `type`, six variants: `'recommendation.issued'`, `'outcome.recorded'`, `'decision.recorded'`, `'loop.detected'`, `'limit.reached'`, `'tuning.released'`. Listeners are invoked synchronously; a throwing listener is caught and ignored.

### 2.3 Default parameter grids

| Dimension | Default arms |
|---|---|
| `temperature` | `[0, 0.2, 0.4, 0.7, 1.0]` |
| `topP` | `[0.9, 1.0]` |
| `maxTurns` | `[8, 16, 32, 64]` |
| `retryBudget` | `[0, 1, 3]` |
| `contextShare` | `[0.4, 0.6, 0.8]` |
| `model` | none; the dimension is active only when `ModelCandidate[]` is declared |

The default baseline of each numeric dimension is the middle of its grid; the default model baseline is the first declared candidate.

### 2.4 `/otel` API

Structural by design: the functions read plain span-shaped objects (`GenAISpanLike`, OTLP JSON field names, attributes flattened into a record) and import no OpenTelemetry package. Compatible with hermes-otel spans and Vercel AI SDK telemetry.

| Export | Contract |
|---|---|
| `GenAISpanLike` | Minimal structural span: `name`, `attributes`, `startTimeUnixNano`, `endTimeUnixNano`, `status.code`, `events`. Unknown fields ignored. |
| `taskFromSpan(span, fallbackAgentId?)` | Agent id resolved from `gen_ai.agent.name`, `gen_ai.agent.id`, `service.name`, then the fallback, then `'otel-agent'`. `promptLength` approximated as `gen_ai.usage.input_tokens * 4`. `prompt` is always left undefined: content is never read from spans. |
| `outcomeFromSpan(executionId, span, toolSpans?)` | Latency from the OTLP timestamps (number or string nanoseconds, negative durations discarded); tokens from `gen_ai.usage.*`; cost from `gen_ai.usage.cost` falling back to `llm.usage.cost`; turns from `gen_ai.agent.turns` falling back to `gen_ai.conversation.turns`; finish reason mapped from `gen_ai.response.finish_reasons` with span status 2 winning as `'error'`; tool calls mapped with a deterministic FNV-1a `argumentsHash` so loops stay detectable without the arguments ever leaving the process. |
| `parametersFromSpan(span)` | The deployed `model`, `temperature`, `topP` from `gen_ai.request.*`, for diffing production configuration against recommendations. |

### 2.5 `/vercel` API

| Export | Contract |
|---|---|
| `NoeticosMiddleware` | `{ middlewareVersion: 'v3', transformParams, wrapGenerate, wrapStream }`, structurally compatible with the Vercel AI SDK v6 `LanguageModelV3Middleware`. Imports nothing from `ai`. |
| `noeticosMiddleware(runtime, { agentId, kind?, clock? })` | `transformParams` classifies the call (asserted `kind` or best-effort prompt text, capped at 4000 characters, classifier input only), applies recommended `temperature` and `topP`, and stashes the `executionId` under `providerOptions.noeticos`. `wrapGenerate` (`generateText`) measures latency, then reports token usage and the mapped finish reason on success, or `error: true` with `finishReason: 'error'` before rethrowing. `wrapStream` (`streamText`) closes the same loop for streamed calls: it reads usage and the finish reason from the terminal finish stream part, passes every part through untouched, and reports exactly once on completion, error, or cancellation, so streamed executions never leak pending entries. If `providerOptions.noeticos.executionId` is missing (middleware bypassed or reordered), the call proceeds unreported. `maxTurns`, `retryBudget`, and `contextShare` are agent-loop parameters consumed via `recommend()`, never written into call options. |

### 2.6 `/integrations` API

All bridges are structural; the siblings are optional peer dependencies and are never imported. The freeze and release helpers reject runtime objects not created by `createNoeticOS`.

| Export | Contract |
|---|---|
| `behavioralaiBridge(runtime, engine, options?)` | Subscribes to the sibling's telemetry. `drift.detected` with `severity 'critical'` for agent X freezes tuning for X (reason names the drifted feature); `drift.recovered` releases it unless `releaseOnRecovery: false`; warnings and info change nothing by design; events without an `agentId` are ignored. Returns the unsubscribe function. |
| `BehavioralAILike`, `BehavioralTelemetryEventLike`, `BehavioralaiBridgeOptions` | Structural mirror types satisfied by the published sibling engine as-is. |
| `keymeshBridge(runtime, client, { agentIds })` | `circuit.open` and `all.exhausted` freeze tuning for every configured agent (credentials in flux invalidate reward comparability); `key.rotated` releases them. Returns a disposer that unsubscribes every handler. |
| `KeymeshLike`, `KeymeshEventLike`, `KeymeshCredentialEventType`, `KeymeshBridgeOptions` | Structural mirror types; keymesh subscribes per event name and unsubscribes through `off`. |
| `modelchainBridge(runtime)` | Returns `ModelchainBridge`. Pure read side, never subscribes, never writes, safe per request. |
| `ModelchainBridge.preferredModelFor(agentId, kind)` | The current promoted model id for the pair, or `undefined` when the model dimension is inactive (no candidates, locked, or pair unobserved), so callers always have a routing fallback. |

### 2.7 `/web` and `/edge`

Both re-export the full core surface except `fileState`, explicitly (no wildcard), so a Node-only export can never leak into neutral builds. No `node:` imports are reachable from these entries.

### 2.8 CLI

```
noeticos help        # also -h, --help, and the default with no arguments
noeticos version     # also --version and -v
noeticos simulate    # --executions <n> --seed <n> --objective <name> --canary-share <x>
noeticos inspect     # --state <path>
noeticos serve       # --port <n> --host <addr> --token <secret> --cors-origin <o> --insecure-no-token --state <path> --seed <n> --objective <name>
```

- The first line of `noeticos help` output is exactly `noeticos 1.0.0`. This is a CI contract; the version segment tracks the package version.
- `version` prints the package version (`1.0.0`); `--version` and `-v` are aliases.
- `simulate` is deterministic: pinned engine clock, one seeded noise stream, byte-identical transcripts per seed. It ends with a counterfactual replay (identical workload and noise, static middle-of-grid baseline versus the tuned profile) and a cost and quality delta.
- `inspect` hydrates a throwaway engine behind a write-blocking backend; the file on disk is never touched.
- `serve` defaults: port `4377`, host `127.0.0.1`. Endpoints: `GET /healthz` (always unauthenticated), `POST /recommend`, `POST /report`, `GET /profiles?agentId=&kind=`, `GET /decisions?agentId=&limit=`. The server refuses to start on a non-loopback host without `--token` (exit 1); `--insecure-no-token` overrides the refusal with a loud warning. With `--token`, every endpoint except `GET /healthz` requires `Authorization: Bearer <token>`, compared in constant time. POST endpoints require `Content-Type: application/json` (415 otherwise). Request bodies are capped at 1 MB (413 beyond it). OPTIONS preflight answers 204 with CORS headers only when both `--token` and `--cors-origin` are set (403 otherwise, no CORS headers). With `--state`, learned state is flushed every 30 seconds and on SIGINT/SIGTERM shutdown.
- Unknown commands print a hint to stderr and exit with code 2; flag errors exit 2; runtime errors exit 1.

### 2.9 Error codes

| Code | Raised by |
|---|---|
| `ERR_INVALID_INPUT` | Rejected caller input anywhere in the engine, bridges, and stats functions |
| `ERR_STATE_LOAD` | `fileState().load()` on unreadable or unparsable files |
| `ERR_STATE_VERSION` | `fileState().load()` on a missing or unsupported snapshot version |

---

## 3. Architecture

```
+--------------------------------------------------------------+
| Caller                                                       |
|   const rec = runtime.recommend(task)                        |
|   ... run the task with rec.parameters ...                   |
|   runtime.report(outcome)                                    |
+------------------------------+-------------------------------+
                               v
+--------------------------------------------------------------+
| EngineCore (createNoeticOS)                                  |
|                                                              |
|  TaskClassifier      deterministic kind + confidence + signals|
|  ParameterBandit x6  one UCB1-tuned bandit per dimension     |
|                      per (agent, task class) track           |
|  SafeRollout         baseline vs candidate judge per         |
|                      experiment (promote / rollback / continue)|
|  P2Quantile x4       running P5/P95 of cost and latency      |
|  DecisionLog         append-only, capacity 1000, monotonic seq|
|  Rng (seeded)        execution ids and cohort assignment     |
|  Telemetry           synchronous listeners, isolated failures |
+------------------------------+-------------------------------+
                               v
+--------------------------------------------------------------+
| StateBackend (optional)   memoryState | fileState | custom   |
| StateSnapshot v1: aggregate statistics only                  |
+--------------------------------------------------------------+
```

### 3.1 Recommendation path

1. Classify the task (`kind` override wins with confidence 1).
2. Resolve the agent record; beyond `maxAgents` the engine answers with static defaults, creates no track, and emits `limit.reached` (degraded but memory-bounded).
3. Ensure a tuning track for the (agent, task class) pair; start an experiment if none is active and the agent is not frozen: the focus rotates through the active (non-locked) dimensions in the fixed order `model, temperature, topP, maxTurns, retryBudget, contextShare`, and the bandit picks the candidate (first never-pulled arm, otherwise the highest upper confidence bound, the promoted value excluded). Every start is logged as `canary.started`.
4. Assign the cohort deterministically: `FNV-1a(executionId) mod 10000 < canaryShare * 10000`. Execution ids come from the seeded engine PRNG plus a counter, so the cohort sequence is a pure function of the seed and the call sequence.
5. Serve parameters: promoted values for baseline, promoted values with exactly the focus parameter swapped to the candidate for canary.
6. Record the pending execution (epoch-tagged) and emit `recommendation.issued`.

### 3.2 Report path

1. Look up the pending execution; unknown, late, replayed, or fabricated ids are ignored (no trustworthy cohort attribution).
2. Detect tool-call loops: 3 or more consecutive calls with identical name and `argumentsHash`; emit `loop.detected`.
3. Update the per-class cost and latency P5/P95 quantile trackers.
4. Compute `{ reward, quality }` (section 4.2) and feed the reward to the focus bandit arm that was actually served, unless the agent is frozen (frozen tracks record nothing into bandits or the rollout).
5. If the report belongs to the current experiment epoch, feed the rollout judge; evaluation runs only on canary outcomes. `promote` makes the candidate the new promoted value (`canary.promoted`); `rollback` restores the baseline (`canary.rolledback`); both reset the rollout, end the experiment, and bump the epoch so stragglers from the old experiment cannot contaminate the next one.
6. Emit `outcome.recorded` with the scalar reward.

### 3.3 Audit

`DecisionLog` is append-only with capacity 1000 and a monotonic `seq` that survives eviction and serialization. Entries are frozen on append. Every entry carries `timestamp`, `type`, `agentId`, `taskClass`, `parameter`, `from`, `to`, human-readable `reasoning`, and numeric `evidence` (the means, bounds, sample counts, or p-values that justified the decision).

The in-memory decision log is not persisted by `flush()`: a `StateSnapshot` carries learned aggregate statistics, never the log entries themselves, so a process restart starts an empty log. Operators who need the decision history beyond the lifetime of the process (audit trails, record-keeping obligations) must subscribe to `decision.recorded` telemetry and ship entries to their own durable store.

### 3.4 State

`StateSnapshot` version 1 (`version: 1`, `savedAt`, opaque `agents` record) carries aggregate statistics only: bandit arms (value, discounted pulls, moment sums), rollout arm aggregates, quantile marker states (cost, latency, and the optional token band as `tokenP5`/`tokenP95`; older snapshots without the token fields restore a fresh token band), execution counts, focus index, and the active experiment descriptor. Prompt content, tool arguments, and any raw task material are never serialized. Restore is asynchronous after construction; `flush()` awaits it so an early flush cannot clobber a previous snapshot with an empty engine. Restore reconciles with the configured space: locked or inactive dimensions are dropped, newly active dimensions start fresh, agents with live traffic win over the snapshot, corrupt entries are skipped individually. Persistence is best-effort: a failing backend never breaks recommendation traffic.

---

## 4. Statistical procedures

All statistics are pure, allocation-light, and dependency-free (`Math` only).

### 4.1 Discounted UCB1-tuned bandit

Each arm keeps exponentially discounted moments with discount `gamma = 0.995`. The discount tick is global per bandit (discounted UCB in the Garivier-Moulines sense): every observation into any arm of a bandit first applies the discount to ALL arms of that bandit, then adds the observation to the observed arm. Unknown values are ignored entirely and apply no tick.

```
every arm:          n <- n * gamma, sum <- sum * gamma, sumSq <- sumSq * gamma
observed arm only:  n <- n + 1, sum <- sum + r, sumSq <- sumSq + r^2
mean  = sum / n
var   = max(0, sumSq / n - mean^2)
```

UCB1-tuned confidence radius (an arm with fewer than one effective pull gets radius 1, so it is always worth exploring):

```
radius = sqrt( (ln(max(total, 2)) / n) * min(1/4, var + sqrt(2 * ln(max(total, 2)) / n)) )
bounds = mean +/- radius
```

The global discount tick keeps the statistics tracking non-stationary workloads: idle arms lose effective count, their confidence bounds re-open, and a stale arm is re-challenged instead of staying frozen out. Candidate selection: first arm with fewer than one effective pull in declaration order (never pulled, or fully decayed: below one effective pull the bound is anchored at the stale mean, so ranking expired arms by upper bound would starve a formerly bad arm forever), otherwise the non-promoted arm with the highest upper bound; declaration order breaks ties deterministically. Measured on the stale-arm flip protocol: 10 of 10 seeds rediscover a flipped optimum within 16000 post-flip executions (worst seed 7638), up from 4 of 10 without the expired-arm re-exploration.

### 4.2 Reward composition and normalization

Per execution, with the active weights `w` (presets: balanced 0.5/0.25/0.25, cost 0.35/0.5/0.15, latency 0.35/0.15/0.5, quality 0.7/0.15/0.15 for quality/cost/latency; custom weights normalized to sum 1):

```
reward = w.quality * quality + w.cost * (1 - costNorm) + w.latency * (1 - latencyNorm)
```

- `quality`: the explicit `qualityScore` (clamped to [0, 1]) always wins. Otherwise derived implicitly: `error` or `finishReason 'error'` yields 0; else start at 1 and subtract 0.35 for `'length'`, 0.5 for `'content-filter'`, 0.15 if any tool call failed, and 0.1 per detected loop repeat capped at 0.4; clamp to [0, 1].
- `costNorm`, `latencyNorm`: the observed value normalized against the running per-class P5..P95 band, estimated online with P2 quantile estimators (one P5 and one P95 marker set each for cost and latency, serialized with the track). A missing value or a degenerate band scores the neutral 0.5, so an unobservable signal neither rewards nor punishes an arm.
- Token-based cost normalization: each (agent, task class) track keeps a second P2 quantile band over total tokens (input plus output). When `costUsd` is absent but token counts are present, the cost term normalizes total tokens against the token band instead; dollars and tokens never share a band, so mixed reporting cannot skew either scale. The token band is persisted in snapshots as optional `tokenP5`/`tokenP95` (older snapshots restore a fresh band).

### 4.3 Promotion test (Welch + Bonferroni look budget + bound separation)

The rollout judge re-evaluates only when a canary outcome is recorded, so one experiment examines the promotion test at most once per canary trial, up to `4 * minSamplesPerArm` times (the futility budget). Testing every look at the full alpha would promote pure noise, the multiple-peeking defect that benchmark scenario S1 caught during development. The procedure therefore is:

```
alpha        = 1 - promotionConfidence
alphaPerLook = alpha / (4 * minSamplesPerArm)        (Bonferroni across the look budget)

(t, df) = Welch t over the canary and baseline reward samples,
          df by Welch-Satterthwaite
p       = exact one-sided upper tail of t at df (regularized incomplete beta)
```

The tail is exact: `P(T > t) = I_x(df/2, 1/2) / 2` with `x = df / (df + t^2)`, evaluated via the regularized incomplete beta function (continued fraction), and the per-side critical values in the bound-separation check invert this exact tail by bisection, so the gate spends exactly its alpha. (The previous normal-tail bound, documented as conservative, underestimated the true tail by 5x to 15x at low degrees of freedom.)

Promotion requires all of:

1. `canaryTrials >= minSamplesPerArm`,
2. `p < alphaPerLook` and the canary mean strictly above the baseline mean,
3. confidence-bound separation: the canary mean's one-sided lower t bound at `alphaPerLook` must exceed the baseline mean's one-sided upper t bound at `alphaPerLook`.

Zero-variance guard: when either side reports zero sample variance with fewer than 30 trials, the t machinery is refused (a small all-identical sample under a discrete reward distribution proves nothing about means) and the promotion question falls back to the exact binomial upper tail on the success indicator: promote only when `P(X >= canarySuccesses | canaryTrials, (baselineSuccesses + 1) / (baselineTrials + 2)) < alphaPerLook` and the canary mean is strictly above the baseline mean.

The whole experiment's false-promotion probability stays at or below `1 - promotionConfidence`.

### 4.4 Early rollback (exact binomial tail)

An execution counts as a success when its quality term is at least 0.5. After the sample gate, the canary failure count is tested against the baseline failure rate with add-one smoothing:

```
pBaselineFail = (baselineFailures + 1) / (baselineTrials + 2)
pWorse        = exact one-sided binomial upper tail P(X >= canaryFailures)
                for X ~ Binomial(canaryTrials, pBaselineFail)
rollback when pWorse < alpha
```

The tail is computed exactly in log space (log-gamma terms combined with streaming log-sum-exp), not by normal approximation, so small canary cohorts are judged correctly.

### 4.5 Wilson quality floor

When `qualityFloor.minSuccessRate` is configured, the canary's success rate is summarized by the upper bound of a Wilson score interval at z = 1.96. If even that optimistic bound is below the floor, the canary is rolled back regardless of its composite reward. An empty cohort has bound 1 and can never be condemned by the floor.

### 4.6 Futility bound

Every experiment is bounded: after `4 * minSamplesPerArm` canary trials without a promotion, the candidate is rolled back with reasoning `no significant improvement within the trial budget`. No experiment runs forever, and the rollback asymmetry is deliberate: a missed improvement costs less than a regression served to baseline traffic.

### 4.7 Evaluation order

Per `evaluate()`: sample gate, quality floor, early binomial rollback, Welch promotion test with bound separation, futility budget, then continue.

---

## 5. The safety invariant (formal contract)

For every recommendation issued by an engine `E` with promoted parameter assignment `P(agent, class)` at the moment of issue:

1. **Baseline purity.** If `cohort = 'baseline'`, then `parameters = P(agent, class)` exactly. No exploration value is ever served to the baseline cohort.
2. **Single-difference canary.** If `cohort = 'canary'`, then `parameters` differs from `P(agent, class)` in exactly one dimension, and that dimension equals the recommendation's `focus`.
3. **Deterministic assignment.** Cohort membership is a pure function of the engine seed and the call sequence (`FNV-1a(executionId) mod 10000 < canaryShare * 10000`); two engines with equal seeds and call sequences produce identical cohort sequences.
4. **Evidence-gated transitions.** `P` changes only through a `canary.promoted` decision satisfying section 4.3, and every change of `P` (promotion or rollback) is recorded as an immutable `DecisionEntry` with its numeric evidence.
5. **Freeze dominance.** While an agent is frozen (`freezeTuning`, bridge-triggered or manual), no experiment starts, no verdict settles, and every cohort serves `P`.

Benchmark scenario S7 (section 6) checks properties 1 and 2 between recommend and report on every execution of a 1000-execution run that crosses a live promotion, and asserts zero violations. Scenario S8 checks property 3 at 20000 draws.

---

## 6. Quality contract: the tuning benchmark

Nine deterministic scenarios run in CI as a permanent contract (`tests/integration/tuning-benchmark.test.ts`). Each runs a real engine on a fixed seed with a pinned clock against a declared ground-truth outcome model with seeded gaussian noise (sigma 0.04; S9 reports its two-point mixture exactly, with no added noise). The bounds below are the defended regression limits; the quoted calibration values are the originally observed figures.

| # | Scenario | Defended bounds (CI assertions) |
|---|---|---|
| S1 | Flat landscape (every arm equal; any promotion is a false positive) | 0 promotions over 3000 executions; at least 1 futility rollback; canary share in [0.07, 0.13] (5.5 sigma corridor). Calibration: 0 promotions, 12 futility rollbacks, share 0.0997. Before the sequential correction of section 4.3 this scenario produced 1 to 8 false promotions on every probed seed. |
| S2 | Temperature convergence (factual-qa optimum at 0, 0.08 quality per grid step) | promoted temperature is 0 within 1500 executions; at least one `canary.promoted` to 0. Calibration: the promotion lands at execution 38 and survives (it moved from 37 by one when promotion verdicts became canary-look-only, so sensitivity is preserved while the look budget is honored). |
| S3 | Harmful candidate (temperature 0 scores 0.45, all else 0.85) | temperature 0 is never promoted; at least one rollback of candidate 0; baseline mean quality >= 0.8 over 2500 executions. The harmful value only ever ran on the canary cohort. |
| S4 | Objective sensitivity (maxTurns 8 vs 64: equal quality, 4x cost, 3x latency) | the cost objective promotes maxTurns 8; the quality objective's baseline mean quality is within 0.005 of the cost engine's and >= 0.8 over 2000 executions. |
| S5 | Loop penalty (retryBudget 3 induces 5 identical tool calls, implicit quality path) | `loop.detected` fires with repeats >= 3; retryBudget 3 is never promoted and is not the final promoted value over 1500 executions. |
| S6 | Model dimension (fast-y at quality 0.80 and a quarter of the cost of frontier-x at 0.84) | under the cost objective, fast-y is promoted over the forced frontier-x baseline within 2000 executions. |
| S7 | Safety invariant (live learning across a promotion boundary) | zero violations of baseline purity and single-difference canary over 1000 executions, with at least one promotion crossed. |
| S8 | Cohort distribution and determinism | canary share in [0.085, 0.115] over 20000 recommends (7 sigma corridor; calibration 0.09955); two same-seed engines produce identical cohort sequences for the first 100 recommends. |
| S9 | Two-point flat landscape (every arm draws quality from the same two-point mixture, 0.95 with probability 0.8 and 0.3 otherwise, reported exactly; any promotion is a false positive) | 0 promotions over 3000 executions on each of three pinned seeds (11, 42, 1337); at least 1 rollback per seed. Calibration: 0 promotions each, 12/14/13 rollbacks, canary shares 0.0970/0.0997/0.1073. Two-point rewards defeat the t machinery specifically: before the zero-variance guard of section 4.3, an all-identical canary window collapsed the per-side t bound onto its mean and promoted pure noise at a measured 15.2% per-experiment rate across 40 probe seeds (post-fix: 1.57%, within the promised 5%; the full 40-seed protocol lives in the acceptance probe, CI pins three seeds at exactly zero). |

A change that moves any of these bounds is a behavioral change of the engine and must be treated as such under SemVer, with the calibration history updated in the same commit.

---

## 7. Stability promise

### 7.1 What counts as the public API

For 1.0.0 onward:

- Every name exported from `.`, `./otel`, `./vercel`, `./integrations`, `./web`, and `./edge`.
- Every type, interface, function signature, and discriminated-union variant reachable from those exports.
- The CLI commands and flags of `noeticos`, the serve endpoint contract, and the first line of `noeticos help` (`noeticos 1.0.0`, version tracking the package).
- The `StateSnapshot` version 1 schema as a compatibility unit: a 1.x engine always loads a version 1 snapshot.
- The error codes of section 2.9.
- The statistical procedure parameters documented in section 4 (discount 0.995, futility factor 4, Wilson z 1.96, success threshold 0.5, penalty constants) and the benchmark bounds of section 6.

Not part of the public API: anything inside `src/` not re-exported from an entry point, the exact wording of `reasoning` strings, the layout of debug output, and the internal serialization details inside the opaque `agents` payload (beyond the guarantee that it round-trips and contains aggregate statistics only).

### 7.2 SemVer policy

| Change | Bump |
|---|---|
| Bug fix, internal refactor, doc-only | patch |
| New export, new optional field, new `TaskKind`, new `DecisionType`, new `TelemetryEvent` variant | minor |
| Renaming or removing an export, signature change, snapshot schema change, CLI flag removal, weakening a benchmark bound | major |

`TaskKind`, `ParameterName`, `Recommendation.cohort`, `ExecutionOutcome.finishReason`, `DecisionType`, and the `TelemetryEvent` discriminator are extensible in minor releases: new members may be added without a major version bump, so exhaustive switches over these types must keep a default branch and consumers must tolerate unknown members.

### 7.3 Deprecation policy

1. **Announce** in a minor release: `@deprecated` JSDoc plus a debounced runtime `console.warn`.
2. **Ship** the deprecated surface for at least one further minor of the same major, always alongside a non-deprecated path.
3. **Remove** only in the next major, accompanied by a `MIGRATING.md` recipe.

Security-driven exceptions ship in the next patch with a `### Security` CHANGELOG entry.

### 7.4 License and provenance invariants

- License stays Apache-2.0 within a major; `NOTICE` ships verbatim in the tarball.
- Every release is published with `--provenance` (SLSA attestation by GitHub Actions). Verify: `npm view @takk/noeticos@<version> --json | jq .dist.attestations`.

---

## 8. Limits and non-goals (1.0.0)

- **Per-coordinate ascent, not joint optimization.** Experiments tune one parameter at a time against the current promoted values of the others. Interactions between parameters (a temperature that is only good at a different `topP`) are found slowly or not at all. Joint optimization is a 1.1 research item.
- **The dimension set is fixed in 1.0.** Roadmap: reasoning-effort tuning (the provider `reasoning`/`thinking` budget knob) is the first planned new dimension for 1.1, added as a minor release under the `ParameterName` extensibility clause of section 7.2.
- **No cross-agent transfer.** Profiles are learned per (agent, task class) with no warm-starting from fleet statistics. A new agent starts from the configured baselines.
- **`qualityScore` is caller-supplied.** The implicit quality derivation covers error states, truncation, content filtering, tool failures, and loops, but the engine has no opinion on semantic output quality. Reward quality is bounded by the quality of the signals you report; see the trust boundary in [SECURITY.md](./SECURITY.md).
- **Single-process learning.** State backends persist and restore, but concurrent engines do not coordinate; the last flush wins. Multi-process operators should centralize through `noeticos serve`.
- **The classifier is heuristic and English-first.** Deterministic and explainable by design, but its keyword and structure signals are tuned for English prompts: non-English prompts classify as `unknown` and tune under the unknown class until `kind` is passed explicitly. Asserting `kind` is the supported path for non-English workloads, and callers with better knowledge should assert it regardless of language.
- **The decision log is capacity-bounded and in-memory only** (1000 entries, monotonic `seq` across evictions, never serialized into snapshots: `flush()` persists learned statistics, not the log, see section 3.3). Operators needing the full history subscribe to `decision.recorded` telemetry and ship entries to their own store.

---

## 9. Threat model summary

Full policy in [SECURITY.md](./SECURITY.md). In scope: decision-audit integrity (append-only, frozen entries, monotonic `seq`), state snapshot poisoning resistance (version validation, per-entry corruption isolation, freeze as containment), the serve surface (default loopback bind with a non-loopback token refusal, constant-time bearer auth, `Content-Type` enforcement, gated CORS preflight, 1 MB body cap), and supply chain (zero runtime dependencies, provenance, files allowlist). The core handles no credentials of any kind. Reward gaming through fabricated outcome reports is the operator's trust boundary: `report()` is as trustworthy as the process calling it, which is why unknown execution ids are ignored and why the audit log records evidence rather than assertions.

---

## 10. Test surface

- 159 tests across 12 files: unit suites for the stats primitives (binomial tail, regularized incomplete beta, Wilson, Welch, exact t tails and their bisection-inverted critical values, P2 quantiles, Welford, seeded RNG), the bandit, the classifier, the rollout judge, and audit plus state; integration suites for the engine, the CLI (including the help contract and serve endpoints), the OTel mapping, the Vercel middleware, the bridges, and the 9-scenario tuning benchmark of section 6.
- Verified on Node 22 and Node 24; CI also runs Node 20. All tests are offline and deterministic (seeded randomness, pinned clocks, no provider credentials).
- Coverage at 1.0.0: 92.16% statements, 84.00% branches, 97.46% functions, 92.15% lines.
- Bundle budgets enforced by `size-limit` (brotli): core 11.15 kB ESM / 11.29 kB CJS, `/otel` 863 B, `/vercel` 981 B, `/integrations` 595 B, `/web` 10.54 kB, `/edge` 10.54 kB.

See [TASK.md](./TASK.md) for the live deferred-work list.
