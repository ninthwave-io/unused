// Criterion 1 — value-position vs type-position reference classification.
//
// Proves oxc-parser output (ESM `module` metadata + AST) lets us classify each
// reference SITE as type-position or value-position, and each imported symbol as
// type-only / value / both. Covers: `import type {T}`, inline `import {type T, fn}`,
// type annotations, `extends`/`implements`, `typeof x` (references the VALUE), and
// `export type {T}`.
//
// NB: oxc's JS/NAPI surface exposes NO scope/symbol table (ADR 0005 / research §1).
// We therefore do NAME-based joining here. Real M2 extractor must own scope +
// shadowing itself — see caveats in the spike report.

import { parseSync } from 'oxc-parser';
import assert from 'node:assert';

// ---- AST reference classifier -------------------------------------------------
// Walk the program tracking an `inType` context flag. Collect every Identifier
// reference site with the position it occurs in. The flips below are the entire
// rule set the extractor needs for type/value discrimination.
function collectRefs(program) {
  const refs = []; // { name, start, inType }

  function childInType(node, key, inType) {
    // Fields that OPEN a type context:
    if (['typeAnnotation', 'returnType', 'typeParameters', 'typeArguments', 'superTypeArguments'].includes(key)) return true;
    if (node.type === 'TSInterfaceDeclaration' && key === 'extends') return true;            // interface extends -> TYPE
    if ((node.type === 'ClassDeclaration' || node.type === 'ClassExpression') && key === 'implements') return true; // implements -> TYPE
    // Fields that (re)open a VALUE context even inside a type:
    if ((node.type === 'ClassDeclaration' || node.type === 'ClassExpression') && key === 'superClass') return false; // extends <value>
    if (node.type === 'TSTypeQuery' && key === 'exprName') return false;                     // typeof <VALUE>
    return inType; // otherwise inherit
  }

  // Keys we must not treat as references (bindings / member & property names).
  function skip(node, key) {
    if (node.type === 'ImportDeclaration') return true;                       // handled via module metadata
    if (node.type === 'ExportNamedDeclaration' && key === 'specifiers') return true;
    if (node.type === 'ExportAllDeclaration') return true;
    if (node.type === 'MemberExpression' && key === 'property' && !node.computed) return true;
    if (['Property', 'PropertyDefinition', 'MethodDefinition', 'TSPropertySignature', 'TSMethodSignature'].includes(node.type)
        && key === 'key' && !node.computed) return true;
    return false;
  }

  function walk(node, inType) {
    if (!node || typeof node !== 'object' || !node.type) return;
    // Record identifier references, then STILL descend: an Identifier can carry a
    // `typeAnnotation` (e.g. `const w: Widget`) or `decorators` that hold references.
    if (node.type === 'Identifier') refs.push({ name: node.name, start: node.start, inType });
    for (const key of Object.keys(node)) {
      if (key === 'type' || key === 'start' || key === 'end' || skip(node, key)) continue;
      const val = node[key];
      const ctx = childInType(node, key, inType);
      if (Array.isArray(val)) { for (const c of val) walk(c, ctx); }
      else if (val && typeof val === 'object') walk(val, ctx);
    }
  }
  walk(program, false);
  return refs;
}

// ---- Analyse one file: join imports (module metadata) with reference sites (AST)
function analyse(filename, src) {
  const r = parseSync(filename, src, { lang: 'ts' });
  assert.equal(r.errors.length, 0, `parse errors in ${filename}: ${JSON.stringify(r.errors)}`);

  // imported locals + whether the import itself was type-only
  const imported = new Map(); // localName -> { module, importIsType }
  for (const imp of r.module.staticImports)
    for (const e of imp.entries)
      imported.set(e.localName.value, { module: imp.moduleRequest.value, importIsType: e.isType });

  // `export type { X }` re-exports (module metadata carries isType)
  const exportTypeNames = new Set();
  for (const exp of r.module.staticExports)
    for (const e of exp.entries)
      if (e.isType && e.exportName?.name) exportTypeNames.add(e.exportName.name);

  const refs = collectRefs(r.program).filter((ref) => imported.has(ref.name));

  const perSymbol = new Map();
  for (const [name, meta] of imported) {
    const sites = refs.filter((ref) => ref.name === name);
    const hasValue = sites.some((s) => !s.inType);
    const hasType = sites.some((s) => s.inType) || exportTypeNames.has(name);
    let verdict = 'unreferenced';
    if (hasValue && hasType) verdict = 'BOTH';
    else if (hasValue) verdict = 'VALUE';
    else if (hasType) verdict = 'TYPE-ONLY';
    perSymbol.set(name, { ...meta, sites, exportedAsType: exportTypeNames.has(name), verdict });
  }
  return perSymbol;
}

function report(title, result) {
  console.log(`\n## ${title}`);
  for (const [name, s] of result) {
    const sites = s.sites.map((x) => `${x.inType ? 'type' : 'value'}@${x.start}`).join(', ') || '(none)';
    console.log(`  ${name.padEnd(10)} importType=${String(s.importIsType).padEnd(5)} exportType=${String(s.exportedAsType).padEnd(5)} -> ${s.verdict.padEnd(12)} sites: [${sites}]`);
  }
}

// ---- (a) type-position only ---------------------------------------------------
const A = analyse('a.ts', `
import type { Widget } from './widget.js';
const w: Widget = null as any;
export type { Widget };
`);
report('(a) import type + type annotation only', A);
assert.equal(A.get('Widget').verdict, 'TYPE-ONLY');
assert.equal(A.get('Widget').importIsType, true);

// ---- (b) value only -----------------------------------------------------------
const B = analyse('b.ts', `
import { Widget } from './widget.js';
const w = new Widget();
`);
report('(b) value only', B);
assert.equal(B.get('Widget').verdict, 'VALUE');
assert.equal(B.get('Widget').importIsType, false);

// ---- (c) both -----------------------------------------------------------------
const C = analyse('c.ts', `
import { Widget } from './widget.js';
const w: Widget = new Widget();
`);
report('(c) both positions', C);
assert.equal(C.get('Widget').verdict, 'BOTH');

// ---- constructs matrix: every required syntactic form -------------------------
const M = analyse('m.ts', `
import type { TA } from './m1.js';
import { type TB, vc } from './m2.js';
import { Sup, Impl, Val } from './m3.js';

const a: TA = null as any;               // annotation           -> TYPE  (TA)
interface I extends TB {}                // interface extends    -> TYPE  (TB)
class K extends Sup implements Impl {}   // superClass=VALUE(Sup); implements=TYPE(Impl)
const t: typeof Val = null as any;       // typeof               -> VALUE (Val)
vc();                                    // call                 -> VALUE (vc)
export type { TA };                      // export type re-export
`);
report('constructs matrix', M);
assert.equal(M.get('TA').verdict, 'TYPE-ONLY');   // annotation + export type
assert.equal(M.get('TA').importIsType, true);
assert.equal(M.get('TA').exportedAsType, true);
assert.equal(M.get('TB').verdict, 'TYPE-ONLY');   // inline `type` import, extends
assert.equal(M.get('TB').importIsType, true);
assert.equal(M.get('Sup').verdict, 'VALUE');      // class extends <value>
assert.equal(M.get('Impl').verdict, 'TYPE-ONLY'); // implements
assert.equal(M.get('Val').verdict, 'VALUE');      // typeof references the VALUE
assert.equal(M.get('vc').verdict, 'VALUE');

console.log('\nOK 01 — all classifications matched expectations. VERDICT: PASS');
