# Hermes Agent bridge recipe

Drive a Hermes Agent installation with NoeticOS recommendations through the `noeticos serve` HTTP bridge. The Hermes gateway runs on Python, so the integration is process-to-process over loopback HTTP, not in-process.

## The honest constraint first

Hermes Agent hooks cannot mutate runtime parameters in-process: a hook script observes a session, it does not get to rewrite the live agent loop's configuration. The bridge therefore works at one of two levels:

1. **Config-rewrite level** (this recipe): fetch a recommendation before a session, rewrite `config.yaml`, let Hermes pick the values up.
2. **Proxy level**: if you front the model API with your own proxy, apply per-call values (`temperature`, `topP`) there. That is out of scope for this recipe.

Hermes Agent v0.16.0 ships `agent.max_turns` (default 90) and `api_max_retries` (3) in `config.yaml`, with no temperature knob and no adaptive tuning. The `compression.*` section hot-reloads; the `agent.*` keys are read at startup, so `max_turns` and retry recommendations apply on the next session, not mid-session. Key names below follow v0.16.0; check your installed `config.yaml` if your version differs.

## 1. Run the bridge

```bash
noeticos serve \
  --port 4377 \
  --host 127.0.0.1 \
  --token "$NOETICOS_TOKEN" \
  --state "$HOME/.hermes/noeticos-state.json"
```

- Binds loopback only; bodies are capped at 1 MB.
- With `--token`, every endpoint except `GET /healthz` requires `Authorization: Bearer <token>`.
- With `--state`, learned profiles survive restarts (flushed every 30 seconds and on shutdown).

Liveness check for supervisors:

```bash
curl -sf http://127.0.0.1:4377/healthz
```

## 2. Pre-session hook: recommend and rewrite config.yaml

Wire this as the shell hook (or gateway webhook) that runs before a Hermes session starts. It posts to `/recommend`, extracts the agent-loop parameters, and rewrites the config with `yq`.

```bash
#!/usr/bin/env bash
set -euo pipefail

HERMES_CONFIG="$HOME/.hermes/config.yaml"
STATE_DIR="$HOME/.hermes/noeticos"
mkdir -p "$STATE_DIR"

REC=$(curl -s -X POST http://127.0.0.1:4377/recommend \
  -H "Authorization: Bearer $NOETICOS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"agentId":"hermes-main","kind":"tool-execution"}')

EXECUTION_ID=$(printf '%s' "$REC" | jq -r .executionId)
MAX_TURNS=$(printf '%s' "$REC" | jq -r .parameters.maxTurns)
RETRY_BUDGET=$(printf '%s' "$REC" | jq -r .parameters.retryBudget)
CONTEXT_SHARE=$(printf '%s' "$REC" | jq -r .parameters.contextShare)

# Agent-loop parameters: applied on the next session (agent.* is read at startup).
yq -i ".agent.max_turns = $MAX_TURNS" "$HERMES_CONFIG"
yq -i ".agent.api_max_retries = $RETRY_BUDGET" "$HERMES_CONFIG"

# contextShare maps onto the hot-reloaded compression section: it is the fraction
# of the context window the agent may fill before trimming, which is exactly what
# a compression trigger threshold expresses. This change takes effect live.
yq -i ".compression.trigger_threshold = $CONTEXT_SHARE" "$HERMES_CONFIG"

# Persist the executionId for the post-session report.
printf '%s' "$EXECUTION_ID" > "$STATE_DIR/current-execution-id"
```

Notes:

- `kind: "tool-execution"` asserts the task class for a tool-driven Hermes session; pass a different `TaskKind` per workflow, or omit `kind` and send `promptLength` and `toolsAvailable` to let the classifier decide. Prompt content does not need to leave the gateway.
- `temperature` and `topP` are also present in the recommendation but Hermes v0.16.0 exposes no temperature knob in `config.yaml`; they only become applicable at proxy level.

## 3. Post-session hook: report the outcome

After the session ends, report what happened under the saved executionId. Pull the measurements from your session accounting (hermes-otel spans, gateway logs, or token accounting).

```bash
#!/usr/bin/env bash
set -euo pipefail

STATE_DIR="$HOME/.hermes/noeticos"
EXECUTION_ID=$(cat "$STATE_DIR/current-execution-id")

curl -s -X POST http://127.0.0.1:4377/report \
  -H "Authorization: Bearer $NOETICOS_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{
    \"executionId\": \"$EXECUTION_ID\",
    \"latencyMs\": $SESSION_LATENCY_MS,
    \"costUsd\": $SESSION_COST_USD,
    \"turns\": $SESSION_TURNS,
    \"finishReason\": \"stop\"
  }"
```

Optional but valuable: include `"qualityScore": <0..1>` when the gateway can grade the session, and `"toolCalls": [{"name": "...", "ok": true, "argumentsHash": "..."}]` so the engine can detect tool loops (3 or more consecutive identical name-plus-hash calls), the exact failure mode that burns 12 to 50 dollars on a hardcoded `max_turns` of 90.

If a session never reports (crash, kill), nothing breaks: the engine ignores unknown and missing outcomes, and unreported recommendations are evicted FIFO at the pending cap.

## 4. Inspect what was learned

```bash
curl -s "http://127.0.0.1:4377/profiles?agentId=hermes-main&kind=tool-execution" \
  -H "Authorization: Bearer $NOETICOS_TOKEN" | jq

curl -s "http://127.0.0.1:4377/decisions?agentId=hermes-main&limit=10" \
  -H "Authorization: Bearer $NOETICOS_TOKEN" | jq
```

Every promotion and rollback in `/decisions` carries its numeric evidence and reasoning, so the answer to "why is `max_turns` 16 now" is one curl away.

## 5. What to expect

With Hermes defaults, `max_turns` 90 is far above the default NoeticOS grid (`[8, 16, 32, 64]`); the first sessions run on the grid baseline of 32 and the engine canaries its way from there. Exploration only ever happens inside the canary cohort (10% of sessions by default) and changes exactly one parameter at a time, so the worst case for any single session is one parameter one grid step away from the current baseline, and every change is reversible and audited.
