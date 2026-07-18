import { describe, expect, it } from "vitest";
import { computeClaimId } from "./id.js";
import { computeSummary, countByConfidence, countByKind, estimateDeletableLoc } from "./summary.js";
import type { Claim, ExportClaim, FileClaim, TestClaim } from "./types.js";

function exportClaim(overrides: Partial<ExportClaim> = {}): ExportClaim {
  const subject = {
    kind: "export" as const,
    name: "formatCurrency",
    loc: { file: "src/utils/currency.ts", span: [12, 24] as const },
  };
  return {
    id: computeClaimId(subject),
    subject,
    verdict: "unused",
    confidence: "high",
    evidence: [
      { type: "static-reachability", detail: "no inbound refs", source: "reference-graph" },
    ],
    provenance: {
      analyzer: "ts-reference-graph",
      version: "0.1.0",
      generatedAt: "2026-07-18T09:12:07.210Z",
    },
    ...overrides,
  };
}

function fileClaim(overrides: Partial<FileClaim> = {}): FileClaim {
  const subject = {
    kind: "file" as const,
    name: "legacy.ts",
    loc: { file: "src/legacy.ts", span: [1, 50] as const },
  };
  return {
    id: computeClaimId(subject),
    subject,
    verdict: "unused",
    confidence: "medium",
    evidence: [
      { type: "static-reachability", detail: "no inbound refs", source: "reference-graph" },
    ],
    provenance: {
      analyzer: "ts-reference-graph",
      version: "0.1.0",
      generatedAt: "2026-07-18T09:12:07.210Z",
    },
    ...overrides,
  };
}

function testOnlyClaim(overrides: Partial<TestClaim> = {}): TestClaim {
  const subject = {
    kind: "test" as const,
    name: "orders.spec.ts",
    loc: { file: "src/orders/orders.spec.ts", span: [1, 30] as const },
  };
  return {
    id: computeClaimId(subject),
    subject,
    verdict: "test-only",
    confidence: "low",
    evidence: [{ type: "test-only", detail: "zombie test", source: "reference-graph" }],
    provenance: {
      analyzer: "ts-reference-graph",
      version: "0.1.0",
      generatedAt: "2026-07-18T09:12:07.210Z",
    },
    ...overrides,
  };
}

describe("countByKind", () => {
  it("returns zero for every kind on an empty run", () => {
    expect(countByKind([])).toEqual({ export: 0, file: 0, dependency: 0, endpoint: 0, test: 0 });
  });

  it("tallies claims per subject kind", () => {
    const claims: Claim[] = [exportClaim(), exportClaim(), fileClaim()];
    expect(countByKind(claims)).toEqual({
      export: 2,
      file: 1,
      dependency: 0,
      endpoint: 0,
      test: 0,
    });
  });
});

describe("countByConfidence", () => {
  it("returns zero for every level on an empty run", () => {
    expect(countByConfidence([])).toEqual({ high: 0, medium: 0, low: 0 });
  });

  it("tallies claims per confidence grade", () => {
    const claims: Claim[] = [
      exportClaim({ confidence: "high" }),
      fileClaim({ confidence: "medium" }),
      testOnlyClaim(),
    ];
    expect(countByConfidence(claims)).toEqual({ high: 1, medium: 1, low: 1 });
  });
});

describe("estimateDeletableLoc (PROVISIONAL, T3.4 owns overlap dedup)", () => {
  it("is zero for an empty run", () => {
    expect(estimateDeletableLoc([])).toBe(0);
  });

  it("sums inclusive span LOC across claims", () => {
    // span [12, 24] -> 13 lines, matching the PRD §4 worked example.
    expect(estimateDeletableLoc([exportClaim()])).toBe(13);
  });

  it("does not dedup overlapping/nested spans (documented provisional behaviour)", () => {
    const outer = fileClaim({
      subject: { kind: "file", name: "legacy.ts", loc: { file: "src/legacy.ts", span: [1, 50] } },
    });
    const inner = exportClaim({
      subject: { kind: "export", name: "helper", loc: { file: "src/legacy.ts", span: [10, 20] } },
    });
    // 50 (file) + 11 (export nested inside it) double-counts the overlap on purpose.
    expect(estimateDeletableLoc([outer, inner])).toBe(50 + 11);
  });
});

describe("computeSummary", () => {
  it("matches the PRD §4 worked example for a single claim", () => {
    const claims: Claim[] = [exportClaim()];
    expect(computeSummary(claims)).toEqual({
      byKind: { export: 1, file: 0, dependency: 0, endpoint: 0, test: 0 },
      byConfidence: { high: 1, medium: 0, low: 0 },
      estDeletableLoc: 13,
    });
  });

  it("combines byKind, byConfidence, and estDeletableLoc across a mixed run", () => {
    const claims: Claim[] = [exportClaim(), fileClaim(), testOnlyClaim()];
    const summary = computeSummary(claims);
    expect(summary.byKind).toEqual({ export: 1, file: 1, dependency: 0, endpoint: 0, test: 1 });
    expect(summary.byConfidence).toEqual({ high: 1, medium: 1, low: 1 });
    expect(summary.estDeletableLoc).toBe(13 + 50 + 30);
  });
});
