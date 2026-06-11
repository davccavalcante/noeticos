# Releasing @takk/noeticos

This document is the runbook for publishing `@takk/noeticos` (NoeticOS) to npm and GitHub. The release flow is intentionally **two-step**: a GitHub Release is created and reviewed FIRST, and only then promoted to NPMJS.

The first published cut is `1.0.0`. From there, [SemVer 2.0.0](https://semver.org/spec/v2.0.0.html) applies per the policy in [SPEC.md section 7](../SPEC.md#7-stability-promise).

---

## 1. One-time prerequisites (Creator's actions)

These require credentials and cannot be performed from inside this repository.

### 1.1 Provision the npm scope

The npm organization `takk` owns the `@takk/*` scope. Verify locally:

```bash
npm whoami
npm org ls takk
```

### 1.2 Add the `NPM_TOKEN` secret to GitHub

A granular automation token is provisioned on npm:

- Name: `takk-ci` (year-less so the convention survives rotation; track the active issuance date in the npm UI)
- Scope: `@takk`
- Permissions: read and write
- Bypass two-factor authentication: enabled
- Expiration: 90 days from issuance; rotate before expiry

In the GitHub repo settings:

- Settings -> Secrets and variables -> Actions -> New repository secret
- Name: `NPM_TOKEN`
- Value: the token issued at <https://www.npmjs.com/settings/takk/tokens>

Rotation flow when the token expires (or is suspected leaked):

1. Issue a new token on npm with the same name, scope, and permissions.
2. Update the `NPM_TOKEN` GitHub secret with the new value.
3. Re-run any failed publish workflow.
4. Revoke the old token.

### 1.3 Enable branch protection

Settings -> Branches -> Add branch protection rule for `main`:

- Require linear history.
- Require conversation resolution.
- Do not allow force pushes; do not allow deletions.
- (Optional, after first CI run) Require status checks to pass: select `test (Node 20)`, `test (Node 22)`, `test (Node 24)`, `biome`.

### 1.4 Configure topics and metadata

Repo settings -> About -> set topics for organic discoverability:

```
adaptive-runtime auto-tuning parameter-tuning multi-armed-bandit online-learning
ai-agents agent-optimization cost-optimization canary safe-rollout decision-audit
vercel-ai-sdk opentelemetry hermes-agent typescript nodejs
```

And set Website: `https://noeticos.takk.ag/` (the canonical project URL).

---

## 2. The two-step release flow

The release pipeline is **intentionally non-atomic**, split across two GitHub Actions workflows that the Creator triggers manually:

| Step | Workflow | What it does | Touches NPMJS? |
|---|---|---|---|
| 1 | `release.yml` | Validates package + version + tag absence + CHANGELOG entry. Builds + lints + typechecks + tests + packs (dry-run). Creates git tag `v<version>` and GitHub Release with title `[REVIEW REQUIRED: NOT YET ON NPMJS]`. | **No** |
| 2 | `npm-publish.yml` | Verifies the tag + GitHub Release from Step 1 exist. Verifies monotonic version vs the npm registry. Builds + lints + typechecks + tests + packs (dry-run). Publishes to npm with `--provenance`. Updates the GitHub Release title to `[PUBLISHED ON NPMJS]`. | **Yes** |

The Creator runs Step 1 immediately after a release-worthy change is merged to main; reviews the resulting GitHub Release page (which carries the changelog, the tag, the commit, the pack-smoke result in the workflow logs); and only then runs Step 2 to push the artifact to NPMJS.

**Why the split?** Once a version is on the npm registry, it cannot be unpublished after 72 hours. The two-step flow gives the Creator a reviewable artifact on GitHub before the release becomes permanent on npm.

---

## 3. Routine release flow

### 3.1 Bump and document

```bash
# Example: releasing 1.0.1

# 1. Bump the version
npm version 1.0.1 --no-git-tag-version

# 2. Prepend a new section to CHANGELOG.md with a UTC timestamp
$EDITOR CHANGELOG.md
# Add: ## [1.0.1] - 2026-MM-DDTHH:MM:SSZ
# Use: date -u +%Y-%m-%dT%H:%M:%SZ

# 3. Keep the CLI help contract in sync: the first line of `noeticos help`
#    must read "noeticos <version>" (CI asserts it).
$EDITOR src/cli/index.ts

# 4. Commit on a branch + open PR (branch protection blocks direct push to main)
git checkout -b chore/release-1.0.1
git add package.json CHANGELOG.md src/cli/index.ts
git commit -s -m "chore: release 1.0.1"
git push -u origin chore/release-1.0.1
gh pr create --fill

# 5. After PR merges to main, fetch main locally (no need to tag manually)
git checkout main && git pull
```

### 3.2 Step 1: create the GitHub Release (no NPMJS yet)

```bash
gh workflow run release.yml \
  -f version=1.0.1 \
  -f confirm=YES-CREATE-GITHUB-RELEASE
```

The workflow validates, builds, tests, packs, then creates the tag `v1.0.1` and a GitHub Release titled `[REVIEW REQUIRED: NOT YET ON NPMJS] @takk/noeticos@1.0.1`.

#### The "Check README links" gate

`release.yml` runs a `Check README links` step (external checks enabled) BEFORE the tag and Release are created: every relative link target in `README.md` must exist in the tree and every absolute URL must answer 2xx/3xx. For offline or pre-push runs use `node scripts/check-links.mjs --skip-external`.

Operational notes for this gate:

- It currently fails, correctly, on `https://noeticos.takk.ag/` (the docs site is not live yet) and on the `raw.githubusercontent.com` README asset (the repository is not pushed yet). Both must be live before running `release.yml`.
- The link to this package's own npm page is auto-skipped with a warning: the gate runs before `npm-publish.yml` by design, so at the first release that page cannot exist yet.
- philarchive.org, philpeople.org, linkedin.com, and x.com bot-gate automated clients; the gate forgives only gate-shaped statuses (401, 403, 405, 429, 999), while 404 and 410 still fail.
- npm package-page links are probed via `registry.npmjs.org`, which answers the existence question without the www.npmjs.com bot gate.

Related: `npm-publish.yml` performs its monotonic-version check with a dependency-free semver comparison; it no longer needs (and must not reintroduce) `require('semver')`.

Visit <https://github.com/davccavalcante/noeticos/releases/tag/v1.0.1> and review:

- The changelog body extracted from `CHANGELOG.md`.
- The commit SHA the tag points to.
- The pack-smoke result in the workflow logs.

### 3.3 Step 2: promote to NPMJS

When the GitHub Release looks good:

```bash
gh workflow run npm-publish.yml \
  -f version=1.0.1 \
  -f confirm=I-AM-THE-CREATOR-AND-I-PUBLISH-TO-NPMJS
```

The workflow verifies the Step 1 artifacts exist, validates monotonic version vs the npm registry, builds, tests, packs, then runs `npm publish --access public --tag <auto-resolved> --provenance`. After publish, the GitHub Release title flips to `[PUBLISHED ON NPMJS] @takk/noeticos@1.0.1`.

### 3.4 Verify the release

```bash
# Cache may take ~1 min to update; the workflow itself verifies the registry.
npm view @takk/noeticos versions
npm view @takk/noeticos dist-tags

# Try installing into a temporary directory
mkdir /tmp/verify && cd /tmp/verify
npm init -y
npm install @takk/noeticos
npx noeticos help   # first line must read "noeticos 1.0.1"

# Verify provenance
npm view @takk/noeticos@1.0.1 --json | jq .dist.attestations
```

### 3.5 Version progression discipline

The Creator's binding rule: no version skipping, no backwards versions, no deprecations without a cycle.

- Initial cut: `1.0.0`.
- Patches: `1.0.1`, `1.0.2`, ...
- Minors: `1.1.0`, `1.2.0`, ...
- Majors: `2.0.0`, only after a full deprecation cycle per [SPEC.md section 7.3](../SPEC.md#73-deprecation-policy).

Prereleases use the standard semver qualifiers (`1.0.0-alpha.1`, `1.0.0-beta.1`, `1.0.0-rc.1`) and route to matching dist-tags (`alpha`, `beta`, `rc`) instead of `latest`. The `npm-publish.yml` workflow auto-resolves the dist-tag from the version qualifier when the `dist_tag` input is left blank.

---

## 4. Promoting a prerelease to `latest`

If a release is published under a non-`latest` dist-tag and you later want it to be the default `npm install` target, run:

```bash
npm dist-tag add @takk/noeticos@1.1.0-rc.1 latest
```

(Requires the same `NPM_TOKEN` and 2FA bypass.)

---

## 5. Emergency: unpublish or deprecate

npm allows `npm unpublish` only within 72 hours of publish AND when no other public package depends on it. Within the window:

```bash
npm unpublish @takk/noeticos@1.0.1
```

After 72 hours, unpublishing is not permitted. Use `npm deprecate`:

```bash
npm deprecate @takk/noeticos@1.0.1 "Replaced by 1.0.2 - fixes promotion-gate regression."
```

The Creator's discipline is to AVOID this stage: strict CI, the permanent tuning benchmark, provenance, a small surface, and the two-step review flow aim to make every published version stable enough to never deprecate. When a deprecation is unavoidable, document it in the next CHANGELOG with a `### Deprecated` section AND ship a non-deprecated alternative in the same release.

---

## 6. Quick reference

| Action | Command |
|---|---|
| Run all tests locally | `pnpm test` |
| Run full verify pipeline | `pnpm verify` |
| Check README links offline | `node scripts/check-links.mjs --skip-external` |
| Check README links incl. external (the release gate) | `node scripts/check-links.mjs` |
| Build only | `pnpm build` |
| Deterministic engine demo | `node --import tsx src/cli/index.ts simulate --executions 2400 --seed 7` |
| Pack smoke (no publish) | `pnpm pack --pack-destination /tmp` |
| Manual publish (DO NOT use; let CI do it) | `npm publish --access public --provenance` |
| Step 1, create GitHub Release | `gh workflow run release.yml -f version=<semver> -f confirm=YES-CREATE-GITHUB-RELEASE` |
| Step 2, publish to NPMJS | `gh workflow run npm-publish.yml -f version=<semver> -f confirm=I-AM-THE-CREATOR-AND-I-PUBLISH-TO-NPMJS` |
| Promote a prerelease to latest | `npm dist-tag add @takk/noeticos@<semver> latest` |
| List versions | `npm view @takk/noeticos versions` |
| Verify provenance | `npm view @takk/noeticos@<semver> --json \| jq .dist.attestations` |
| Rotate NPM_TOKEN | Issue new token at <https://www.npmjs.com/settings/takk/tokens>, update GitHub secret, revoke old |

---

## 7. Stability policy

See [SPEC.md section 7](../SPEC.md#7-stability-promise) for the binding stability contract: public surface definition, SemVer rules, the minor-extensible unions, deprecation cycle, security exception path, prerelease channels, and license/provenance invariants. The tuning-benchmark bounds of [SPEC.md section 6](../SPEC.md#6-quality-contract-the-tuning-benchmark) are part of that contract.
