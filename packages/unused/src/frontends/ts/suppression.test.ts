/**
 * Suppression capture (T2.1 acceptance) — the spike's decorator trap
 * (criterion 3, caveat 6) and the mandatory-reason rule (PRD §6).
 */
import { describe, expect, it } from "vitest";
import { parseSource } from "./parse.js";

function suppressions(src: string) {
  return parseSource("case.ts", src).suppressions.map((s) => ({
    reason: s.reason,
    valid: s.valid,
    reasonMissing: s.reasonMissing,
    targetName: s.targetName,
  }));
}

describe("suppression capture", () => {
  it("captures a directive directly above a declaration", () => {
    expect(suppressions(`/* unused:ignore legacy shim */\nexport const alpha = 1;`)).toEqual([
      { reason: "legacy shim", valid: true, reasonMissing: false, targetName: "alpha" },
    ]);
  });

  it("DECORATOR TRAP: captures across a decorator sitting before the `export` keyword", () => {
    // oxc places @Deco's span before ExportNamedDeclaration.start; anchoring on
    // node.start naively would see @Deco in the gap and miss this.
    expect(suppressions(`/* unused:ignore decorated case */\n@Deco\nexport class Beta {}`)).toEqual(
      [{ reason: "decorated case", valid: true, reasonMissing: false, targetName: "Beta" }],
    );
  });

  it("MISSING REASON: a reasonless directive is captured as invalid, not dropped", () => {
    expect(suppressions(`/* unused:ignore */\nexport const x = 1;`)).toEqual([
      { reason: null, valid: false, reasonMissing: true, targetName: "x" },
    ]);
  });

  it("an intervening non-directive comment breaks adjacency", () => {
    expect(
      suppressions(
        `/* unused:ignore should not apply */\n// an intervening note\nexport const gamma = 3;`,
      ),
    ).toEqual([]);
  });

  it("a non-directive comment is not a suppression", () => {
    expect(suppressions(`/* just a normal comment */\nexport const y = 1;`)).toEqual([]);
  });

  it("captures a directive above a class member", () => {
    expect(
      suppressions(`export class Svc {\n  /* unused:ignore kept for API */\n  legacy() {}\n}`),
    ).toEqual([
      { reason: "kept for API", valid: true, reasonMissing: false, targetName: "legacy" },
    ]);
  });

  it("line-comment form is also recognised", () => {
    expect(suppressions(`// unused:ignore cli flag\nexport function run() {}`)).toEqual([
      { reason: "cli flag", valid: true, reasonMissing: false, targetName: "run" },
    ]);
  });
});
