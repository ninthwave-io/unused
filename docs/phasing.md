# Implementation phasing — unused

Status: DRAFT — Phase 3, awaiting founder gate. Red-teamed by architect (initial verdict: rework on sizing; this version applies the restructure).

Nine milestones, strictly ordered, each sized for ~10–15 focused hours of **orchestrated founder time** (subagents implement; the hours are specs, reviews, integration, and triage). **Deviations from the founding brief's 6-milestone shape, justified:** (1) the brief's M1 bundled scaffold + fixtures + the whole graph core (~25h+) — split so the FP-enforcement machinery exists before analyzer code can merge; (2) the graph core itself splits into pipeline (M2) and hazard/confidence (M3) milestones — the red-team sized the combined version at ~30h and it concentrates all existential risk; (3) reporters (M6) and the CI gate (M7) split for the same reason; (4) an **extraction spike** runs inside M1 — ADR 0005's named reversal-evidence test, proven before the stack commitment compounds. Tier-3 extraction and the curl installer are out per the Phase 1 gate.

**Standing rules (every milestone):** each task gets a written spec (context, files in scope, acceptance checklist) before delegation; delegation policy per CLAUDE.md (core-implementer = Opus on graph/resolver/claims; Sonnet elsewhere); every diff reviewed, Opus reviewer on core paths; never commit red; **from M3 onward every milestone includes a smoke-triage task** (2–3 pinned repos, exhaustive triage of high-confidence findings, ≥30 sampled medium/low, recorded in `docs/smoke/MN.md`) and its acceptance line is "zero un-triaged high-confidence findings; zero confirmed high-confidence FPs surviving the gate". Milestone gates: demo + corpus precision/recall + debt taken + proposed next-milestone adjustments → founder approval. **Incumbent study (founder directive)**: fixture scenarios are mined from Knip's/Fallow's test suites and FP issue trackers (permissively licensed) — always re-derived, never copied; smoke-triage tasks include a differential Knip run on the same repo with disagreements triaged. **Benchmarking (founder directive)**: a bench harness lands in M2; every gate from M3 reports cold-run timing vs the PRD §8 budget and vs Knip on the same repo.

**Estimated total:** ~110–115 focused hours ≈ 8–11 elapsed weeks at 10–15 h/week. (Honest math: the brief's 6×12h ≈ 72h did not survive contact with the red-team.)

---

## M1 — Foundations, quality contract, extraction spike (~13–15 h)
**Entry:** Phase 3 gate approved. (npm org registration = parallel founder action, not a blocker.)
- T1.1 [implementer] Repo scaffold: pnpm workspace (`packages/unused`, `fixtures/`), strict tsconfig, Biome, dependency-cruiser boundary rules (core ↛ frontends; reporters ↛ analysis internals), Vitest, GitHub Actions (typecheck, lint, boundaries, tests). *Accept:* CI green; boundary rule proven by a failing counter-example.
- T1.2 [implementer; Opus review] Claim schema module: types per PRD §4, exported JSON Schema, claim id per ADR 0006, summary computation. *Accept:* id stability/change unit tests; JSON Schema validates the PRD worked example verbatim.
- T1.3 [test-engineer] Fixture harness: loader (each fixture a mini-repo), `labels.yaml`, claim↔label join, precision/recall scoreboard, CI gates (zero high-confidence FP; corpus precision non-decreasing vs main). *Accept:* runs against a stub all-alive analyzer; gates demonstrably fail on a planted FP.
- T1.4 [test-engineer] Corpus v1 (≥12 labelled fixtures): dead/alive exports and files, re-export chains, side-effect imports, string/computed imports, `require(expr)`, ambient `.d.ts`, inverse type-position fixtures (must NOT flag). *Accept:* every label has `because:`; labels reviewed by orchestrator.
- T1.5 [core-implementer] **Extraction spike** (~3–4h): prove oxc-parser output supports (a) value- vs type-position reference distinction, (b) `export * from` and namespace re-export traversal, (c) leading-comment capture for suppressions — on 4 hard fixtures. *Accept:* written spike report; pass ⇒ M2 entry; fail ⇒ STOP, ADR 0005 gets a superseding ADR before any further work.
**Milestone acceptance:** CI incl. both precision gates green; spike verdict recorded.
**Demo:** scoreboard + a gate visibly failing on a planted FP + the spike report.

## M2 — Graph pipeline: parse → resolve → IR → first claims (~13–14 h; Opus-heavy)
**Entry:** M1 gates live; spike passed.
- T2.1 [core-implementer] Discovery + parse: file walk, oxc-parser, per-file module record (imports/exports/re-exports/side-effect imports, type-only flags, spans, **leading-comment/suppression capture** — red-team: built here, not retrofitted at reporters). *Accept:* module records match hand-written expectations on corpus fixtures.
- T2.2 [core-implementer] Resolution: oxc-resolver + get-tsconfig (paths, extends, exports maps); unresolved import ⇒ hazard annotation, never a crash. *Accept:* alias/exports-map fixtures resolve; downgrade path tested.
- T2.3 [core-implementer] IR assembly per architecture §3: nodes/edges with provenance spans; zero-config default entrypoints (package.json `main`/`module`/`exports`/`bin`) — **this freezes the no-config entry contract** (M4 layers on top additively). *Accept:* IR snapshot tests; every edge carries a span.
- T2.4 [core-implementer] Basic reachability + claim emission on hazard-free fixtures: `unused` verdicts for exports/files, evidence from provenance, why-path storage. *Accept:* hazard-free corpus subset green at the FP gate.
- T2.5 [implementer] Minimal CLI: `unused --json`, exit codes 0/2/3. *Accept:* schema-valid JSON on fixture repos.
- T2.6 [implementer] Bench harness (founder directive): reproducible timed cold runs (ours + Knip on the same target), JSON results committed under `docs/bench/`. *Accept:* one command reproduces; first fixture-scale numbers recorded.
**Milestone acceptance:** pipeline end-to-end on hazard-free fixtures; corpus gates green (hazard fixtures excluded via explicit skip-list with a debt note).
**Demo:** `unused --json` on a fixture monolith.

## M3 — Hazard registry and the false-positive bar (~14–15 h; the FP spine)
**Entry:** M2 accepted.
- T3.1 [core-implementer] Hazard registry: structure + downgrade semantics + the architecture §4 class set (string/computed imports, `require(expr)`, computed CJS exports, config-referenced files, checker-only type relationships, `emitDecoratorMetadata`, conditional `exports`/`browser` remapping, JSX runtime dep liveness, ambient `.d.ts`, project `references`). Split across 2–3 subagent sessions by class group. *Accept:* ≥1 labelled fixture per class proving the downgrade; unmodelled-hazard invariant test (planted unknown pattern ⇒ alive).
- T3.2 [core-implementer] Two-sided type-reference rule: AST-visible type-position references resolve as real references. *Accept:* inverse fixtures stay unflagged; recall on type-heavy fixtures reported.
- T3.3 [core-implementer] Confidence assignment + assumption-set rendering from code (global assumptions constant + per-hazard clauses). *Accept:* rendered doc diffs against architecture §4 wording.
- T3.4 [implementer] `estDeletableLoc` computation (span→LOC with nested/overlapping-subject dedup) into summary. *Accept:* unit tests incl. overlap cases.
- T3.5 [orchestrator + test-engineer] Pin 2–3 smoke repos; first full triage; `docs/smoke/M3.md`; record cold-run timing vs PRD §8 targets **and vs Knip on the same repos (bench harness)**; differential run vs Knip with disagreements triaged.
**Milestone acceptance:** full corpus (no skip-list) green; smoke: zero confirmed high-confidence FPs; timing baseline recorded.
**Demo:** claims on a real smoke repo + triage notes + the generated assumption set.

## M4 — Dependencies, workspaces, config, presets (~13 h)
**Entry:** M3 accepted.
- T4.1 [core-implementer] Dependency claims: declared vs resolved; `@types` pairing; bin-only packages ⇒ alive-via-hazard. *Accept:* dependency fixtures incl. the nasty cases.
- T4.2 [core-implementer] Workspaces: npm/pnpm/yarn-classic/bun detection, per-workspace roots/claims, cross-workspace references, `workspace:` protocol; Yarn PnP ⇒ exit 2 refusal. *Accept:* monorepo fixtures with cross-package imports.
- T4.3 [implementer] Config: `unused.config.jsonc` + shipped-JSON-Schema validation, precedence flags > config > defaults; invalid config ⇒ exit 3 naming the fix. *Accept:* config fixtures; error snapshots; **no-config regression: zero-config output identical pre/post this milestone**.
- T4.4 [implementer] Preset interface + `vite` + `next` presets (both are entrypoint conventions — they belong together here). *Accept:* zero FPs on the labelled vite fixture; Next fixture proves `pages/`/`app/`/API-route files are **kept alive** (reserved-as-endpoint), never flagged.
- T4.5 [test-engineer] Adversarial growth: config-referenced files, workspace alias edges. *Accept:* ≥4 new labelled fixtures; corpus precision non-decreasing.
- T4.6 [orchestrator + test-engineer] Smoke triage → `docs/smoke/M4.md`.
**Gate checkpoint (founder directive):** performance early-pivot review — cold runs >3× Knip on the same repo, or clearly off the PRD §8 trajectory, opens the ADR 0004 reversal (native/Rust hot paths) at this gate, not post-v1.
**Demo:** monorepo smoke run with per-workspace claims.

## M5 — Tier 2: test-only liveness (~11–12 h; the first differentiator)
**Entry:** M4 accepted.
- T5.1 [core-implementer] Root partitioning (production/test/config), per-partition reachability, config-reachable never flagged. *Accept:* partition fixtures incl. config-only code.
- T5.2 [core-implementer] `test-only` verdicts + zombie-test detection. *Accept:* zombie fixtures; shared-util fixtures (both partitions) NOT flagged.
- T5.3 [implementer] CI-seconds estimate, labelled "estimated" (report-and-badge §3). *Accept:* configurable average; never presented as measured.
- T5.4 [test-engineer] Test-only adversarials (helper chains, fixtures-of-fixtures). *Accept:* ≥4 new labelled fixtures; precision non-decreasing.
- T5.5 [orchestrator + test-engineer] Smoke triage → `docs/smoke/M5.md`.
**Demo:** test-only claims + zombie tests with CI-seconds on a smoke repo.

## M6 — Reporters and the CLI surface (~12–13 h; the product's face)
**Entry:** M5 accepted.
- T6.1 [implementer] TTY report to the cli-ux spec (layout, badges, top-10 truncation, degradation modes) + suppression rendering (counts, `--show-suppressed`). *Accept:* snapshots for TTY/narrow/NO_COLOR/non-TTY; spec-fidelity review by orchestrator.
- T6.2 [implementer] Flag surface: `--filter`, `--min-confidence`, `--cwd`, `--all`, `--no-color` + exit-3 validation for bad values. *Accept:* flag matrix tests incl. invalid-value errors.
- T6.3 [implementer] SARIF reporter per PRD mapping incl. `partialFingerprints`. *Accept:* validates against the SARIF 2.1.0 schema in CI; one manual GitHub code-scanning upload (labelled one-time, not CI-repeatable).
- T6.4 [test-engineer] Reporter contract tests; JSON/SARIF snapshots pinned to schemaVersion. *Accept:* snapshot change requires schema-version bump (ADR 0006).
- T6.5 [orchestrator + test-engineer] Smoke triage → `docs/smoke/M6.md`.
**Demo:** the full TTY report on a smoke repo, wide and narrow.

## M7 — CI gate: baseline + check (~10 h)
**Entry:** M6 accepted.
- T7.1 [implementer] `unused baseline`: per-workspace id-sorted JSONL, version stamps (ADR 0006), bless-summary output. *Accept:* baseline fixtures; deterministic ordering.
- T7.2 [implementer] `unused check`: new-claim diff, default threshold `high`, remediation output, exit contract, analyzer-version-mismatch warn path, missing-baseline exit 3. *Accept:* gate scenario tests (new claim on branch; re-baseline flow; version mismatch).
- T7.3 [test-engineer] Gate adversarials: renamed symbol (resolved+new semantics), moved file, reformat-only diff. *Accept:* documented expected behaviour proven by tests.
- T7.4 [orchestrator + test-engineer] Smoke triage → `docs/smoke/M7.md`.
**Demo:** a deliberately failing `unused check` in a sample PR with actionable output.

## M8 — why + MCP (~10 h)
**Entry:** M7 accepted.
- T8.1 [core-implementer] Why-path query: shortest path(s) from stored provenance, entrypoint-kind labels, answers for ANY symbol. *Accept:* path fixtures incl. re-export chains and test-only paths.
- T8.2 [implementer] `unused why` CLI rendering (cli-ux §4).
- T8.3 [implementer] MCP server via official TS SDK (stdio): `find_unused`, `why_alive`, `usage_evidence` (static + test-only evidence; explicit not-configured slots). *Accept:* SDK-client integration test; schema parity with `--json`.
- T8.4 [test-engineer] Scripted agent-workflow regression (find → why → verify). 
- T8.5 [orchestrator + test-engineer] Smoke triage → `docs/smoke/M8.md`.
**Demo:** live MCP session from Claude Code against a smoke repo.

## M9 — Packaging + private beta (~12–14 h)
**Entry:** M8 accepted; **npm org `ninthwave-io` registered (hard blocker now)**.
- T9.1 [implementer] Packaging: bundling, `bin`/shebang/ESM correctness, engines check with clear error, npx cold-start budget, GitHub Actions trusted publishing + provenance. *Accept:* `npm pack` install works on a clean machine; dry-run publish clean. (Red-team: first-npx bugs always surface — budget includes a fix loop.)
- T9.2 [doc-writer] README (leads with `npx @ninthwave-io/unused`, evidence ladder, assumption-set link, badge) + `--help` text in the cli-ux voice.
- T9.3 [implementer] `unused report` (md/html, self-contained) + `unused badge` (endpoint JSON/SVG) per spec. *Accept:* report renders offline; badge JSON valid; badge counts high-confidence only.
- T9.4 [test-engineer] Final corpus sweep + first public recall report; final smoke → `docs/smoke/M9.md`.
- T9.5 [orchestrator] Private beta checklist: v0.1.0 tag, triage clean, scoreboard published in-repo, provenance verified, 5–10 named beta users (founder sources), feedback channel.
**Demo:** fresh-machine `npx` run + a shareable deletion report.

---

## After v1 (flagged, not planned)
Tier-3 endpoint extraction (Next API routes first — stretch, per Phase 1 gate); warm-path cache (recorded debt, architecture §5); tier-4 locally-driven log sources (ADR 0002 free tier); Python frontend, then Elixir frontend (ADR 0003); npm dispute follow-up for unscoped `unused`; **public launch prep is a separate phase with its own plan — not this document.**
