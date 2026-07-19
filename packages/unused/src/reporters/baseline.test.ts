/**
 * `unused baseline` bless-summary tests (T7.1, PRD §3: "Prints a summary of
 * every claim it blesses so PR review sees what was waved through").
 */
import { describe, expect, it } from "vitest";
import type { Claim } from "../core/claims/index.js";
import { type BaselineUnitSummary, renderBlessSummary } from "./baseline.js";

function claim(overrides: Partial<Claim> & Pick<Claim, "subject" | "verdict">): Claim {
  return {
    id: `id_${overrides.subject.name}`,
    confidence: "high",
    evidence: [
      { type: "static-reachability", detail: "no inbound refs", source: "reference-graph" },
    ],
    provenance: {
      analyzer: "ts-reference-graph",
      version: "0.1.0",
      generatedAt: "2026-07-18T00:00:00.000Z",
    },
    ...overrides,
  } as Claim;
}

describe("renderBlessSummary", () => {
  it("reports the total file/claim count up top", () => {
    const units: BaselineUnitSummary[] = [
      { label: "root", path: ".unused/baseline.jsonl", claims: [] },
    ];
    const text = renderBlessSummary(units, true);
    expect(text).toContain("unused baseline: wrote 1 baseline file (0 claims blessed).");
  });

  it("breaks down each unit by kind, verdict, and confidence", () => {
    const units: BaselineUnitSummary[] = [
      {
        label: "root",
        path: ".unused/baseline.jsonl",
        claims: [
          claim({
            subject: { kind: "export", name: "a", loc: { file: "src/a.ts", span: [1, 2] } },
            verdict: "unused",
            confidence: "high",
          }),
          claim({
            subject: { kind: "file", name: "src/b.ts", loc: { file: "src/b.ts", span: [1, 4] } },
            verdict: "unused",
            confidence: "medium",
          }),
          claim({
            subject: { kind: "test", name: "t.spec.ts", loc: { file: "t.spec.ts", span: [1, 2] } },
            verdict: "test-only",
            confidence: "high",
          }),
        ],
      },
    ];
    const text = renderBlessSummary(units, true);
    expect(text).toContain("root -- 3 claims (.unused/baseline.jsonl)");
    expect(text).toContain("by kind: 1 export, 1 file, 0 dependency, 0 endpoint, 1 test");
    expect(text).toContain("by verdict: 2 unused, 1 test-only");
    expect(text).toContain("by confidence: 2 high, 1 medium, 0 low");
  });

  it("multiple units each get their own breakdown, in order (monorepo, T7.1)", () => {
    const units: BaselineUnitSummary[] = [
      { label: "root", path: ".unused/baseline.jsonl", claims: [] },
      {
        label: "packages/app",
        path: "packages/app/.unused/baseline.jsonl",
        claims: [
          claim({
            subject: {
              kind: "file",
              name: "src/orphan.ts",
              loc: { file: "packages/app/src/orphan.ts", span: [1, 3] },
            },
            verdict: "unused",
          }),
        ],
      },
    ];
    const text = renderBlessSummary(units, true);
    expect(text).toContain("wrote 2 baseline files (1 claim blessed).");
    expect(text).toContain("root -- 0 claims (.unused/baseline.jsonl)");
    expect(text).toContain("packages/app -- 1 claim (packages/app/.unused/baseline.jsonl)");
  });

  it("skips the kind/verdict/confidence breakdown lines for a zero-claim unit", () => {
    const units: BaselineUnitSummary[] = [
      { label: "root", path: ".unused/baseline.jsonl", claims: [] },
    ];
    const text = renderBlessSummary(units, true);
    expect(text).not.toContain("by kind:");
  });

  it("names the main-only baseline workflow (PRD §3)", () => {
    const text = renderBlessSummary(
      [{ label: "root", path: ".unused/baseline.jsonl", claims: [] }],
      true,
    );
    expect(text).toContain("regenerated on main only");
  });

  it("ascii mode never emits the unicode em dash", () => {
    const text = renderBlessSummary(
      [{ label: "root", path: ".unused/baseline.jsonl", claims: [] }],
      true,
    );
    expect(text).not.toContain("—");
  });
});
