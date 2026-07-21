# 0011 — Elixir frontend: compiler-tracer-based reference graph

Date: 2026-07-19
Status: Accepted (founder delegation, 2026-07-19; pre-v0.1.0 multi-language foundations directive)

## Context
ADR 0003 committed to multi-language positioning with per-language frontends emitting the shared IR, and named Elixir next-after-Python — moved ahead by founder directive (2026-07-19): the multi-language skeleton/pattern must exist before v0.1.0, proven against a real Elixir codebase. Research (docs/research/elixir-landscape-2026-07.md, verified live on Elixir 1.20.2/OTP 29): `mix xref` is module/file-level only since v1.10 and cannot answer function-level liveness; the compiler tracer API (`Code.put_compiler_option(:tracers, ...)`) delivers function-level events (`remote_function`, `local_function`, `struct_expansion`, …) and is what `mix_unused` and `boundary` build on; no maintained liveness competitor exists in the ecosystem.

## Options considered
- **Source parsing** (tree-sitter/custom AST) — reimplements macro and protocol expansion the compiler gives away free; the same anti-pattern ADR 0005 rejected for TS/JS. Rejected.
- **`mix xref`-based** — near-free machine-readable module graph, but module-level only: structurally cannot claim an unused function. Rejected as primary; kept as a cross-check.
- **Compiler-tracer-based** — function-level reference events from the real compiler (macros/protocols already expanded); requires running `mix compile` in the target project (a build, not a read) — a real departure from the TS frontend's no-execution posture that must be stated honestly.

## Decision
The Elixir frontend obtains its reference graph from a **custom compiler tracer** injected via a generated tracer module and `mix compile --force`, supplemented by `mix xref graph --format json` as a module-level consistency cross-check. Events map to the existing IR (nodes: modules/functions as symbols, files, apps as packages; edges with spans from tracer metadata). Entrypoint model: OTP application callbacks + supervision-tree children, Phoenix endpoint/router, mix tasks, releases config — production roots; `test/` + ExUnit = test partition; `config/*.exs` = config roots. Umbrella apps map to the existing workspace-unit model.

**Honest posture difference, stated in the assumption set**: analyzing Elixir runs the project's own compiler (and therefore its compile-time code) in a child `mix` process — unlike the TS frontend, which never executes user code. This is disclosed, not hidden; a user who cannot compile (or trusts nothing) gets a refusal, never a silently-wrong answer. No network, no telemetry, unchanged.

**Hazard classes (Elixir registry entries from day one)**: behaviour/OTP callback dispatch (callbacks are reflectively invoked — implementations of a used behaviour are alive); dynamic dispatch (`apply/3`, `Module.concat`, config/`runtime.exs`-resolved modules — verified invisible to tracing; scope-capped, never confidently dead); Phoenix/protocol runtime dispatch (LiveView callbacks, `defimpl` blocks; HEEx template visibility to tracing is UNVERIFIED — flagged for empirical testing in the skeleton phase, treated as a project-scope hazard until proven).

Evidence that would reverse this: the tracer approach failing to produce a usable function-level graph on a real Phoenix codebase (the reference-codebase assessment is the test), or the compile-requirement proving unacceptable to users — fallback would be xref-based module-level claims only (a smaller, honest product).

## Consequences
- v0.1.0 ships the Elixir frontend as a **skeleton behind the frontend interface**: tracer + IR emission + entrypoint model + hazard registry entries + a small labelled corpus (`fixtures/elixir/`), marked experimental; full parity (config, presets-equivalent, dependency claims via mix.lock) is post-v1 roadmap.
- The frontend interface gets its second real implementation, proving ADR 0003's core constraint before the first release — the point of the founder directive.
- Requires Elixir/OTP present to analyze Elixir projects (refusal with a clear message otherwise).
- The corpus gains a `fixtures/elixir/` tree with the same labels.yaml contract (per-language layout existed from M1 by design).

## Implementation amendment — isolated build state (2026-07-21)

The compiler tracer runs the analyzed application under a temporary
`MIX_BUILD_PATH`. It reuses previously compiled dependency application paths but
does not place the analyzed application's compiler manifests, BEAM files, `.app`
resource, or consolidated protocols in the project's `_build`. This preserves
the compiler-backed precision decision while preventing analysis from making a
subsequent `mix compile --warnings-as-errors` regenerate consolidation output.
A project whose dependency artifacts are not available from a prior clean
compile is refused explicitly; the analyzer neither fetches nor silently builds
dependencies into the consumer's tree.

The isolated application layout also contains a link to the project's tracked
`priv` directory before `compile.elixir` begins. This preserves conventional
compile-time reads through `Application.app_dir/2` while keeping the resource
and the consumer's `_build` unchanged; the link exists only for the lifetime of
the analyzer's temporary directory.

## Implementation amendment — test-partition completeness (2026-07-21)

The production compiler trace and the separately compiled ExUnit partition have
independent completeness. A test module may execute module-body code that reads
application runtime state; normal `mix test` starts the application first, while
the analyzer deliberately uses `--no-start`. If that separate test compile
fails, production facts remain usable but the boundary is `partial` and its test
partition is `incomplete` in schema 1.4.0.

The analyzer does not start the application speculatively. Instead, a
non-claimable safety root keeps every compiler-known production file, module,
and public function alive, including exact cross-language bridge descendants.
Potentially test-reachable subjects therefore produce neither claims nor
supported deletion plans. One deterministic diagnostic is emitted on stderr;
canonical JSON stdout contains only structured completeness metadata.

## Implementation amendment — separate Mix test environment (2026-07-21)

Production and test facts are traced by separate child invocations. Production
keeps the caller's original Mix environment and strict refusal contract. The
test partition runs under explicit `MIX_ENV=test`, `--no-start`, and a distinct
temporary build whose dependency links come only from the consumer's matching
test-environment build. Neither child writes to the consumer build, and the
test child never starts the analyzed application, runs `mix test`, or requires
`test/test_helper.exs`.

Dependency artifacts are derived from each cached `Mix.Dep` rather than an
assumed `_build/<env>/lib/<app>` layout. The runner preserves Mix's
`MIX_BUILD_ROOT`, exact `MIX_BUILD_PATH`, `MIX_TARGET`, and
`build_per_environment` semantics, follows each dependency's actual build path,
and validates its default or custom `.app` resource unless `app: false`.
Absent optional dependencies and `compile: false, app: false` data dependencies
do not make an otherwise complete partition partial.

The test child compiles the effective test environment, but retains facts only
from the non-production `elixirc_paths` delta (conventionally `test/support`)
and deterministically sorted ExUnit source files. Compatible re-emission from
production-inventory files is ignored, so production facts remain solely those
observed in the original environment. Novel/conflicting module identity or
file ownership is incomplete rather than merged speculatively.

Each child writes a phase-delimited structured trace. Test facts are merged only
after an exit-zero child produces exactly one complete terminal record; partial
or malformed output is discarded. Missing same-environment dependency
artifacts, layout failures, timeouts, support/test compilation failures,
runtime exits, and module/file ownership collisions all produce the existing
explicit partial boundary, sanitized diagnostic, and production-surface safety
roots. They never abort already-complete production analysis or masquerade as a
complete test partition.
