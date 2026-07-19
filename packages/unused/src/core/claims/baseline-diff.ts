/**
 * Baseline diffing — the pure comparison core `unused check` gates on (T7.2,
 * docs/phasing.md M7; PRD §3 CI story; cli-ux §3). Operates only on `Claim`
 * arrays (this run's claims vs. a previously-blessed baseline's claims), with
 * zero I/O and zero frontend/CLI knowledge — reading `.unused/baseline.jsonl`
 * and rendering the result are the frontend's and reporters' jobs
 * respectively (dependency-cruiser: core never imports outward).
 *
 * ## Identity (ADR 0006)
 * A claim is "new" when its `id` is absent from the baseline's id set. Since
 * `id` excludes span/line and is a hash of `(kind, language, name, file,
 * protocol, method)`, this diff is naturally stable to reformatting and
 * in-file moves, and — documented, not a bug — reads a rename or a cross-file
 * move as one resolved claim plus one new claim (PRD §4).
 *
 * ## Suppression is the escape hatch (PRD §4/§6) — a VALID one only
 * A new claim escapes the gate only when it carries a **valid** suppression:
 * `/* unused:ignore <reason> *\/` with a non-empty reason. The reason is
 * mandatory (PRD §6) precisely so the source comment can stand in for a
 * human decision the gate would otherwise be forcing — an unexplained
 * directive is not that decision, and letting it through would make
 * `/* unused:ignore *\/` (no reason) a silent, gate-proof way to ship dead
 * weight, exactly the loophole PRD §6 closes by making the reason mandatory.
 *
 * `claims.ts`'s `suppressionOf` rejects a missing/blank reason, warns on stderr,
 * and leaves the emitted claim unsuppressed. Analyzer-produced claims therefore
 * reach this module with either a valid non-empty suppression or none at all.
 * The non-empty check below is retained as a defensive boundary for malformed
 * programmatic input; the ClaimRun schema also requires a non-empty reason.
 */
import type { Claim, Confidence } from "./types.js";

/** A suppression only counts as the gate's escape hatch when its reason is non-blank. */
function isValidlySuppressed(claim: Claim): boolean {
  return claim.suppression !== undefined && claim.suppression.reason.trim() !== "";
}

/** `high` > `medium` > `low`, matching the schema's `Confidence` enum. */
const CONFIDENCE_RANK: Readonly<Record<Confidence, number>> = { low: 0, medium: 1, high: 2 };

/** Does `confidence` meet or exceed the gate `threshold`? */
export function meetsConfidenceThreshold(confidence: Confidence, threshold: Confidence): boolean {
  return CONFIDENCE_RANK[confidence] >= CONFIDENCE_RANK[threshold];
}

export interface BaselineDiff {
  /**
   * New (not in the baseline id set), at/above `threshold`, and either
   * unsuppressed or suppressed WITHOUT a reason — exactly the set `unused
   * check` gates on. A reasonless `/* unused:ignore *\/` gates like any
   * other unsuppressed claim (see the module docstring). Id-sorted for
   * deterministic rendering.
   */
  readonly newClaims: readonly Claim[];
  /**
   * New, at/above `threshold`, validly suppressed (a non-empty reason) —
   * informational only, never gating (see the module docstring). Id-sorted.
   */
  readonly newSuppressedClaims: readonly Claim[];
  /**
   * Count of baseline claim ids absent from the current run — resolved
   * dead-weight, a feel-good signal with no effect on the exit code
   * (docs/phasing.md M7 point 4).
   */
  readonly resolvedCount: number;
}

function byId(a: Claim, b: Claim): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Diff `currentClaims` against `baselineClaims` at `threshold`. Below-
 * threshold new claims are simply omitted from every list here — they were
 * never candidates for the gate at any point, and `unused check` (cli-ux §3)
 * prints only NEW claims at/above the gate threshold, never the full set.
 */
export function diffAgainstBaseline(
  baselineClaims: readonly Claim[],
  currentClaims: readonly Claim[],
  threshold: Confidence,
): BaselineDiff {
  const baselineIds = new Set(baselineClaims.map((c) => c.id));
  const currentIds = new Set(currentClaims.map((c) => c.id));

  const newAtThreshold = currentClaims.filter(
    (c) => !baselineIds.has(c.id) && meetsConfidenceThreshold(c.confidence, threshold),
  );
  const newClaims = newAtThreshold.filter((c) => !isValidlySuppressed(c)).sort(byId);
  const newSuppressedClaims = newAtThreshold.filter((c) => isValidlySuppressed(c)).sort(byId);

  let resolvedCount = 0;
  for (const claim of baselineClaims) {
    if (!currentIds.has(claim.id)) resolvedCount += 1;
  }

  return { newClaims, newSuppressedClaims, resolvedCount };
}
