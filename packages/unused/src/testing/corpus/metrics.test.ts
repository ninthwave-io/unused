import { describe, expect, it } from "vitest";
import type { Claim, Confidence, ExportSubject, FileSubject } from "../../core/claims/types.js";
import type { Label } from "./labels.js";
import {
  type CaseInput,
  gateNoConfidenceViolations,
  gateNoHighConfidenceFalsePositives,
  gatePrecisionNonDecreasing,
  scoreCase,
  scoreCorpus,
} from "./metrics.js";

function label(overrides: Partial<Label> = {}): Label {
  return {
    kind: "export",
    name: "thing",
    file: "src/thing.ts",
    expected: "alive",
    because: "test fixture label",
    ...overrides,
  };
}

function exportClaim(
  overrides: { name?: string; file?: string; confidence?: Confidence } = {},
): Claim {
  const subject: ExportSubject = {
    kind: "export",
    name: overrides.name ?? "thing",
    loc: { file: overrides.file ?? "src/thing.ts", span: [1, 1] },
  };
  return {
    id: `exp_${subject.name}_${subject.loc.file}`,
    subject,
    verdict: "unused",
    confidence: overrides.confidence ?? "high",
    evidence: [{ type: "static-reachability", detail: "no importers", source: "test" }],
    provenance: { analyzer: "test", version: "0.0.0", generatedAt: "2026-01-01T00:00:00.000Z" },
  };
}

function fileClaim(overrides: { file?: string; confidence?: Confidence } = {}): Claim {
  const subject: FileSubject = {
    kind: "file",
    name: overrides.file ?? "src/orphan.ts",
    loc: { file: overrides.file ?? "src/orphan.ts", span: [1, 1] },
  };
  return {
    id: `fil_${subject.name}`,
    subject,
    verdict: "unused",
    confidence: overrides.confidence ?? "high",
    evidence: [{ type: "static-reachability", detail: "no importers", source: "test" }],
    provenance: { analyzer: "test", version: "0.0.0", generatedAt: "2026-01-01T00:00:00.000Z" },
  };
}

describe("scoreCase — basic classifications", () => {
  it("has vacuous precision and recall 1.0 when there are no labels and no claims", () => {
    const result = scoreCase({ case: "empty", labels: [], claims: [] });
    expect(result.precision).toBe(1);
    expect(result.recall).toBe(1);
  });

  it("has vacuous precision 1.0 when there are labels but zero claims", () => {
    const result = scoreCase({
      case: "c",
      labels: [label({ expected: "dead", minConfidence: "high", name: "dead1" })],
      claims: [],
    });
    expect(result.precision).toBe(1);
    expect(result.recall).toBe(0);
    expect(result.misses).toHaveLength(1);
  });

  it("flags a dead-verdict claim on an alive-labelled subject as a false positive", () => {
    const input: CaseInput = {
      case: "c",
      labels: [label({ expected: "alive", name: "aliveThing" })],
      claims: [exportClaim({ name: "aliveThing", confidence: "high" })],
    };
    const result = scoreCase(input);
    expect(result.falsePositives).toHaveLength(1);
    expect(result.falsePositives[0]?.label.name).toBe("aliveThing");
    expect(result.confidenceViolations).toHaveLength(0);
  });

  it("counts a within-ceiling claim on a dead-labelled subject as a true positive", () => {
    const input: CaseInput = {
      case: "c",
      labels: [label({ expected: "dead", minConfidence: "medium", name: "deadThing" })],
      claims: [exportClaim({ name: "deadThing", confidence: "medium" })],
    };
    const result = scoreCase(input);
    expect(result.truePositives).toBe(1);
    expect(result.falsePositives).toHaveLength(0);
    expect(result.confidenceViolations).toHaveLength(0);
    expect(result.recall).toBe(1);
  });

  it("counts a claim under the ceiling (lower confidence than allowed) as a true positive too", () => {
    // fixtures/README.md: minConfidence is a ceiling on hazard subjects —
    // under-confidence is tolerated, only over-confidence is a violation.
    const input: CaseInput = {
      case: "c",
      labels: [label({ expected: "dead", minConfidence: "high", name: "deadThing" })],
      claims: [exportClaim({ name: "deadThing", confidence: "low" })],
    };
    const result = scoreCase(input);
    expect(result.truePositives).toBe(1);
    expect(result.confidenceViolations).toHaveLength(0);
  });

  it("flags a claim exceeding the ceiling on a dead-labelled subject as a confidence violation, not a false positive", () => {
    const input: CaseInput = {
      case: "c",
      labels: [label({ expected: "dead", minConfidence: "medium", name: "hazardThing" })],
      claims: [exportClaim({ name: "hazardThing", confidence: "high" })],
    };
    const result = scoreCase(input);
    expect(result.confidenceViolations).toHaveLength(1);
    expect(result.falsePositives).toHaveLength(0);
    expect(result.truePositives).toBe(0);
  });

  it("counts a claim matching no label as unlabelled, excluded from precision/recall", () => {
    const input: CaseInput = {
      case: "c",
      labels: [label({ expected: "dead", minConfidence: "high", name: "labelled" })],
      claims: [exportClaim({ name: "unlabelled-thing", confidence: "high" })],
    };
    const result = scoreCase(input);
    expect(result.unlabelledClaims).toHaveLength(1);
    expect(result.falsePositives).toHaveLength(0);
    expect(result.confidenceViolations).toHaveLength(0);
    // The one dead label is unmatched (a miss), independent of the unrelated claim.
    expect(result.misses).toHaveLength(1);
  });

  it("treats a dead-labelled subject with no joining claim as a miss, lowering recall", () => {
    const input: CaseInput = {
      case: "c",
      labels: [
        label({ expected: "dead", minConfidence: "high", name: "found" }),
        label({ expected: "dead", minConfidence: "high", name: "missed" }),
      ],
      claims: [exportClaim({ name: "found", confidence: "high" })],
    };
    const result = scoreCase(input);
    expect(result.misses).toHaveLength(1);
    expect(result.misses[0]?.name).toBe("missed");
    expect(result.recall).toBe(0.5);
  });
});

describe("scoreCase — join edge cases", () => {
  it("does not conflate two labels sharing a name in different files", () => {
    const input: CaseInput = {
      case: "c",
      labels: [
        label({ expected: "alive", name: "helper", file: "src/a.ts" }),
        label({ expected: "dead", minConfidence: "high", name: "helper", file: "src/b.ts" }),
      ],
      claims: [exportClaim({ name: "helper", file: "src/b.ts", confidence: "high" })],
    };
    const result = scoreCase(input);
    // The claim joins only to src/b.ts's dead-labelled "helper" — a true
    // positive — and must not also match (or otherwise affect) src/a.ts's
    // alive-labelled "helper" of the same name.
    expect(result.truePositives).toBe(1);
    expect(result.falsePositives).toHaveLength(0);
    expect(result.misses).toHaveLength(0);
  });

  it("joins file-kind subjects on (kind, name, file) where name === file", () => {
    const input: CaseInput = {
      case: "c",
      labels: [
        label({
          kind: "file",
          expected: "dead",
          minConfidence: "high",
          name: "src/orphan.ts",
          file: "src/orphan.ts",
        }),
      ],
      claims: [fileClaim({ file: "src/orphan.ts", confidence: "high" })],
    };
    const result = scoreCase(input);
    expect(result.truePositives).toBe(1);
    expect(result.misses).toHaveLength(0);
  });

  it("does not cross-match a file-kind label against an export-kind claim of the same name/file", () => {
    const input: CaseInput = {
      case: "c",
      labels: [
        label({
          kind: "file",
          expected: "dead",
          minConfidence: "high",
          name: "src/thing.ts",
          file: "src/thing.ts",
        }),
      ],
      // An export subject that happens to share a name/file string with the file label above.
      claims: [exportClaim({ name: "src/thing.ts", file: "src/thing.ts", confidence: "high" })],
    };
    const result = scoreCase(input);
    // kind disambiguates the join key: this export claim does not satisfy the file label.
    expect(result.truePositives).toBe(0);
    expect(result.misses).toHaveLength(1);
    expect(result.unlabelledClaims).toHaveLength(1);
  });
});

describe("scoreCorpus — aggregation", () => {
  it("sums totals across cases rather than averaging per-case rates", () => {
    const caseA: CaseInput = {
      case: "a",
      labels: [label({ expected: "dead", minConfidence: "high", name: "d1" })],
      claims: [exportClaim({ name: "d1", confidence: "high" })],
    };
    const caseB: CaseInput = {
      case: "b",
      labels: [
        label({ expected: "dead", minConfidence: "high", name: "d2" }),
        label({ expected: "alive", name: "a2" }),
      ],
      claims: [exportClaim({ name: "a2", confidence: "high" })], // false positive, case b's own precision is 0
    };
    const corpus = scoreCorpus([caseA, caseB]);
    expect(corpus.truePositives).toBe(1);
    expect(corpus.falsePositives).toHaveLength(1);
    expect(corpus.precision).toBe(0.5); // 1 TP / (1 TP + 1 FP), not an average of 1.0 and 0.0
    expect(corpus.cases).toHaveLength(2);
  });

  it("merges byConfidenceTier counts across cases", () => {
    const caseA: CaseInput = {
      case: "a",
      labels: [label({ expected: "dead", minConfidence: "high", name: "d1" })],
      claims: [exportClaim({ name: "d1", confidence: "high" })],
    };
    const caseB: CaseInput = {
      case: "b",
      labels: [label({ expected: "dead", minConfidence: "medium", name: "d2" })],
      claims: [exportClaim({ name: "d2", confidence: "medium" })],
    };
    const corpus = scoreCorpus([caseA, caseB]);
    expect(corpus.byConfidenceTier.high.truePositives).toBe(1);
    expect(corpus.byConfidenceTier.medium.truePositives).toBe(1);
    expect(corpus.byConfidenceTier.low.truePositives).toBe(0);
  });
});

describe("gate predicates", () => {
  it("gateNoHighConfidenceFalsePositives passes when there are none and fails when there is one", () => {
    const clean = scoreCorpus([{ case: "c", labels: [label({ expected: "alive" })], claims: [] }]);
    expect(gateNoHighConfidenceFalsePositives(clean).pass).toBe(true);

    const dirty = scoreCorpus([
      {
        case: "c",
        labels: [label({ expected: "alive" })],
        claims: [exportClaim({ confidence: "high" })],
      },
    ]);
    const result = gateNoHighConfidenceFalsePositives(dirty);
    expect(result.pass).toBe(false);
    expect(result.reason).toMatch(/high-confidence false positive/);
  });

  it("gateNoHighConfidenceFalsePositives does not fail on a low/medium-confidence false positive alone", () => {
    const mediumOnly = scoreCorpus([
      {
        case: "c",
        labels: [label({ expected: "alive" })],
        claims: [exportClaim({ confidence: "medium" })],
      },
    ]);
    expect(gateNoHighConfidenceFalsePositives(mediumOnly).pass).toBe(true);
  });

  it("gateNoConfidenceViolations passes when there are none and fails when there is one", () => {
    const clean = scoreCorpus([
      {
        case: "c",
        labels: [label({ expected: "dead", minConfidence: "medium", name: "d" })],
        claims: [exportClaim({ name: "d", confidence: "medium" })],
      },
    ]);
    expect(gateNoConfidenceViolations(clean).pass).toBe(true);

    const dirty = scoreCorpus([
      {
        case: "c",
        labels: [label({ expected: "dead", minConfidence: "medium", name: "d" })],
        claims: [exportClaim({ name: "d", confidence: "high" })],
      },
    ]);
    const result = gateNoConfidenceViolations(dirty);
    expect(result.pass).toBe(false);
    expect(result.reason).toMatch(/confidence violation/);
  });

  it("gatePrecisionNonDecreasing passes at or above the baseline and fails below it", () => {
    const metrics = scoreCorpus([
      {
        case: "c",
        labels: [label({ expected: "alive" })],
        claims: [exportClaim({ confidence: "low" })],
      },
    ]); // precision 0
    expect(gatePrecisionNonDecreasing(metrics, 0).pass).toBe(true);
    expect(gatePrecisionNonDecreasing(metrics, 0.5).pass).toBe(false);
  });
});
