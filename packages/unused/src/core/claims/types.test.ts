import { describe, expect, it } from "vitest";
import type { SubjectKind, Verdict } from "./types.js";
import { isValidKindVerdict, KIND_VERDICTS, SCHEMA_VERSION } from "./types.js";

describe("SCHEMA_VERSION", () => {
  it("matches the PRD worked example (ADR 0006 semver policy)", () => {
    expect(SCHEMA_VERSION).toBe("1.0.0");
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
