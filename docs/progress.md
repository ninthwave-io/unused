# Progress — unused

Updated: 2026-07-18

## Current phase
Phase 4 (implementation). **Milestone M3 — COMPLETE, awaiting founder gate approval.** M1 approved+tagged; M2 approved (founder "continue") + tagged `m2`. Do not start M4 until approved; tag `m3` on approval.

## M3 result (commits 578bc31..b5c9c8f)
- **Hazard registry complete**: closed 16-class enum, compile-time-complete, per-class scope (project/subtree/file/symbol-set/none) + confidence caps; whole-project suppression replaced by scoped effects; every class has real, probe-verified detection (high without, capped with).
- **Gate D** added: unlabelled high-confidence claims fail CI.
- **Generated assumption set**: docs/generated/assumption-set.md rendered from code (globals + per-class rationale), byte-exact drift test. v1.1.x.
- **estDeletableLoc** real (interval-merge, subsumption, suppression-excluded).
- **Corpus: 19 cases / 49 subjects.** Scoreboard: precision 1.0, recall 0.870, 0 FP/CV/unlabelled. 367 tests.
- **Smoke (docs/smoke/M3.md)**: pinned hono v4.12.30 / axios v1.18.1 / fastify v5.10.0. First run found **144 confirmed high FPs (axios)** + the hono unbuilt-exports trap — T3.6 fixed all root causes (interim test-root recognition, unresolvable-entrypoint-target hazard + dist→src remap, staticSpecifierPrefix relative-only, tool-config roots). **Post-fix: 0 high claims on all three repos; residual mediums triaged safe.**
- **Bench (docs/bench/)**: 179–356ms medians on smoke repos, within 1.1× of Knip, <1% of the PRD 60s budget (repos are ~5% of target scale — budget unvalidated at 5k modules). Early-pivot checkpoint (M4 gate): no signal suggesting a Rust pivot.

## Known debt
- Corpus cases needed (labels exist only as __testfixtures__): emit-decorator-metadata, conditional-exports-divergence, project-references, test-root recognition, unresolvable-entrypoint; checker-only base-interface-via-merge gap (per-symbol scope post-v1); subsumption-aware label matching (metrics).
- Test-only verdict/partition + zombie tests = M5 (interim: test-reachable is simply alive). PnP assumption-text nit ("M4" vs v1). Monorepo/workspaces = M4 (smoke had to skip zod). project-references cap is blunt (whole-package medium).

## Next (after M3 gate approval)
M4 (docs/phasing.md): dependency claims, workspaces (npm/pnpm/yarn-classic/bun; PnP refusal), unused.config.jsonc, vite+next presets, no-config regression, corpus additions above, smoke incl. a monorepo repo. **M4 gate includes the founder-directive performance checkpoint.**

## Standing founder actions
npm org `ninthwave-io`; branch protection when remote; optional `unused` dispute; beta names before M9.
