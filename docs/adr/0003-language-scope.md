# 0003 — Language scope: multi-language positioning, TS/JS-first implementation

Date: 2026-07-18
Status: Accepted

## Context
Phase 1 research (docs/research/competitive-landscape-2026-07.md) established that both incumbents are TS/JS-only: Knip analyses TS/JS exclusively, and Fallow — though written in Rust — targets TS/JS only. Per-language tools exist elsewhere (vulture for Python, cargo-machete for Rust) but are single-language and binary-verdict. Founder direction at the Phase 1 gate: position as multi-language; Python makes market sense; Elixir support would be heavily dogfooded by the founder.

## Options considered
- **TS/JS-only product** — matches incumbents; simplest; cedes the one positioning axis neither Knip nor Fallow occupies.
- **Multi-language at launch** — suicide for a solo founder; splits the FP-quality budget across ecosystems before any is trustworthy.
- **Multi-language positioning, sequenced implementation** — one oracle, one claim schema, many languages; v1 ships TS/JS only, with the core built so languages are frontends, not rewrites.

## Decision
Multi-language positioning with sequenced implementation:
1. **v1: TS/JS only** — the wedge remains Knip's false-positive pain; nothing about v1 milestones changes.
2. **Next: Python, then Elixir** (order to be confirmed in the roadmap — Python for market size, Elixir for founder dogfooding; both are named on the public roadmap from day one).
3. **Core constraint**: the reference-graph IR, claim engine, and reporters are language-agnostic; each language is a frontend that emits IR (entrypoints, symbols, references, hazard annotations). The Phase 2 parser ADR must not couple the core to the TypeScript compiler API.
4. Elixir note for Phase 2 research: the BEAM ecosystem has native liveness hooks (`mix xref`, compiler tracing) that may make an Elixir frontend unusually cheap and unusually accurate.

Evidence that would reverse this: TS/JS FP targets unmet by the end of the v1 milestones — in that case language expansion freezes until the wedge holds.

## Consequences
- BRD positioning gains a differentiation axis stated honestly: not "more languages today" but "one claim schema, graded confidence, every language on the roadmap".
- Claim schema needs a language-neutral audit in the Phase 2 schema ADR (e.g. an optional `subject.language` field; `export` as a kind name is TS-flavoured but acceptable as a generic "public symbol").
- Golden-fixture corpus layout must be per-language from day one (`fixtures/ts/…`), even while only TS exists.
