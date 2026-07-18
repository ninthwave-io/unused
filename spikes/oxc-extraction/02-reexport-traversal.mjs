// Criterion 2 — re-export traversal (star + named), through a 3+file chain.
//
// entry.ts imports `x` from barrel.ts; barrel does `export * from './a.js'`,
// `export * from './a2.js'`, and `export { y } from './b.js'`. We show the module
// records expose enough (star sources, named re-export maps, local exports) to:
//   * resolve `x` to its defining file THROUGH the star export,
//   * detect that b.ts's other export `z` is NOT re-exported by the barrel,
//   * detect the ambiguity two star sources create for the same name `x`.
//
// Module resolution here is a trivial `.js`->`.ts` swap; the real frontend uses
// oxc-resolver (ADR 0005). The point of the spike is the *metadata*, not resolution.

import { parseSync } from 'oxc-parser';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert';

const DIR = resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures/reexport');
const resolveSpec = (fromFile, spec) => resolve(dirname(fromFile), spec.replace(/\.js$/, '.ts'));

// ---- per-file module record from oxc's staticExports ------------------------
const cache = new Map();
function record(file) {
  if (cache.has(file)) return cache.get(file);
  const { module: m } = parseSync(file, readFileSync(file, 'utf8'), { lang: 'ts' });
  const rec = { localExports: new Set(), starSources: [], namedReexports: new Map() };
  for (const exp of m.staticExports) for (const e of exp.entries) {
    if (!e.moduleRequest) { if (e.exportName.kind === 'Name') rec.localExports.add(e.exportName.name); }
    else if (e.importName.kind === 'AllButDefault' && e.exportName.kind === 'None') rec.starSources.push(e.moduleRequest.value);
    else if (e.importName.kind === 'Name') rec.namedReexports.set(e.exportName.name, { source: e.moduleRequest.value, importName: e.importName.name });
  }
  cache.set(file, rec);
  return rec;
}

// ---- resolve an exported name to its defining file(s) -----------------------
// Returns every file that defines `name` as reachable through `file`'s exports.
// Multiple results == ambiguity (the star-collision hazard) — detectable, per §3.
function resolveExport(file, name, seen = new Set()) {
  if (seen.has(file + '#' + name)) return []; // cycle guard
  seen.add(file + '#' + name);
  const rec = record(file);
  const hits = [];
  if (rec.localExports.has(name)) hits.push({ file, via: 'local' });
  if (rec.namedReexports.has(name)) {
    const { source, importName } = rec.namedReexports.get(name);
    hits.push(...resolveExport(resolveSpec(file, source), importName, seen));
  }
  for (const star of rec.starSources)
    hits.push(...resolveExport(resolveSpec(file, star), name, seen)); // empty if star source lacks `name`
  return hits;
}

const short = (f) => f.slice(DIR.length + 1);
const barrel = resolve(DIR, 'barrel.ts');

// ---- 1. resolve `x` through the star export ---------------------------------
const xHits = resolveExport(barrel, 'x');
console.log('resolve x via barrel ->', xHits.map((h) => `${short(h.file)} (${h.via})`));
assert.ok(xHits.some((h) => short(h.file) === 'a.ts'), 'x must resolve through star export to a.ts');

// ---- 2. ambiguity: `x` comes from TWO star sources --------------------------
const xFiles = [...new Set(xHits.map((h) => short(h.file)))];
console.log('x defining files:', xFiles, xFiles.length > 1 ? '-> AMBIGUOUS (detected)' : '');
assert.equal(xFiles.length, 2, 'star collision must yield 2 candidate definitions (a.ts, a2.ts)');
assert.deepEqual(xFiles.sort(), ['a.ts', 'a2.ts']);

// ---- 3. `y` resolves through the NAMED re-export; `z` is NOT re-exported -----
const yHits = resolveExport(barrel, 'y');
const zHits = resolveExport(barrel, 'z');
console.log('resolve y via barrel ->', yHits.map((h) => short(h.file)));
console.log('resolve z via barrel ->', zHits.length ? zHits.map((h) => short(h.file)) : '(not re-exported)');
assert.deepEqual(yHits.map((h) => short(h.file)), ['b.ts'], 'y is named-re-exported from b.ts');
assert.equal(zHits.length, 0, 'z is a local export of b.ts and must NOT be reachable through the barrel');

// sanity: b.ts really does export z locally (so the "not re-exported" result is meaningful)
assert.ok(record(resolve(DIR, 'b.ts')).localExports.has('z'));

console.log('\nOK 02 — star + named traversal, ambiguity, and non-re-export detection all hold. VERDICT: PASS');
