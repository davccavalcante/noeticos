# Contributing to @takk/noeticos

Thanks for considering a contribution. This document is the canonical guide for proposing changes to `@takk/noeticos` (NoeticOS).

The project is open source under [Apache License 2.0](../LICENSE). The package surface, the statistical procedures, and the stability promise are documented in [SPEC.md](../SPEC.md).

---

## 1. Code of conduct

Be respectful, be precise, and assume good faith. The maintainer reads every issue and PR personally; disrespectful, harmful, or manipulative behavior is grounds for removal from the project. The full policy is in [CODE_OF_CONDUCT.md](../CODE_OF_CONDUCT.md).

---

## 2. Contributor license

Every contribution is governed by the Apache License 2.0 (the same license the project is published under). Sign off every commit with `git commit -s` (Developer Certificate of Origin):

```bash
git commit -s -m "fix(rollout): clamp wilson bound at zero trials"
```

The `-s` flag appends a `Signed-off-by:` trailer that attests you have the right to submit the change under Apache 2.0. PRs without DCO sign-off are not merged. Substantive features additionally follow the signed-CLA path in [CLA.md](../CLA.md).

---

## 3. Local setup

### 3.1 Prerequisites

- **Node 20, 22, or 24.** CI runs all three; the package is verified on 22 and 24. `.nvmrc` pins the local line.
- **pnpm 10.** The repo uses `pnpm` for install and scripts; `pnpm-lock.yaml` is the source of truth.
- **git** with `git commit -s` configured (DCO).

### 3.2 Clone and install

```bash
git clone https://github.com/davccavalcante/noeticos.git
cd noeticos
pnpm install
```

### 3.3 Verify locally

```bash
pnpm verify          # lint + typecheck + test + build + publint
# or run individually:
pnpm lint
pnpm typecheck
pnpm test
pnpm test:coverage
pnpm build
pnpm publint
pnpm attw            # published-types check
pnpm size            # bundle budgets (brotli)
```

Current baseline (verify before opening a PR): **159 tests passing across 12 files**. Coverage `92.16% statements / 84.00% branches / 97.46% functions / 92.15% lines`.

A quick sanity check that exercises the whole engine end to end:

```bash
node --import tsx src/cli/index.ts simulate --executions 2400 --seed 7
```

The transcript is byte-identical per seed; if your change alters it, explain why in the PR.

---

## 4. Branch and commit conventions

### 4.1 Branch names

- `fix/<short-slug>` - bug fixes
- `feat/<short-slug>` - new optional surface (minor bump)
- `docs/<short-slug>` - README/SPEC/CHANGELOG-only changes
- `chore/<short-slug>` - tooling, deps, CI
- `refactor/<short-slug>` - internal restructuring with no API change

Avoid PRs larger than ~500 LOC; split into smaller logically-coherent PRs.

### 4.2 Commit style

[Conventional Commits](https://www.conventionalcommits.org/) are encouraged but not enforced. What IS enforced:

- **One commit per logical change.** No `WIP` or `fixup` commits in the merged history.
- **Imperative subject up to 70 chars.** Body wrap at 72 cols.
- **DCO sign-off (`git commit -s`).**

### 4.3 What requires a discussion before coding

Open a GitHub Issue first if your change touches:

- A new public export on any entry (`.`, `/otel`, `/vercel`, `/integrations`, `/web`, `/edge`); SemVer minor/major impact per [SPEC.md section 7](../SPEC.md#7-stability-promise).
- A new `TaskKind`, `DecisionType`, or `TelemetryEvent` variant.
- The statistical procedures (promotion gate, rollback tests, reward composition, discount, futility factor) or any benchmark bound in [SPEC.md section 6](../SPEC.md#6-quality-contract-the-tuning-benchmark).
- The `StateSnapshot` version 1 schema or the `StateBackend` interface.
- The CLI flags, subcommands, or the serve endpoint contract (including the `noeticos help` first-line CI contract).
- The bridge contracts in `/integrations`.

For docs-only fixes, typos, or contained internal refactors, skip the issue and open a PR directly.

---

## 5. Pull request workflow

### 5.1 Before opening

- All checks green: `pnpm verify`.
- Coverage thresholds preserved or improved (see `vitest.config.ts`).
- For any change that touches the public API: `SPEC.md` and `README.md` updated.
- For any change that moves a tuning-benchmark bound: the calibration comment in `tests/integration/tuning-benchmark.test.ts` updated in the same commit, with the rationale.
- For any deprecated surface: `@deprecated` JSDoc + runtime `console.warn` (debounced) + a `### Deprecated` section in the next `CHANGELOG.md` entry.

### 5.2 PR description

Fill the [PULL_REQUEST_TEMPLATE.md](./PULL_REQUEST_TEMPLATE.md) honestly. Empty sections are not acceptable; write "N/A" with a one-line reason if a section truly does not apply.

### 5.3 Review

The maintainer reviews every PR personally. Expect:

- Surgical line-by-line read.
- Questions on intent before merge (the Creator's discipline: if you notice any problem, error, or inconsistency, ask before acting).
- Required for governance-touching changes: explicit Creator approval before merge.

### 5.4 After merge

CI publishes nothing on merge to `main`. Publishing is a Creator-triggered two-step flow (see [RELEASING.md](./RELEASING.md)).

---

## 6. Tests

Add tests for any non-trivial change. Patterns:

- **Vitest** (`tests/unit/*.test.ts`, `tests/integration/*.test.ts`). One file per surface area. All tests are offline and deterministic: seeded randomness, pinned clocks (`clock: () => 0`), no provider credentials, no network.
- **The tuning benchmark** (`tests/integration/tuning-benchmark.test.ts`) is a permanent quality contract; do not weaken a bound to make a change pass. If a bound genuinely must move, that is a SPEC-level discussion first (section 4.3).
- **Statistical code** gets tests against known reference values, not against itself.

Every fix-able bug ships with a regression test that fails pre-fix and passes post-fix.

---

## 7. Security disclosure

Do NOT open a public GitHub Issue for security vulnerabilities. Email `davcavalcante@proton.me` with the prefix `[SECURITY]` and we will coordinate fix and disclosure privately. The threat model is in [SECURITY.md](../SECURITY.md).

---

## 8. Releasing

Releases are maintainer-only. The full runbook lives in [RELEASING.md](./RELEASING.md). Contributors do not tag, do not publish, do not edit historical CHANGELOG entries (those are immutable per Keep a Changelog).

When proposing a change that warrants a release, indicate in your PR description which SemVer bump you believe it triggers (patch / minor / major per [SPEC.md section 7.2](../SPEC.md#72-semver-policy)). The maintainer makes the final call.

---

## 9. Communication

- **GitHub Issues** for bug reports and feature requests (see [ISSUE_TEMPLATE/](./ISSUE_TEMPLATE)).
- **GitHub Discussions** (if enabled) for design conversations.
- **Email** `davcavalcante@proton.me` for anything private, sensitive, or trademark/license-related.

The project's primary language for code, docs, CI, issues, and PRs is **English**. Use English in PR descriptions and code comments.

---

## Contact

**David C Cavalcante**
- Email: [davcavalcante@proton.me](mailto:davcavalcante@proton.me)
- LinkedIn: [linkedin.com/in/hellodav](https://linkedin.com/in/hellodav)
- GitHub: [github.com/davccavalcante](https://github.com/davccavalcante)
- X: [x.com/davccavalcante](https://x.com/davccavalcante)
- Project site: [noeticos.takk.ag](https://noeticos.takk.ag/)
