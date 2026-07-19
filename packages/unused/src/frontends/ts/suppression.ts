/**
 * Suppression capture: `/* unused:ignore <reason> *\/` directly above a
 * declaration (architecture.md §4, PRD §6, spike criterion 3).
 *
 * oxc comments are a flat, source-ordered list — NOT attached to AST nodes.
 * We associate the **nearest preceding** comment whose end is separated from
 * the declaration's *effective leading edge* by whitespace only.
 *
 * ## The decorator trap (spike §3, caveat 6)
 * For `@Deco export class X`, oxc places the decorator span *before* the
 * `ExportNamedDeclaration.start`. Anchoring on `node.start` naively would see
 * `@Deco` in the gap and MISS the suppression. The effective leading edge is
 * therefore `min(node.start, decorator starts)` — including decorators on the
 * inner declaration of an export wrapper.
 *
 * ## Missing reason
 * The reason is mandatory (PRD §6). `/* unused:ignore *\/` (no reason) is
 * still captured, with `valid: false` + `reasonMissing: true`, so claim
 * emission warns on stderr and leaves the claim unsuppressed (and gate-eligible)
 * rather than silently accepting or dropping the invalid directive.
 *
 * ## Scope of targets
 * Directives are recognised on top-level declarations/exports and on class /
 * interface / enum / namespace members (one level of nesting). Trailing
 * same-line directives and comments inside decorator argument lists are out
 * of scope (spike §caveat 6) — documented non-support.
 */
import { isNode, nodeArray, prop, type RawNode, str } from "./ast.js";
import type { LineIndex } from "./line-index.js";
import type { SuppressionRecord } from "./module-record.js";

export interface CommentLike {
  value: string;
  start: number;
  end: number;
}

const DIRECTIVE = /^unused:ignore(?:\s+([\s\S]+))?$/;

const DECL_TYPES = new Set([
  "ExportNamedDeclaration",
  "ExportDefaultDeclaration",
  "FunctionDeclaration",
  "TSDeclareFunction",
  "ClassDeclaration",
  "TSInterfaceDeclaration",
  "TSTypeAliasDeclaration",
  "TSEnumDeclaration",
  "TSModuleDeclaration",
  "VariableDeclaration",
]);

const MEMBER_TYPES = new Set([
  "MethodDefinition",
  "PropertyDefinition",
  "AccessorProperty",
  "TSPropertySignature",
  "TSMethodSignature",
]);

export function collectSuppressions(
  program: RawNode,
  comments: readonly CommentLike[],
  source: string,
  li: LineIndex,
): SuppressionRecord[] {
  const sorted = [...comments].sort((a, b) => a.end - b.end);
  const out: SuppressionRecord[] = [];

  for (const node of collectTargets(program)) {
    const edge = leadingEdge(node);
    const comment = leadingComment(sorted, edge, source);
    if (comment === null) continue;
    const parsed = parseDirective(comment.value);
    if (parsed === null) continue;
    out.push({
      reason: parsed.reason,
      valid: parsed.reason !== null,
      reasonMissing: parsed.reason === null,
      targetName: targetName(node),
      targetSpan: li.span(edge, node.end),
      commentSpan: li.span(comment.start, comment.end),
    });
  }
  return out;
}

function parseDirective(value: string): { reason: string | null } | null {
  const m = DIRECTIVE.exec(value.trim());
  if (m === null) return null;
  const reason = m[1]?.trim();
  return { reason: reason !== undefined && reason.length > 0 ? reason : null };
}

/** Nearest preceding comment with only-whitespace between it and `edge`. */
function leadingComment(
  sorted: readonly CommentLike[],
  edge: number,
  source: string,
): CommentLike | null {
  let best: CommentLike | null = null;
  for (const c of sorted) {
    if (c.end <= edge && (best === null || c.end > best.end)) best = c;
  }
  if (best === null) return null;
  // Adjacency: anything other than whitespace in the gap (e.g. another
  // comment) breaks the association.
  if (!/^\s*$/.test(source.slice(best.end, edge))) return null;
  return best;
}

/** `min(node.start, decorator starts, inner-declaration decorator starts)`. */
function leadingEdge(node: RawNode): number {
  let edge = node.start;
  for (const d of decoratorsOf(node)) edge = Math.min(edge, d.start);
  const decl = prop(node, "declaration");
  if (isNode(decl)) for (const d of decoratorsOf(decl)) edge = Math.min(edge, d.start);
  return edge;
}

function decoratorsOf(node: RawNode): RawNode[] {
  return nodeArray(prop(node, "decorators"));
}

function collectTargets(program: RawNode): RawNode[] {
  const out: RawNode[] = [];
  visitBody(nodeArray(prop(program, "body")), out);
  return out;
}

function visitBody(stmts: readonly RawNode[], out: RawNode[]): void {
  for (const stmt of stmts) {
    if (DECL_TYPES.has(stmt.type)) {
      out.push(stmt);
      const inner = unwrapExport(stmt);
      visitMembers(inner, out);
      if (inner.type === "TSModuleDeclaration") {
        const body = prop(inner, "body");
        if (isNode(body)) visitBody(nodeArray(prop(body, "body")), out);
      }
    }
  }
}

/** Recurse one level into class/interface bodies for member-level directives. */
function visitMembers(node: RawNode, out: RawNode[]): void {
  const body = prop(node, "body");
  const members = isNode(body) ? nodeArray(prop(body, "body")) : [];
  for (const m of members) {
    if (MEMBER_TYPES.has(m.type)) out.push(m);
  }
}

function unwrapExport(node: RawNode): RawNode {
  if (node.type === "ExportNamedDeclaration" || node.type === "ExportDefaultDeclaration") {
    const decl = prop(node, "declaration");
    if (isNode(decl)) return decl;
  }
  return node;
}

function targetName(node: RawNode): string | null {
  const n = unwrapExport(node);
  if (n.type === "VariableDeclaration") {
    const first = nodeArray(prop(n, "declarations"))[0];
    if (first !== undefined) {
      const id = prop(first, "id");
      if (isNode(id)) return str(id, "name") ?? null;
    }
    return null;
  }
  if (
    n.type === "MethodDefinition" ||
    n.type === "PropertyDefinition" ||
    n.type === "AccessorProperty"
  ) {
    const key = prop(n, "key");
    if (isNode(key)) return str(key, "name") ?? null;
    return null;
  }
  const id = prop(n, "id");
  if (isNode(id)) return str(id, "name") ?? null;
  if (node.type === "ExportDefaultDeclaration") return "default";
  return null;
}
