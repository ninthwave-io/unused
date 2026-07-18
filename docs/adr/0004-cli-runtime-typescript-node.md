# 0004 — CLI runtime: TypeScript on Node ≥22

Date: 2026-07-18
Status: Accepted (founder, Phase 2 gate, 2026-07-18)

## Context
The CLI needs a runtime. Distribution is npx-first (`npx @ninthwave-io/unused`); the founder is solo at 10–20 h/week; Fallow has claimed the raw-speed positioning with Rust; our differentiation is evidence quality, not benchmarks. Research: docs/research/parser-and-language-stack-2026-07.md.

## Options considered
- **TypeScript on Node ≥22** — npx-native; MCP TypeScript SDK is stable (v1.29.0, stdio recommended); parse-speed problem solved by native oxc bindings (ADR 0005); Knip proves the stack at 43M downloads/month; maximum founder velocity.
- **Rust** — fastest, single-binary; but npx distribution needs per-platform binary packaging, the founder ships slower in it, and it competes on the axis Fallow already owns.
- **Go** — fast, easy distribution; weakest TS/JS-ecosystem parsing story; same velocity concern.

## Decision
TypeScript on Node ≥22 (floor decided by founder at the Phase 1 gate). Speed strategy is native parser bindings + per-file caching (architecture §5), not runtime choice. Evidence that would reverse this: missing the PRD §8 performance targets by more than 2× after the post-graph-core caching work (architecture §5 sequencing) — the reversal path is porting hot paths to native (oxc ecosystem), not a full rewrite.

## Consequences
- npx works with zero packaging effort; MCP server ships in-process.
- We accept losing raw-speed benchmarks to Fallow; the counter-position is trust and evidence grading, stated openly.
- Node ≥22 floor excludes stragglers on EOL Node 20 — acceptable for a developer tool.
