/**
 * `unused check` output (T7.2, docs/phasing.md M7; docs/design/cli-ux.md
 * §3) — NEW claims vs baseline (each with the same one-line why as the
 * default report), remediation guidance, and a verdict line. Renders from
 * `core/claims` types plus the `BaselineDiff` shape `core/claims`'s
 * `diffAgainstBaseline` computes; no frontend/CLI I/O here (reporters
 * boundary — dependency-cruiser).
 */
import type { BaselineDiff, Claim, Confidence } from "../core/claims/index.js";
import { formatCount, locLabel, whyText } from "./tty.js";

/** One version-stamp field's baseline-vs-current disagreement; `undefined` when it matches. */
export interface MismatchField<T> {
  readonly baseline: T;
  readonly current: T;
}

/** ADR 0006 version stamps plus `configHash` (PRD §4) — any mismatch is a graceful-degrade warning, never a hard fail (PRD §4). */
export interface CheckVersionMismatch {
  readonly analyzer: MismatchField<string> | undefined;
  readonly idVersion: MismatchField<number> | undefined;
  readonly schema: MismatchField<string> | undefined;
  /** `true` when `configHash` differs — the values themselves aren't informative to a human, so only the fact of divergence is carried. */
  readonly configHash: boolean;
}

export interface CheckBaselineMeta {
  /** ISO 8601 (the baseline's `generatedAt`). */
  readonly generatedAt: string;
  readonly analyzerVersion: string;
  /** Total claims across every workspace's baseline file — the full blessed snapshot, not filtered to `threshold`. */
  readonly claimCount: number;
}

interface RenderCheckOptionsCommon {
  /** Non-TTY stdout, `NO_COLOR`, or no real terminal — plain ASCII (cli-ux §5), matching the default report's degradation. */
  readonly ascii: boolean;
  readonly baseline: CheckBaselineMeta;
  readonly mismatch: CheckVersionMismatch;
}

/**
 * The gate ran normally: baseline and current claim ids are comparable, so
 * `diff` (`core/claims`'s `diffAgainstBaseline`) is meaningful and the usual
 * NEW-claims/remediation/verdict rendering applies.
 */
export interface RenderCheckEvaluatedOptions extends RenderCheckOptionsCommon {
  readonly kind: "evaluated";
  readonly threshold: Confidence;
  readonly diff: BaselineDiff;
}

/**
 * The gate was skipped (T7.2 reviewer fix): an `idVersion` or schemaVersion
 * MAJOR mismatch means claim ids computed under two different recipes are
 * being compared, so EVERY current claim looks "new" against the baseline —
 * a false avalanche, not a real signal. PRD §4's graceful-degrade rule ("an
 * analyzer upgrade must never paint the whole repo as new dead weight")
 * demands more than a warning here: the comparison itself is meaningless, so
 * the caller must not run `diffAgainstBaseline` at all, and this renders the
 * "not evaluated" state explicitly rather than either a fabricated pass or a
 * fabricated failure — a non-evaluated gate must say so, never silently read
 * as clean.
 */
export interface RenderCheckSkippedOptions extends RenderCheckOptionsCommon {
  readonly kind: "gate-not-evaluated";
}

export type RenderCheckOptions = RenderCheckEvaluatedOptions | RenderCheckSkippedOptions;

function hasMismatch(m: CheckVersionMismatch): boolean {
  return (
    m.analyzer !== undefined || m.idVersion !== undefined || m.schema !== undefined || m.configHash
  );
}

/** "high-confidence" for the default threshold (matching cli-ux §3's literal example text); "<threshold>-confidence-or-above" otherwise. */
function thresholdNoun(threshold: Confidence): string {
  return threshold === "high" ? "high-confidence" : `${threshold}-confidence-or-above`;
}

function plural(n: number): string {
  return n === 1 ? "" : "s";
}

function claimLine(claim: Claim): string {
  return `  ${claim.verdict}  ${claim.subject.kind}  ${claim.subject.name}  ${locLabel(claim)}  ${claim.confidence}  ${whyText(claim, true)}`;
}

function renderMismatchWarning(m: CheckVersionMismatch, ascii: boolean): string[] {
  const warn = ascii ? "!" : "⚠";
  const lines: string[] = [
    `${warn} baseline was generated under different conditions than this run — comparisons may be noisy:`,
  ];
  if (m.analyzer !== undefined) {
    lines.push(
      `  - analyzer version: baseline ${m.analyzer.baseline}, current ${m.analyzer.current}`,
    );
  }
  if (m.idVersion !== undefined) {
    lines.push(
      `  - claim id recipe (idVersion): baseline ${m.idVersion.baseline}, current ${m.idVersion.current}`,
    );
  }
  if (m.schema !== undefined) {
    lines.push(`  - schema version: baseline ${m.schema.baseline}, current ${m.schema.current}`);
  }
  if (m.configHash) {
    lines.push("  - config: changed since baseline (configHash differs)");
  }
  lines.push(
    "  recommend: re-baseline on main (`unused baseline`) once these changes have landed there.",
  );
  return lines;
}

function renderRemediation(): string[] {
  return [
    "remediation:",
    "  - delete the dead code, or",
    "  - suppress it with a reason: /* unused:ignore <reason> */ immediately above the declaration, or",
    "  - if this is accepted debt, re-baseline on main: `unused baseline` (never on a feature branch).",
  ];
}

/** Renders the full `unused check` report (cli-ux §3): baseline metadata, an optional mismatch warning, then either the NEW-claims/remediation/verdict block (`kind: "evaluated"`) or the explicit "gate not evaluated" line (`kind: "gate-not-evaluated"`). */
export function renderCheckReport(options: RenderCheckOptions): string {
  const { ascii, baseline, mismatch } = options;
  const dash = ascii ? "--" : "—";
  const date = baseline.generatedAt.slice(0, 10);
  const lines: string[] = [
    `baseline: ${date} (${formatCount(baseline.claimCount)} claim${plural(baseline.claimCount)}, analyzer ${baseline.analyzerVersion})`,
  ];

  if (hasMismatch(mismatch)) {
    lines.push("", ...renderMismatchWarning(mismatch, ascii));
  }

  if (options.kind === "gate-not-evaluated") {
    const warn = ascii ? "!" : "⚠";
    lines.push(
      "",
      `${warn} gate not evaluated ${dash} claim ids are not comparable across this baseline (idVersion/schema change) ${dash} re-baseline required ${dash} exit 0`,
    );
    return `${lines.join("\n")}\n`;
  }

  const { threshold, diff } = options;

  if (diff.newClaims.length > 0) {
    lines.push("", ...diff.newClaims.map(claimLine));
  }

  if (diff.newSuppressedClaims.length > 0) {
    lines.push(
      "",
      `${formatCount(diff.newSuppressedClaims.length)} new claim${plural(diff.newSuppressedClaims.length)} at or above ${threshold} confidence ${dash} suppressed, not gated:`,
      ...diff.newSuppressedClaims.map(claimLine),
    );
  }

  if (diff.resolvedCount > 0) {
    lines.push(
      "",
      `${formatCount(diff.resolvedCount)} claim${plural(diff.resolvedCount)} resolved since baseline.`,
    );
  }

  if (diff.newClaims.length > 0) {
    const n = diff.newClaims.length;
    lines.push(
      "",
      ...renderRemediation(),
      "",
      `${ascii ? "FAIL" : "✗"} ${formatCount(n)} new ${thresholdNoun(threshold)} claim${plural(n)} since baseline (${date}, ${formatCount(baseline.claimCount)} claim${plural(baseline.claimCount)}) ${dash} exit 1`,
    );
  } else {
    lines.push("", `${ascii ? "PASS" : "✓"} no new dead weight since baseline ${dash} exit 0`);
  }

  return `${lines.join("\n")}\n`;
}
