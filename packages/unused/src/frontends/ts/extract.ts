/**
 * The context-flip AST walk: one traversal that produces reference sites
 * (value/type, shadow-resolved), dynamic imports, `require` calls, and the
 * parse-level hazard markers — architecture.md §3/§4, ADR 0005, spike
 * criterion 1 + caveats 1/2/5.
 *
 * ## Type/value classification
 * A single `inType` context flag flips as we descend. The two spec-critical
 * subtleties (spike §1): `class extends X` references the **value** `X`
 * (`superClass`, evaluated at runtime), and `typeof X` inside a type
 * references the **value** `X`. Type-position references (annotations,
 * `extends` on interfaces, `implements`, `<T>` args, `as`/`satisfies` operands)
 * are **real references** and are recorded — never blanket-downgraded.
 *
 * ## Shadowing
 * We maintain a stack of {@link ScopeBindings} frames. An occurrence of an
 * imported name is recorded only if no enclosing **non-module** scope binds
 * that name in the occurrence's namespace. Binding identifiers and property
 * names never leak as references: property/member names are skipped, and a
 * binding that collides with an import is always inside its own shadowing
 * frame (a module-scope rebind of an import is illegal), so it resolves away.
 *
 * ## Degrade toward alive
 * Computed `import(expr)` / `require(expr)`, and `import =` / `export =`
 * emit hazard markers rather than a confident classification.
 */
import { isNode, nodeArray, prop, type RawNode, str } from "./ast.js";
import type { LineIndex } from "./line-index.js";
import type {
  DynamicImport,
  HazardMarker,
  ReferenceSite,
  RequireCall,
  TypeImportRecord,
} from "./module-record.js";
import { collectBindings, type ScopeBindings, scopeKindFor } from "./scope.js";

export interface ExtractResult {
  references: ReferenceSite[];
  dynamicImports: DynamicImport[];
  requires: RequireCall[];
  typeImports: TypeImportRecord[];
  hazards: HazardMarker[];
}

/**
 * Walk `program`, collecting references to `importedLocals`, dynamic imports,
 * require calls, and hazards.
 */
export function extract(
  program: RawNode,
  importedLocals: ReadonlySet<string>,
  li: LineIndex,
): ExtractResult {
  const references: ReferenceSite[] = [];
  const dynamicImports: DynamicImport[] = [];
  const requires: RequireCall[] = [];
  const typeImports: TypeImportRecord[] = [];
  const hazards: HazardMarker[] = [];

  // scopeStack[0] is always the module frame and is EXCLUDED from shadow
  // checks (imports live there; a module-scope rebind of an import is illegal).
  const scopeStack: ScopeBindings[] = [collectBindings(program, "module")];

  function isShadowed(name: string, position: "value" | "type"): boolean {
    for (let i = 1; i < scopeStack.length; i++) {
      const frame = scopeStack[i] as ScopeBindings;
      const set = position === "value" ? frame.values : frame.types;
      if (set.has(name)) return true;
    }
    return false;
  }

  function recordReference(name: string, position: "value" | "type", node: RawNode): void {
    if (!importedLocals.has(name)) return;
    if (isShadowed(name, position)) return;
    references.push({ localName: name, position, span: li.span(node.start, node.end) });
  }

  function recordDynamicImport(node: RawNode): void {
    const source = prop(node, "source");
    let value: string | null = null;
    let computed = true;
    let argSpan = li.span(node.start, node.end);
    if (isNode(source)) {
      argSpan = li.span(source.start, source.end);
      if (source.type === "Literal") {
        const raw = prop(source, "value");
        if (typeof raw === "string") {
          value = raw;
          computed = false;
        }
      }
    }
    dynamicImports.push({ source: value, computed, argSpan, span: li.span(node.start, node.end) });
    if (computed) {
      hazards.push({
        kind: "computed-dynamic-import",
        detail: "dynamic import() with a computed (non-string-literal) specifier",
        span: argSpan,
      });
    }
  }

  function recordRequire(node: RawNode): void {
    const callee = prop(node, "callee");
    if (!isNode(callee) || callee.type !== "Identifier" || str(callee, "name") !== "require")
      return;
    // A local binding named `require` means this is not the global require.
    if (isShadowed("require", "value")) return;
    const args = nodeArray(prop(node, "arguments"));
    const arg0 = args[0];
    if (arg0 === undefined) return;
    let value: string | null = null;
    let computed = true;
    if (arg0.type === "Literal") {
      const raw = prop(arg0, "value");
      if (typeof raw === "string") {
        value = raw;
        computed = false;
      }
    }
    const argSpan = li.span(arg0.start, arg0.end);
    requires.push({ source: value, computed, argSpan, span: li.span(node.start, node.end) });
    if (computed) {
      hazards.push({
        kind: "computed-require",
        detail: "require() with a computed (non-string-literal) argument",
        span: argSpan,
      });
    }
  }

  /**
   * Record a `TSImportType` (`import('./svc').Service` in a type position) as a
   * type-only module edge. FP-critical: without this a file whose only link to
   * a module is a TSImportType would become a confident false "unused".
   * `typeQuery` is derived from `inType` — the only value-context path to a
   * TSImportType is `typeof import('…')` (`TSTypeQuery.exprName`), which reopens
   * a value context.
   */
  function recordTypeImport(node: RawNode, inType: boolean): void {
    const source = prop(node, "source");
    // A TSImportType source must be a string literal (a computed specifier is
    // invalid TS and surfaces as a parse error → parse-error hazard).
    if (!isNode(source) || source.type !== "Literal") return;
    const raw = prop(source, "value");
    if (typeof raw !== "string") return;
    typeImports.push({
      source: raw,
      sourceSpan: li.span(source.start, source.end),
      qualifier: qualifierRoot(prop(node, "qualifier")),
      typeQuery: !inType,
      span: li.span(node.start, node.end),
    });
  }

  /**
   * Record a `TSImportEqualsDeclaration`. FP-critical: `import x = require("./m")`
   * is a literal, statically-resolvable module edge — T2.1 previously dropped the
   * whole subtree, so a file imported *only* this way got no incoming edge and was
   * flagged a confident false "unused". We record it as a require-form module
   * reference (resolve + emit then give the target a keep-alive edge). The entity
   * form `import x = A.B` is a value alias to the root identifier `A`. The
   * import-equals hazard is still emitted (confidence cap for the CJS mechanism).
   */
  function recordImportEquals(node: RawNode, inType: boolean): void {
    const moduleRef = prop(node, "moduleReference");
    if (isNode(moduleRef) && moduleRef.type === "TSExternalModuleReference") {
      const expr = prop(moduleRef, "expression");
      if (isNode(expr) && expr.type === "Literal") {
        const raw = prop(expr, "value");
        if (typeof raw === "string") {
          requires.push({
            source: raw,
            computed: false,
            argSpan: li.span(expr.start, expr.end),
            span: li.span(node.start, node.end),
          });
        }
      }
    } else if (isNode(moduleRef)) {
      const root = qualifierRoot(moduleRef);
      if (root !== null) recordReference(root, inType ? "type" : "value", moduleRef);
    }
    hazards.push({
      kind: "import-equals",
      detail:
        "TS `import x = require(...)` / `import x = A.B` (CJS interop, not statically modelled)",
      span: li.span(node.start, node.end),
    });
  }

  function walk(node: RawNode, inType: boolean): void {
    const kind = scopeKindFor(node);
    // The module frame is pushed once above; don't re-push it here.
    const pushed = kind !== null && kind !== "module";
    if (pushed) scopeStack.push(collectBindings(node, kind as Exclude<typeof kind, null>));

    try {
      switch (node.type) {
        case "Identifier": {
          const nm = str(node, "name");
          if (nm !== undefined) recordReference(nm, inType ? "type" : "value", node);
          break;
        }
        case "JSXIdentifier": {
          // Reached only in element-name position (attribute names / member
          // properties are skipped below). JSX element references are values.
          const nm = str(node, "name");
          if (nm !== undefined) recordReference(nm, "value", node);
          break;
        }
        case "ImportExpression":
          recordDynamicImport(node);
          break;
        case "CallExpression":
          recordRequire(node);
          break;
        case "TSImportType":
          recordTypeImport(node, inType);
          break;
        case "TSImportEqualsDeclaration":
          recordImportEquals(node, inType);
          break;
        case "TSExportAssignment":
          // `export = expr` — the expression subtree is walked normally below, so
          // a value reference to a local/imported binding (`export = imported`) is
          // recorded like any other use-site. The hazard still caps confidence for
          // the CJS-interop mechanism (declaration merging etc.).
          hazards.push({
            kind: "export-assignment",
            detail: "TS `export = ...` (CJS interop, not statically modelled)",
            span: li.span(node.start, node.end),
          });
          break;
        default:
          break;
      }

      for (const key of Object.keys(node as unknown as Record<string, unknown>)) {
        if (key === "type" || key === "start" || key === "end") continue;
        if (shouldSkipChild(node, key)) continue;
        const childInType = childContextIsType(node, key, inType);
        walkValue(prop(node, key), childInType);
      }
    } finally {
      if (pushed) scopeStack.pop();
    }
  }

  function walkValue(value: unknown, inType: boolean): void {
    if (Array.isArray(value)) {
      for (const c of value) if (isNode(c)) walk(c, inType);
    } else if (isNode(value)) {
      walk(value, inType);
    }
  }

  walk(program, false);
  return { references, dynamicImports, requires, typeImports, hazards };
}

/** Leftmost identifier of a `TSImportType` qualifier (`A` in `A.B`); `null` if absent. */
function qualifierRoot(qualifier: unknown): string | null {
  if (!isNode(qualifier)) return null;
  if (qualifier.type === "Identifier") return str(qualifier, "name") ?? null;
  if (qualifier.type === "TSQualifiedName") return qualifierRoot(prop(qualifier, "left"));
  return null;
}

/**
 * Does descending into `node[key]` open (or reopen) a **type** context?
 * The value-reopening cases (superClass, `typeof`, `as`/`satisfies` operand)
 * matter as much as the type-opening ones (spike §1).
 */
function childContextIsType(node: RawNode, key: string, inType: boolean): boolean {
  const t = node.type;

  // --- reopen VALUE inside a type ---
  if ((t === "ClassDeclaration" || t === "ClassExpression") && key === "superClass") return false;
  if (t === "TSTypeQuery" && key === "exprName") return false; // typeof <VALUE>
  if ((t === "TSAsExpression" || t === "TSSatisfiesExpression") && key === "expression")
    return false;
  if (t === "TSInstantiationExpression" && key === "expression") return false;

  // --- open TYPE ---
  if (
    key === "typeAnnotation" ||
    key === "returnType" ||
    key === "typeParameters" ||
    key === "typeArguments" ||
    key === "superTypeArguments"
  ) {
    return true;
  }
  if (t === "TSTypeParameter" && (key === "constraint" || key === "default")) return true;
  if (t === "TSInterfaceDeclaration" && key === "extends") return true;
  if ((t === "ClassDeclaration" || t === "ClassExpression") && key === "implements") return true;

  return inType;
}

/** Keys we must not descend into for reference recording (bindings / names / metadata). */
function shouldSkipChild(node: RawNode, key: string): boolean {
  const t = node.type;

  // Static import/export surface is handled via oxc `module` metadata.
  if (t === "ImportDeclaration") return true;
  if (t === "ExportAllDeclaration") return true;
  if (t === "ExportNamedDeclaration" && key === "specifiers") return true;
  if (t === "TSImportEqualsDeclaration") return true; // hazard-only; skip subtree

  // Member / property / qualified names are not references to bindings.
  if (t === "MemberExpression" && key === "property" && !isComputed(node)) return true;
  if (t === "JSXMemberExpression" && key === "property") return true;
  if (t === "JSXAttribute" && key === "name") return true;
  if (t === "TSQualifiedName" && key === "right") return true;

  // TSImportType: the module string and qualifier are captured as a type-import
  // record (recordTypeImport); `typeArguments` are still walked for references
  // to local imports (e.g. `import('./x').Box<LocalType>`).
  if (t === "TSImportType" && (key === "source" || key === "qualifier")) return true;
  if (
    (t === "Property" ||
      t === "PropertyDefinition" ||
      t === "MethodDefinition" ||
      t === "AccessorProperty" ||
      t === "TSPropertySignature" ||
      t === "TSMethodSignature" ||
      t === "TSEnumMember") &&
    key === "key" &&
    !isComputed(node)
  ) {
    return true;
  }

  // Type-parameter *name* is a binding; its constraint/default are walked.
  if (t === "TSTypeParameter" && key === "name") return true;

  // Statement labels are not references.
  if (t === "LabeledStatement" && key === "label") return true;
  if ((t === "BreakStatement" || t === "ContinueStatement") && key === "label") return true;

  return false;
}

function isComputed(node: RawNode): boolean {
  return (node as unknown as Record<string, unknown>)["computed"] === true;
}
