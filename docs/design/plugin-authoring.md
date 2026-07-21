# Internal plugin authoring

Status: pre-v0.1 internal contract  
Decision: ADR 0013  
Delivery ledger: `docs/delivery/polyglot-first-class.md`

This guide is the implementation contract for compiled-in language,
convention, and bridge plugins. It does not define a third-party loading ABI.
External loading remains deferred until the built-in TypeScript, Elixir, Rust,
and Rustler implementations have proved the boundary.

## Choose the narrowest plugin kind

- A `LanguageFrontendPlugin` discovers a manifest boundary and emits a complete
  repository-relative graph fragment plus the inputs core needs to emit claims.
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

Computed or ambiguous runtime identity requires a registered hazard with the
narrowest truthful scope. A convention must never invent an edge just to gain
recall. A bridge should join exact endpoint keys and keep unmatched externally
visible runtime surfaces alive unless the repository is provably closed.

## Migrating frontend-owned conventions

Do not enable a plugin alongside the same frontend emission. Extract or reuse a
pure recognizer, add a narrow internal deferral flag to the language adapter,
and transfer ownership only in registry-driven analysis. Preserve the direct
single-language path until compatibility evidence permits removing it.

The first example is `github-actions-run`:

- direct `analyzeProjectWithGraph` still emits the established config roots;
- `typescriptLanguagePlugin` defers that exact family;
- `convention:typescript-github-actions` invokes the shared recognizer and
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
