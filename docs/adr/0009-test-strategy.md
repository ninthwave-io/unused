# 0009 — Test strategy: the golden-fixture corpus is the quality contract

Date: 2026-07-18
Status: Accepted (founder, Phase 2 gate, 2026-07-18)

## Context
False-positive rate is the top quality metric; CLAUDE.md makes a fixture FP regression merge-blocking with no exceptions. The corpus must be the enforcement mechanism, not documentation.

## Options considered
Unit tests only (no ground truth against real-shaped repos); snapshot-only testing (drifts, blesses regressions); labelled fixture corpus with a measuring harness (chosen).

## Decision
- **Corpus layout**: `fixtures/<language>/<case>/` — each case a minimal repo (own package.json/tsconfig) testing one mechanism, with `labels.yaml` beside it: every labelled symbol/file/dependency → `alive` or `dead`, expected confidence, and a `because:` line explaining the label. Labels are ground truth: never edited to make a test pass; a wrong-looking label is escalated to the orchestrator.
- **Harness** (runs in Vitest): analyses each fixture, joins claims to labels, computes per-case and corpus-wide precision/recall by confidence tier, and writes a scoreboard artifact.
- **CI gates** (merge-blocking): zero false positives at `high` confidence; corpus-wide precision never decreases vs the main-branch scoreboard; unit tests, typecheck, lint, boundaries all green. Recall is reported, not gated (PRD §8 asymmetry).
- **Adversarial minimum**: every feature lands with at least one dynamic-reference fixture drawn from the architecture §4 hazard set (string/computed imports, `require(expr)`, computed CJS exports, config-referenced files, framework magic, checker-only type relationships, `emitDecoratorMetadata`, conditional `exports`/`browser`-field remapping, JSX runtime dependency liveness, ambient/global `.d.ts` files, tsconfig project `references`) plus the IR edge cases (re-export chains, side-effect imports) and the inverse fixtures proving AST-visible type-position references are NOT flagged.
- **Reporter tests**: TTY/JSON/SARIF via snapshot tests pinned to the claim schema; JSON/SARIF snapshots are contract tests and changing them requires a schema-version bump (ADR 0006).
- **Real-repo smoke**: 2–3 pinned large OSS repos per milestone; every **high-confidence** finding hand-triaged exhaustively, medium/low sampled (≥30 per repo) — exhaustive-everything is unbounded solo toil (red-team bound); results recorded in `docs/smoke/` per milestone so triage is auditable.

## Consequences
- The corpus is a durable asset (BRD §6) and grows monotonically — cases are never deleted, only added or corrected via reviewed label changes.
- Precision-never-decreases requires keeping the main-branch scoreboard as a CI artifact — small plumbing cost in M1.
- Per-language corpus layout means Python/Elixir arrive with their own labelled ground truth from their first commit (ADR 0003).
- (Added 2026-07-18, T2.7 review) The precision-non-decreasing gate's enforcement point is the `pull_request` CI run. That is only sound if `main` forbids direct pushes and this CI check is a required status check — a direct push to main self-compares trivially and bypasses every PR gate. Branch protection must be configured accordingly when the repo goes remote (founder/orchestrator action, tracked in progress.md).
