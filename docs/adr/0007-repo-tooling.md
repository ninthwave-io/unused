# 0007 — Repo layout and tooling

Date: 2026-07-18
Status: Accepted (founder, Phase 2 gate, 2026-07-18)

## Context
Solo founder, 10–20 h/week: every tool is a maintenance liability. The architecture needs one enforced boundary (core must never import language frontends — ADR 0003) but does not need npm package granularity.

## Options considered
- Multi-package pnpm monorepo (core/frontend/cli/mcp as separate packages) — clean but heavy: versioning, inter-package churn, publish complexity, all toil.
- **Single published package with lint-enforced internal boundaries** — one `package.json`, one publish, boundaries checked in CI; split later only if an actual consumer needs a sub-package.

## Decision
- **pnpm** as package manager, single published package `@ninthwave-io/unused`; a pnpm workspace exists from day one (`packages/unused` + private `fixtures/`) so a future split is a move, not a migration.
- **TypeScript strict** (tsc for typecheck, no emit — build via tsdown/esbuild-class bundler chosen at M1).
- **Biome** for lint + format (one fast tool); **dependency-cruiser** in CI for the module-boundary rules (core ↛ frontends, reporters ↛ analysis internals) — fitting, given what the product is.
- **Vitest** for tests (ADR 0009).
- GitHub Actions CI: typecheck, lint, boundaries, unit tests, golden-fixture precision gate — the commit-blocking set from CLAUDE.md.

## Consequences
- One version number, one changelog, one publish pipeline.
- Boundary discipline rests on dependency-cruiser config rather than package.json walls — reviewed like code, cheap to strengthen later.
- If the hosted platform later wants `core` as a library, the workspace split is prepared but unspent.
