import { describe, expect, it } from "vitest";
import type { Claim, ClaimRun } from "../core/claims/index.js";
import { applyClaimFilters, filterClaims, hasActiveFilters } from "./filter.js";

function claim(overrides: Partial<Claim> & Pick<Claim, "subject" | "verdict">): Claim {
  return {
    id: `id_${overrides.subject.name}`,
    language: "ts",
    confidence: "high",
    evidence: [{ type: "static-reachability", detail: "why", source: "reference-graph" }],
    provenance: {
      analyzer: "ts-reference-graph",
      version: "0.1.0",
      generatedAt: "2026-07-18T00:00:00.000Z",
    },
    ...overrides,
  } as Claim;
}

const exportHigh = claim({
  subject: { kind: "export", name: "a", loc: { file: "a.ts", span: [1, 1] } },
  verdict: "unused",
  confidence: "high",
});
const fileMedium = claim({
  subject: { kind: "file", name: "b.ts", loc: { file: "b.ts", span: [1, 5] } },
  verdict: "unused",
  confidence: "medium",
});
const depLow = claim({
  subject: { kind: "dependency", name: "left-pad", loc: { file: "package.json", span: [1, 1] } },
  verdict: "unused",
  confidence: "low",
});
const testOnly = claim({
  subject: { kind: "test", name: "x.spec.ts", loc: { file: "x.spec.ts", span: [1, 1] } },
  verdict: "test-only",
  confidence: "high",
});

const ALL = [exportHigh, fileMedium, depLow, testOnly] as const;

function makeRun(claims: readonly Claim[]): ClaimRun {
  return {
    schemaVersion: "1.1.0",
    tool: { name: "unused", version: "0.1.0" },
    run: {
      root: "/repo",
      configHash: "abc",
      startedAt: "2026-07-18T00:00:00.000Z",
      durationMs: 10,
      boundaries: [
        {
          status: "complete",
          pluginId: "language:typescript",
          boundaryId: "ts:.",
          language: "ts",
          fileCount: 1,
          workspaceCount: 1,
          partitions: { production: "complete", config: "complete", test: "complete" },
        },
      ],
    },
    claims,
    summary: {
      byKind: { export: 1, file: 1, dependency: 1, endpoint: 0, test: 1 },
      byConfidence: { high: 2, medium: 1, low: 1 },
      estDeletableLoc: 6,
      zombieTests: { count: 1, estCiSecondsPerRun: 5, estimated: true, avgSecondsPerTestFile: 5 },
    },
  };
}

describe("hasActiveFilters", () => {
  it("is false with no options", () => {
    expect(hasActiveFilters({})).toBe(false);
  });
  it("is false with an empty kinds array", () => {
    expect(hasActiveFilters({ kinds: [] })).toBe(false);
  });
  it("is true with a non-empty kinds array", () => {
    expect(hasActiveFilters({ kinds: ["export"] })).toBe(true);
  });
  it("is true with minConfidence set", () => {
    expect(hasActiveFilters({ minConfidence: "high" })).toBe(true);
  });
});

describe("filterClaims", () => {
  it("returns every claim with no filter", () => {
    expect(filterClaims(ALL, {})).toEqual(ALL);
  });

  it("restricts to one kind", () => {
    expect(filterClaims(ALL, { kinds: ["export"] })).toEqual([exportHigh]);
  });

  it("restricts to multiple kinds (union)", () => {
    expect(filterClaims(ALL, { kinds: ["export", "test"] })).toEqual([exportHigh, testOnly]);
  });

  it("applies a confidence floor (medium keeps high+medium, drops low)", () => {
    expect(filterClaims(ALL, { minConfidence: "medium" })).toEqual([
      exportHigh,
      fileMedium,
      testOnly,
    ]);
  });

  it("floor 'low' keeps everything", () => {
    expect(filterClaims(ALL, { minConfidence: "low" })).toEqual(ALL);
  });

  it("floor 'high' keeps only high", () => {
    expect(filterClaims(ALL, { minConfidence: "high" })).toEqual([exportHigh, testOnly]);
  });

  it("kind and confidence compose (AND, not OR)", () => {
    expect(filterClaims(ALL, { kinds: ["file", "dependency"], minConfidence: "medium" })).toEqual([
      fileMedium,
    ]);
  });
});

describe("applyClaimFilters", () => {
  it("returns the same run reference when no filter is active", () => {
    const run = makeRun(ALL);
    expect(applyClaimFilters(run, {})).toBe(run);
  });

  it("filters claims AND recomputes summary so the two never disagree", () => {
    const run = makeRun(ALL);
    const filtered = applyClaimFilters(run, { kinds: ["export"] });
    expect(filtered.claims).toEqual([exportHigh]);
    expect(filtered.summary.byKind).toEqual({
      export: 1,
      file: 0,
      dependency: 0,
      endpoint: 0,
      test: 0,
    });
    expect(filtered.summary.byConfidence).toEqual({ high: 1, medium: 0, low: 0 });
    expect(filtered.summary.zombieTests).toBeUndefined(); // the zombie test claim was filtered out
  });

  it("preserves a configured ciSecondsPerTestFile average across the filter", () => {
    const run = makeRun(ALL); // zombieTests.avgSecondsPerTestFile === 5 (a non-default value, deliberately)
    const filtered = applyClaimFilters(run, { minConfidence: "high" }); // keeps the test-only claim
    expect(filtered.summary.zombieTests?.avgSecondsPerTestFile).toBe(5);
    expect(filtered.summary.zombieTests?.count).toBe(1);
  });

  it("leaves run.claims/summary untouched other than the claims/summary fields", () => {
    const run = makeRun(ALL);
    const filtered = applyClaimFilters(run, { kinds: ["export"] });
    expect(filtered.schemaVersion).toBe(run.schemaVersion);
    expect(filtered.tool).toEqual(run.tool);
    expect(filtered.run).toEqual(run.run);
  });
});
