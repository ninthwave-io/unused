import { describe, expect, it } from "vitest";
import { computeClaimId } from "./id.js";
import {
  computeSummary,
  computeZombieTestsSummary,
  countByConfidence,
  countByKind,
  DEFAULT_CI_SECONDS_PER_TEST_FILE,
  estimateDeletableLoc,
} from "./summary.js";
import type { Claim, ExportClaim, FileClaim, TestClaim } from "./types.js";

function exportClaim(overrides: Partial<ExportClaim> = {}): ExportClaim {
  const subject = {
    kind: "export" as const,
    name: "formatCurrency",
    loc: { file: "src/utils/currency.ts", span: [12, 24] as const },
  };
  return {
    id: computeClaimId(subject),
    language: "ts",
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
    language: "ts",
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
    language: "ts",
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

describe("estimateDeletableLoc", () => {
  it("is zero for an empty run", () => {
    expect(estimateDeletableLoc([])).toBe(0);
  });

  it("sums inclusive span LOC for a single claim", () => {
    // span [12, 24] -> 13 lines, matching the PRD §4 worked example.
    expect(estimateDeletableLoc([exportClaim()])).toBe(13);
  });

  it("merges a nested span into its covering interval, counted once", () => {
    const outer = exportClaim({
      subject: { kind: "export", name: "outer", loc: { file: "src/a.ts", span: [1, 50] } },
    });
    const inner = exportClaim({
      subject: { kind: "export", name: "inner", loc: { file: "src/a.ts", span: [10, 20] } },
    });
    // inner [10,20] is fully inside outer [1,50] -> only the outer 50 lines count.
    expect(estimateDeletableLoc([outer, inner])).toBe(50);
  });

  it("merges partially overlapping spans into their union", () => {
    const first = exportClaim({
      subject: { kind: "export", name: "first", loc: { file: "src/a.ts", span: [1, 10] } },
    });
    const second = exportClaim({
      subject: { kind: "export", name: "second", loc: { file: "src/a.ts", span: [5, 15] } },
    });
    // [1,10] union [5,15] -> [1,15] -> 15 lines, not the naive 10 + 11 = 21.
    expect(estimateDeletableLoc([first, second])).toBe(15);
  });

  it("does not merge merely-adjacent, non-overlapping spans", () => {
    const first = exportClaim({
      subject: { kind: "export", name: "first", loc: { file: "src/a.ts", span: [1, 5] } },
    });
    const second = exportClaim({
      subject: { kind: "export", name: "second", loc: { file: "src/a.ts", span: [6, 10] } },
    });
    expect(estimateDeletableLoc([first, second])).toBe(5 + 5);
  });

  it("a file claim subsumes every export span inside that file, counted once", () => {
    const file = fileClaim({
      subject: { kind: "file", name: "legacy.ts", loc: { file: "src/legacy.ts", span: [1, 50] } },
    });
    const nestedExport = exportClaim({
      subject: { kind: "export", name: "helper", loc: { file: "src/legacy.ts", span: [10, 20] } },
    });
    // The file claim's 50 lines subsume the export claim's — it contributes nothing extra.
    expect(estimateDeletableLoc([file, nestedExport])).toBe(50);
  });

  it("excludes a test-only claim from the estimate (deleting it is a code+test cascade, T5.2)", () => {
    // A test-only export in an otherwise-alive file: real, but not deletable on
    // its own, so it contributes nothing to the deletable-LOC estimate.
    const testOnlyExport = exportClaim({
      subject: { kind: "export", name: "onlyTested", loc: { file: "src/x.ts", span: [1, 20] } },
      verdict: "test-only",
      evidence: [
        { type: "test-only", detail: "reachable only from a test", source: "reference-graph" },
      ],
    });
    expect(estimateDeletableLoc([testOnlyExport])).toBe(0);
    // Alongside a real unused claim, only the unused lines count.
    const dead = exportClaim({
      subject: { kind: "export", name: "dead", loc: { file: "src/y.ts", span: [1, 10] } },
    });
    expect(estimateDeletableLoc([testOnlyExport, dead])).toBe(10);
  });

  it("excludes a suppressed claim from the estimate", () => {
    const suppressed = exportClaim({
      subject: { kind: "export", name: "ignored", loc: { file: "src/b.ts", span: [1, 20] } },
      suppression: { reason: "used by a codegen plugin" },
    });
    expect(estimateDeletableLoc([suppressed])).toBe(0);
  });

  it("excludes a suppressed claim even when it overlaps a live claim in the same file", () => {
    const suppressed = exportClaim({
      subject: { kind: "export", name: "ignored", loc: { file: "src/c.ts", span: [1, 30] } },
      suppression: { reason: "kept for a plugin API" },
    });
    const live = exportClaim({
      subject: { kind: "export", name: "dead", loc: { file: "src/c.ts", span: [40, 45] } },
    });
    // Only the non-suppressed 6-line span counts; the suppressed 30-line span is dropped
    // entirely rather than merged in.
    expect(estimateDeletableLoc([suppressed, live])).toBe(6);
  });

  it("sums merged LOC independently across multiple files (no cross-file merging)", () => {
    const fileAOuter = exportClaim({
      subject: { kind: "export", name: "a1", loc: { file: "src/a.ts", span: [1, 20] } },
    });
    const fileAInner = exportClaim({
      subject: { kind: "export", name: "a2", loc: { file: "src/a.ts", span: [5, 10] } },
    });
    const fileB = fileClaim({
      subject: { kind: "file", name: "b.ts", loc: { file: "src/b.ts", span: [1, 30] } },
    });
    const fileC = exportClaim({
      subject: { kind: "export", name: "c1", loc: { file: "src/c.ts", span: [100, 104] } },
    });
    // src/a.ts merges to 20, src/b.ts is 30 (file claim), src/c.ts is 5 -> 55 total.
    expect(estimateDeletableLoc([fileAOuter, fileAInner, fileB, fileC])).toBe(20 + 30 + 5);
  });

  it("keeps the same relative file path in two different monorepo packages separate", () => {
    const packageA = exportClaim({
      subject: {
        kind: "export",
        name: "shared",
        loc: { file: "src/index.ts", package: "pkg-a", span: [1, 10] },
      },
    });
    const packageB = exportClaim({
      subject: {
        kind: "export",
        name: "shared",
        loc: { file: "src/index.ts", package: "pkg-b", span: [1, 10] },
      },
    });
    // Same relative path in two different packages must not be merged together.
    expect(estimateDeletableLoc([packageA, packageB])).toBe(10 + 10);
  });
});

// ---------------------------------------------------------------------------
// computeZombieTestsSummary (T5.3, docs/design/report-and-badge.md §3)
// ---------------------------------------------------------------------------

describe("computeZombieTestsSummary", () => {
  it("is undefined for an empty run — nothing to estimate", () => {
    expect(computeZombieTestsSummary([])).toBeUndefined();
  });

  it("is undefined when the run has no zombie `test` claims (a zero-zombie run)", () => {
    const claims: Claim[] = [exportClaim(), fileClaim()];
    expect(computeZombieTestsSummary(claims)).toBeUndefined();
  });

  it("counts one zombie test at the default 5s/file average, estimated: true always", () => {
    expect(computeZombieTestsSummary([testOnlyClaim()])).toEqual({
      count: 1,
      estCiSecondsPerRun: 5,
      estimated: true,
      avgSecondsPerTestFile: DEFAULT_CI_SECONDS_PER_TEST_FILE,
    });
  });

  it("sums count across multiple zombie test claims (export/file claims don't count)", () => {
    const secondZombie = testOnlyClaim({
      subject: {
        kind: "test",
        name: "billing.spec.ts",
        loc: { file: "src/billing.spec.ts", span: [1, 10] },
      },
    });
    const claims: Claim[] = [exportClaim(), testOnlyClaim(), secondZombie];
    expect(computeZombieTestsSummary(claims)).toEqual({
      count: 2,
      estCiSecondsPerRun: 10,
      estimated: true,
      avgSecondsPerTestFile: DEFAULT_CI_SECONDS_PER_TEST_FILE,
    });
  });

  it("honours a config-supplied avgSecondsPerTestFile override", () => {
    expect(computeZombieTestsSummary([testOnlyClaim()], 2.5)).toEqual({
      count: 1,
      estCiSecondsPerRun: 2.5,
      estimated: true,
      avgSecondsPerTestFile: 2.5,
    });
  });

  it("counts a suppressed zombie-test claim too, matching byKind/byConfidence (PRD §4/§6)", () => {
    const suppressed = testOnlyClaim({ suppression: { reason: "kept deliberately for now" } });
    expect(computeZombieTestsSummary([suppressed])?.count).toBe(1);
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
    // The 30-line test-only (zombie) claim is counted in byKind/byConfidence but
    // NOT in estDeletableLoc — only the two `unused` claims (13 + 50) count (T5.2).
    expect(summary.estDeletableLoc).toBe(13 + 50);
  });

  it("omits zombieTests entirely on a zero-zombie run (never a count: 0 block)", () => {
    const summary = computeSummary([exportClaim(), fileClaim()]);
    expect(summary.zombieTests).toBeUndefined();
    expect(Object.keys(summary)).not.toContain("zombieTests");
  });

  it("adds a zombieTests block at the default average when the run has a zombie test", () => {
    const summary = computeSummary([exportClaim(), testOnlyClaim()]);
    expect(summary.zombieTests).toEqual({
      count: 1,
      estCiSecondsPerRun: 5,
      estimated: true,
      avgSecondsPerTestFile: DEFAULT_CI_SECONDS_PER_TEST_FILE,
    });
  });

  it("threads the ciSecondsPerTestFile option through to the zombieTests block (config override)", () => {
    const summary = computeSummary([testOnlyClaim()], { ciSecondsPerTestFile: 12 });
    expect(summary.zombieTests).toEqual({
      count: 1,
      estCiSecondsPerRun: 12,
      estimated: true,
      avgSecondsPerTestFile: 12,
    });
  });
});
