# Privacy Notice - NoeticOS

This notice describes what data `@takk/noeticos` processes when you install
and run it. NoeticOS is an npm library and CLI that runs entirely inside your
own process and infrastructure. The author (David C Cavalcante, Takk Innovate
Studio) hosts no service, sees no traffic, and collects no telemetry.

Last updated: **2026-06-11**.

---

## 1. What NoeticOS is, and is not

NoeticOS is a self-hosted library. There is no cloud component, no account, no
sign-up. The author does not host any endpoint that your installation talks
to. The package has zero runtime dependencies, so there is no transitive code
that could phone home either. The only I/O NoeticOS can perform is the state
file **you** explicitly configure and the local HTTP listener **you**
explicitly start with `noeticos serve`.

---

## 2. Data NoeticOS processes (in your process)

### 2.1 Prompt text (classifier input only, never stored)

`recommend()` optionally accepts the raw prompt of a task. It is used for one
purpose: deterministic task classification, locally, in memory. Prompt content
is never stored beyond the classification call, never written to a state
snapshot, never included in a decision log entry, and never carried in a
telemetry event. Callers who prefer not to pass prompts at all can supply
`kind`, `promptLength`, `toolsAvailable`, or `metadata` instead; the engine
degrades gracefully with sparse input.

### 2.2 Execution outcomes (aggregate operational signals)

`report()` accepts operational measurements: latency, cost, token counts,
turn counts, finish reasons, per-tool success flags, and an optional quality
score. Tool-call arguments are never accepted; loop detection works on a
caller-computed hash (`argumentsHash`), so the arguments themselves never
reach the engine.

### 2.3 Learned state (in memory by default)

Per (agent, task class) pair, NoeticOS keeps bandit arm statistics (counts,
discounted reward moments, confidence bounds), running cost and latency
quantile markers, experiment state, and the decision log. With no state
backend configured this lives only in process memory and is discarded on
exit.

### 2.4 Persisted state (only if you configure a backend)

If you pass `state: fileState({ path })` (or run `noeticos serve --state`),
NoeticOS writes a `StateSnapshot` (version 1) to the path you specify.

**Aggregate statistics only.** A snapshot contains arm counts, mean rewards,
confidence bounds, quantile markers, execution counters, and experiment
descriptors, keyed by the agent ids and task classes you used. It never
contains prompt content, tool arguments, model outputs, or any other raw task
material. This is a structural property of the snapshot schema, not a
filtering step.

The snapshot does reveal operational metadata (which agent ids exist, how
many executions each task class served, which parameter values won). Treat it
according to your own threat model; a typical project adds it to
`.gitignore`.

### 2.5 What `/otel` ingestion reads

The `@takk/noeticos/otel` functions read only these span fields: the span
name, the OTLP timestamps, the status code, and the attributes
`gen_ai.agent.name`, `gen_ai.agent.id`, `service.name`,
`gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`,
`gen_ai.usage.cost` (fallback `llm.usage.cost`), `gen_ai.request.tools.count`,
`gen_ai.request.model`, `gen_ai.request.temperature`, `gen_ai.request.top_p`,
`gen_ai.response.finish_reasons`, `gen_ai.agent.turns` (fallback
`gen_ai.conversation.turns`), `gen_ai.tool.name`, and
`gen_ai.tool.call.arguments` (reduced immediately to a deterministic hash).
Span events, which can carry message bodies under the GenAI conventions, are
deliberately ignored, and `taskFromSpan` always leaves the prompt field
undefined. Prompt and completion content is never extracted from spans.

### 2.6 The `serve` listener

`noeticos serve` binds `127.0.0.1` by default and exposes the engine to
processes on the same machine. Request bodies are capped at 1 MB, and with
`--token` every endpoint except `GET /healthz` requires bearer
authentication. The server stores nothing beyond the engine state described
above. If you choose to bind a non-loopback host, transport security and
network policy are your responsibility.

---

## 3. Data NoeticOS does NOT collect

- **No telemetry to the author.** Zero outbound network calls. The telemetry
  surface is an in-process listener API you subscribe to yourself; nothing
  leaves your process unless you wire it to leave.
- **No analytics.** No usage statistics, no error reporting, no install
  pings.
- **No third-party code that phones home.** Zero runtime dependencies. The
  optional peer dependencies are the author's own sibling packages
  (`@takk/keymesh`, `@takk/modelchain`, `@takk/behavioralai`), are only
  loaded if you install and import them, and follow the same self-hosted
  posture.
- **No credentials.** NoeticOS handles no API keys, tokens, or secrets of any
  kind. The only secret it can ever see is the bearer token you choose for
  `serve`, which is compared and never stored.

---

## 4. GDPR and LGPD posture

NoeticOS processes operational statistics about software agents, not end-user
personal data. Prompts that may contain personal data are accepted only as
transient classifier input under your control and are never persisted. If
your application routes personal data through tasks, that flow is governed by
your own privacy program, not by NoeticOS.

For operators in scope of **GDPR** or **LGPD**:

- **Minimization.** Persistence is opt-in and limited to aggregate
  statistics; request and response bodies are never logged or stored.
- **Right to erasure.** Delete the state file you configured to remove all
  persisted NoeticOS state. Agent ids are caller-chosen; using pseudonymous
  agent ids keeps snapshots free of direct identifiers.
- **Portability and inspectability.** The snapshot is a single JSON document;
  `noeticos inspect --state <path>` renders it human-readable without
  modifying it.
- **Records of processing.** The append-only decision log documents every
  runtime parameter change with timestamp, evidence, and reasoning, which
  operators can incorporate into their own accountability documentation.

---

## 5. Security disclosure

See [`SECURITY.md`](./SECURITY.md) for vulnerability reporting and the threat
model. The author can be reached at **davcavalcante@proton.me** (preferred)
or **say@takk.ag** (Takk relay) with the `[SECURITY]` prefix.

---

## 6. Children

NoeticOS is developer infrastructure with no user-facing surface and no
features directed at children. It is not intended for direct use by children
under 13.

---

## 7. Changes to this notice

This file is versioned in git alongside the code. Material changes are
announced in [`CHANGELOG.md`](./CHANGELOG.md) and in the release notes on
GitHub.

---

## 8. Contact

- General (author): **davcavalcante@proton.me**
- Takk relay: **say@takk.ag**
- LinkedIn: <https://linkedin.com/in/hellodav>
- Security: **davcavalcante@proton.me** (or **say@takk.ag**) with the
  `[SECURITY]` prefix (see [`SECURITY.md`](./SECURITY.md)).
