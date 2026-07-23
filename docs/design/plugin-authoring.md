# Internal plugin authoring

Status: pre-v0.1 internal contract  
Decision: ADR 0013  
Delivery ledger: `docs/delivery/polyglot-first-class.md`

This guide is the implementation contract for compiled-in language,
convention, and bridge plugins. It does not define a third-party loading ABI.
External loading remains deferred until the built-in TypeScript, Elixir, Rust,
and Rustler implementations have proved the boundary.

## Choose the narrowest plugin kind

- A `LanguageFrontendPlugin` discovers a manifest boundary and emits a
  repository-relative graph fragment plus the inputs core needs to emit claims.
  It declares production/config/test completeness; a partial fragment is valid
  only when missing facts have been conservatively safety-rooted.
- A `ConventionPlugin` adds roots, references, endpoints, or hazards for one or
  more languages. It must not compute reachability or emit claims.
- A `BridgePlugin` joins already-emitted facts across language fragments. It
  runs after every applicable convention and before the one global reachability
  pass. It must not invoke another language frontend.

Keep one plugin responsible for one auditable convention family. Prefer a
literal edge or root over a hazard; prefer a narrowly scoped hazard over a
project-wide cap; when identity cannot be proved, degrade toward alive.

## Identity and paths

- Plugin ids are stable lowercase namespaces such as
  `convention:typescript-github-actions` or `bridge:rustler`.
- Every graph path and `Site.file` returned by a plugin is POSIX and relative to
  the repository analysis root, even when the plugin analyzes a nested project.
- Use `prefixRepositoryPath` when adapting a recognizer whose paths are local to
  a boundary. Reject a path outside its declared boundary instead of silently
  rebasing it.
- Reuse core ids (`fileId`, `symbolId`, `entrypointId`, `endpointId`). Never
  create a second identity scheme in plugin metadata.
- Every edge and hazard has an exact source site. `why` renders stored
  provenance; it does not re-run a recognizer.

## Phase and precision rules

The repository order is fixed:

1. discover and analyze language boundaries;
2. merge collision-checked graph fragments;
3. apply convention contributions in deterministic plugin-id order;
4. apply bridge contributions in deterministic plugin-id order;
5. compute partitioned reachability once;
6. emit claims once per owning fragment against the shared reachability.

A contribution may add nodes, edges, hazards, and diagnostics. It may not
remove or mutate another plugin's facts. Duplicate identical node ids are
idempotent; conflicting shapes fail loudly. Diagnostics must be deterministic
and must never enter canonical JSON stdout.

Language diagnostics stay out-of-band. The CLI renders deterministic diagnostics
to stderr, while `run.boundaries[].status` and `.partitions` carry only stable
machine-readable completeness. An incomplete partition must not be represented
as a confidence downgrade: add the narrowest safety roots needed to make every
potentially reachable subject alive, including bridge descendants, so claim and
deletion-plan semantics agree.

When a convention depends on expensive language-tool facts, the language
frontend may prepare a `GraphContribution` during its one parse/compiler pass
and place it in `FrontendGraphFragment.deferredContributions` under the owning
plugin id. The base fragment must omit those facts in registry-driven runs; the
convention plugin activates the exact prepared contribution in phase 3. Rebase
deferred edges against the complete owning graph with
`rebaseGraphContribution`. This is an ownership hand-off, not permission to
parse, trace, or compile twice.

## Configuration ownership and projection

Repository dispatch loads an explicit or auto-discovered root config exactly
once. `--config` selects only that repository config; it is never forwarded to
nested frontends or reinterpreted relative to their directories. A nested
frontend may auto-discover its own local config. Root policy and local policy
then compose as follows:

- root and local `entry` roots are additive;
- root, physical-directory, ecosystem-name, and local `project` scopes all
  intersect;
- local suppression wins over root suppression, while an ecosystem-name
  suppression wins over a matching physical-directory fallback;
- either root or local `ignoreDependencies` may exclude a dependency claim;
- aggregate gate and CI economics belong to the repository root; ignored local
  values produce deterministic stderr diagnostics;
- a forced root preset list, including `[]`, controls every TypeScript
  boundary and shadows local preset selection.

A workspace directory key identifies one physical unit and applies to every
language frontend at that path. An ecosystem package/application/crate name
identifies only the frontend unit that reported that name. Both keys may match
one frontend: entries and exact roots are additive, projects intersect, and
the name-specific suppression is more specific. A name matching more than one
physical workspace is a configuration error; use the directory key instead.

Language frontends own local matching. They must validate local policy once,
apply file/project/dependency/suppression semantics to their claim inputs and
annotations, and emit a `FrontendConfigContribution` containing:

- the full canonical SHA-256 digest of effective local analysis policy;
- whether that policy changes analysis;
- exact configured symbol roots expanded once against authoritative frontend
  units and filtered to the frontend language;
- a common canonical selector inventory used to prove that every configured
  language has exactly one owner;
- a compact O(rules/patterns) config-warning inventory with collision-proof
  structured identities, per-language file-match/applicability facts, and
  suppression patterns scoped to their authoritative unit for the one
  post-reachability claim check; and
- any local gate/CI values needed for the repository-owned warning.

Never carry raw local config through fragment composition. The orchestrator
verifies same-directory contributions have the same digest and selector
inventory, requires every frontend to emit the same warning-rule identities,
ORs file-match status across applicable languages, and renders each unmatched
or stale warning exactly once. Do not retain per-rule matched-file lists: that
would make contribution memory grow with rules × files. The orchestrator also
merges complementary exact roots and resolves them only after all conventions
have contributed symbols. It hashes one contribution per physical local config,
so adding a second language frontend at that directory does not double-count
policy. Sorting for hashes and diagnostics uses locale-independent code-unit
order.

Plugin code imports policy types from `frontends/config-contract.ts`. Parsing
and matching still live in `frontends/ts/config.ts` as a transitional pre-v0.1
implementation detail; do not add new plugin imports of that language-owned
module. A future extraction may move the implementation behind the neutral
surface without changing plugin obligations.

An Elixir convention may also own an `elixirAtomRoleSummaryProvider`. This is a
pre-graph semantic input, not a graph contribution and not a third-party
loading surface. The repository dispatcher collects all such providers from
the deterministic convention registry before analyzing any boundary, validates
the complete inventory including collisions with language-owned summaries,
and passes the same frozen inventory to root, nested, and mixed analysis. Do
not gate this inventory on the convention's graph-phase `applies` callback;
the Elixir frontend performs its own fail-closed dependency and exact-version
applicability check against compiler facts and one parsed `mix.lock`.

Provider ids must equal their owning `convention:*` plugin id. Their Hex
dependency names and exact audited versions are data, not ranges; every summary
origin must repeat that plugin/dependency ownership. A malformed, duplicate,
colliding, or wrongly owned compiled-in provider is a registry defect and must
abort before analysis. An absent dependency, missing or non-Hex lock entry, or
unaudited version is environmental non-applicability and must omit the provider
without a diagnostic on canonical JSON stdout. Keep the summary surface sparse:
an omitted argument role remains an escape, and project-owned modules must not
inherit dependency semantics merely by using the same canonical name.

A convention may be provider-only. `convention:money` is the reference shape:
it exposes one static `elixirAtomRoleSummaryProvider`, returns `false` from its
graph-phase `applies`, and returns an empty graph contribution from `analyze`.
Register and export it normally; do not add an orchestrator conditional merely
because it contributes before graph construction. Constructor summaries stay
sparse: register only argument positions whose computed atoms can enter a
successful result, omit guard-impossible positions, and retain propagation
until a separate audited terminal actually consumes the value.

Computed or ambiguous runtime identity requires a registered hazard with the
narrowest truthful scope. A convention must never invent an edge just to gain
recall. A bridge should join exact endpoint keys and keep unmatched externally
visible runtime surfaces alive unless the repository is provably closed.

## Migrating frontend-owned conventions

Do not enable a plugin alongside the same frontend emission. Extract or reuse a
pure recognizer, add a narrow internal deferral flag to the language adapter,
and transfer ownership only in registry-driven analysis. Preserve the direct
single-language path until compatibility evidence permits removing it.

The first example is the external config-carrier family:

- direct `analyzeProjectWithGraph` still emits the established config roots;
- `typescriptLanguagePlugin` defers the GitHub Actions, Taskfile, and native
  build-script recognizers;
- `convention:typescript-config-carriers` invokes the shared recognizers and
  emits the rebased roots;
- isolated and repository-dispatch tests prove there is neither a gap nor a
  duplicate implementation.

## Tests and fixtures

Every plugin needs:

- an isolated `applies`/`analyze` test with a minimal synthetic context;
- exact assertions for nodes, edges, hazards, diagnostics, and sites;
- an inverse case that proves an unrelated file remains claimable;
- a repository-dispatch test proving the contribution affects global
  reachability before claims;
- labelled alive and dead subjects in the appropriate corpus when user-visible
  precision changes;
- `why` and deletion-plan coverage for runtime or cross-language edges.

Copy `fixtures/templates/convention-plugin/` when starting a public fixture.
Replace every placeholder with neutral names and generated code. Fixtures must
be independently derived from public conventions; never copy consumer source,
identifiers, paths, configuration, logs, profiles, or prose.

## Registration and verification

Export the plugin from its module and add it to `BUILT_IN_PLUGINS`. The
orchestrator must not gain a convention-specific conditional. Registry tests
lock deterministic ids and kinds.

At minimum run the plugin tests, affected frontend regression tests,
`pnpm run typecheck`, `pnpm run boundaries`, and `git diff --check`. A new
hazard also requires assumption-set regeneration. A new corpus requires a
scoreboard command, non-vacuous precision gates, and a committed scoreboard.
