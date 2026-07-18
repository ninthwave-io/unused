# Deletion report and badge — unused

Status: APPROVED at the Phase 2 gate (2026-07-18). Build contract.

## 1. Deletion report (the growth artifact)
- `unused report [--md|--html]` renders a local, self-contained, share-friendly artifact from the last analysis (no re-run needed).
- Contents: headline totals (deletable LOC, unused exports/files/deps, dead endpoints when tier 3 lands, zombie tests + CI seconds per run and per month), top-10 deletions by LOC, confidence breakdown, the assumption-set footnote, tool version + date.
- Designed to be screenshotted or pasted into a PR/Slack: one screen, big numbers, no scrolling required for the headline.
- **Privacy**: generated locally; contains file paths and symbol names — the report itself warns it reveals repo internals before anyone shares it. Nothing is uploaded, ever (ADR 0002 trust wording).

## 2. README badge
- v1 (free, static): `unused badge` writes a shields.io endpoint JSON (or plain SVG) into the repo, e.g. `unused: clean` / `unused: 12 claims`, refreshed by CI on main. No server involved.
- Hosted dynamic badge (auto-updating, no CI step) = paid, later — consistent with ADR 0002.
- Badge states: `clean` (green, zero high-confidence claims), `N claims` (counts **high-confidence claims only** — the badge never counts medium/low candidates; neutral grey-blue, informational, not shaming), `unknown` (never analysed). A 0-high/5-medium repo shows `clean`.
- The badge links to unused.dev.

## 3. CI seconds methodology (the number people quote)
- Zombie-test CI cost = measured or estimated per-test runtime × runs per month; v1 uses test-file count × configurable average when no timing data exists, and labels the number "estimated" — the report never presents an estimate as a measurement (falsifiability rule).

## Open questions
- (accumulate during Phase 2)
