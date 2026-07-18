/**
 * Corpus expectation tests (T2.1 acceptance): hand-written expected
 * ModuleRecords for real fixture files read from `fixtures/ts/**`. Fixtures
 * are read-only ground truth — never modified here.
 *
 * These assert the *full* record (minus the absolute `filePath`) for a spread
 * of mechanisms: dead local exports, side-effect import, named re-export
 * chain, `import type` + `export type` re-export, `export *`, and the
 * value-syntax-but-type-use FP trap.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { ModuleRecord } from "./module-record.js";
import { parseSource } from "./parse.js";

const repoFile = (rel: string) => fileURLToPath(new URL(`../../../../../${rel}`, import.meta.url));

function record(rel: string): Omit<ModuleRecord, "filePath"> {
  const abs = repoFile(rel);
  const { filePath: _filePath, ...rest } = parseSource(abs, readFileSync(abs, "utf8"));
  return rest;
}

const empty = {
  imports: [],
  dynamicImports: [],
  requires: [],
  typeImports: [],
  exports: [],
  references: [],
  suppressions: [],
  hazards: [],
  parseErrors: [],
} as const;

describe("corpus module records", () => {
  it("basic-dead-export/math.ts — two local value exports, one dead", () => {
    expect(record("fixtures/ts/basic-dead-export/src/math.ts")).toEqual({
      ...empty,
      lang: "ts",
      exports: [
        {
          kind: "local",
          exportedName: "add",
          localName: "add",
          isDefault: false,
          typeOnly: false,
          span: { start: 7, end: 69, startLine: 1, endLine: 3 },
        },
        {
          kind: "local",
          exportedName: "subtract",
          localName: "subtract",
          isDefault: false,
          typeOnly: false,
          span: { start: 166, end: 233, startLine: 6, endLine: 8 },
        },
      ],
    });
  });

  it("side-effect-import/index.ts — side-effect import binds nothing", () => {
    expect(record("fixtures/ts/side-effect-import/src/index.ts")).toEqual({
      ...empty,
      lang: "ts",
      imports: [
        {
          source: "./polyfill.js",
          sourceSpan: { start: 74, end: 89, startLine: 2, endLine: 2 },
          specifiers: [],
          sideEffect: true,
          typeOnly: false,
          span: { start: 67, end: 90, startLine: 2, endLine: 2 },
        },
      ],
    });
  });

  it("re-export-chain/barrel.ts — two named re-exports with source specifiers", () => {
    expect(record("fixtures/ts/re-export-chain/src/barrel.ts")).toEqual({
      ...empty,
      lang: "ts",
      exports: [
        {
          kind: "named-reexport",
          exportedName: "usedThing",
          importedName: "usedThing",
          source: "./lib/usedThing.js",
          sourceSpan: { start: 104, end: 124, startLine: 2, endLine: 2 },
          typeOnly: false,
          span: { start: 87, end: 96, startLine: 2, endLine: 2 },
        },
        {
          kind: "named-reexport",
          exportedName: "unusedThing",
          importedName: "unusedThing",
          source: "./lib/unusedThing.js",
          sourceSpan: { start: 154, end: 176, startLine: 3, endLine: 3 },
          typeOnly: false,
          span: { start: 135, end: 146, startLine: 3, endLine: 3 },
        },
      ],
    });
  });

  it("import-type-reexport/types.ts — import type + export type re-export", () => {
    expect(record("fixtures/ts/import-type-reexport/src/types.ts")).toEqual({
      ...empty,
      lang: "ts",
      imports: [
        {
          source: "./model.js",
          sourceSpan: { start: 26, end: 38, startLine: 1, endLine: 1 },
          specifiers: [
            {
              kind: "named",
              importedName: "User",
              localName: "User",
              typeOnly: true,
              span: { start: 14, end: 18, startLine: 1, endLine: 1 },
            },
          ],
          sideEffect: false,
          typeOnly: true,
          span: { start: 0, end: 39, startLine: 1, endLine: 1 },
        },
      ],
      exports: [
        {
          kind: "named-reexport",
          exportedName: "User",
          importedName: "User",
          source: "./model.js",
          sourceSpan: { start: 26, end: 38, startLine: 1, endLine: 1 },
          typeOnly: true,
          span: { start: 55, end: 59, startLine: 3, endLine: 3 },
        },
      ],
    });
  });

  it("export-star-chain/api.ts — star re-export carries source only", () => {
    expect(record("fixtures/ts/export-star-chain/src/api.ts")).toEqual({
      ...empty,
      lang: "ts",
      exports: [
        {
          kind: "star-reexport",
          source: "./mid.js",
          sourceSpan: { start: 51, end: 61, startLine: 2, endLine: 2 },
          typeOnly: false,
          span: { start: 37, end: 62, startLine: 2, endLine: 2 },
        },
      ],
    });
  });

  it("type-position-inverse/index.ts — value-syntax import used only as a type is a TYPE reference (the FP trap)", () => {
    const rec = record("fixtures/ts/type-position-inverse/src/index.ts");
    // Point is imported with value syntax (typeOnly:false) but only ever used
    // in a type annotation — the reference MUST still be captured, in type
    // position, or the import would be wrongly flagged unused.
    expect(rec.imports[0]?.specifiers[0]).toMatchObject({
      localName: "Point",
      typeOnly: false,
    });
    expect(rec.references).toEqual([
      {
        localName: "Point",
        position: "type",
        span: { start: 269, end: 274, startLine: 6, endLine: 6 },
      },
    ]);
    expect(rec.hazards).toEqual([]);
  });
});
