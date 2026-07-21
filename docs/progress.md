# Progress — unused

Updated: 2026-07-21. **Pre-v0.1.0 scaling and runtime-reachability blockers corrected; final founder release decision remains.** No semver release tag has been created.

## What shipped (v1, private-beta ready)
`@ninthwave-io/unused` — a liveness oracle for TS/JS. Tiers 1–2 fully implemented:
- **Analysis**: oxc-based frontend (per-unit resolution incl. member tsconfigs), language-agnostic IR (intra-file symbol edges, provenance spans), partitioned reachability (production/config/test), 18-class hazard registry with scoped confidence caps, dependency claims (conservative-first), test-only verdicts + zombie tests + estimated CI-seconds, workspaces (npm/pnpm/yarn-classic/bun; PnP refused loudly), JSONC config (project=claimability, ignore=invisibility), presets (vite, next incl. metadata routes), generated assumption set (drift-tested).
- **Surfaces**: TTY report per cli-ux spec; `--json` (schema 1.1.0) + SARIF 2.1.0 (fingerprints); `unused check`/`baseline` CI gate (per-workspace JSONL, version+configHash stamps, honest gate-not-evaluated state); `unused why`; MCP server (find_unused / why_alive / usage_evidence, SDK 1.29.0); `unused report --md|--html` + `unused badge`; full flag surface, exit contract 0/1/2/3.
- **Quality**: corpus 36 cases / 103 subjects — precision 1.0, recall 0.939, 0 FP/CV/unlabelled; gates A–D with planted proofs, origin/main baseline in CI. 824 tests. Smoke: hono/axios/fastify/zod pinned, 0 high-confidence FPs after three fix rounds (M3: 144 test-file highs; M4: member tsconfig paths; M5: 15 wrong zombies incl. systemic intra-file edge gap). Perf ≤1.23× knip at ~400-file scale; checkpoint verdict: stay TS.
- **Packaging**: npm pack verified cold from an installed tarball (caught the symlinked-bin silent-noop bug); OIDC provenance workflow tag-gated and ready; README + assumption-set link.

## FOUNDER ACTIONS (blocking launch, in order)
1. Register the npm org `ninthwave-io` (first-come) + configure trusted publishing for `@ninthwave-io/unused`.
2. Create the GitHub repo (github.com/ninthwave-io/unused), push main + tags, enable branch protection with the CI check required (ADR 0009 prerequisite — Gate C's enforcement depends on it).
3. Tag `v0.1.0` to fire the provenance publish workflow (verify the npm page: provenance badge, README).
4. Private beta: 5–10 users; feedback channel. Optional: npm dispute letter for unscoped `unused`.

## Post-v1 backlog (ranked, from smoke/review debt)
Tier-3 endpoint extraction (Next API routes first — schema contract already shipped); tier-4 locally-driven log sources (ADR 0002 free tier); Python then Elixir frontends (ADR 0003; Elixir via mix xref/compiler tracers per research); devDependency claims; YAML/JSONC config-string scan; per-test zombie walk cost at scale; warm-path cache (architecture §5); staleness/error-path MCP test coverage; subsumption-aware label matching; per-symbol checker-only scope.

## Resuming a session
Read CLAUDE.md, this file, docs/adr/ (0001–0010 all Accepted), docs/phasing.md, docs/smoke/M3–M5.md. The corpus + gates are the quality contract; never commit red; labels are truth.

## Pre-v0.1.0 iteration round (founder directives, 2026-07-19)
- **Remote live**: github.com/ninthwave-io/unused; ruleset `main-protection` active (PR + required `ci` check, no force-push/deletion, admin bypass). Tagging policy: semver-only on the remote (m1–m9 were never pushed; local process markers only).
- **reference-codebase TS/JS assessment** (docs/smoke/reference-codebase-ts-sanitized.md; detailed triage scratch-only): found + fixed the whole-run hazard-cap scoping bug (per-unit caps now, incl. referenced project-reference units), storybook preset (hidden-dir discovery, cross-unit aggregator globs), cdk preset, capacitor dep rule. Customer repo: 0 high/477 flat-medium → 313 high/19 medium, ALL high triaged true-positive, story/CDK FPs → 0.
- **Elixir frontend skeleton** (ADR 0011, Accepted): compiler-tracer approach (research: docs/research/elixir-landscape-2026-07.md — mix xref module-level-only; boundary = prior art; no live competitor). HEEx empirically VISIBLE to tracing. Behaviour-honesty fix (unreferenced behaviour module stays claimable). fixtures/elixir 8 cases precision 1.0, toolchain-gated in CI. reference-codebase Phoenix app: 1062 claims all-medium, 0 high FPs. Disclosure: Elixir analysis compiles the target project (unlike TS) — in the assumption set.
- Corpus: TS 40 cases (precision 1.0, 0 FP) + Elixir 8 cases (precision 1.0). 857 tests.

## Before v0.1.0 (remaining)
Founder review of the reference-codebase deletion list (the real-use-case validation is the founder acting on it); decide Elixir experimental-flag wording for the README; then tag v0.1.0 (fires provenance publish; npm org + trusted publishing already registered).

## Next development round (from the reference-codebase interactive review, 2026-07-19)
118 claims validated in-product (19-claim batch deletions passing 11k+ tests). Upstream work order, ranked (details in a founder-provided local handoff file — private, never committed):
1. **Four confirmed HIGH false positives** — reproduce sanitized, fix, corpus-lock (FP rate outranks everything).
2. **Cross-workspace MEDIUM hazard leakage** — per-unit cap scoping still leaks in some shape; diagnose against the handoff.
3. **Missing reachability sources**: Taskfile, GitHub Actions workflows, Vite/Vitest configs-as-roots gaps, MSW handlers, browser-asset references (HTML/manifest), native-config (mobile) — each as config-root/preset work with fixtures.
4. **Deletion-consequence cascades** (product feature): report "deleting X makes Y newly dead" chains + re-export removal consequences — likely a `why`-adjacent graph query + report section.
5. **File-level suppression** (`unused:ignore-file` or config), and **`unused why` for dependency claims**.
6. Then: fresh re-run against the reference codebase from its original commit; Elixir interactive review (unstarted); v0.1.0 decision with founder.

## Current session checkpoint (founder interview completed, 2026-07-19)
- The private review handoff and full review log were preserved outside this public repository under neutral filenames. No private product identifiers or artifacts were added here.
- The founder product interview is complete and implementation has resumed autonomously under the standing authority. ADR 0012 records the approved discovery, suppression, full-reachability, deletion-plan, and mutating `--fix` contract.
- Uncommitted draft work exists for the four confirmed HIGH false-positive mechanisms (sanitized fixtures plus recognizers). It has not been accepted, reviewed, committed, or pushed and must be treated as exploratory until the interview decisions are recorded.
- Diagnosis confirmed the MEDIUM leakage mechanism: computed-import/require hazards currently affect claims even when the carrier module is unreachable; the root workspace unit is a residual ownership bucket, so this leaks across unrelated components. Proposed correction: activate outgoing dynamic hazards only when their carrier is reachable, while retaining conservative whole-unit scope for a reachable opaque loader.
- Deletion-cascade assessment recommends modelling consequences as read-only counterfactual deletion plans, separate from current claims/gates, with staged exposed claims and required re-export edits. This would be an additive schema change and needs founder agreement before specification or implementation.
- No commit or push had been made at the interview checkpoint. Implementation and the ranked review/gate loop have now resumed.
- Founder interview decisions recorded after that pause:
  - file claims should cover the complete set unreachable from production/config/test roots, not only zero-inbound files;
  - deletion/fix planning belongs in the CLI and additive machine schema, but no new MCP tool is needed;
  - project-level pattern configuration is preferred over a new per-file inline suppression directive. Research is in progress against Knip's current configuration/discovery approach before the exact contract is fixed.
  - suppression will use hybrid support: retain exact inline declaration suppressions, add structured project/workspace pattern suppressions for file-level policy;
  - remove the current graph-invisibility `ignore` behavior before release; project boundaries affect claimability without erasing reference edges;
  - discovery should respect relevant `.gitignore` files by default;
  - the CLI supports actual mutation via a conventional `--fix` workflow, never commits for the user, and makes changes suitable for VCS review;
  - only unsuppressed HIGH `unused` claims are eligible; export/dependency fixes are the default, file deletion additionally requires `--allow-remove-files`, and each run mutates only its initial analysis set before re-analysis.
  - Vulture is the named research comparator for the future Python frontend; it does not expand the current v0.1.0 work order.

## Implementation checkpoint (2026-07-19, review rounds active)
- ADR 0012 is implemented across discovery, claim policy, deletion planning, reporting, and conservative CLI mutation. The implementation is still uncommitted while independent fix/re-review rounds finish; do not treat this checkpoint as release acceptance.
- Complete file reachability, dependency-aware `why`, `why --delete`, standalone schema-1.2 deletion plans, report consequence summaries, structured root/workspace suppressions, ordered `project` scope, default nested/ancestor `.gitignore` handling, and `--no-gitignore` are present.
- `--fix` mutates only its frozen unsuppressed-HIGH-unused set, has two opt-ins for files, fails closed on semantic inbound references/unsupported plans, applies required re-export and primary edits transactionally with rollback, never commits, and re-analyses once to report remaining/newly exposed claims.
- The cross-unit hazard leak is corrected with carrier-reachable fixed-point activation; config-reference evidence now points to the actual carrier site.
- Missing-root work covers workflow commands, Task, Vite/Vitest, k6, browser HTML/extension/service-worker assets, MSW, native project commands, AudioWorklet assets, and CDK `NodejsFunction` entries. Review found and fixed multiple “fixture was easier than production syntax” cases; a final bounded Task/CDK/native review round remains active at this checkpoint.
- Latest fully green shared run before the active final review fixes: 963 tests passed / 4 skipped; TS corpus 52 cases / 146 labelled subjects, precision 1.0, recall 0.9552; typecheck, lint, boundaries, diff check, and privacy scan green. Re-run every gate after the final edits.
- A fresh private reference checkout is pinned outside this repository at the handoff commit and ready for the post-gate comparison. No private identifiers, paths, symbols, code, or review artifacts have been copied into the public tree.

## Pre-release precision round accepted (2026-07-19)
- ADR 0012 is implemented and independently re-reviewed after every confirmed finding. The accepted surface includes complete file reachability, carrier-scoped hazards, graph-preserving project scope, nested/ancestor `.gitignore`, structured suppressions, dependency-aware `why`, read-only deletion consequences, and conservative transactional `--fix` mutation.
- Missing-root coverage now includes bounded GitHub Actions, Task (including includes, executable positions, working directories, and bounded runtime templates), Vite/Vitest, k6, browser assets, MSW, native project commands, AudioWorklet, and CDK `NodejsFunction` references. Task/GitHub command parsing roots executable source positions only; arbitrary path arguments remain claimable.
- Native Podfile discovery deliberately scans every receiver-eligible exact-literal `system` token. This is precision-first: ambiguous comments/literals can keep a dead script alive, but Ruby lexical ambiguity cannot hide a real invocation and create a HIGH false positive. Assumption set 1.7 and labelled misses record the bounded recall cost.
- Final public gates: 996 tests passed / 4 skipped; typecheck, lint (existing informational diagnostics only), dependency boundaries, generated-assumption sync, build, diff check, README parity, and both corpus gates pass. TS corpus: 52 cases / 237 labelled subjects, precision 1.0, recall 0.826530612244898. Elixir corpus: 8 cases, precision 1.0, recall 1.0. A packed tarball installs and runs from an empty npm project; the smoke caught and corrected the YAML parser's runtime-dependency classification before acceptance.
- Fresh pinned reference-codebase comparison: 355 claims (352 HIGH / 3 MEDIUM; 189 exports / 157 files / 9 tests). All four reviewed HIGH false positives are absent. The detailed approved batch tables enumerate 131 stable claim IDs despite the private headline summary saying 118; all 131 survive. The 20 new HIGH claims not already in those tables are file claims 1–4 reference steps downstream of previously validated dead claims; no new HIGH export claim remains.
- Release assessment: technical **GO for the next consuming-project interactive review**, with no semver tag yet. Final v0.1.0 tag/publish remains founder-only after that review. The principal accepted limitation is TS corpus recall 0.8265 from precision-first native-config handling; precision remains the blocking invariant at 1.0.
- Future Python work should use Vulture as a named comparator for AST traversal, confidence, and suppression ergonomics; Python remains outside this release round.
- GitHub CI portability follow-up: Elixir integration cases use the same `mix` availability gate as the Elixir corpus, while compiler-free configuration validation remains unconditional. The Node-only run passes 991 tests / skips 9 toolchain-dependent tests; an Elixir-equipped run passes all 1000. This lets the standard runner exercise the full portable suite without weakening Elixir coverage on toolchain-equipped runners.

## Pre-v0.1.0 scalability and Elixir runtime-reference round (2026-07-21)

- A neutral generated scaling corpus now covers exactly 250, 500, 1,000,
  2,000, and 3,000 TS source files with multiple workspaces, dense export
  surfaces, import fan-out, tests, dynamic imports, config roots, and dead code.
  Opt-in `--performance` diagnostics report every analysis phase and required
  work counter to stderr without contaminating JSON stdout.
- The exact scaling causes were repeated graph work and an unbounded secondary
  filesystem traversal: quadratic materialization of intra-file export
  transitive closure, a whole-graph reachability walk per test root, and config
  extraction reopening ignored dependency/build trees instead of consuming
  discovery's bounded inventory. Emission now stops at the first exported
  boundary, test walks stop once non-zombie/uncertain status is established,
  reachability uses an indexed queue, and source/JSON/package-root discovery is
  one gitignore-aware pass. At 3,000 files wall time fell from 6.65s to 1.78s
  and peak RSS from 723MB to 403MB; claims stayed exactly 21,172. A separate
  neutral ignored-tree stress case cuts config extraction from 823ms to 16ms
  with all analyzed counters unchanged. The corrected curve is near-linear.
  Full evidence is in
  `docs/bench/2026-07-21-scaling-investigation.md`.
- Ordinary terminal/JSON/filtered output performs zero deletion simulations.
  Shareable reports previously planned every eligible claim despite rendering
  ten; report planning is now bounded to those ten. `why --delete` plans one.
- Neutral Elixir corpus cases cover reachable MFA callback tuples and literal
  helpers selected through the conventional `apply(__MODULE__, which, [])`
  `use` dispatcher. Literal MFA module+name pairs conservatively connect every
  compiler-known same-name arity because framework runtimes may add request
  arguments to the tuple's initialization data; helper selection remains exact
  to the literal helper/0. Both become provenance-bearing runtime edges.
  `why` shows the real path/site and deletion planning refuses a subject with a
  reachable runtime edge. Unrelated functions remain claimable; no blanket
  suppression was added.
- Post-correction profiling is parser-dominant in the already native Oxc parser;
  a broad Rust rewrite is unwarranted before v0.1.0. The benchmark note records
  complexity, boundary/serialization, and maintenance reasoning.
- Final public gates: typecheck, lint (the same two existing warnings and 48
  informational diagnostics), boundaries (880 modules / 1,792 dependencies),
  64 test files / 1,007 tests, generated-assumption sync, build, packaging
  smoke, diff check, README parity, and privacy scan pass. TS corpus remains 52
  cases / 237 subjects at precision 1.0 and recall 0.826530612244898. Elixir
  corpus is now 10 cases / 26 subjects at precision 1.0 and recall 1.0.
- A fresh, separately performed consuming-project rerun completed within the
  interactive budget, with canonical and filtered machine output schema-valid,
  ordinary modes performing zero deletion simulations, both runtime mechanisms
  free of the reviewed false claims, and both deletion queries refusing the
  live subjects. Raw evidence stayed outside this repository.
- Release posture is **technical GO for the founder's v0.1.0 decision**. This
  public repository contains no external project identifiers, paths, source,
  symbols, configuration, artifacts, output, or quoted review prose. No tag,
  publish, push, or external mutation was performed.
