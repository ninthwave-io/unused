import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { Ajv2020 } from "ajv/dist/2020.js";
import type { FormatsPlugin } from "ajv-formats";
import { describe, expect, it } from "vitest";
import type { DeletionPlan } from "./types.js";

const addFormats = createRequire(import.meta.url)("ajv-formats") as FormatsPlugin;
const schema = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("./schema/deletion-plan.schema.json", import.meta.url)),
    "utf8",
  ),
) as object;

function validator() {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  return ajv.compile(schema);
}

const PLAN: DeletionPlan = {
  schemaVersion: "1.3.0",
  selected: { kind: "export", file: "src/origin.ts", name: "thing", line: 2 },
  supported: true,
  reExportEdits: [
    {
      kind: "remove-re-export",
      file: "src/api.ts",
      line: 7,
      exportedName: "thing",
      targetFile: "src/origin.ts",
      targetName: "thing",
      site: {
        file: "src/api.ts",
        span: { start: 70, end: 75, startLine: 7, endLine: 7 },
      },
    },
  ],
  stages: [{ stage: 1, newlyDead: [{ kind: "file", file: "src/orphan.ts" }] }],
};

describe("deletion-plan.schema.json", () => {
  it("compiles and validates the exported 1.2 plan shape", () => {
    const validate = validator();
    expect(validate(PLAN), JSON.stringify(validate.errors)).toBe(true);
  });

  it("rejects claim fields so plans cannot masquerade as claim verdicts", () => {
    const validate = validator();
    expect(validate({ ...PLAN, confidence: "high" })).toBe(false);
  });

  it("rejects subjects and support states that the TypeScript contract excludes", () => {
    const validate = validator();
    expect(
      validate({
        ...PLAN,
        selected: { kind: "export", file: "src/origin.ts" },
      }),
    ).toBe(false);
    expect(validate({ ...PLAN, supported: false })).toBe(false);
    expect(validate({ ...PLAN, unsupportedReason: "not modeled" })).toBe(false);
  });

  it("allows dependencies only as unsupported selections with empty consequences", () => {
    const validate = validator();
    const dependency = { kind: "dependency", file: "package.json", name: "some-package" };
    expect(
      validate({
        schemaVersion: "1.3.0",
        selected: dependency,
        supported: false,
        unsupportedReason: "dependency deletion has no graph cascade model",
        reExportEdits: [],
        stages: [],
      }),
      JSON.stringify(validate.errors),
    ).toBe(true);
    expect(validate({ ...PLAN, selected: dependency })).toBe(false);
    expect(
      validate({
        ...PLAN,
        stages: [{ stage: 1, newlyDead: [dependency] }],
      }),
    ).toBe(false);
  });

  it("requires unsupported plans to have empty edits and stages", () => {
    const validate = validator();
    const unsupported = {
      ...PLAN,
      supported: false,
      unsupportedReason: "not modeled",
    };
    expect(validate({ ...unsupported, stages: [] })).toBe(false);
    expect(validate({ ...unsupported, reExportEdits: [] })).toBe(false);
  });
});
