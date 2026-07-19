# Progress — unused

Updated: 2026-07-19. **v1 BUILD COMPLETE — M1–M9 all done and tagged (m1..m9).** Gates M5–M9 self-approved under the founder's 2026-07-19 delegation ("review on my behalf, do not stop for approval, complete the implementation").

## What shipped (v1, private-beta ready)
`@ninthwave-io/unused` — a liveness oracle for TS/JS. Tiers 1–2 fully implemented:
- **Analysis**: oxc-based frontend (per-unit resolution incl. member tsconfigs), language-agnostic IR (intra-file symbol edges, provenance spans), partitioned reachability (production/config/test), 18-class hazard registry with scoped confidence caps, dependency claims (conservative-first), test-only verdicts + zombie tests + estimated CI-seconds, workspaces (npm/pnpm/yarn-classic/bun; PnP refused loudly), JSONC config (project=claimability, ignore=invisibility), presets (vite, next incl. metadata routes), generated assumption set (drift-tested).
- **Surfaces**: TTY report per cli-ux spec; `--json` (schema 1.1.0) + SARIF 2.1.0 (fingerprints); `unused check`/`baseline` CI gate (per-workspace JSONL, version+configHash stamps, honest gate-not-evaluated state); `unused why`; MCP server (find_unused / why_alive / usage_evidence, SDK 1.29.0); `unused report --md|--html` + `unused badge`; full flag surface, exit contract 0/1/2/3.
- **Quality**: corpus 36 cases / 103 subjects — precision 1.0, recall 0.939, 0 FP/CV/unlabelled; gates A–D with planted proofs, origin/main baseline in CI. 824 tests. Smoke: hono/axios/fastify/zod pinned, 0 high-confidence FPs after three fix rounds (M3: 144 test-file highs; M4: member tsconfig paths; M5: 15 wrong zombies incl. systemic intra-file edge gap). Perf ≤1.23× knip at ~400-file scale; checkpoint verdict: stay TS.
- **Packaging**: npm pack verified cold from an installed tarball (caught the symlinked-bin silent-noop bug); OIDC provenance workflow tag-gated and ready; README + assumption-set link.

## FOUNDER ACTIONS (blocking launch, in order)
1. Register the npm org `ninthwave-io` (first-come) + configure trusted publishing for `@ninthwave-io/unused`.
2. Create the GitHub repo (github.com/ninthwave-io/unused), push main + tags, enable branch protection with the CI check required (ADR 0009 prerequisite — Gate C's enforcement depends on it).
3. Tag `v0.1.0` to fire the provenance publish workflow (verify the npm page: provenance badge, README).
4. Private beta: 5–10 users; feedback channel. Optional: npm dispute letter for unscoped `unused`.

## Post-v1 backlog (ranked, from smoke/review debt)
Tier-3 endpoint extraction (Next API routes first — schema contract already shipped); tier-4 locally-driven log sources (ADR 0002 free tier); Python then Elixir frontends (ADR 0003; Elixir via mix xref/compiler tracers per research); devDependency claims; YAML/JSONC config-string scan; per-test zombie walk cost at scale; warm-path cache (architecture §5); staleness/error-path MCP test coverage; subsumption-aware label matching; per-symbol checker-only scope.

## Resuming a session
Read CLAUDE.md, this file, docs/adr/ (0001–0010 all Accepted), docs/phasing.md, docs/smoke/M3–M5.md. The corpus + gates are the quality contract; never commit red; labels are truth.
