/**
 * Claim filtering shared by every reporter output (T6.2, docs/phasing.md
 * M6). PRD §3 defines `--filter <kind>` and `--min-confidence <level>` as
 * general CLI flags, not TTY-only options; the delegation spec's explicit
 * decision is that they **filter claims in every output, including
 * `--json`** — a consumer piping `--json` through `--filter`/`--min-confidence`
 * sees exactly the claim set a human would see in the terminal, and a SARIF
 * upload only carries the claims the flags let through. This module is the
 * one place that rule is implemented, so the TTY, `--json`, and SARIF paths
 * can never drift from each other.
 *
 * Imports only `core/claims` (dependency-cruiser reporters boundary: "no
 * frontends, and no core internals besides core/claims").
 */
import {
  type Claim,
  type ClaimRun,
  type Confidence,
  computeSummary,
  type SubjectKind,
} from "../core/claims/index.js";

export interface ClaimFilterOptions {
  /** `--filter <kind>` (repeatable/comma-separated, PRD §3). Absent/empty ⇒ no kind restriction. */
  readonly kinds?: readonly SubjectKind[];
  /** `--min-confidence <level>` (PRD §3). Absent ⇒ no confidence floor. */
  readonly minConfidence?: Confidence;
}

const CONFIDENCE_RANK: Readonly<Record<Confidence, number>> = { low: 1, medium: 2, high: 3 };

/** Is either filter actually restricting anything? (Distinguishes "user passed --filter/--min-confidence" from "the run legitimately has zero claims" for reporter empty-state copy.) */
export function hasActiveFilters(options: ClaimFilterOptions): boolean {
  return (
    (options.kinds !== undefined && options.kinds.length > 0) || options.minConfidence !== undefined
  );
}

/** Filter a bare claim list by kind set and/or confidence floor. */
export function filterClaims(claims: readonly Claim[], options: ClaimFilterOptions): Claim[] {
  const kindSet =
    options.kinds !== undefined && options.kinds.length > 0 ? new Set(options.kinds) : undefined;
  const floor =
    options.minConfidence !== undefined ? CONFIDENCE_RANK[options.minConfidence] : undefined;
  return claims.filter((claim) => {
    if (kindSet !== undefined && !kindSet.has(claim.subject.kind)) return false;
    if (floor !== undefined && CONFIDENCE_RANK[claim.confidence] < floor) return false;
    return true;
  });
}

/**
 * Filter a whole {@link ClaimRun} and recompute `summary` from the filtered
 * claims, so `byKind`/`byConfidence`/`estDeletableLoc`/`zombieTests` stay
 * internally consistent with the filtered `claims` array in every output —
 * a `--json` consumer must never see a summary that counts claims the
 * `claims` array doesn't contain. The zombie-tests CI-seconds average
 * (config `ciSecondsPerTestFile`, if the run had one) is carried through so
 * filtering never silently reverts a configured average back to the
 * built-in default. Returns `run` unchanged (same reference) when no filter
 * is active — the common case, and cheap.
 */
export function applyClaimFilters(run: ClaimRun, options: ClaimFilterOptions): ClaimRun {
  if (!hasActiveFilters(options)) return run;
  const claims = filterClaims(run.claims, options);
  const ciSecondsPerTestFile = run.summary.zombieTests?.avgSecondsPerTestFile;
  return {
    ...run,
    claims,
    summary: computeSummary(claims, { ciSecondsPerTestFile }),
  };
}
