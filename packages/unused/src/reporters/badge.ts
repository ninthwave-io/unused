/**
 * `unused badge` — the README badge artifact (T9.3, docs/phasing.md M9;
 * docs/design/report-and-badge.md §2). Writes a shields.io *endpoint* JSON
 * document — no server involved, refreshed by re-running `unused badge` in
 * CI on main. Renders from `core/claims` only (reporters boundary —
 * dependency-cruiser).
 *
 * ## Count scope: unsuppressed high-confidence claims
 * report-and-badge.md §2 fixes the confidence filter ("counts high-confidence
 * claims only — the badge never counts medium/low candidates") but is silent
 * on suppression. ADR 0012 resolves that ambiguity: suppressed claims remain
 * machine-visible and separately counted, but are excluded from gates and
 * default human-facing actionable totals. The badge mirrors that trust signal.
 */
import type { ClaimRun, Confidence } from "../core/claims/index.js";

export interface BadgeJson {
  readonly schemaVersion: 1;
  readonly label: "unused";
  readonly message: string;
  readonly color: "green" | "blue";
}

function plural(n: number): string {
  return n === 1 ? "" : "s";
}

/** Every unsuppressed claim at this confidence, regardless of verdict/kind. */
function countAtConfidence(run: ClaimRun, confidence: Confidence): number {
  let n = 0;
  for (const c of run.claims) {
    if (c.confidence === confidence && c.suppression === undefined) n += 1;
  }
  return n;
}

/**
 * Computes the badge state from a claim run. `clean` (green) at zero
 * high-confidence claims — including a repo with only medium/low candidates
 * (report-and-badge.md §2's explicit "a 0-high/5-medium repo shows clean").
 * Otherwise `N claims` (blue — "neutral grey-blue, informational, not
 * shaming").
 */
export function computeBadge(run: ClaimRun): BadgeJson {
  const highCount = countAtConfidence(run, "high");
  return {
    schemaVersion: 1,
    label: "unused",
    message: highCount === 0 ? "clean" : `${highCount} claim${plural(highCount)}`,
    color: highCount === 0 ? "green" : "blue",
  };
}

/** Serialises {@link computeBadge}'s result as the shields.io endpoint JSON file contents (`.unused/badge.json`), pretty-printed for a legible git diff. */
export function renderBadgeJson(run: ClaimRun): string {
  return `${JSON.stringify(computeBadge(run), null, 2)}\n`;
}

/** The one-line stdout confirmation `unused badge` prints after writing the artifact. */
export function renderBadgeConfirmation(badge: BadgeJson, path: string): string {
  return `unused badge: wrote ${path} (${badge.message}).\n`;
}
