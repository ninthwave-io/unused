# Polyglot-first delivery ledger

Updated: 2026-07-21
Owner: autonomous Codex delivery under founder direction
Decision: ADR 0013
Starting checkpoint: `c89954e` (`fix: scale analysis and preserve runtime reachability`)

This file is the authoritative resume point for first-class TypeScript, Elixir,
Rust, and Rustler/NIF delivery. Update it before every checkpoint commit. Do not
reconstruct status from chat history.

## Objective

Make one `unused --cwd <repo>` invocation safely identify and help delete dead
TypeScript, Elixir, and Rust code in a mixed repository, including liveness that
crosses Elixir/Rust NIF boundaries. Framework breadth is deliberately bounded;
all language, convention, and bridge support must be modular.

## Non-negotiable constraints

- Precision outranks recall. An incomplete boundary degrades toward alive or
  fails explicitly; it never licenses a confident dead claim.
- Cross-language edges are added before the one global reachability/claim pass.
- Canonical JSON stdout remains schema-valid and diagnostic-free.
- `why` and deletion planning use stored provenance and the merged graph.
- No runtime third-party plugin loading until the internal contracts are proven.
- No broad Rust rewrite without post-correction profiler evidence.
- The consuming project is validation-only. Never copy its identifiers, paths,
  source, symbols, configuration, artifacts, profiles, or prose into this repo.
- Use neutral public conventions and independently generated fixtures.
- Commit small coherent checkpoints; do not push, tag, or publish without
  founder approval.

## Resume protocol

After interruption:

1. Read `CLAUDE.md`, ADR 0013, this ledger, and `docs/progress.md`.
2. Run `git status --short` and `git log -5 --oneline`; preserve unrelated work.
3. Find the first milestone below not marked `complete`.
4. Re-run that milestone's focused verification before changing code.
5. Continue only one checkpoint at a time.
6. Update this ledger with files, decisions, tests, and the next exact action.
7. Run the checkpoint gates, commit it, then advance the milestone status.

## Delivery milestones

### P0 — Direction and resumability

Status: complete

Deliverables:

- ADR 0013 accepted direction.
- This execution ledger with acceptance and resume instructions.
- Architecture/progress documents point here.

Acceptance:

- A new agent can determine the objective, constraints, completed work, next
  action, and verification commands without private context or chat history.

Verified: ADR, ledger, architecture, and progress cross-reference one another.

Next action: implement P1 contract types and deterministic registry tests.

### P1 — Typed plugin contracts and registry

Status: complete

Deliverables:

- `LanguageFrontendPlugin`, `ConventionPlugin`, and `BridgePlugin` interfaces.
- Deterministic static registry with duplicate-id rejection.
- Boundary, fragment, capability, diagnostic, and completeness types.
- Unit tests and dependency-boundary enforcement.

Acceptance:

- Registry order is deterministic; duplicate ids fail loudly.
- Plugin failures identify plugin and boundary.
- Contracts depend only on core/public frontend-neutral types.

Delivered:

- `frontends/plugins/types.ts` defines boundaries, repository context, graph
  fragments, claim inputs, capabilities, diagnostics, completeness records, and
  the three plugin contracts.
- `frontends/plugins/registry.ts` provides a deterministic static registry,
  globally unique validated ids, and kind-filtered views.
- `PluginExecutionError` and `executePluginOperation` preserve plugin/boundary
  attribution on failures.
- Focused verification: typecheck; 3 registry tests; dependency boundaries
  (884 modules / 1,802 dependencies).

Next action: P2 boundary discovery and TS/Elixir plugin adapters. Preserve
single-language behavior while replacing root-manifest dispatch incrementally.

### P2 — Unified TS + Elixir orchestration

Status: in progress

Deliverables:

- Gitignore-aware nested boundary discovery.
- TS and Elixir adapters registered through P1.
- Repository-relative graph fragment rebasing and collision checks.
- One global reachability and claim pass; transitional claim concatenation gone.
- Per-boundary status/counters in internal run metadata.

Acceptance:

- A neutral root with nested TS and Mix projects is analyzed by one command.
- A planted cross-fragment edge changes liveness before claims.
- Existing single-language JSON is compatibility-tested.
- Missing Mix fails explicitly when an Elixir boundary is detected.

Progress:

- The shared gitignore-aware inventory now records visible `package.json`,
  `mix.exs`, and `Cargo.toml` project directories in its one bounded walk.
- Deterministic boundary selection lets a root workspace/umbrella own nested
  same-ecosystem manifests while retaining sibling nested projects.
- Graph rebasing translates file/symbol/entrypoint ids, edges, hazard sites,
  and subtree prefixes into repository-relative coordinates.
- Core claim emission now accepts explicit analysis and claimable file scopes.
  It consumes repository-wide reachability while isolating hazard activation,
  subject emission, and zombie-test analysis to the owning fragment.
- A fragment cannot emit claims merely because another language has a root: it
  needs its own production entrypoint or an inbound production-reachable bridge.
- Focused verification: typecheck; 53 core claim tests (including three scoped
  polyglot cases); dependency boundaries (888 modules / 1,813 deps); lint with
  the existing 2 warnings and 48 informational diagnostics.

Next action: expose claim inputs from the TypeScript and Elixir frontends and
rebase them with each graph fragment. Then register both adapters and replace
root-manifest dispatch with nested-boundary orchestration using one merged graph
and one partitioned-reachability computation.

### P3 — Rust frontend foundation

Status: pending

Deliverables:

- Cargo boundary/workspace discovery and toolchain refusal contract.
- Measured compiler-integration decision note.
- Rust graph emission for crates, targets, files, public items, roots, and tests.
- Neutral labelled Rust corpus and scoreboard.

Acceptance:

- Independently generated Cargo fixtures cover binary/library roots, workspace
  members, modules, tests, features/build-script hazards, and planted dead code.
- Rust corpus precision is 1.0; recall and toolchain skips are explicit.
- `why` works for live and dead Rust subjects.

### P4 — Rustler/NIF bridge

Status: pending

Deliverables:

- Rustler convention plugin(s) and cross-language bridge plugin.
- Literal registration/stub pairing with repository provenance.
- Scoped ambiguity hazard for dynamic registration.
- Cross-language `why` and deletion-plan support.

Acceptance:

- Neutral fixture proves an Elixir stub keeps its Rust NIF alive.
- The Rust registration keeps the corresponding Elixir surface alive where the
  runtime contract requires it.
- `why` renders the cross-language transition and exact carrier site.
- `why --delete` refuses a live bridged subject or models required edits and
  consequence stages correctly.
- Removing the planted bridge produces the expected dead claims.

### P5 — Convention modularization

Status: pending

Deliverables:

- Existing TS conventions migrate incrementally behind `ConventionPlugin`.
- Elixir OTP/Phoenix/runtime conventions use the same contract.
- Plugin authoring/test guide and neutral fixture template.

Acceptance:

- Adding a convention does not require editing the orchestrator.
- Applicability, roots, edges, hazards, and diagnostics are fixture-testable in
  isolation.

### P6 — Integrated acceptance and release decision

Status: pending

Deliverables:

- Full typecheck/lint/boundary/test/build/package/privacy gates.
- TS, Elixir, Rust, and bridge corpus reports.
- Polyglot phase/counter and CPU/RSS benchmark evidence.
- Separate consuming-project canonical/mode/why/delete rerun.
- Updated Rust decision and release posture.

Acceptance:

- Every ADR 0013 acceptance item is evidenced.
- Private artifacts remain outside the public repository.
- No tag, push, or publish occurs without founder approval.

## Verification commands

Run at each applicable checkpoint:

```sh
pnpm run typecheck
pnpm run lint
pnpm run boundaries
pnpm run test
pnpm run assumptions
pnpm run scoreboard
pnpm run scoreboard:elixir
pnpm run build
git diff --check
```

Add Rust and bridge scoreboards when P3/P4 introduce them. Packaging and privacy
smokes are mandatory at P6 and before any release recommendation.

## Decision log

- 2026-07-21: first-class means one global graph/claim pass, not merged reports.
- 2026-07-21: plugin categories are language, convention, and bridge.
- 2026-07-21: plugins are statically registered until three languages and one
  bridge prove the contracts.
- 2026-07-21: Rustler/NIF is the first cross-language bridge.
- 2026-07-21: consuming-project evidence remains private and is never the source
  of public fixtures.

## Checkpoint history

- `c89954e` — corrected TS scaling, bounded config inventory, Elixir runtime MFA
  and dynamic-use reachability, deletion safety, and public benchmark evidence.
- `b634c08` — accepted ADR 0013 and established this resumable delivery ledger.
- `261070a` — added typed language/convention/bridge contracts and deterministic
  plugin registry with attributed execution failures.
