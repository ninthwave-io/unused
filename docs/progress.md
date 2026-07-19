# Progress — unused

Updated: 2026-07-19. **Founder directive (2026-07-19): complete v1 autonomously; gates self-approved under delegation ("review on my behalf, do not stop for approval").**

## Current phase
Phase 4. M1–M5 complete: m1–m4 tagged; **M5 gate self-approved (delegated) — tag m5 on commit.** Next: M6 reporters.

## State (through M5)
- Analyzer: discovery/parse (oxc), per-unit resolution (member tsconfigs), IR with intra-file symbol edges (M5 fix — was a systemic gap), partitioned reachability (production/config/test), 16+-class hazard registry with scoped caps, dependency claims (conservative-first), test-only verdicts + zombie tests + CI-seconds estimate (schema 1.1.0), workspaces (4 managers, PnP refused), config (JSONC, project=claimability vs ignore=invisibility), presets (vite, next incl. metadata routes), generated assumption set (v1.5+, drift-tested).
- Corpus: 36 cases / 103 subjects; precision 1.0, recall 0.939, 0 FP/CV/unlabelled; gates A–D + planted proofs. 585 tests.
- Smoke (docs/smoke/M3–M5.md): pinned hono/axios/fastify/zod; every round found real FP classes (M3: 144 test-file highs; M4: member-tsconfig paths; M5: 15/21 wrong zombies incl. systemic intra-file edge gap) — all fixed, re-verified: 0 high FPs everywhere; remaining zombies 3 TP + 8 shared scope-gaps.
- Perf: ≤1.23× knip, <1% PRD budget at ~400-file scale; checkpoint verdict: stay TS.
- CLI: unused [--json|--cwd|--config]; exit 0/2/3 contract; bench wired.

## Remaining (v1)
- M6 reporters: TTY per cli-ux spec + flags (--filter/--min-confidence/--all/--show-suppressed) + SARIF (fingerprints) + suppression rendering; contract tests.
- M7 gate: baseline JSONL + check + exit 1; configHash must start reflecting ignore/gate config (recorded debt).
- M8: unused why + MCP (find_unused/why_alive/usage_evidence; whyReachable provenance exists).
- M9: packaging (npm pack verified; publish dry-run only — founder must register npm org + publish), README + --help, report/badge artifacts, beta checklist.

## Known debt (rolled)
devDeps out of scope; YAML/JSONC config-string scan; per-test zombie walk cost at scale; external-only-test doc line; configHash under-hashing (M7); Elixir/Python post-v1; warm cache post-v1.

## Founder checklist (cannot be done by the orchestrator)
Register npm org `ninthwave-io`; npm publish (M9 prepared, dry-run verified); create remote + branch protection with required checks; optional unscoped-`unused` dispute; 5–10 beta users.
