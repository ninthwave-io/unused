/**
 * Claim-run summary computation (PRD §4: `summary.byKind`, `.byConfidence`,
 * `.estDeletableLoc` — "so a TTY report or a chat-posted digest can render
 * totals without walking the full `claims` array").
 */
import type { Claim, ClaimSummary, Confidence, SubjectKind } from "./types.js";

const SUBJECT_KINDS: readonly SubjectKind[] = ["export", "file", "dependency", "endpoint", "test"];
const CONFIDENCES: readonly Confidence[] = ["high", "medium", "low"];

function zeroByKind(): Record<SubjectKind, number> {
  const counts = {} as Record<SubjectKind, number>;
  for (const kind of SUBJECT_KINDS) {
    counts[kind] = 0;
  }
  return counts;
}

function zeroByConfidence(): Record<Confidence, number> {
  const counts = {} as Record<Confidence, number>;
  for (const confidence of CONFIDENCES) {
    counts[confidence] = 0;
  }
  return counts;
}

export function countByKind(claims: readonly Claim[]): Record<SubjectKind, number> {
  const counts = zeroByKind();
  for (const claim of claims) {
    counts[claim.subject.kind] += 1;
  }
  return counts;
}

export function countByConfidence(claims: readonly Claim[]): Record<Confidence, number> {
  const counts = zeroByConfidence();
  for (const claim of claims) {
    counts[claim.confidence] += 1;
  }
  return counts;
}

/**
 * PROVISIONAL `estDeletableLoc`: sum of `span[1] - span[0] + 1` (inclusive
 * line count) over every claim's subject, with **no overlap/nesting
 * dedup** — a claim for a file and a claim for an export inside that same
 * file both contribute their full span, so this over-counts whenever
 * claims nest or overlap (e.g. an unused file containing unused exports).
 *
 * Every claim in a `ClaimRun` already represents some flavour of "dead"
 * under the current verdict vocabulary (PRD §4) — including the tier-4/5
 * reserved verdicts, which are semantically dead-but-unconfirmed and simply
 * never emitted by v1 — so this provisional pass does not filter by
 * verdict.
 *
 * The real computation (span -> LOC with nested/overlapping-subject dedup)
 * is scoped to phasing.md T3.4; this function is the placeholder it
 * replaces.
 */
export function estimateDeletableLoc(claims: readonly Claim[]): number {
  let total = 0;
  for (const claim of claims) {
    const [startLine, endLine] = claim.subject.loc.span;
    total += endLine - startLine + 1;
  }
  return total;
}

export function computeSummary(claims: readonly Claim[]): ClaimSummary {
  return {
    byKind: countByKind(claims),
    byConfidence: countByConfidence(claims),
    estDeletableLoc: estimateDeletableLoc(claims),
  };
}
