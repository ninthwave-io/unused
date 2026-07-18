# CLI UX — unused

Status: APPROVED at the Phase 2 gate (2026-07-18). The terminal report is the product's face; this is its UI spec and build contract.

## 1. Principles
- **Evidence-first**: every printed claim answers "why should I believe you" on the same line. No bare verdicts.
- **Calm**: dead code is not an emergency. No red walls, no shame. Warm neutral palette; red reserved for tool errors only.
- **Ranked by actionability**: high confidence first, then by estimated deletable LOC. The first screen of output should be the best deletions in the repo.
- **Zero-config first run is the pitch**: it must be fast, honest, and self-explaining — it gets one chance (BRD §2).
- **Machine surfaces are contracts**: TTY layout may evolve; `--json`/SARIF/exit codes do not.

## 2. Default report (`unused`) — layout spec
```
unused v0.1.0 — acme-web (1,284 files, 3 workspaces) — 4.2s

  12 unused exports · 3 unused files · 2 unused dependencies
  ~1,840 deletable LOC · 7 test-only symbols · 2 suppressed

UNUSED EXPORTS                                        confidence
  ● formatCurrency   src/utils/currency.ts:12   no refs from any entrypoint
  ● parseLegacyId    src/utils/ids.ts:44        no refs from any entrypoint
  ◐ getFlags         src/flags.ts:9             unused, but dynamic import nearby

TEST-ONLY (production-dead, kept alive by tests)
  ● OrderMapper      src/orders/mapper.ts:30    only ref: orders.spec.ts — ~14 CI s/run

  ○ 3 low-confidence candidates hidden — `unused --min-confidence low` to show
  2 suppressed — `unused --show-suppressed`

next: `unused why formatCurrency` · `unused --json` · docs: unused.dev
```
- Confidence badges: `●` high, `◐` medium, `○` low (color + shape, never color alone).
- Sections ordered: exports, files, dependencies, test-only, endpoints (when present).
- Low-confidence claims summarised, not listed, by default.
- **Scale rule (red-team)**: each section truncates at the top 10 claims (ranked by deletable LOC) with an explicit affordance — `… 37 more exports — unused --filter export --all, or --json`. The primary persona has a 500-claim repo; the first screen must be the best deletions, never a wall.
- Footer always teaches one next step.

## 3. `unused check` output
- Prints only NEW claims vs baseline (each with the same one-line why), then a verdict line:
  `✗ 2 new high-confidence claims since baseline (2026-07-01, 41 claims) — exit 1`
  or `✓ no new dead weight since baseline — exit 0`.
- Baseline metadata (date, analyzer version, claim count) always shown; analyzer-version mismatch prints the re-baseline warning (PRD §4).
- Default gate threshold is `high` — the gate stakes trust only on claims we would stake trust on; `gate.threshold` overrides.
- Failure output always teaches remediation: a legitimate new claim → delete the code or suppress with `/* unused:ignore <reason> */`; intentional debt → re-baseline on main. The gate never strands the user without a next step.

## 4. `unused why <symbol|file>` output
- Alive: render the shortest path(s), one hop per line, entrypoint kind labelled:
  `src/index.ts (production entrypoint) → src/app.ts → src/orders/mapper.ts:30 OrderMapper`
- Alive-via-test-only: say so explicitly, suggest the tier-2 interpretation.
- Dead: state the verdict, confidence, evidence list, and the hazard classes checked.

## 5. Degradation
- Non-TTY stdout or `NO_COLOR` or `--no-color`: plain ASCII, same information, stable line grammar (grep-able: one claim per line).
- Narrow terminals (<80 cols): drop the why column to an indented second line; never wrap mid-token.
- CI logs: no spinners, no cursor control; progress as plain lines.

## 6. Errors and empty states
- Clean repo: celebrate briefly, suggest the badge and `unused check` adoption. Never print an empty table.
- Config/usage error (exit 3): one-line error + the exact fix (`unused check` without baseline → "run: unused baseline").
- Analysis error (exit 2): what failed, first affected path, and where to file it.
- Partial parse failures: prominent warning block with file count and consequence ("N files skipped — treated as potentially referencing anything; confidence downgraded accordingly").

## Open questions
- (accumulate during Phase 2)
