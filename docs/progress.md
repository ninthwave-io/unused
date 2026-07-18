# Progress — unused

Updated: 2026-07-18

## Current phase
Phase 4 (implementation). **Milestone M1 — COMPLETE, awaiting founder gate approval.** Do not start M2 until approved. Tag `m1` on approval.

## Done
- Phases 0–3 complete and gate-approved (see git history + ADRs 0001–0010, all Accepted). Founder directives recorded: study-not-copy incumbents + differential Knip runs; benchmarking from M2 with early-pivot checkpoint at the M4 gate.
- **M1 (commits 003598c..a9d0f8b)**: T1.1 scaffold (pnpm workspace, strict TS pinned <7 — TS7 makes dependency-cruiser fail open, Biome, boundary rules proven to bite, CI with least-privilege perms); T1.2 claim schema (full PRD §4/ADR 0006 contract, discriminated-union kind→verdict binding, JSON Schema validates the PRD worked example byte-identical); T1.4 corpus v1 (13 cases, 29 labelled subjects, alive labels in 12/13); T1.5 extraction spike (**PROCEED** — all 4 criteria pass; decorator-offset trap found for suppression comments; ~9k files/sec parse); T1.3 harness (gates A/B/C as pure predicates, permanent evil-analyzer rejection proofs, deterministic scoreboard). 96 tests green; both Opus reviews were approve-with-changes, all findings applied.

## Current scoreboard (stub analyzer — baseline)
precision 1.0 (vacuous), recall 0, 13 cases / 29 subjects, 14 dead-labelled misses awaiting the real analyzer.

## Known debt (conscious, recorded)
- Gate C baseline is in-tree → hardening scheduled as T2.7 (CI compares origin/main scoreboard); until then any PR touching fixtures/scoreboard.json is a review red flag.
- Clean-subject under-confidence not surfaced until M3 (fixtures/README note).
- estDeletableLoc is a provisional span-sum (real dedup at T3.4).
- bin path `dist/cli.js` has no build step yet (bundler chosen at M2 packaging touchpoint or M9).

## Next (after M1 gate approval)
M2 — graph pipeline (docs/phasing.md): T2.1 discovery/parse (incl. suppression-comment capture with the spike's decorator-offset fix), T2.2 resolution, T2.3 IR assembly, T2.4 basic reachability + claims, T2.5 `--json` CLI, T2.6 bench harness, T2.7 Gate C hardening. Spike's flagged core risk for T2.1–T2.4: hand-rolled name resolution/shadowing (no symbol table over NAPI) — dedicated shadowing fixtures + Opus review on every extractor diff.

## Standing founder actions
Register npm org `ninthwave-io` (time-sensitive, hard blocker at M9); optional npm dispute for unscoped `unused`; 5–10 beta-user names before M9.
