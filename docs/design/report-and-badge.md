# Deletion report and badge — unused

Status: APPROVED at the Phase 2 gate (2026-07-18). Build contract.

## 1. Deletion report (the growth artifact)
- `unused report [--md|--html]` renders a local, self-contained, share-friendly artifact from the last analysis (no re-run needed).
- Contents: headline totals (deletable LOC, unused exports/files/deps, dead endpoints when tier 3 lands, zombie tests + CI seconds per run and per month), top-10 deletions by LOC, compact deletion-consequence summaries for the highest-value findings, confidence breakdown, the assumption-set footnote, tool version + date.
- Consequences are explicitly labelled counterfactual plans. They do not change claim totals, gates, baseline identity, or badge state (ADR 0012).
- Designed to be screenshotted or pasted into a PR/Slack: one screen, big numbers, no scrolling required for the headline.
- **Privacy**: generated locally; contains file paths and symbol names — the report itself warns it reveals repo internals before anyone shares it. Nothing is uploaded, ever (ADR 0002 trust wording).

## 2. README badge
- v1 (free, static): `unused badge` writes a shields.io endpoint JSON (or plain SVG) into the repo, e.g. `unused: clean` / `unused: 12 claims`, refreshed by CI on main. Suppressed policy exceptions are excluded from this actionable total. No server involved.
- Hosted dynamic badge (auto-updating, no CI step) = paid, later — consistent with ADR 0002.
- Badge states: `clean` (green, zero unsuppressed high-confidence claims), `N claims` (counts **unsuppressed high-confidence claims only** — the badge never counts policy-suppressed or medium/low candidates; neutral grey-blue, informational, not shaming), `unknown` (never analysed). A repo with only suppressed highs or medium candidates shows `clean`; the full machine report still preserves those claims.
- The badge links to unused.dev.

## 3. CI seconds methodology (the number people quote)
- Zombie-test CI cost = measured or estimated per-test runtime × runs per month; v1 uses test-file count × configurable average when no timing data exists, and labels the number "estimated" — the report never presents an estimate as a measurement (falsifiability rule).

## Open questions
- (accumulate during Phase 2)
