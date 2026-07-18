// Criterion 3 — leading-comment capture for `/* unused:ignore <reason> */`.
//
// oxc exposes comments with { type, value, start, end }. We deterministically
// associate a suppression comment with the declaration it precedes: the NEAREST
// preceding comment whose end is before the decl's leading edge with ONLY
// whitespace in between.
//
// Edge case proven here: a decorator sits BETWEEN the comment and the `export`
// keyword. oxc places the decorator's span (start 30) BEFORE the
// ExportNamedDeclaration's own start (36) — so associating against `node.start`
// naively would see `@Deco` in the gap and MISS the suppression. We compute an
// effective leading edge = min(node.start, decorator starts). We also prove the
// negative: an intervening non-suppression comment breaks adjacency.

import { parseSync } from 'oxc-parser';
import assert from 'node:assert';

const src = `/* unused:ignore legacy shim */
export const alpha = 1;

/* unused:ignore decorated case */
@Deco
export class Beta {}

/* unused:ignore should NOT apply */
// an intervening note breaks adjacency
export const gamma = 3;
`;

const r = parseSync('t.ts', src, { lang: 'ts' });
const comments = [...r.comments].sort((a, b) => a.end - b.end);

// Effective leading edge of a declaration = earliest of its own start and any
// decorator start (decorators can precede the `export` keyword's position).
function leadingEdge(node) {
  const decs = [...(node.decorators ?? []), ...(node.declaration?.decorators ?? [])];
  return decs.reduce((min, d) => Math.min(min, d.start), node.start);
}

function declName(node) {
  const d = node.declaration ?? node;
  if (d.type === 'VariableDeclaration') return d.declarations[0].id.name;
  return d.id?.name ?? d.type;
}

// Nearest preceding comment with only-whitespace between it and the decl.
function leadingComment(edge) {
  let best = null;
  for (const c of comments) if (c.end <= edge && (!best || c.end > best.end)) best = c;
  if (!best) return null;
  if (!/^\s*$/.test(src.slice(best.end, edge))) return null; // adjacency broken (e.g. by another comment)
  return best;
}

function suppression(node) {
  const c = leadingComment(leadingEdge(node));
  if (!c) return null;
  const m = c.value.trim().match(/^unused:ignore\s+(.+)$/);
  return m ? m[1].trim() : null;
}

const results = {};
for (const node of r.program.body) {
  const name = declName(node);
  results[name] = suppression(node);
  console.log(`${name.padEnd(6)} edge@${String(leadingEdge(node)).padEnd(3)} -> suppression: ${results[name] ? JSON.stringify(results[name]) : '(none)'}`);
}

assert.equal(results.alpha, 'legacy shim');            // simple adjacency
assert.equal(results.Beta, 'decorated case');          // decorator between comment and `export`
assert.equal(results.gamma, null);                     // intervening comment breaks adjacency -> NOT applied

console.log('\nOK 03 — adjacency, decorator edge case, and intervening-comment negative all hold. VERDICT: PASS');
