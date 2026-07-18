/**
 * Parse → ModuleRecord unit tests (T2.1): import/export mechanisms, dynamic
 * import & require (literal vs computed ⇒ hazard), type-only forms, the
 * `import =`/`export =` hazards, and parse-error degradation.
 */
import { describe, expect, it } from "vitest";
import type { ModuleRecord } from "./module-record.js";
import { parseSource } from "./parse.js";

const rec = (src: string, file = "case.ts"): ModuleRecord => parseSource(file, src);

describe("imports", () => {
  it("distinguishes named / default / namespace specifiers", () => {
    const r = rec(`import D, { n } from './a.js';\nimport * as ns from './b.js';`);
    expect(r.imports[0]?.specifiers).toEqual([
      expect.objectContaining({ kind: "default", importedName: "default", localName: "D" }),
      expect.objectContaining({ kind: "named", importedName: "n", localName: "n" }),
    ]);
    expect(r.imports[1]?.specifiers[0]).toEqual(
      expect.objectContaining({ kind: "namespace", importedName: "*", localName: "ns" }),
    );
  });

  it("`import { x as y }` records imported and local names separately", () => {
    const r = rec(`import { x as y } from './a.js';`);
    expect(r.imports[0]?.specifiers[0]).toEqual(
      expect.objectContaining({ importedName: "x", localName: "y", typeOnly: false }),
    );
  });

  it("statement-level `import type` sets both statement and specifier typeOnly", () => {
    const r = rec(`import type { A } from './a.js';`);
    expect(r.imports[0]?.typeOnly).toBe(true);
    expect(r.imports[0]?.specifiers[0]?.typeOnly).toBe(true);
  });

  it("inline `import { type A }` sets specifier typeOnly but NOT statement typeOnly", () => {
    const r = rec(`import { type A, b } from './a.js';`);
    expect(r.imports[0]?.typeOnly).toBe(false);
    expect(r.imports[0]?.specifiers[0]?.typeOnly).toBe(true);
    expect(r.imports[0]?.specifiers[1]?.typeOnly).toBe(false);
  });

  it("side-effect import has zero specifiers and sideEffect:true", () => {
    const r = rec(`import './polyfill.js';`);
    expect(r.imports[0]).toEqual(
      expect.objectContaining({ source: "./polyfill.js", specifiers: [], sideEffect: true }),
    );
  });
});

describe("exports", () => {
  it("named default export carries the local binding name", () => {
    const r = rec(`export default function baz() {}`);
    expect(r.exports[0]).toEqual(
      expect.objectContaining({
        kind: "local",
        exportedName: "default",
        localName: "baz",
        isDefault: true,
      }),
    );
  });

  it("anonymous default export has a null local name", () => {
    const r = rec(`export default class {}`);
    expect(r.exports[0]).toEqual(
      expect.objectContaining({
        kind: "local",
        exportedName: "default",
        localName: null,
        isDefault: true,
      }),
    );
  });

  it("`export { x as y } from` is a named re-export with source", () => {
    const r = rec(`export { x as y } from './a.js';`);
    expect(r.exports[0]).toEqual(
      expect.objectContaining({
        kind: "named-reexport",
        exportedName: "y",
        importedName: "x",
        source: "./a.js",
        typeOnly: false,
      }),
    );
  });

  it("`export * as ns from` records importedName '*'", () => {
    const r = rec(`export * as ns from './a.js';`);
    expect(r.exports[0]).toEqual(
      expect.objectContaining({ kind: "named-reexport", exportedName: "ns", importedName: "*" }),
    );
  });

  it("`export type { A } from` is a type-only re-export", () => {
    const r = rec(`export type { A } from './a.js';`);
    expect(r.exports[0]).toEqual(
      expect.objectContaining({ kind: "named-reexport", typeOnly: true }),
    );
  });

  it("`export type T = ...` is a type-only local export", () => {
    const r = rec(`export type T = number;`);
    expect(r.exports[0]).toEqual(
      expect.objectContaining({ kind: "local", exportedName: "T", typeOnly: true }),
    );
  });
});

describe("dynamic import & require", () => {
  it("string-literal `import('./x')` resolves; no hazard", () => {
    const r = rec(`const p = import('./x.js');`);
    expect(r.dynamicImports[0]).toEqual(
      expect.objectContaining({ source: "./x.js", computed: false }),
    );
    expect(r.hazards).toEqual([]);
  });

  it("computed `import(expr)` yields source:null + a computed-dynamic-import hazard", () => {
    const r = rec(`const name = 'a';\nconst p = import('./mods/' + name);`);
    expect(r.dynamicImports[0]).toEqual(expect.objectContaining({ source: null, computed: true }));
    expect(r.hazards.map((h) => h.kind)).toContain("computed-dynamic-import");
  });

  it("string-literal `require('./x')` resolves; computed require is a hazard", () => {
    const r = rec(
      `declare const require: (id: string) => unknown;\nconst a = require('./lit.js');\nconst k = 'x';\nconst b = require('./' + k);`,
    );
    expect(r.requires[0]).toEqual(expect.objectContaining({ source: "./lit.js", computed: false }));
    expect(r.requires[1]).toEqual(expect.objectContaining({ source: null, computed: true }));
    expect(r.hazards.map((h) => h.kind)).toContain("computed-require");
  });

  it("a `require` shadowed by a local binding is not treated as a module require", () => {
    const r = rec(`function f() { const require = (s: string) => s; return require('./x.js'); }`);
    expect(r.requires).toEqual([]);
  });
});

describe("TSImportType (inline `import('…')` in a type position)", () => {
  it("records a type-only module edge with qualifier (the FP-spine fix)", () => {
    const r = rec(`let x: import('./svc.js').Service;`);
    expect(r.typeImports).toEqual([
      expect.objectContaining({ source: "./svc.js", qualifier: "Service", typeQuery: false }),
    ]);
    // Not a runtime import/dynamic import; and no false "no edge".
    expect(r.imports).toEqual([]);
    expect(r.dynamicImports).toEqual([]);
    expect(r.hazards).toEqual([]);
  });

  it("captures the module edge when nested in a conditional type", () => {
    const r = rec(`type C = X extends import('./svc.js').Service ? 1 : 0;`);
    expect(r.typeImports).toEqual([
      expect.objectContaining({ source: "./svc.js", qualifier: "Service", typeQuery: false }),
    ]);
  });

  it("`typeof import('./x')` is a value-flavoured type query (typeQuery:true, no qualifier)", () => {
    const r = rec(`let z: typeof import('./x.js');`);
    expect(r.typeImports).toEqual([
      expect.objectContaining({ source: "./x.js", qualifier: null, typeQuery: true }),
    ]);
  });

  it("a bare `import('./x')` type records a null qualifier", () => {
    const r = rec(`let y: import('./svc.js');`);
    expect(r.typeImports[0]).toEqual(
      expect.objectContaining({ source: "./svc.js", qualifier: null, typeQuery: false }),
    );
  });

  it("uses the leftmost identifier for a nested qualifier `A.B`", () => {
    const r = rec(`let x: import('./svc.js').A.B;`);
    expect(r.typeImports[0]?.qualifier).toBe("A");
  });

  it("still records type-argument references to local imports", () => {
    const r = rec(`import type { Local } from './l.js';\nlet x: import('./svc.js').Box<Local>;`);
    expect(r.typeImports[0]).toEqual(expect.objectContaining({ source: "./svc.js" }));
    expect(r.references).toEqual([
      expect.objectContaining({ localName: "Local", position: "type" }),
    ]);
  });
});

describe("hazards for CJS/TS interop", () => {
  it("`import x = require(...)` emits an import-equals hazard", () => {
    const r = rec(`import fs = require('fs');`);
    expect(r.hazards.map((h) => h.kind)).toContain("import-equals");
  });

  it("`import x = require('./m')` ALSO records the module reference (keep-alive edge; FP fix)", () => {
    // Previously the whole TSImportEqualsDeclaration subtree was dropped, so a
    // file imported only this way got no incoming edge → confident false "unused".
    const r = rec(`import util = require('./util.js');`);
    expect(r.requires).toEqual([expect.objectContaining({ source: "./util.js", computed: false })]);
    expect(r.hazards.map((h) => h.kind)).toContain("import-equals");
  });

  it("`export = x` emits an export-assignment hazard", () => {
    const r = rec(`const api = {};\nexport = api;`);
    expect(r.hazards.map((h) => h.kind)).toContain("export-assignment");
  });

  it("`export = imported` records a value reference to the imported binding", () => {
    // The re-exported binding is a real use-site: the value reference keeps the
    // imported name live (its import already carries the source edge).
    const r = rec(`import { thing } from './x.js';\nexport = thing;`);
    expect(r.references).toContainEqual(
      expect.objectContaining({ localName: "thing", position: "value" }),
    );
  });
});

describe("parse-error degradation", () => {
  it("records diagnostics and emits a parse-error hazard (degrade toward alive)", () => {
    const r = rec(`function ( { const`);
    expect(r.parseErrors.length).toBeGreaterThan(0);
    expect(r.hazards.map((h) => h.kind)).toContain("parse-error");
  });
});

describe("provenance", () => {
  it("every emitted record carries a span with 1-based lines", () => {
    const r = rec(`import { A } from './a.js';\nexport const B = new A();`);
    const spans = [
      ...r.imports.map((i) => i.span),
      ...r.imports.flatMap((i) => i.specifiers.map((s) => s.span)),
      ...r.exports.map((e) => e.span),
      ...r.references.map((x) => x.span),
    ];
    expect(spans.length).toBeGreaterThan(0);
    for (const s of spans) {
      expect(s.startLine).toBeGreaterThanOrEqual(1);
      expect(s.endLine).toBeGreaterThanOrEqual(s.startLine);
      expect(s.end).toBeGreaterThanOrEqual(s.start);
    }
  });
});
