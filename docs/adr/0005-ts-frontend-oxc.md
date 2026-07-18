# 0005 — TS/JS frontend: oxc-parser + oxc-resolver, own reference extraction, no type checker in the v1 path

Date: 2026-07-18
Status: Accepted (founder, Phase 2 gate, 2026-07-18)

## Context
The TS/JS frontend must parse, resolve modules (tsconfig paths, package.json `exports` maps, four workspace managers), and extract references — with false positives as the top quality metric. Verified July 2026 (docs/research/parser-and-language-stack-2026-07.md): Knip v6 (March 2026) dropped the TypeScript compiler API for `oxc-parser` + `oxc-resolver` + `get-tsconfig` with custom graph logic; Fallow consumes `oxc_semantic`/`oxc_resolver` as Rust crates, self-described as "syntactic analysis, no type resolution"; TS 7 (tsgo) went GA 2026-07-08 **without a stable programmatic API** (embedders told to wait for ~7.1); GitHub's stack-graphs is archived — tree-sitter has no production-quality resolution story.

## Options considered
- **TypeScript compiler API (TS 6 legacy)** — richest semantics (symbols, types, module resolution), but now a legacy embedding target mid-transition to tsgo, with an unstable successor API and the incumbent having just migrated off it. Slowest option.
- **oxc-parser + oxc-resolver + get-tsconfig, own extraction** — fast native parse with import/export metadata; battle-tested resolution (enhanced-resolve port with `exports`/monorepo support); we write the symbol/reference extraction and graph ourselves (oxc exposes no scope/symbol table over NAPI). Same infrastructure as Knip v6 — parity where parity is table stakes, differentiation in the layer above (hazard registry, graded confidence, why-alive paths).
- **tree-sitter** — multi-language uniformity, but syntax-only: no module resolution, no binding; the archived stack-graphs project is the cautionary tale. Rejected for TS/JS; per ADR 0003 each language frontend picks its own best tool anyway (Elixir: `mix xref` + compiler tracers; Python: candidate `grimp` for the import graph).

## Decision
The TS/JS frontend uses **oxc-parser** (AST + import/export metadata, type-only imports included), **oxc-resolver** (module resolution), and **get-tsconfig** (paths/extends), with our own reference/symbol extraction and the language-agnostic IR from architecture §3. No type checker runs in the v1 analysis path. A type-aware *enhancement pass* (e.g. tsserver-assisted resolution of specific hazard classes) is a possible future addition behind the frontend interface — never a requirement for the core path. Evidence that would reverse this: a hazard-class analysis showing syntactic extraction cannot hold the high-confidence zero-FP bar even with the registry downgrades — measured on the fixture corpus, not assumed.

## Consequences
- Reference extraction becomes the correctness-critical core deliverable (Opus/core-implementer territory) — we own every binding rule we rely on.
- The type-reference rule is two-sided (red-team): references visible in AST type positions (annotations, `extends`/`implements`, `typeof`, `import type`) are **real references, resolved statically** — never blanket-downgraded, or recall collapses. Only checker-only relationships (declaration merging, `emitDecoratorMetadata`, inference-only usage) become **hazard-registry entries with fixtures from M1**: where syntax cannot prove absence, confidence caps at `medium` (alive-when-uncertain invariant). The full M1 hazard set lives in architecture §4.
- No dependency on the TS project's API roadmap during the tsgo transition.
- Speed parity with Knip's infrastructure is plausible; benchmarks against Fallow remain unwinnable and unclaimed.
