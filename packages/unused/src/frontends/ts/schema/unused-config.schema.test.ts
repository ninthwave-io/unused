/**
 * Validates `unused-config.schema.json` against ajv (draft 2020-12), mirroring
 * `core/claims/schema.test.ts`'s pattern: (1) the schema itself must compile
 * under strict mode; (2) the PRD §6 worked example must validate verbatim;
 * (3) a representative set of invalid shapes (mirroring `config.test.ts`'s
 * hand-rolled `validateConfig` cases) must be rejected, so the shipped schema
 * and the runtime validator never drift apart silently.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
// See core/claims/schema.test.ts for why the named import is used here
// instead of ajv's default export (a CJS/ESM interop quirk under this repo's
// tsconfig).
import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";

function readJson(relativePath: string): unknown {
  const path = fileURLToPath(new URL(relativePath, import.meta.url));
  return JSON.parse(readFileSync(path, "utf8"));
}

const schema = readJson("./unused-config.schema.json");

function compileSchema() {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  return ajv.compile(schema as object);
}

const PRD_WORKED_EXAMPLE = {
  entry: ["src/index.ts", "src/pages/**/*.tsx"],
  project: ["src/**/*.{ts,tsx}"],
  suppressions: [
    { files: ["**/*.generated.ts"], kinds: ["file", "export"], reason: "generated source" },
  ],
  ignoreDependencies: ["@types/node"],
  workspaces: {
    "packages/api": { entry: ["src/server.ts"] },
  },
  gate: { threshold: "medium" },
};

describe("unused-config.schema.json", () => {
  it("is itself a valid draft 2020-12 schema (compiles under strict mode)", () => {
    expect(() => compileSchema()).not.toThrow();
  });

  it("validates the PRD §6 worked example verbatim", () => {
    const validate = compileSchema();
    const valid = validate(PRD_WORKED_EXAMPLE);
    expect(validate.errors).toBeNull();
    expect(valid).toBe(true);
  });

  it("validates an empty config (every field optional)", () => {
    const validate = compileSchema();
    expect(validate({})).toBe(true);
  });

  it("validates a config with presets", () => {
    const validate = compileSchema();
    expect(validate({ presets: ["vite", "next"] })).toBe(true);
    expect(validate({ presets: [] })).toBe(true);
  });

  it("rejects an unknown top-level field (additionalProperties: false)", () => {
    const validate = compileSchema();
    expect(validate({ ...PRD_WORKED_EXAMPLE, extra: "nope" })).toBe(false);
  });

  it("rejects entry that is not an array of strings", () => {
    const validate = compileSchema();
    expect(validate({ entry: "src/index.ts" })).toBe(false);
    expect(validate({ entry: [42] })).toBe(false);
    expect(validate({ entry: [""] })).toBe(false);
  });

  it("rejects an unknown workspace-override field", () => {
    const validate = compileSchema();
    expect(validate({ workspaces: { "packages/api": { bogus: [] } } })).toBe(false);
  });

  it("rejects an invalid gate.threshold value", () => {
    const validate = compileSchema();
    expect(validate({ gate: { threshold: "critical" } })).toBe(false);
  });

  it("rejects gate without threshold (required)", () => {
    const validate = compileSchema();
    expect(validate({ gate: {} })).toBe(false);
  });

  it("rejects an unrecognised preset name", () => {
    const validate = compileSchema();
    expect(validate({ presets: ["webpack"] })).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // ciSecondsPerTestFile (T5.3, docs/design/report-and-badge.md §3)
  // ---------------------------------------------------------------------------

  it("validates a positive ciSecondsPerTestFile override", () => {
    const validate = compileSchema();
    expect(validate({ ciSecondsPerTestFile: 12 })).toBe(true);
    expect(validate({ ciSecondsPerTestFile: 2.5 })).toBe(true);
  });

  it("rejects a zero or negative ciSecondsPerTestFile", () => {
    const validate = compileSchema();
    expect(validate({ ciSecondsPerTestFile: 0 })).toBe(false);
    expect(validate({ ciSecondsPerTestFile: -1 })).toBe(false);
  });

  it("rejects a non-number ciSecondsPerTestFile", () => {
    const validate = compileSchema();
    expect(validate({ ciSecondsPerTestFile: "5" })).toBe(false);
  });
});
