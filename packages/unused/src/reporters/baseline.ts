/**
 * `unused baseline` bless-summary output (T7.1, docs/phasing.md M7; PRD §3:
 * "Prints a summary of every claim it blesses so PR review sees what was
 * waved through"). Printed after `.unused/baseline.jsonl` is written, so a
 * reviewer gets counts by kind/verdict/confidence per workspace without
 * having to open the (potentially large) JSONL diff. Renders from
 * `core/claims` types only (reporters boundary — dependency-cruiser).
 */
import type { Claim, Confidence, SubjectKind } from "../core/claims/index.js";
import { formatCount } from "./tty.js";

export interface BaselineUnitSummary {
  /** `"root"` for the root package, else its `rootRelDir`. */
  readonly label: string;
  /** This unit's baseline file, root-relative POSIX (`baselineDisplayPath`). */
  readonly path: string;
  readonly claims: readonly Claim[];
}

const KINDS: readonly SubjectKind[] = ["export", "file", "dependency", "endpoint", "test"];
const CONFIDENCES: readonly Confidence[] = ["high", "medium", "low"];

function countByKind(claims: readonly Claim[]): Record<SubjectKind, number> {
  const out = Object.fromEntries(KINDS.map((k) => [k, 0])) as Record<SubjectKind, number>;
  for (const c of claims) out[c.subject.kind] += 1;
  return out;
}

function countByConfidence(claims: readonly Claim[]): Record<Confidence, number> {
  const out = Object.fromEntries(CONFIDENCES.map((c) => [c, 0])) as Record<Confidence, number>;
  for (const c of claims) out[c.confidence] += 1;
  return out;
}

/** Verdict is an open-ended-per-kind enum (PRD §4); count whatever actually appears, in first-seen order. */
function countByVerdict(claims: readonly Claim[]): ReadonlyArray<readonly [string, number]> {
  const counts = new Map<string, number>();
  for (const c of claims) counts.set(c.verdict, (counts.get(c.verdict) ?? 0) + 1);
  return [...counts.entries()];
}

function plural(n: number): string {
  return n === 1 ? "" : "s";
}

function renderUnit(unit: BaselineUnitSummary, dash: string): string[] {
  const byKind = countByKind(unit.claims);
  const byConfidence = countByConfidence(unit.claims);
  const byVerdict = countByVerdict(unit.claims);
  const n = unit.claims.length;
  const lines: string[] = [
    `${unit.label} ${dash} ${formatCount(n)} claim${plural(n)} (${unit.path})`,
  ];
  if (n > 0) {
    lines.push(`  by kind: ${KINDS.map((k) => `${byKind[k]} ${k}`).join(", ")}`);
    lines.push(`  by verdict: ${byVerdict.map(([v, c]) => `${c} ${v}`).join(", ")}`);
    lines.push(`  by confidence: ${CONFIDENCES.map((c) => `${byConfidence[c]} ${c}`).join(", ")}`);
  }
  return lines;
}

/** Renders the full `unused baseline` bless summary across every workspace unit written. `ascii` follows the same TTY-degradation convention as the default report (cli-ux §5). */
export function renderBlessSummary(units: readonly BaselineUnitSummary[], ascii: boolean): string {
  const dash = ascii ? "--" : "—";
  const totalClaims = units.reduce((n, u) => n + u.claims.length, 0);
  const lines: string[] = [
    `unused baseline: wrote ${units.length} baseline file${plural(units.length)} (${formatCount(totalClaims)} claim${plural(totalClaims)} blessed).`,
    "",
  ];
  for (const unit of units) {
    lines.push(...renderUnit(unit, dash), "");
  }
  lines.push(
    `baselines are regenerated on main only ${dash} regenerating on a feature branch masks the very regressions \`unused check\` exists to catch (docs/prd.md §3).`,
  );
  return `${lines.join("\n")}\n`;
}
