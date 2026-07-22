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
- Boundary metadata records plugin, language, status, file count, and workspace
  count. Schema 1.3.0 now publishes the completed records in canonical JSON and
  attributes every claim with an explicit language id; the internal graph API
  retains the same records for programmatic callers.
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

Status: complete

Deliverables:

- Existing TS conventions migrate incrementally behind `ConventionPlugin`.
- Elixir OTP/Phoenix/runtime conventions use the same contract.
- Plugin authoring/test guide and neutral fixture template.

Acceptance:

- Adding a convention does not require editing the orchestrator.
- Applicability, roots, edges, hazards, and diagnostics are fixture-testable in
  isolation.

Progress:

- `convention:typescript-config-carriers` is the first convention family fully
  transferred from frontend composition to the typed registry path. It reuses
  the existing GitHub Actions, Taskfile, and native build-script recognizers,
  emits rebased config entrypoints, and is tested both in isolation and through
  nested repository dispatch.
- The TypeScript language adapter explicitly defers only those three carrier
  families; direct single-language analysis retains its established frontend
  path. This prevents duplicate roots while preserving the public compatibility
  fast path during incremental migration.
- Focused verification: 37 convention/plugin/dispatch tests pass (2 Mix-skipped
  under the default shell); typecheck and dependency boundaries pass (913
  modules / 1,955 dependencies).
- `docs/design/plugin-authoring.md` now fixes plugin selection, repository-path
  identity, phase ordering, precision degradation, migration ownership,
  registration, testing, and verification rules. Architecture links to it.
- `fixtures/templates/convention-plugin/` provides a neutral, unscored fixture
  shape and labels starter with mandatory live/dead inverse coverage, bridge
  mutation guidance, local-toolchain expectations, and the public/private
  derivation boundary. The corpus README now documents active language and
  polyglot scoreboards instead of its obsolete pre-analyzer state.
- `convention:elixir-runtime` now owns literal runtime-reference edges,
  behaviour/OTP/Phoenix/dynamic-dispatch hazards, and Phoenix endpoint/router
  roots in registry-driven analysis. Direct Elixir analysis retains the same
  established emission for compatibility.
- The Elixir frontend prepares the convention contribution from its one
  compiler trace and one existing runtime-reference extraction, then omits it
  from the base fragment. Deferred contributions are typed, keyed by plugin id,
  and rebased against retained graph nodes; the plugin activates them before
  global reachability. No project is rescanned or recompiled.
- An integration test analyzes two nested neutral Mix boundaries together and
  proves the rebased MFA edge and behaviour-callback hazard keep their exact
  live subjects unclaimed. Focused P5 completion verification: 16 plugin/
  dispatch/polyglot tests pass under the selected Mix toolchain; typecheck and
  dependency boundaries pass (916 modules / 1,970 dependencies).

P5 decision: the contracts are proven by a filesystem convention family, a
compiler-fact convention family, and a cross-language bridge. Further
TypeScript preset/source convention migration can proceed incrementally without
blocking v0.1.0; no convention-specific orchestrator branch or external plugin
loading ABI is required.

Next action: begin P6 with the complete quality-gate matrix, regenerate every
scoreboard/assumption artifact, run packaging/privacy smokes, and capture a
polyglot phase/counter plus wall/CPU/RSS benchmark before updating the release
and Rust decision notes.

### P6 — Integrated acceptance and release decision

Status: complete

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

Progress:

- The first complete matrix pass reached the full suite after typecheck, lint,
  boundaries, assumption sync, and all four scoreboard generators passed. It
  exposed one deterministic T3.6 smoke regression rather than being waived.
- Root cause: the P3 entrypoint exception intended for Rust contains-only
  private symbols did not explicitly exclude exported symbols. Production
  roots masked this through production surface reachability; a TypeScript test
  root incorrectly surfaced its exported setup function as `test-only`.
- Core now pre-indexes exported symbol ids once and permits only contains-only
  symbols through the entrypoint exception. The 60 focused TS/core/Rust tests
  pass, Rust private-item recall remains intact, and the Elixir scoreboard
  returns to its committed 10-case precision/recall 1.0 state with zero
  unlabelled claims.
- Parallel full-suite execution exposed a compiler-cache isolation flaw in the
  bridge corpus: simultaneous Mix/Cargo analyses of one fixture could observe
  another worker's fresh build and lose diagnostic facts. Every corpus analysis
  now copies tracked fixture inputs to a unique temporary root and excludes
  build output. The concurrent bridge/gate reproducer and full suite pass.
- Polyglot performance output now attributes shared discovery, boundary/config
  detection, Elixir tracing, Cargo/rustc checks, convention extraction,
  fragment/bridge graph work, global reachability, hazards, and claims. A
  regression test requires the applicable phases and final counters to be
  non-zero; unsupported work such as TS module resolution in the Rustler-only
  fixture remains an explicit zero.
- Cold public Rustler fixture evidence (tracked files copied to a fresh
  directory): 1.01s wall, 1.41s external user+system CPU, 132.9MB external peak
  RSS, schema-valid JSON, 5 files, 12 symbols, 37 edges, 2 claims, 3 workspaces,
  9 graph walks, 5 fixed-point iterations, and zero deletion simulations.
  Compiler/parsing work is 879.456ms; convention extraction is 2.118ms, graph
  construction 1.012ms, reachability 0.541ms, hazards 0.096ms, and claims
  1.052ms. The compiler boundary, not the bounded JavaScript graph core,
  dominates this deliberately small cold polyglot run. Reproduction details
  are in `docs/bench/2026-07-21-polyglot-acceptance.md`.
- Final matrix: typecheck; lint with the established 2 warnings and 48
  informational diagnostics; dependency boundaries (917 modules / 1,980
  dependencies); generated-assumption sync; all 81 test files / 1,064 tests;
  build; and diff check pass.
- Final scoreboards: TypeScript 52 cases / 237 subjects, precision 1.0, recall
  0.826530612244898; Elixir 10 / 26, precision and recall 1.0; Rust 4 / 12,
  precision 1.0 and recall 0.8333333333333334; polyglot bridge 1 / 4,
  precision and recall 1.0. Every scoreboard has zero false positives,
  confidence violations, and unlabelled claims.
- The packed package installs in a new npm project under the selected Node 22
  runtime. Its installed bin renders help and produces diagnostic-free schema
  1.3.0 JSON; the tarball contains the CLI, claim schema, README, LICENSE, and
  package metadata. The privacy scan found zero consuming-project identifiers,
  new absolute user paths, or credential patterns in tracked delivery changes.
- The separate validation-only consuming-project rerun completed within its
  interactive budget. Canonical and filtered machine output remained valid,
  ordinary modes performed zero deletion simulations, the reviewed runtime
  subjects produced no false claims, and deletion queries refused the live
  subjects. Only this de-identified conclusion is recorded here.

P6 decision: ADR 0013 delivery is technically accepted for the founder's
v0.1.0 release decision. A broad Rust rewrite remains unwarranted: TypeScript's
algorithmic hot paths are corrected and parser-dominant in native Oxc, while
the polyglot cold path is dominated by the required external compilers. No tag,
push, publish, or consuming-project mutation was performed by this programme.

Next action: founder release review. Any semver tag, push, or publication remains
an explicit founder action.

### P7 — Public polyglot observability

Status: complete

Schema 1.3.0 is the ADR 0006 MINOR addition that makes P2's completion facts
public. Canonical JSON now contains a deterministic `run.boundaries` record for
every completed frontend boundary and a required `language` on every claim.
TypeScript renders `ts` without changing its historical empty claim-id language
slot; `idVersion` remains 1 and every existing claim id stays stable. SARIF
projects the same language into each result's properties.

A neutral built-CLI regression creates a root TypeScript project, a nested Mix
application, and a Cargo crate nested beneath that application. It validates
the output against the shipped schema, asserts all three completion records,
and requires claims attributable to `ts`, `ex`, and `rs`. The release matrix
passes at 81 files / 1,066 tests; all four corpus scoreboards retain precision
1.0 and their accepted totals. The installed-tarball smoke emits schema 1.3.0
with a boundary record and attributed claims. The privacy scan finds no private
consumer identifier, added absolute user path, private-key marker, or credential
marker.

### P8 — Elixir test-partition completeness

Status: complete (`af6d953`)

Objective: preserve useful production compiler facts when isolated ExUnit
compilation is incomplete without allowing any potentially test-reachable
subject or bridge descendant to look deletion-safe.

Implemented checkpoint:

- tracer `test_compile_error` is retained as explicit partition completeness;
- schema 1.4.0 requires production/config/test status and marks the boundary
  partial when the test partition is incomplete;
- a non-claimable `mix.exs` safety anchor reaches every compiler-known
  production file, module, and public function before bridge/global
  reachability;
- deterministic diagnostics are out-of-band on stderr; and
- deletion planning refuses live `safety-root` inbound references.

Neutral acceptance coverage uses an independently generated Mix application
whose normal test command starts application state that a test module reads at
compile time. Unit, same-graph `why`, deletion, canonical CLI, corpus, complete
fixture equivalence, and mixed TypeScript/Elixir/Rust bridge tests are present.

Verification:

- typecheck passes; lint passes with the established 2 warnings and 48
  informational diagnostics; dependency boundaries pass over 917 modules and
  1,982 dependencies; `git diff --check` passes;
- the full toolchain-equipped suite passes all 81 files / 1,075 tests;
- schema tests, canonical JSON stdout/stderr separation, same-graph `why`,
  deletion refusal, exact complete-fixture claims, and mixed bridge protection
  are included in that run;
- generated assumption set 1.8 is in sync; build and an installed-tarball smoke
  emit diagnostic-free schema 1.4.0 JSON with complete partition metadata;
- TypeScript remains 52 cases / 237 subjects, precision 1.0, recall
  0.826530612244898; Elixir is 11 / 29, precision 1.0, recall
  0.9090909090909091 with the single deliberate incomplete-partition recall
  miss; Rust remains 4 / 12, precision 1.0, recall 0.8333333333333334; Rustler
  remains 1 / 4 at precision and recall 1.0; every corpus has zero false
  positives, confidence violations, and unlabelled claims; and
- the privacy scan finds no added absolute user paths, credential/private-key
  markers, or paths outside the neutral public fixture/docs/package scope.

Independent review approved the complete diff. The accepted checkpoint is
`af6d953` (`feat: expose incomplete analysis partitions`).

### P9 — Isolated `MIX_ENV=test` support tracing

Status: implementation verified; independent review approved

Objective: trace modules selected by effective test-only `elixirc_paths`
without starting the application or allowing test-environment compilation to
contaminate production facts.

Confirmed public reproduction:

- an independently generated Mix application configures
  `elixirc_paths(:test) == ["lib", "test/support"]`;
- a test uses a macro defined in `test/support`, and normal `mix test` passes;
- the accepted `af6d953` analyzer runs its manual ExUnit compile inside the
  development tracer, cannot load that macro, and publishes a conservative
  partial test partition.

Approved design:

- keep strict production tracing in the caller's original Mix environment and
  existing isolated build;
- run a second phase-aware child with explicit `MIX_ENV=test`, `--no-start`, a
  distinct isolated build, and dependency links only from the matching test
  environment;
- compile the effective test environment, retain facts only from the
  non-production `elixirc_paths` delta and sorted `test/**/*_test.exs`, and
  ignore compatible re-emission from production-inventory files;
- never run `mix test`, require `test_helper.exs`, start the target application,
  fetch dependencies, or write consumer build artifacts;
- require an exit-zero child and exactly one complete phase terminal before
  merging any test facts; exact-dedupe and stable-sort the merged records;
- discard all test records and mark partial for missing same-environment
  artifacts, layout/output/protocol failures, timeouts, support/test compile or
  runtime failures, and novel/conflicting module/file ownership; and
- retain the schema-1.4 partial diagnostic and production-surface/bridge safety
  roots unchanged for every incomplete case.

Acceptance before review:

- neutral standard and custom support-path coverage proves correct test-only
  reachability and complete metadata;
- tests prove the target app/test helper never starts and both consumer build
  trees are unchanged;
- missing test artifacts, support/runtime failure, malformed/partial output,
  and ownership collision are explicit partial results, never throws or silent
  completeness;
- deterministic merge, no-test completeness, JSON stdout purity, existing
  incomplete `why`/delete behavior, and Rustler bridge safety remain green;
- update this ledger/progress/ADR/assumption disclosure, run all public gates,
  then send design/diff/results for independent review before any commit.

Implementation and verification:

- the runner is now a bounded orchestrator over dedicated error, Mix-isolation,
  phase-protocol, and ownership/merge modules;
- the phase decoder rejects null, unknown, foreign, malformed, missing, and
  duplicate records; trace reads are size-bounded before allocation;
- production/test module and function re-emission must be semantically equal,
  and production-owned test edges are discarded only when an equivalent
  production edge exists; an additive edge from a compatibly re-emitted module
  is retained as test-scoped after strict owner-source validation, while novel
  module/function semantics or unprovable ownership make the partition partial;
- effective dependency build paths and `:app` resource contracts come from
  `Mix.Dep` in each phase: required resources are validated, absent optional or
  `compile: false, app: false` artifacts remain optional, `app: false` requires
  no `.app`, and a binary custom `app:` path is followed exactly;
- caller build semantics are preserved for `MIX_BUILD_ROOT`, `MIX_BUILD_PATH`,
  `MIX_TARGET`, per-environment and shared builds. An exact `MIX_BUILD_PATH` is
  shared across phases because Mix defines it as an exact override; otherwise
  dev/test provenance remains distinct, and all source build trees remain
  byte/timestamp stable;
- neutral generated integration cases cover a support macro plus a custom
  support path, target application and `test_helper` non-start, discovery and
  timeout failures, missing/optional/app-less/custom-resource artifacts,
  support/test runtime failure, compiler rejection and direct ownership
  collision, reflection failure, no-tests completeness, exact/root/target/shared
  Mix build layouts, provenance, and build non-mutation;
- `fixtures/elixir/test-support-paths` independently locks macro-expanded
  standard support and custom effective support-path `why` evidence; ordinary
  `mix test` passes;
- focused runner, real-Mix, and analysis coverage passes 64/64;
- the full Elixir-equipped suite passes 83 files / 1,130 tests with no skips;
  typecheck, lint (the established 2 warnings / 48 infos), dependency boundaries
  (923 modules / 2,010 dependencies), assumption-set 1.9 sync, build, and diff
  checks pass; and
- all corpus gates retain zero false positives, confidence violations, and
  unlabelled claims: TypeScript 52 cases / 237 subjects (precision 1.0, recall
  0.826530612244898), Elixir 12 / 31 (precision 1.0, recall
  0.9090909090909091), Rust 4 / 12 (precision 1.0, recall
  0.8333333333333334), and polyglot 1 / 4 (precision/recall 1.0).
- a packed tarball installs into a fresh npm project; its installed CLI emits
  diagnostic-free schema-1.4 JSON with boundary metadata, and the archive
  contains the CLI, claim schema, README, LICENSE, and package metadata; and
- the privacy scan finds zero consuming-project identifiers, absolute user
  paths, credential/private-key markers, or non-neutral source material in the
  tracked diff and untracked delivery files.

#### Test-scoped production-edge follow-up

Status: non-owner provenance amendment and public verification complete;
independent review approved, commit pending

Resume objective: retain additive `MIX_ENV=test` references emitted by a
semantically compatible production module without weakening the fail-closed
ownership boundary or relabelling evidence provenance.

Design and acceptance:

- discard exact production event duplicates; accept a novel event from a
  production-owned module only after its test reflection is semantically
  compatible;
- require the event's exact reflected owner source, or normalize only a single
  safe extensionless compiler pseudo-source to that unique owner; ownerless
  events remain restricted to the explicit test inventory, and all ambiguous,
  external, substituted, path-like, or extension-bearing sources fail closed;
- for an exact semantic duplicate only, allow a raw compiler/library/template
  source that exactly matches bounded provenance recorded when a validated
  production event's raw source differed from its reflected owner; preserve
  safe repository-relative production evidence, normalize unsafe production
  evidence to its owner, and keep the raw provenance weak, lazy, internal, and
  nonserialized so ordinary owner-sourced events allocate none and cannot
  authorize a non-owner duplicate;
- represent the accepted event as a test-scoped IR edge: production/config
  traverse shared edges, while the effective test world traverses shared plus
  test edges from immutable roots retaining their actual ids, kinds, and
  reasons;
- derive test-only claims by subtracting production/config reachability; make
  `why`, per-test zombie walks, and deletion consequences honor the same edge
  activity without introducing synthetic roots;
- neutral generated Mix coverage must prove both exact-owner and extensionless
  pseudo-source cases, plus complete/partial merge negatives; shared-edge and
  production/config regressions must remain green; and
- before commit: synchronize assumption set 1.12, run all public quality gates,
  corpus gates, packaging and privacy smokes, then obtain independent review.

Non-owner provenance amendment (2026-07-22):

- the exact-duplicate exception now covers validated safe repository-relative
  non-owner source labels as well as unsafe external labels; it remains an
  exact semantic-key plus raw-source match, never authorizes a novel edge, and
  does not alter safe production evidence;
- synthetic negatives cover changed safe, external, and test-inventory raw
  sources; changed target, function name, and dynamic-dispatch semantics;
  ownerless and unknown owners; and an ordinary owner-sourced production event
  attempting to authorize a non-owner test duplicate; and
- an independently generated real-Mix EEx fixture uses a tracked template as
  the shared non-owner compiler source. It proves the production evidence stays
  `priv/shared.eex`, the exact test re-emission is discarded rather than added
  as a test edge, and the tracked template and source build tree are unchanged.

Amendment verification (2026-07-22):

- the focused ownership suite passes 65/65 and the neutral real-Mix suite passes
  25/25 under Elixir 1.20.2 / Erlang 29.0.3;
- the complete Elixir-equipped suite passes 83 files / 1,177 tests with no
  skips; typecheck, assumption-set 1.12 generation/sync, build, lint (the
  established 2 warnings / 48 infos), dependency boundaries (923 modules /
  2,014 dependencies), and diff checks pass;
- all corpus gates retain zero false positives, confidence violations, and
  unlabelled claims: TypeScript 52 cases / 237 subjects (precision 1.0, recall
  0.826530612244898), Elixir 13 cases / 33 subjects (precision 1.0, recall
  0.9090909090909091, no toolchain skips), Rust 4 cases (precision 1.0, recall
  0.8333333333333334), and polyglot 1 case (precision/recall 1.0); and
- a packed tarball installs under Node 22.16.0 and emits diagnostic-free schema
  1.4.0 JSON from a neutral entrypoint. Its archive contains the CLI, claim-run
  schema, README, LICENSE, and package metadata. The public-diff privacy scan is
  clean; and
- final independent review reports no findings and separately passes the 65
  focused ownership cases, 25 real-Mix cases, typecheck, assumption sync, lint
  baseline, and diff checks.

Verification checkpoint (2026-07-22):

- targeted graph, merge, deletion, reporting, CLI, and MCP coverage passes 7
  files / 260 tests with 8 expected environment-gated skips; the neutral
  real-Mix suite passes 24/24;
- the full Elixir-equipped suite passes 83 files / 1,168 tests with no skips;
  typecheck, build, assumption-set 1.11 sync, lint (the established 2 warnings /
  48 infos), dependency boundaries (923 modules / 2,014 dependencies), and diff
  checks pass;
- all corpus gates retain zero false positives, confidence violations, and
  unlabelled claims: TypeScript 52 cases / 237 subjects (precision 1.0, recall
  0.826530612244898), Elixir 13 cases / 33 subjects (precision 1.0, recall
  0.9090909090909091, no toolchain skips), Rust 4 cases (precision 1.0, recall
  0.8333333333333334), and polyglot 1 case (precision/recall 1.0); and
- a packed tarball installs under Node 22.16.0 and emits diagnostic-free schema
  1.4.0 JSON. Its archive contains the CLI, claim-run schema, README, LICENSE,
  and package metadata. The public-diff privacy scan is clean.

#### Dead-inbound deletion-plan follow-up

Status: complete and independently approved

Resume objective: make every language-agnostic single-subject deletion plan
account for ordinary inbound references from unreachable callers, without
weakening the underlying claims or inventing unsafe cross-language rewrites.

Accepted v0.1 design and acceptance:

- preflight the selected subject plus its unavailable named/star re-export
  surface, and reject any external non-re-export inbound edge regardless of the
  source's production/config/test reachability;
- report the deterministic first stored source site and keep the unsupported
  schema-1.4 shape (`reExportEdits: []`, `stages: []`); re-export-only plans
  remain supported with their exact proven edits;
- centralize the preflight in core so `why --delete`, bounded report planning,
  and `--fix` cannot disagree. Build one inbound index per captured graph and
  reuse it across report/fix plans; the new lookup must not add a whole-graph
  scan per claim;
- do not put unreachable callers into `stages`: they were dead before the
  counterfactual and are not newly dead. A future atomic deletion-cohort field
  could remove callers and targets together without edits, but requires a
  schema minor bump and separate approval;
- independently generated neutral graph, TypeScript CLI, real-Mix Elixir, test-
  scoped, runtime, re-export, deterministic-order, and Rust/Rustler regressions
  must cover the shared rule. Claims, confidence, corpus labels, and ordinary
  canonical JSON remain unchanged; and
- benchmark indexed planning over increasing neutral graphs, run all public
  quality/corpus/package/privacy gates, and obtain independent review before a
  focused commit.

Implementation checkpoint (2026-07-22):

- core now builds deterministic ordinary-inbound and reverse-re-export indexes
  in O(E). `why --delete`, bounded report summaries, and `--fix` all call the
  same preflight; report and fix runs reuse one index for their captured graph;
- direct targets are checked before re-export closure work. Named, star, alias,
  and namespace-forwarded surfaces are then checked through the indexed reverse
  closure. Ordinary consumers block the plan; a surface containing only proven
  re-export edits remains supported;
- TypeScript selected-export plans retain their existing same-file local-use
  exception because the rewrite removes the export surface rather than the
  local binding. Elixir, Rust, and cross-language symbols have no such reflected
  local-name marker, so their same-file runtime references remain blockers;
- neutral graph and CLI coverage proves direct dead callers, test-scoped edges,
  stable source-site ordering, same-file TypeScript local use, exact re-export
  edits, and forwarded consumers. Existing neutral runtime Elixir and Rustler
  cases exercise the shared rule. A real-Mix fixture keeps its three valid dead
  file claims while proving that either target alone fails compilation and the
  reviewed caller-plus-target cohort compiles;
- schema, claim confidence, canonical JSON, and assumption-set 1.12 are
  unchanged. The unsupported schema-1.4 variant has empty edits/stages. Adding
  atomic cohorts remains a separately approved future schema-minor change; and
- a 30-repeat synthetic direct-blocker probe with 10 planned targets measured
  these medians on Node 22.16.0:

| Files | Symbols | Edges | O(E) index | 10 blocker plans |
| ---: | ---: | ---: | ---: | ---: |
| 260 | 260 | 770 | 0.023 ms | 0.067 ms |
| 510 | 510 | 1,520 | 0.009 ms | 0.094 ms |
| 1,010 | 1,010 | 3,020 | 0.020 ms | 0.126 ms |
| 2,010 | 2,010 | 6,020 | 0.036 ms | 0.224 ms |
| 4,010 | 4,010 | 12,020 | 0.072 ms | 0.453 ms |

Index construction is O(E), and the measured direct-blocker curve is
near-linear. A structural regression also proves that repeated direct-blocker
plans using the context do not call `graph.edges()`. This table does not
characterize forwarded-surface closure: named/star/namespace forwarding still
uses bounded reverse-index walks plus the pre-existing re-export/reachability
counterfactual, and is exercised for correctness rather than presented here as
a general deletion-planning complexity result.

Verification checkpoint (2026-07-22):

- the focused public suite passes 8 files / 208 tests, and the full pinned
  Elixir-equipped suite passes 83 files / 1,187 tests with no skips;
- typecheck, build, assumption-set 1.12 sync, lint (the established 2 warnings /
  48 infos), dependency boundaries (923 modules / 2,013 dependencies), and the
  dedicated Elixir corpus gate (1 file / 4 tests) pass;
- all scoreboards have zero false positives: TypeScript 52 cases / 237 subjects
  (precision 1.0, recall 0.826530612244898), Elixir 14 cases / 36 subjects
  (precision 1.0, recall 0.9285714285714286, no toolchain skips), Rust 4 cases
  (precision 1.0, recall 0.8333333333333334), and polyglot 1 case
  (precision/recall 1.0). Only the intended Elixir artifact changes;
- a packed tarball installs under Node 22.16.0 and emits diagnostic-free
  schema-1.4 JSON from a neutral TypeScript entrypoint. Its archive contains the
  CLI, claim-run schema, README, LICENSE, and package metadata; and
- diff checks and scans of the complete public tree/diff for private project
  identifiers, host paths, private keys, and common credential forms are clean;
  and
- independent review found and drove two corrections before approval: bucket
  and blocker sorting were replaced by linear deterministic selection, and a
  forwarded star barrel no longer treats a harmless side-effect consumer as a
  blocker. Exact-name and unknown consumers remain conservative, with focused
  regressions for both sides. Final re-review reports no remaining findings.

#### Load-free BEAM reflection follow-up

Status: complete and independently approved in `76dc36b`

Objective: retain compiler-backed Elixir precision when a compiled module has
an unavailable native `@on_load` hook, without loading or executing that module
during reflection.

Design and acceptance:

- enumerate sorted production and test BEAM paths in their isolated compile
  directories; test sources compile with `Kernel.ParallelCompiler.compile_to_path`;
- derive module/source, behaviours, protocol/implementation markers, and the
  public export surface from validated BEAM metadata, with path-based EEP-48
  docs used only for optional line evidence;
- exclude `module_info`, `behaviour_info`, generated `__*__` helpers, struct
  helpers, and raw `MACRO-*` exports while retaining ordinary/default-wrapper
  functions;
- valid docs-disabled output remains complete with line-zero evidence; missing
  or malformed core metadata fails closed under the existing production/test
  completeness contracts;
- the neutral `on-load-beam-reflection` corpus case proves compile success,
  explicit load failure, behaviour/function accuracy (including default-arity
  wrappers), production callback `why` evidence, deletion refusal, and zero
  analyzer-created hook marker;
- persisted behaviour/protocol/implementation carrier facts add bounded
  carrier-to-public-function runtime edges: callbacks become explainably live
  only when their carrier module is reachable, while an unreachable carrier
  remains a high-confidence dead-file candidate; and
- preserve source build trees, JSON purity, corpus precision, and the disclosed
  compiler-only execution boundary.

Current focused evidence: the Elixir frontend passes 8 files / 101 tests; the
real-Mix environment file passes 23/23; the Elixir corpus passes 13 cases / 33
subjects at precision 1.0 and recall 0.9090909090909091 with no skipped cases,
false positives, confidence violations, or unlabelled claims.

Full verification passes 83 files / 1,141 tests, typecheck, lint (the established
2 warnings / 48 infos), boundaries (923 modules / 2,014 dependencies),
assumption-set 1.10 sync, all four corpus gates, build, installed-tarball JSON,
build-tree non-mutation, diff, and privacy checks.

Next exact action: rerun the consuming project separately with the committed
schema-1.4 CLI, require complete TypeScript, Elixir production/test, and Rust
partitions, then resume deletion only from that complete graph. Keep all
consumer output and identifiers outside this public repository.

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
pnpm run scoreboard:rust
pnpm run scoreboard:polyglot
pnpm run build
git diff --check
```

Packaging and privacy smokes remain mandatory before any release recommendation.

## Decision log

- 2026-07-21: first-class means one global graph/claim pass, not merged reports.
- 2026-07-21: plugin categories are language, convention, and bridge.
- 2026-07-21: plugins are statically registered until three languages and one
  bridge prove the contracts.
- 2026-07-21: Rustler/NIF is the first cross-language bridge.
- 2026-07-21: consuming-project evidence remains private and is never the source
  of public fixtures.
- 2026-07-21: bounded partition incompleteness is explicit `partial` metadata,
  never an unqualified complete boundary or a confidence-only downgrade.
- 2026-07-22: BEAM reflection reads validated file metadata without loading
  project modules; compiler-proven runtime carriers provide conditional,
  evidence-bearing callback reachability without rooting dead carrier files.

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
- `6ed8fc8` through `d1f365c` — locked the Rustler bridge and completed
  TypeScript/Elixir convention modularization plus the authoring contract.
- `4a7d452` — restored the exported-entrypoint invariant found by the complete
  matrix.
- `532352c` — isolated compiler-backed corpus runs for deterministic parallel
  gates.
- `9238c77` — completed polyglot phase and resource instrumentation.
- `76dc36b` — made BEAM reflection load-free and aligned runtime callback
  reachability, `why`, and deletion refusal with compiler-proven carriers.

### Standalone Elixir script inventory follow-up

Status: complete and independently approved from clean checkpoint `33ec88f`

Resume objective: make gitignore-visible standalone Elixir scripts first-class
source without treating every script as a production root or weakening
deletion safety.

Frozen design and acceptance:

- extend the existing single repository discovery pass with `.ex`/`.exs`
  inventory; reject ignored/external paths and keep compiler, Mix, config, and
  test ownership unchanged;
- implement extraction as the statically registered
  `convention:elixir-scripts`, with direct-root and nested polyglot-boundary
  coverage;
- leave arbitrary untraced scripts unrooted and claimable; root only an exact
  executable/shebang/`Mix.install` script or exact GitHub Actions/Taskfile
  `elixir`/`mix run` command target, plus exact formatter/IEx configuration and
  dependency-scoped Ecto/Phoenix migration/seed paths; arbitrary `priv` scripts
  remain claimable;
- add exact source-provenance edges for known literal aliases, remote calls,
  MFA tuples, exact script loads, and inter-script module references;
- cap only a script-defined module or opaque dynamic invocation at medium with
  `elixir-script-opaque`; do not add a project-wide suppression or root;
- mask strings/heredocs at code-unit-stable offsets, cover grouped aliases and
  optional-parentheses calls/loads, and apply a carrier-reachable bounded cap
  for residual syntax in an actually rooted script;
- prove target-only deletion refusal for compiler-known and inter-script
  targets while retaining an explicit, manually possible deletion cohort;
- corpus-label every live/dead subject, synchronize assumption set 1.13, keep
  canonical JSON/schema unchanged, and preserve compiler build isolation;
- demonstrate bounded scaling with the generated 250–4,000-file benchmark in
  `docs/bench/2026-07-22-elixir-script-inventory.md`; and
- run typecheck, lint, boundaries, the full Elixir-equipped suite, generated
  assumptions, all four corpus scoreboards, build, installed-tarball smoke,
  diff/privacy checks, and independent public-only review before one focused
  commit. Do not run the private consuming project from this workstream.

Final matrix before review: typecheck, build, generated assumption set 1.13,
lint (the established 2 warnings / 48 infos), boundaries (925 modules / 2,030
dependencies), and the full Elixir-equipped suite (84 files / 1,196 tests, no
skips) pass. All corpus gates retain zero false positives, confidence
violations, and unlabelled claims: TypeScript 52 cases / 237 subjects (precision
1.0, recall 0.826530612244898), Elixir 15 / 41 (precision 1.0, recall
0.9473684210526315), Rust 4 / 12 (precision 1.0, recall
0.8333333333333334), and polyglot 1 / 4 (precision/recall 1.0). An installed
tarball under Node 22.16.0 emits diagnostic-free schema-1.4 JSON and contains
the CLI, schema, README, LICENSE, and package metadata; diff and privacy checks
pass.

The neutral
fixture produces five intended file claims, roots its exact Taskfile target,
excludes ignored input, keeps a compiler-visible Mix task alive, refuses two
unsafe target-only plans with exact caller sites, and verifies the explicit
caller-plus-target cohort still compiles.

Framework/syntax review corrections are included in that matrix: an Ecto-
scoped neutral inventory roots all 300 generated migration scripts while an
adjacent manual `priv` script remains unrooted; hidden formatter/IEx discovery
is exercised end to end; strings/heredocs and Unicode offsets cannot create
false roots; optional-parentheses and grouped-alias forms retain their targets;
and repository command carriers are scanned once per orchestration context.
Independent public-only review drove and then approved the code-position mask,
optional-parentheses/capture coverage, separate opaque and bounded hazards,
framework-owned path rules, shared carrier cache, one-time exact-load membership
set, and both adversarial scaling series. No private access or review artifact
entered the repository.
