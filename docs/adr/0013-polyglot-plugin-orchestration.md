# 0013 — First-class polyglot orchestration and plugin contracts

Date: 2026-07-21
Status: Accepted (founder directive, 2026-07-21)

## Context

The product exists to make deletion trustworthy in a private consuming
codebase whose runtime spans TypeScript, Elixir, and Rust NIFs. The current
language dispatch is not sufficient for that purpose:

- it detects only `package.json` and `mix.exs` at the requested root;
- nested language boundaries must be analyzed separately;
- each frontend computes reachability and claims before graphs are merged;
- concatenating claims means a cross-language edge cannot make a claimed
  subject alive; and
- framework/convention knowledge is implemented as frontend-local functions,
  not a common extension contract.

Matching Knip's complete integration catalogue is not the goal. The required
product is a polyglot deletion oracle with selective, high-quality integrations
that are modular and independently testable.

## Decision

### One repository analysis

`unused --cwd <repository>` discovers every supported project boundary beneath
the requested root, excluding ignored, dependency, generated, and build-output
trees. TypeScript workspaces, Mix projects, Cargo workspaces/crates, and future
frontends participate in one run.

Every frontend emits a **repository-relative graph fragment** and supporting
claim inputs. Frontends do not produce the final claim set in the polyglot
path. The orchestrator performs these stages in order:

1. discover language project boundaries;
2. run each language frontend and collect graph fragments;
3. run convention plugins within their applicable fragments;
4. merge fragments into one collision-safe repository graph;
5. run bridge plugins over the merged inventory;
6. compute global partitioned reachability once;
7. emit, suppress, and report claims once; and
8. retain the merged graph for `why` and deletion planning.

Bridge edges therefore exist before liveness is decided. An Elixir function
referenced only through a Rustler registration, or a Rust NIF referenced only
through an Elixir stub, cannot be claimed dead.

### Three typed plugin contracts

The initial plugin system is statically registered and compiled with the tool.
It is not arbitrary runtime code loading.

- **Language frontend plugin** — detects project boundaries and emits graph
  fragments plus language-specific claim inputs and diagnostics.
- **Convention plugin** — contributes roots, references, hazards, or dependency
  facts for one language/framework/tool without owning orchestration. Existing
  Next, Vite, Storybook, Phoenix, OTP, Taskfile, CDK, and similar recognizers
  migrate behind this contract incrementally.
- **Bridge plugin** — observes multiple language inventories and adds
  provenance-bearing cross-language edges. Rustler/NIF is the first bridge.

All plugins have stable ids, explicit applicability, declared capabilities, and
deterministic output. A failure records the responsible plugin and boundary.
It never silently disappears.

External/community-loaded plugins are deferred until the contracts have been
proven by TypeScript, Elixir, Rust, and Rustler. The internal registry is the
community contribution seam in the meantime.

### Identity and repository coordinates

Every file, site, unit, and claim location is POSIX and relative to the analysis
repository root. Project-boundary-relative paths are rebased before merging.
Node identities must remain collision-safe when two languages expose the same
relative path or symbol spelling. Language and owning boundary are graph
metadata and participate in claim identity; TypeScript's existing empty
language slot remains wire-compatible.

### Completeness and partial failure

The orchestrator records every detected frontend boundary as complete, partial,
unsupported, or failed, with production/config/test partition status. A detected boundary that cannot be analyzed prevents
high-confidence claims whose proof could cross that boundary. The default CLI
fails closed when a required toolchain or compiler run fails; a future explicit
partial-analysis mode may return bounded results but may not masquerade as a
complete run.

A frontend may return `partial` only when it can bound the missing facts toward
alive. The initial case is an incomplete Elixir test compile: compiler-known
production surfaces are safety-rooted before bridges and global reachability, so
the incomplete boundary and its exact bridge descendants cannot produce a
deletion-safe claim. Unrelated complete boundaries continue normally.

Elixir and Rust compiler/tooling execution remains explicit. TypeScript keeps
its no-user-code-execution posture.

### Rust and Rustler

The Rust frontend uses Cargo project metadata and compiler-derived facts where
available; the exact compiler integration is selected through a measured spike,
not assumed in this ADR. It must model crates, targets, source files, public
items, roots, tests, build scripts, features, and macro uncertainty without
claiming public API solely because a private-call lint is silent.

The Rustler bridge independently recognizes the two sides of a NIF contract:
Elixir NIF stubs/module setup and Rust exported NIF registrations/functions. A
literal, provable pairing creates an exact `runtime-resolved` edge. Ambiguous
registration creates the narrowest safe no-claim or confidence cap. Every edge
carries the source site used by `why` and deletion planning.

### Deletion and explanation

`why` paths may cross languages and must label each transition. `why --delete`
and `--fix` operate on the merged graph. A live cross-language inbound edge
blocks deletion; a supported plan includes cross-language consequences and
required edits. No language frontend may bypass the shared safety policy.

## Acceptance

The programme is complete when:

1. one repository-root invocation detects and analyzes nested TS, Mix, and
   Cargo boundaries;
2. output is one schema-valid claim run with language and owner attribution;
3. a neutral Rustler fixture proves Elixir → Rust liveness, cross-language
   `why`, and safe deletion refusal/consequences;
4. removal of the bridge edge makes the planted Rust and Elixir subjects
   claimable, proving the fixture is not vacuous;
5. missing toolchains and failed boundaries fail explicitly;
6. TS, Elixir, Rust, and bridge corpus precision is 1.0, with recall reported;
7. ordinary JSON/report modes perform no eager deletion simulations;
8. the 2,000+ TypeScript scaling fixture remains within its accepted curve;
9. canonical consuming-project TS+Elixir+Rust analysis completes within the
   interactive budget and reviewed live subjects are not claimed; and
10. no private consuming-project identifiers, source, paths, configuration,
    artifacts, or raw output enter the public repository.

## Consequences

- The current `dispatch.ts` claim-concatenation path is transitional and will
  be removed after graph-fragment orchestration is live.
- Frontend composition must separate graph extraction from global claim
  emission; this is a deliberate architectural change, not a Rust-only patch.
- Selective convention coverage is acceptable. New support must use a plugin
  contract rather than add orchestration conditionals.
- The first Rust milestone can be conservative and incomplete, but it cannot
  emit confident claims from an incomplete boundary.
- A broad native rewrite remains out of scope; Rust is a target language and a
  possible bounded implementation tool only where profiling justifies it.
