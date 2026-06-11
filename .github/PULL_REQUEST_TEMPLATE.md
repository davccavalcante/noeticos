<!--
Thank you for the PR. Please fill EVERY section honestly. Empty sections are
not acceptable; write "N/A" with a one-line reason if a section truly does
not apply. The maintainer reads every PR line-by-line; complete context is
faster for everyone than back-and-forth questions.

Read .github/CONTRIBUTING.md before opening this PR if you haven't yet.
-->

## Summary

<!-- One paragraph: what does this PR do and why? Avoid restating the diff;
state the intent. -->

## Affected surface

<!-- Tick every surface touched. -->

- [ ] engine core (`src/core/*`, `src/bandit/*`, `src/rollout/*`, `src/classify/*`, `src/stats/*`, `src/audit/*`)
- [ ] otel ingestion (`src/otel/*`)
- [ ] vercel middleware (`src/vercel/*`)
- [ ] integrations bridges (`src/integrations/*`)
- [ ] web / edge entries (`src/web/*`, `src/edge/*`)
- [ ] state backends (`src/state/*`)
- [ ] CLI (`src/cli/*`)
- [ ] tests (`tests/*`)
- [ ] examples (`examples/*`)
- [ ] CI / workflows (`.github/*`)
- [ ] docs (README / SPEC / CHANGELOG / PRIVACY / SECURITY)
- [ ] package metadata (`package.json`, configs)

## What changed

<!-- Summarize the change in 1-5 bullets. Include the key file paths and
one-line rationale per bullet. -->

- `<file>` - <change + rationale>

## SemVer impact

<!-- Per SPEC.md section 7.2. Tick the highest applicable level. -->

- [ ] No published impact (docs-only / internal refactor / CI-only)
- [ ] Patch - bug fix, internal refactor, dependency patch
- [ ] Minor - new optional export, new optional field, new TaskKind / DecisionType / TelemetryEvent variant
- [ ] Major - renaming/removing an export, signature change, snapshot schema change, CLI flag removal, weakened benchmark bound

If Major: include a `MIGRATING.md` update and explain the migration path below.

## Statistical and benchmark impact

<!-- The tuning benchmark (tests/integration/tuning-benchmark.test.ts) is a
permanent quality contract. -->

- [ ] No change to statistical procedures or benchmark bounds
- [ ] A benchmark bound or calibration comment moved (link the prior Issue per CONTRIBUTING section 4.3 and justify below)

## Test plan

<!-- Demonstrate the change works. Cover both "what now passes that did not
before" and "what continues to pass that should". -->

### Test counts

<!-- Run `pnpm test` locally and report: -->

- Before this PR: 135 / 135 passing (baseline at 1.0.0)
- After this PR: <X> / <Y> passing

### New tests

<!-- For any fix-able bug or new optional surface, list the regression test(s)
added. Tests must fail pre-fix and pass post-fix (CONTRIBUTING section 6). -->

- `tests/<path>/<file>.test.ts` - `<test name>`: <what it asserts>

## Documentation

<!-- Tick every doc updated. -->

- [ ] `README.md`
- [ ] `SPEC.md` (if public surface or procedures changed)
- [ ] `CHANGELOG.md` (new section - DO NOT edit historical entries)
- [ ] `PRIVACY.md` / `SECURITY.md` (if data handling or threat model changed)
- [ ] `.github/CONTRIBUTING.md` or `.github/RELEASING.md` (if process changed)
- [ ] N/A - docs-only PR / internal refactor / no public surface change

## License + contributor agreement

- [ ] DCO sign-off on every commit (`git commit -s`).
- [ ] If the PR is substantive per CLA.md section 2: PR title prefixed `[CLA-signed]`.
- [ ] If the PR introduces new third-party deps: licenses compatible with Apache 2.0 verified (and the zero-runtime-deps invariant preserved for the published package).

## Anything else

<!-- Design rationale, follow-up PR plans, simulate transcript diffs, anything
the maintainer should know. -->
