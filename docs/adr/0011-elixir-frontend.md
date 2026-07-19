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
