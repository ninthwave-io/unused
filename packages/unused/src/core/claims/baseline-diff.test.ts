import { describe, expect, it } from "vitest";
import { diffAgainstBaseline, meetsConfidenceThreshold } from "./baseline-diff.js";
import { computeClaimId } from "./id.js";
import type { Claim, ExportClaim } from "./types.js";

const PROVENANCE = {
  analyzer: "ts-reference-graph",
  version: "0.1.0",
  generatedAt: "2026-07-18T09:12:07.210Z",
} as const;

function exportClaim(
  name: string,
  file: string,
  overrides: Partial<ExportClaim> = {},
): ExportClaim {
  const subject = { kind: "export" as const, name, loc: { file, span: [1, 2] as const } };
  return {
    id: computeClaimId(subject),
    language: "ts",
    subject,
    verdict: "unused",
    confidence: "high",
    evidence: [
      { type: "static-reachability", detail: "no inbound refs", source: "reference-graph" },
    ],
    provenance: PROVENANCE,
    ...overrides,
  };
}

describe("meetsConfidenceThreshold", () => {
  it("high meets every threshold", () => {
    expect(meetsConfidenceThreshold("high", "high")).toBe(true);
    expect(meetsConfidenceThreshold("high", "medium")).toBe(true);
    expect(meetsConfidenceThreshold("high", "low")).toBe(true);
  });

  it("medium meets medium/low but not high", () => {
    expect(meetsConfidenceThreshold("medium", "high")).toBe(false);
    expect(meetsConfidenceThreshold("medium", "medium")).toBe(true);
    expect(meetsConfidenceThreshold("medium", "low")).toBe(true);
  });

  it("low only meets low", () => {
    expect(meetsConfidenceThreshold("low", "high")).toBe(false);
    expect(meetsConfidenceThreshold("low", "medium")).toBe(false);
    expect(meetsConfidenceThreshold("low", "low")).toBe(true);
  });
});

describe("diffAgainstBaseline", () => {
  it("clean: every current claim already in the baseline -> no new claims, 0 resolved", () => {
    const a = exportClaim("a", "src/a.ts");
    const diff = diffAgainstBaseline([a], [a], "high");
    expect(diff.newClaims).toEqual([]);
    expect(diff.newSuppressedClaims).toEqual([]);
    expect(diff.resolvedCount).toBe(0);
  });

  it("a claim present only in the current run is new -> gates at/above threshold", () => {
    const kept = exportClaim("kept", "src/kept.ts");
    const fresh = exportClaim("fresh", "src/fresh.ts");
    const diff = diffAgainstBaseline([kept], [kept, fresh], "high");
    expect(diff.newClaims.map((c) => c.id)).toEqual([fresh.id]);
    expect(diff.resolvedCount).toBe(0);
  });

  it("a baseline claim absent from the current run counts as resolved, not gated", () => {
    const gone = exportClaim("gone", "src/gone.ts");
    const diff = diffAgainstBaseline([gone], [], "high");
    expect(diff.newClaims).toEqual([]);
    expect(diff.resolvedCount).toBe(1);
  });

  it("rename reads as one resolved claim plus one new claim (ADR 0006, documented behaviour)", () => {
    const before = exportClaim("oldName", "src/math.ts");
    const after = exportClaim("newName", "src/math.ts");
    const diff = diffAgainstBaseline([before], [after], "high");
    expect(diff.newClaims.map((c) => c.id)).toEqual([after.id]);
    expect(diff.resolvedCount).toBe(1);
  });

  it("a below-threshold new claim never appears in newClaims or newSuppressedClaims", () => {
    const medium = exportClaim("mediumOnly", "src/mods/x.ts", { confidence: "medium" });
    const diff = diffAgainstBaseline([], [medium], "high");
    expect(diff.newClaims).toEqual([]);
    expect(diff.newSuppressedClaims).toEqual([]);
  });

  it("a medium threshold gates a new medium claim that a high threshold would not", () => {
    const medium = exportClaim("mediumOnly", "src/mods/x.ts", { confidence: "medium" });
    const atHigh = diffAgainstBaseline([], [medium], "high");
    const atMedium = diffAgainstBaseline([], [medium], "medium");
    expect(atHigh.newClaims).toEqual([]);
    expect(atMedium.newClaims.map((c) => c.id)).toEqual([medium.id]);
  });

  it("a new VALIDLY suppressed claim (non-empty reason) at/above threshold is surfaced separately and never gates (suppression is the escape hatch)", () => {
    const suppressed = exportClaim("withReason", "src/legacy.ts", {
      suppression: { reason: "migration pending" },
    });
    const diff = diffAgainstBaseline([], [suppressed], "high");
    expect(diff.newClaims).toEqual([]);
    expect(diff.newSuppressedClaims.map((c) => c.id)).toEqual([suppressed.id]);
  });

  it("defensively rejects a malformed programmatic Claim with a blank suppression reason", () => {
    const withoutReason = exportClaim("withoutReason", "src/legacy.ts", {
      suppression: { reason: "" },
    });
    const diff = diffAgainstBaseline([], [withoutReason], "high");
    expect(diff.newClaims.map((c) => c.id)).toEqual([withoutReason.id]);
    expect(diff.newSuppressedClaims).toEqual([]);
  });

  it("newClaims and newSuppressedClaims are id-sorted for deterministic rendering", () => {
    const claims: Claim[] = [
      exportClaim("z", "src/z.ts"),
      exportClaim("a", "src/a.ts"),
      exportClaim("m", "src/m.ts"),
    ];
    const diff = diffAgainstBaseline([], claims, "high");
    const ids = diff.newClaims.map((c) => c.id);
    expect(ids).toEqual([...ids].sort());
  });
});
