# Progress — unused

Updated: 2026-07-18

## Current phase
Phase 3 — COMPLETE, awaiting founder gate approval of docs/phasing.md. Do not start Phase 4 (implementation, milestone M1) until the founder explicitly approves.

## Done
- Phase 0: workspace, CLAUDE.md, agent team, docs skeleton.
- Phase 1: BRD + PRD, APPROVED at gate 2026-07-18. Decisions: MIT (ADR 0001), credential-boundary free/paid (ADR 0002), multi-language positioning TS/JS-first (ADR 0003), `@ninthwave-io/unused`, Node ≥22, tier-3 extraction post-v1, no curl installer, `usage_evidence` ships.
- Phase 2: architecture + design specs + ADRs 0004–0010, APPROVED at gate 2026-07-18 (all ADRs Accepted; gate default `high` and high-only badge confirmed; copyright stays "Rob Lambell").
- Phase 3: docs/phasing.md drafted, red-teamed by architect (initial verdict: rework on sizing), restructured to 9 milestones (~110–115h ≈ 8–11 weeks at 10–15 h/wk): M1 foundations + quality contract + **extraction spike**; M2 graph pipeline; M3 hazard registry + FP bar; M4 deps/workspaces/config/presets; M5 test-only liveness; M6 reporters + CLI surface; M7 CI gate; M8 why + MCP; M9 packaging + private beta. Smoke-triage task budgeted in every milestone from M3; suppression capture moved into M2 frontend build; `estDeletableLoc` owned (M3); flag surface owned (M6); milestone-number references across docs made neutral ("post-v1").

## Key standing facts
- Competitive: Knip = incumbent (oxc stack since v6); Fallow = closest threat (TS/JS-only, paid instrumented runtime tier); open niche = zero-integration runtime signals; both incumbents TS/JS-only → multi-language axis ours.
- Stack: TS/Node ≥22, oxc-parser + oxc-resolver + own extraction (no type checker in v1 path), pnpm single package, Biome, dependency-cruiser, Vitest, JSONC config, MCP TS SDK.
- The M1 extraction spike is ADR 0005's reversal test: if oxc-parser cannot support value/type-position distinction, re-export traversal, and comment capture, STOP and supersede ADR 0005.

## Next (only after gate approval)
- Phase 4, milestone M1: write task specs for T1.1–T1.5, delegate per policy, review, commit, run the M1 gate.
- Standing founder actions (time-sensitive): register npm org `ninthwave-io`; optionally file the npm dispute for unscoped `unused`; source 5–10 beta-user names before M9.

## Open questions at the Phase 3 gate (founder decisions)
1. Approve the 9-milestone plan and its honest total (~110–115h ≈ 8–11 weeks) — vs the brief's original 6×~12h shape?
2. Comfortable with the M1 spike-stop rule (a failed spike halts everything for a superseding parser ADR)?
3. Any constraint on smoke-repo choice (they get analysed locally only, nothing leaves the machine — but they'll be named in docs/smoke/)?
