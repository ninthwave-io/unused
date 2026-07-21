import { describe, expect, it } from "vitest";
import type {
  DeletionPlan,
  DeletionPlanConsequenceSubject,
  DeletionPlanStage,
  DeletionPlanSubject,
  SubjectKind,
  Verdict,
} from "./types.js";
import { isValidKindVerdict, KIND_VERDICTS, SCHEMA_VERSION } from "./types.js";

describe("SCHEMA_VERSION", () => {
  it("is 1.4.0 — additive boundary partition completeness is a MINOR bump", () => {
    expect(SCHEMA_VERSION).toBe("1.4.0");
  });
});

describe("DeletionPlan type contract", () => {
  it("keeps subject and supported-state variants discriminated", () => {
    const subject: DeletionPlanSubject = {
      kind: "export",
      file: "src/origin.ts",
      name: "thing",
    };
    const plan: DeletionPlan = {
      schemaVersion: "1.4.0",
      selected: subject,
      supported: false,
      unsupportedReason: "not modeled",
      reExportEdits: [],
      stages: [],
    };
    const consequence: DeletionPlanConsequenceSubject = {
      kind: "file",
      file: "src/orphan.ts",
    };
    expect(plan.supported).toBe(false);
    expect(consequence.kind).toBe("file");

    // @ts-expect-error Export subjects require a name, matching the JSON Schema.
    const missingExportName: DeletionPlanSubject = { kind: "export", file: "src/origin.ts" };
    // @ts-expect-error Unsupported plans require a non-empty reason structurally.
    const missingUnsupportedReason: DeletionPlan = {
      schemaVersion: "1.4.0",
      selected: subject,
      supported: false,
      reExportEdits: [],
      stages: [],
    };
    const dependencyConsequence: DeletionPlanConsequenceSubject = {
      // @ts-expect-error Dependencies are selections, never newly-dead graph consequences.
      kind: "dependency",
      file: "package.json",
      name: "some-package",
    };
    const stageWithDependency: DeletionPlanStage = {
      stage: 1,
      newlyDead: [
        {
          // @ts-expect-error Stage consequences are restricted to graph export/file subjects.
          kind: "dependency",
          file: "package.json",
          name: "some-package",
        },
      ],
    };
    // @ts-expect-error Dependency deletion cannot be represented as a supported graph plan.
    const supportedDependency: DeletionPlan = {
      schemaVersion: "1.4.0",
      selected: { kind: "dependency", file: "package.json", name: "some-package" },
      supported: true,
      reExportEdits: [],
      stages: [],
    };
    // @ts-expect-error Unsupported plans cannot claim required source edits.
    const unsupportedWithEdit: DeletionPlan = {
      schemaVersion: "1.4.0",
      selected: subject,
      supported: false,
      unsupportedReason: "not modeled",
      reExportEdits: [
        {
          kind: "remove-re-export" as const,
          file: "src/api.ts",
          line: 1,
          targetFile: "src/origin.ts",
          site: {
            file: "src/api.ts",
            span: { start: 0, end: 1, startLine: 1, endLine: 1 },
          },
        },
      ],
      stages: [],
    };
    // @ts-expect-error Unsupported plans cannot claim graph-derived stages.
    const unsupportedWithStage: DeletionPlan = {
      schemaVersion: "1.4.0",
      selected: subject,
      supported: false,
      unsupportedReason: "not modeled",
      reExportEdits: [],
      stages: [
        {
          stage: 1,
          newlyDead: [{ kind: "file" as const, file: "src/orphan.ts" }],
        },
      ],
    };
    expect(missingExportName.kind).toBe("export");
    expect(missingUnsupportedReason.supported).toBe(false);
    expect(dependencyConsequence.kind).toBe("dependency");
    expect(stageWithDependency.newlyDead).toHaveLength(1);
    expect(supportedDependency.supported).toBe(true);
    expect(unsupportedWithEdit.reExportEdits).toHaveLength(1);
    expect(unsupportedWithStage.stages).toHaveLength(1);
  });
});

describe("kind -> verdict binding (PRD §4)", () => {
  it.each([
    ["export", "unused"],
    ["export", "test-only"],
    ["file", "unused"],
    ["file", "test-only"],
    ["dependency", "unused"],
    ["dependency", "test-only"],
    ["endpoint", "unconsumed-endpoint"],
    ["test", "test-only"],
  ] satisfies Array<[SubjectKind, Verdict]>)("accepts %s / %s", (kind, verdict) => {
    expect(isValidKindVerdict(kind, verdict)).toBe(true);
  });

  it.each([
    ["export", "unconsumed-endpoint"],
    ["file", "unconsumed-endpoint"],
    ["dependency", "unconsumed-endpoint"],
    ["endpoint", "unused"],
    ["endpoint", "test-only"],
    ["test", "unused"],
    ["test", "unconsumed-endpoint"],
    ["export", "no-runtime-traffic"],
    ["endpoint", "no-user-engagement"],
  ] satisfies Array<[SubjectKind, Verdict]>)("rejects %s / %s", (kind, verdict) => {
    expect(isValidKindVerdict(kind, verdict)).toBe(false);
  });

  it("KIND_VERDICTS covers every subject kind", () => {
    const kinds: SubjectKind[] = ["export", "file", "dependency", "endpoint", "test"];
    for (const kind of kinds) {
      expect(KIND_VERDICTS[kind].length).toBeGreaterThan(0);
    }
  });

  it("never binds the reserved tier-4/5 verdicts to any kind in v1", () => {
    const kinds: SubjectKind[] = ["export", "file", "dependency", "endpoint", "test"];
    for (const kind of kinds) {
      expect(isValidKindVerdict(kind, "no-runtime-traffic")).toBe(false);
      expect(isValidKindVerdict(kind, "no-user-engagement")).toBe(false);
    }
  });
});
