// This file is imported only via `import util = require('./util.js')` in
// src/index.ts — a TSImportEqualsDeclaration, TS's CJS-interop import form,
// not a standard ES ImportDeclaration. An analyzer whose IR walk only
// recognises ImportDeclaration/ExportDeclaration nodes and drops
// TSImportEqualsDeclaration would see no importer for this file at all and
// flag it, and every export below, dead. That is the false-positive trap
// this case exists to catch: import-equals is a first-class static,
// literally-resolvable edge (architecture §3), exactly like a namespace
// import under CJS interop.
export function greet(name: string): string {
  return `hello, ${name}`;
}

// Reached only through the same import-equals binding as greet() above, but
// never actually accessed off it (index.ts calls util.greet, never
// util.unused) — genuinely dead. The import-equals target is a literal
// string, so no dynamic-reference hazard is nearby; claimable at high
// confidence.
export function unused(): string {
  return "never called";
}
