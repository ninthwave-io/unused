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

Status: complete

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
- Both existing frontends now return the complete claim-emission inputs needed
  after graph merge: line counts, dependencies, self-package ids, units,
  analysis files, and claimable files. The rebasing layer translates all
  path-bearing inputs together with the graph.
- Compiled-in TypeScript and Elixir language adapters now implement the typed
  contract, declare auditable capabilities, select nested boundaries from one
  shared manifest inventory, suppress duplicate per-boundary diagnostics, and
  return repository-relative fragments with frontend-neutral metadata.
- Root dispatch now discovers nested boundaries through the registry, merges
  collision-checked graph fragments, applies convention/bridge contribution
  phases, computes partitioned reachability once, and emits fragment-scoped
  claims from that repository-wide result. Claim concatenation is gone.
- Root config entry, project, dependency-ignore, suppression, warning, summary,
  and gate behavior applies to the complete file union. Stable claim
  coordinates retain local frontend suppression/package annotations.
- Internal boundary metadata records plugin, language, status, file count, and
  workspace count without entering canonical JSON. Single-root and no-manifest
  paths retain their historical frontend output.
- Acceptance evidence: a neutral nested TS+Mix repository is analyzed in one
  graph; core tests prove a planted cross-fragment edge changes claim liveness;
  the 166-test CLI/TS/Elixir regression selection passes (6 toolchain/fixture
  skips under the default environment); all 3 dispatch tests pass when run with
  the installed Elixir/Erlang versions selected explicitly.
- Focused verification: typecheck; 58 scoped/plugin/dispatch tests; dependency
  boundaries (890 modules / 1,834 deps); lint with the existing 2 warnings and
  48 informational diagnostics.

Next action: begin P3 with an evidence-backed Rust frontend design: inventory
the installed Cargo/rustc capabilities and current IR needs, choose the narrowest
compiler-supported extraction boundary, document refusal/feature/build-script
hazards, then add Cargo boundary discovery and neutral fixtures before item
reachability claims.

### P3 — Rust frontend foundation

Status: complete

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

Progress:

- `docs/research/rust-frontend-stack-2026-07.md` records the measured stable
  Cargo/rustc extraction boundary and rejected alternatives.
- Initial precision contract: a private function must receive the same compiler
  `dead_code` diagnostic in all-target default and all-features checks. Public,
  generated, macro-ambiguous, FFI/linkage, and incomplete feature configurations
  degrade toward alive or fail explicitly.
- Compiler/build-script/proc-macro execution and the no-silent-partial refusal
  rule are explicit.
- The Rust frontend foundation now executes Cargo without a shell, caps captured
  output, distinguishes missing-toolchain from invalid-project failures, and
  validates the machine-readable workspace/package/target/feature subset.
- Workspace members and target source paths are required to remain inside the
  detected Cargo workspace. Canonical filesystem paths avoid macOS `/var` versus
  `/private/var` identity drift.
- Focused verification: typecheck; 3 Cargo metadata/refusal tests; dependency
  boundaries (894 modules / 1,847 dependencies).
- Shared discovery now records visible `.rs` sources and excludes Cargo
  `target/` output in the same bounded gitignore-aware traversal.
- The registered Rust plugin emits Cargo package/target/source roots and public
  item graph facts. Non-target source files are conservatively rooted until a
  compiler-derived module graph exists, so the frontend cannot produce unsafe
  whole-file claims.
- High-confidence Rust item claims are limited to unique private functions that
  rustc reports as `dead_code` in both default and all-features, all-target
  checks. Their exact compiler span/evidence survives nested fragment rebasing
  and repository-wide claim emission.
- Core now permits unreachable contains-only private symbols in an entrypoint
  file while retaining the existing rule that exported entrypoint surfaces are
  alive. A focused regression locks both halves.
- Focused verification: typecheck; 73 Rust/compiler/discovery/core/plugin/
  dispatch tests pass (2 Mix-skipped under the default shell); dependency
  boundaries (898 modules / 1,879 dependencies).
- A neutral four-case Rust corpus now covers library, binary, integration-test,
  workspace, optional-feature, and build-script targets. The committed Rust
  scoreboard reports 4 cases / 12 labelled subjects, precision 1.0, recall
  0.8333, zero false positives, zero confidence violations, and one explicit
  unused-public-API miss.
- Rust corpus gates are non-vacuous and enforce precision, confidence ceilings,
  unlabelled-high-confidence safety, and non-decrease against
  `fixtures/scoreboard.rust.json`. The `scoreboard:rust` command regenerates it.
- `why` integration checks both the rustc-evidenced dead function and a live
  public API path. Multi-package Rust claims carry the owning Cargo package.
- Macro-expanded compiler spans are excluded. Any source attribute immediately
  attached to a dead function also excludes it from the initial claim class;
  `extern`/linkage/runtime/proc-macro/Rustler spellings are independently
  guarded. Tests prove an attributed dead function remains unclaimed.
- If all-features compilation fails (including mutually exclusive features),
  `CargoCompileError` fails the boundary explicitly. Default-only diagnostics
  never leak through as claims.

P3 decision: the measured 0.8333 recall is sufficient to enter P4 because the
only recorded miss is general unused public library API, while the founding
consumer need is Rustler runtime pairing. Keep that miss visible; do not infer
public-API death from absent in-repository calls. Revisit stronger compiler
integration after Rustler corpus/consumer evidence, using the triggers in the
Rust extraction decision.

Next action: begin P4 with a neutral Rustler fixture and two isolated extractors:
Elixir NIF stub/module setup and Rust `#[rustler::nif]`/registration inventory.
Join only literal provable pairs in a `BridgePlugin`; dynamic or ambiguous
registration must create the narrowest no-claim hazard.

### P4 — Rustler/NIF bridge

Status: complete

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

Progress:

- Official Rustler 0.38 conventions were re-derived from public docs: an
  Elixir module uses `Rustler` and declares `:nif_not_loaded` stubs; Rust NIFs
  use `#[rustler::nif]`; `rustler::init!` names the literal `Elixir.Module`.
- Isolated, source-only extractors now return exact module, function, arity,
  file, and line facts for those forms without fetching or compiling Rustler.
  Scheduling attributes are identity-neutral; renamed/unsupported attributes
  and computed init modules are explicitly ambiguous.
- Extractor tests use neutral generated-style source, cover nested parameter
  syntax and multiline stubs, and prove commented examples are ignored.
- Compiled-in `convention:rustler-elixir`, `convention:rustler-rust`, and
  `bridge:rustler` plugins now use neutral endpoint identities to join exact
  literal module/function/arity pairs. Adding them required no orchestrator
  conditionals; dispatch now receives the complete static plugin registry.
- Exact pairs contribute an Elixir-stub-to-Rust-function `runtime-resolved`
  edge at the stub site before global reachability. There is no reverse edge:
  compiling a Rust crate does not make an otherwise uncalled Elixir function
  live. An unmatched NIF is kept alive as a possible external BEAM surface.
- Computed init modules, unsupported attribute options, duplicate loaders, and
  missing traced stub symbols activate the new carrier-reachable,
  symbol-surface `rustler-ambiguous-registration` no-claim hazard. Its generated
  assumption-set entry records the precision boundary.
- Focused verification: 27 plugin/dispatch/Rust/hazard tests pass (2 Mix-skipped
  under the default shell); typecheck and dependency boundaries pass (907
  modules / 1,917 dependencies).
- The independently constructed `fixtures/polyglot/rustler-literal` case runs
  both real compilers without network access. Tiny local neutral macro crates
  preserve the documented Rustler syntax; they do not copy or emulate a private
  project. The case labels one live and one dead function on each language side.
- `fixtures/scoreboard.polyglot.json` records 1 case / 4 subjects, precision
  1.0, recall 1.0, two true-positive high-confidence claims, and zero false
  positives, misses, confidence violations, or unlabelled claims.
- Cross-language `why` renders the production application call, exact Elixir
  stub line, and Rust NIF attribute line. Removing the planted caller makes
  both exact functions dead while a separate loader marker keeps the containing
  Elixir module live, proving the result is not a dead-file side effect.
- `why --delete` refuses the live Rust function at its inbound runtime edge and
  the live Elixir stub at its inbound static caller. The planner now applies
  this safety rule to every reachable non-re-export reference; it no longer
  reports a live statically called subject as supported without a caller edit.
- Focused verification after fixture integration: 263 CLI/core/plugin/dispatch/
  polyglot tests pass; typecheck and dependency boundaries pass (911 modules /
  1,941 dependencies); the polyglot scoreboard gate passes under the explicitly
  selected installed Mix toolchain.

P4 decision: the literal Rustler bridge is sufficient to enter P5. Renamed NIF
exports, computed module registration, and duplicate registration remain
explicit no-claim surfaces until independently evidenced syntax can be paired
without guessing.

Next action: begin P5 by extracting existing TypeScript convention/config root
logic behind compiled-in `ConventionPlugin` implementations without changing
claim output. Add an authoring guide and neutral plugin fixture template before
migrating the narrower Elixir runtime conventions.

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
- `0948d91` through `3542cf7` — completed polyglot discovery/orchestration and
  the stable Cargo/rustc Rust frontend with its precision corpus.
- `9d7292a` and `0e37316` — extracted public Rustler conventions and joined
  exact Elixir/Rust endpoints through the typed plugin phases.
