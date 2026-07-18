/**
 * Minimal, dependency-free helpers for walking oxc-parser's ESTree-ish AST.
 *
 * oxc exposes no scope/symbol table over the NAPI boundary (ADR 0005, spike
 * §caveat 1), so we treat nodes structurally. We access child properties via
 * bracketed casts (`noPropertyAccessFromIndexSignature` forbids dot-access on
 * an index signature) and narrow on the string `type` discriminant.
 */

/** The common shape every AST node carries. */
export interface RawNode {
  type: string;
  start: number;
  end: number;
}

type Rec = Record<string, unknown>;

/** Read an arbitrary property (may be a node, array, primitive, or absent). */
export function prop(node: RawNode, key: string): unknown {
  return (node as unknown as Rec)[key];
}

/** Read a string property, or `undefined` if absent / not a string. */
export function str(node: RawNode, key: string): string | undefined {
  const v = (node as unknown as Rec)[key];
  return typeof v === "string" ? v : undefined;
}

/** Read a boolean property as a strict `=== true` test. */
export function bool(node: RawNode, key: string): boolean {
  return (node as unknown as Rec)[key] === true;
}

/** Type guard: an object carrying a string `type` is an AST node. */
export function isNode(v: unknown): v is RawNode {
  return typeof v === "object" && v !== null && typeof (v as Rec)["type"] === "string";
}

/** Own enumerable keys of a node (including `type`/`start`/`end`). */
export function keys(node: RawNode): string[] {
  return Object.keys(node as unknown as Rec);
}

/** Coerce a property value to the AST nodes it contains (filters holes/primitives). */
export function nodeArray(v: unknown): RawNode[] {
  return Array.isArray(v) ? v.filter(isNode) : [];
}
