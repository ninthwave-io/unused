/**
 * Minimal hand-rolled scope/binding tracker — the frontend's correctness core
 * and its single largest false-positive surface (spike §caveat 1, ADR 0005).
 *
 * ## Why this exists
 * oxc-parser gives us no symbol table over NAPI. To decide whether an
 * occurrence of an imported name is a real reference to the import — or is
 * *shadowed* by a local declaration — we build our own lexical scopes.
 *
 * ## Model
 * Two namespaces are tracked independently, because TS separates them:
 *  - **value** bindings: `var`/`let`/`const`, function/class/enum names,
 *    parameters, catch params, named-function-expression names, namespaces.
 *  - **type** bindings: `interface`/`type`/`enum`/`class` names and
 *    **type parameters** (`<T>`).
 * A value-position use is shadowed only by a value binding; a type-position
 * use only by a type binding. This is what makes `import type { T }` survive
 * an inner `const T`, and lets an inner `<T>` shadow a type-only import.
 *
 * Bindings are **hoisted to their scope**: a scope's bindings are gathered by
 * a bounded scan of the scope node *before* its children are walked, so a
 * `const`/`class` declared anywhere in a block shadows uses earlier in that
 * block (TDZ is irrelevant to *which binding* a name denotes). `var` and the
 * function's own parameters/type-params live on the function scope; `let`/
 * `const`/`class`/`function`/`interface`/`type`/`enum` are block-scoped.
 *
 * ## Safety direction
 * The dangerous error is dropping a *real* reference (⇒ false "unused" ⇒ the
 * enemy). So we only over-approximate bindings when unsure — never
 * under-approximate — which errs toward keeping references (alive).
 *
 * ## Known limits (documented, all err toward alive / a missed dead import,
 * never toward a false "unused"):
 *  - `var` declared inside a **top-level block** is attributed to module scope
 *    (module scope is excluded from shadow checks anyway, so harmless).
 *  - `with` statements are not modelled (dynamic scope; rare, and disallowed
 *    in modules/strict mode).
 *  - TS `declare global` / ambient-module augmentation scopes are treated as
 *    ordinary blocks.
 *  - Namespace (`TSModuleDeclaration`) bodies are treated as blocks; the
 *    namespace name binds value+type in the enclosing scope.
 *  - Destructuring default *values* (`{ a = expr }`) are walked for references
 *    elsewhere; only the bound names are collected here.
 *  - `SwitchStatement`/`SwitchCase` open **no** scope here, so a `const`/`let`
 *    declared inside a `case` is not collected as a binding and does not shadow.
 *    This under-approximates bindings (the real switch body is one block scope
 *    shared by all cases) — it errs toward keeping references (alive), never
 *    toward a false "unused", so it is safe; stated for completeness.
 */
import { isNode, nodeArray, prop, type RawNode, str } from "./ast.js";

export type ScopeKind = "module" | "function" | "block" | "for" | "catch" | "class" | "type-params";

export interface ScopeBindings {
  values: Set<string>;
  types: Set<string>;
}

const FUNCTION_TYPES = new Set([
  "FunctionDeclaration",
  "FunctionExpression",
  "ArrowFunctionExpression",
  "TSDeclareFunction",
]);

/** The scope kind a node opens, or `null` if it opens no scope. */
export function scopeKindFor(node: RawNode): ScopeKind | null {
  const t = node.type;
  if (t === "Program") return "module";
  if (FUNCTION_TYPES.has(t)) return "function";
  if (t === "BlockStatement" || t === "StaticBlock" || t === "TSModuleBlock") return "block";
  if (t === "ForStatement" || t === "ForInStatement" || t === "ForOfStatement") return "for";
  if (t === "CatchClause") return "catch";
  if (t === "ClassDeclaration" || t === "ClassExpression") return "class";
  if (t === "TSInterfaceDeclaration" || t === "TSTypeAliasDeclaration") return "type-params";
  return null;
}

/** Collect every value-binding name introduced by a binding target/pattern. */
export function bindingNames(node: unknown, out: string[] = []): string[] {
  if (!isNode(node)) return out;
  switch (node.type) {
    case "Identifier": {
      const nm = str(node, "name");
      if (nm !== undefined) out.push(nm);
      break;
    }
    case "ObjectPattern":
      for (const p of nodeArray(prop(node, "properties"))) {
        if (p.type === "RestElement") bindingNames(prop(p, "argument"), out);
        else bindingNames(prop(p, "value"), out); // Property.value is the binding target
      }
      break;
    case "ArrayPattern":
      for (const el of nodeArray(prop(node, "elements"))) bindingNames(el, out);
      break;
    case "AssignmentPattern":
      bindingNames(prop(node, "left"), out);
      break;
    case "RestElement":
      bindingNames(prop(node, "argument"), out);
      break;
    case "TSParameterProperty": // constructor(private x) — parameter property
      bindingNames(prop(node, "parameter"), out);
      break;
    default:
      break;
  }
  return out;
}

/** Compute a scope's own bindings by a bounded scan of `node` (no descent into nested scopes). */
export function collectBindings(node: RawNode, kind: ScopeKind): ScopeBindings {
  const values = new Set<string>();
  const types = new Set<string>();

  switch (kind) {
    case "module": {
      for (const stmt of nodeArray(prop(node, "body"))) addDeclarationBinding(stmt, values, types);
      collectHoistedVars(node, values);
      break;
    }
    case "function": {
      for (const p of nodeArray(prop(node, "params")))
        for (const n of bindingNames(p)) values.add(n);
      addTypeParameters(prop(node, "typeParameters"), types);
      if (node.type === "FunctionExpression") {
        const id = prop(node, "id"); // named function expression binds its own name
        if (isNode(id)) {
          const nm = str(id, "name");
          if (nm !== undefined) values.add(nm);
        }
      }
      const body = prop(node, "body");
      if (isNode(body)) collectHoistedVars(body, values);
      break;
    }
    case "block": {
      for (const stmt of nodeArray(prop(node, "body"))) addDeclarationBinding(stmt, values, types);
      break;
    }
    case "for": {
      const head = node.type === "ForStatement" ? prop(node, "init") : prop(node, "left");
      if (isNode(head) && head.type === "VariableDeclaration") {
        for (const d of nodeArray(prop(head, "declarations")))
          for (const n of bindingNames(prop(d, "id"))) values.add(n);
      }
      break;
    }
    case "catch": {
      const param = prop(node, "param");
      if (isNode(param)) for (const n of bindingNames(param)) values.add(n);
      break;
    }
    case "class": {
      const id = prop(node, "id");
      if (isNode(id)) {
        const nm = str(id, "name");
        if (nm !== undefined) {
          values.add(nm);
          types.add(nm);
        }
      }
      addTypeParameters(prop(node, "typeParameters"), types);
      break;
    }
    case "type-params": {
      addTypeParameters(prop(node, "typeParameters"), types);
      break;
    }
    default:
      break;
  }
  return { values, types };
}

/** Add the binding(s) a top-level/block declaration statement introduces. */
function addDeclarationBinding(stmt: RawNode, values: Set<string>, types: Set<string>): void {
  let n = stmt;
  if (n.type === "ExportNamedDeclaration" || n.type === "ExportDefaultDeclaration") {
    const decl = prop(n, "declaration");
    if (!isNode(decl)) return; // `export { x }` / `export default <expr>` — no new local binding here
    n = decl;
  }
  switch (n.type) {
    case "VariableDeclaration":
      for (const d of nodeArray(prop(n, "declarations")))
        for (const b of bindingNames(prop(d, "id"))) values.add(b);
      break;
    case "FunctionDeclaration":
    case "TSDeclareFunction":
      addNamedId(n, values);
      break;
    case "ClassDeclaration":
    case "TSEnumDeclaration":
      addNamedId(n, values, types);
      break;
    case "TSInterfaceDeclaration":
    case "TSTypeAliasDeclaration":
      addNamedId(n, undefined, types);
      break;
    case "TSModuleDeclaration": {
      const id = prop(n, "id");
      if (isNode(id) && id.type === "Identifier") addNamedId(n, values, types);
      break;
    }
    default:
      break;
  }
}

function addNamedId(node: RawNode, values?: Set<string>, types?: Set<string>): void {
  const id = prop(node, "id");
  if (!isNode(id)) return;
  const nm = str(id, "name");
  if (nm === undefined) return;
  values?.add(nm);
  types?.add(nm);
}

function addTypeParameters(typeParams: unknown, types: Set<string>): void {
  if (!isNode(typeParams)) return;
  for (const tp of nodeArray(prop(typeParams, "params"))) {
    // TSTypeParameter.name is an Identifier node (its own binding).
    const name = prop(tp, "name");
    if (isNode(name)) {
      const nm = str(name, "name");
      if (nm !== undefined) types.add(nm);
    } else {
      const nm = str(tp, "name");
      if (nm !== undefined) types.add(nm);
    }
  }
}

/** Deep-scan for `var` bindings, stopping at nested function/module scopes (var hoists to the function). */
function collectHoistedVars(node: RawNode, out: Set<string>): void {
  const t = node.type;
  if (FUNCTION_TYPES.has(t) || t === "StaticBlock" || t === "TSModuleDeclaration") return;
  if (t === "VariableDeclaration" && str(node, "kind") === "var") {
    for (const d of nodeArray(prop(node, "declarations")))
      for (const b of bindingNames(prop(d, "id"))) out.add(b);
  }
  for (const child of childNodes(node)) collectHoistedVars(child, out);
}

function childNodes(node: RawNode): RawNode[] {
  const out: RawNode[] = [];
  for (const key of Object.keys(node as unknown as Record<string, unknown>)) {
    if (key === "type" || key === "start" || key === "end") continue;
    const v = prop(node, key);
    if (Array.isArray(v)) {
      for (const c of v) if (isNode(c)) out.push(c);
    } else if (isNode(v)) {
      out.push(v);
    }
  }
  return out;
}
