# Security Policy

`@takk/noeticos` (NoeticOS) is a stable (1.0.0) library for adaptive runtime
parameter tuning of production agents. Security reports are taken seriously
and each one is acknowledged within two business days.

## Supported versions

Each published version follows strict SemVer (see [`SPEC.md`](./SPEC.md)
section 7 and [`.github/RELEASING.md`](./.github/RELEASING.md)). Only the
latest minor of the current major receives security patches; an older major
receives critical-CVE fixes for 6 months after the next major lands.

| Package | Supported |
|---|---|
| `@takk/noeticos` | current `latest` dist-tag |

## Reporting a vulnerability

**Please do not file public GitHub issues for security problems.** Send
reports to **davcavalcante@proton.me** (preferred) or **say@takk.ag** (Takk
relay), with the subject line beginning `[SECURITY]`.

Include, at minimum:

- Affected version (`npm ls @takk/noeticos`).
- Reproduction steps or a minimal proof-of-concept.
- Impact assessment (what an attacker can achieve).
- Any suggested mitigation.

PGP or signed reports are welcome but not required. If you need an
out-of-band channel, ask in the first message and one will be proposed.

## Response process

1. Acknowledgement within **2 business days**.
2. Triage and severity assignment within **7 days**.
3. Fix targeted for the next release; critical issues ship as an out-of-band
   patch on the affected minor.
4. Coordinated disclosure: the reporter is credited in the changelog and
   advisory unless they request anonymity.

## Threat model in scope

Findings in any of the following are in scope:

- **Decision-audit integrity.** Any way to edit, delete, reorder, or forge
  `DecisionEntry` records, to break the monotonic sequence numbering across
  evictions or serialization round trips, or to cause a promotion or rollback
  that is not recorded with its evidence. The audit log is the accountability
  surface of the whole package; its append-only property is a contract.
- **State snapshot poisoning.** Any crafted snapshot that, when loaded,
  crashes the engine, escapes the documented restore behavior, or silently
  changes parameters outside the promoted values of the snapshot. Defenses in
  place that findings can target: snapshots are validated by `version`,
  corrupt agent and track entries are skipped individually, restored
  experiments are reconciled against the configured space, and an operator
  can contain a suspect agent immediately with `freezeTuning`. A path that
  causes prompt content or other raw task material to be written into a
  snapshot is also in scope (the schema forbids it structurally).
- **The serve surface.** `noeticos serve` binds `127.0.0.1` by default,
  enforces `Authorization: Bearer <token>` on every endpoint except
  `GET /healthz` when `--token` is set, and caps request bodies at 1 MB. Any
  bypass of the token check, any pre-auth resource exhaustion beyond the body
  cap, and any path traversal through the `--state` flag handling are in
  scope.
- **Safety-invariant bypass.** Any input sequence that makes a baseline
  recommendation carry a non-promoted value, makes a canary differ from the
  baseline in more than the focus parameter, or promotes a candidate without
  the documented statistical evidence.
- **Supply chain.** Tarball contamination, compromised npm scope, or a
  published artifact whose provenance attestation does not match the source
  commit.

## Trust boundary: fabricated outcomes

`report()` believes its caller. An actor who can already execute code in your
process can feed fabricated outcomes and steer tuning (reward gaming). This
is the operator's trust boundary by design: NoeticOS mitigates the blast
radius (unknown execution ids are ignored, cohort attribution cannot be
forged after the fact, every resulting decision is auditable with its
numeric evidence, and `freezeTuning` plus `constraints.locked` bound what
tuning can change), but it does not attempt to authenticate in-process
callers. Reports about reward gaming from a position that already has code
execution in the host process are out of scope; reports about gaming through
the authenticated serve API from outside the trust boundary are in scope.

## Out of scope

- **Credential handling.** There is none in the core, by design: NoeticOS
  stores no API keys, no tokens, no secrets. The custody of the optional
  serve bearer token in your environment is the operator's responsibility.
- The security of any model provider or upstream API your agents talk to,
  and the quality or safety of model outputs.
- The semantic correctness of caller-supplied `qualityScore` values (see the
  trust boundary above).
- Denial of service against your own application through unbounded
  recommendation traffic; capacity guards (`maxAgents`,
  `maxPendingExecutions`) bound memory, not your compute bill.
- Theoretical attacks against the non-cryptographic FNV-1a hash used for
  cohort bucketing and tool-argument hashing; it is a determinism
  mechanism, not a security control, and is documented as such.

## Supply-chain assurances

- **Zero runtime dependencies.** The transitive attack surface of the
  published package is empty. The sibling bridges are optional peer
  dependencies you install explicitly, and the package never imports them.
- **Provenance.** Every release is published with `npm publish --provenance`
  (SLSA attestation by GitHub Actions). Verify with
  `npm view @takk/noeticos@<version> --json | jq .dist.attestations`.
- **Files allowlist.** `package.json#files` restricts the tarball to `dist`,
  `README.md`, `LICENSE`, `NOTICE`, `CHANGELOG.md`, and `SECURITY.md`;
  nothing else can ship by accident.
- **Frozen lockfile.** `pnpm-lock.yaml` is committed and CI installs with a
  frozen lockfile, so builds are reproducible against pinned dev tooling.
