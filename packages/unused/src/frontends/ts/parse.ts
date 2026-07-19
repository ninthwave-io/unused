/**
 * Parse a source file with oxc-parser and assemble its {@link ModuleRecord}
 * (T2.1, phasing.md M2). This is the frontend's entry point for per-file
 * extraction; discovery (`discover.ts`) feeds it, resolution (T2.2) and IR
 * assembly (T2.3) consume its output.
 *
 * Static import/export surface is read from oxc's `module` metadata (spike
 * §"What oxc exposes"); references, dynamic imports, `require`, and hazards
 * come from our own AST walk (`extract.ts`); suppressions from `suppression.ts`.
 *
 * We type oxc's `module` metadata with a **local mirror** ({@link OxcModule})
 * rather than importing oxc's `const enum`s — string-literal unions compare
 * cleanly and keep this module insulated from `isolatedModules` const-enum
 * friction. The mirror matches oxc-parser 0.140.0 exactly (pinned).
 */

import { readFile } from "node:fs/promises";
import { parseSync } from "oxc-parser";
import { nodeArray, type RawNode, str } from "./ast.js";
import { extract } from "./extract.js";
import { LineIndex } from "./line-index.js";
import type {
  ExportRecord,
  ImportSpecifier,
  ModuleRecord,
  ParseDiagnostic,
  SourceLang,
  StaticImport,
} from "./module-record.js";
import { type CommentLike, collectSuppressions } from "./suppression.js";

// ---------------------------------------------------------------------------
// Local mirror of the oxc `module` metadata (oxc-parser 0.140.0).
// ---------------------------------------------------------------------------

interface OxcValueSpan {
  value: string;
  start: number;
  end: number;
}

interface OxcName {
  kind: string;
  name: string | null;
  start: number | null;
  end: number | null;
}

interface OxcImportEntry {
  importName: OxcName;
  localName: OxcValueSpan;
  isType: boolean;
}

interface OxcStaticImport {
  start: number;
  end: number;
  moduleRequest: OxcValueSpan;
  entries: OxcImportEntry[];
}

interface OxcExportEntry {
  start: number;
  end: number;
  moduleRequest: OxcValueSpan | null;
  importName: OxcName;
  exportName: OxcName;
  localName: OxcName;
  isType: boolean;
}

interface OxcStaticExport {
  entries: OxcExportEntry[];
}

interface OxcModule {
  staticImports: OxcStaticImport[];
  staticExports: OxcStaticExport[];
}

interface OxcErrorLike {
  message?: string;
}

interface OxcParseResult {
  program: RawNode;
  module: OxcModule;
  comments: CommentLike[];
  errors: OxcErrorLike[];
}

// ---------------------------------------------------------------------------
// Public entry points
// ---------------------------------------------------------------------------

/** Parse a file already read into memory. Pure (no IO) — the testing seam. */
export function parseSource(filePath: string, source: string): ModuleRecord {
  const initialLang = langForPath(filePath);
  const { result, lang } = parseWithFallback(filePath, source, initialLang);
  const li = new LineIndex(source);

  const imports = buildImports(result.module, result.program, li);
  const exports = buildExports(result.module, li);
  const importedLocals = new Set<string>();
  for (const imp of imports) for (const s of imp.specifiers) importedLocals.add(s.localName);

  const { references, intraFileRefs, dynamicImports, requires, typeImports, hazards } = extract(
    result.program,
    importedLocals,
    li,
  );
  const suppressions = collectSuppressions(result.program, result.comments, source, li);

  const parseErrors: ParseDiagnostic[] = result.errors.map((e) => ({
    message: e.message ?? "unknown parse error",
  }));
  if (parseErrors.length > 0) {
    // Degrade toward alive: a file we could not fully parse must not yield
    // confident "unused" claims downstream.
    hazards.push({
      kind: "parse-error",
      detail: `${parseErrors.length} parse diagnostic(s); extraction may be incomplete`,
      span: li.span(0, 0),
    });
  }

  return {
    filePath,
    lang,
    imports,
    dynamicImports,
    requires,
    typeImports,
    exports,
    references,
    intraFileRefs,
    suppressions,
    hazards,
    parseErrors,
  };
}

/** Read `filePath` from disk and parse it. */
export async function parseFile(filePath: string): Promise<ModuleRecord> {
  const source = await readFile(filePath, "utf8");
  return parseSource(filePath, source);
}

// ---------------------------------------------------------------------------
// Parsing (with a js→jsx fallback for JSX-in-.js)
// ---------------------------------------------------------------------------

function parseWithFallback(
  filePath: string,
  source: string,
  lang: SourceLang,
): { result: OxcParseResult; lang: SourceLang } {
  const first = parseSync(filePath, source, { lang }) as unknown as OxcParseResult;
  // Plain `.js`/`.mjs`/`.cjs` files commonly contain JSX (e.g. CRA). If the
  // `js` grammar errored, retry as `jsx` (a superset) before giving up.
  if (lang === "js" && first.errors.length > 0) {
    const retry = parseSync(filePath, source, { lang: "jsx" }) as unknown as OxcParseResult;
    if (retry.errors.length < first.errors.length) return { result: retry, lang: "jsx" };
  }
  return { result: first, lang };
}

/** Map an extension to the oxc `lang`. `.ts`/`.mts`/`.cts` never use the tsx grammar (`<T>` ambiguity). */
function langForPath(filePath: string): SourceLang {
  const dot = filePath.lastIndexOf(".");
  const ext = dot >= 0 ? filePath.slice(dot).toLowerCase() : "";
  switch (ext) {
    case ".tsx":
      return "tsx";
    case ".jsx":
      return "jsx";
    case ".ts":
    case ".mts":
    case ".cts":
      return "ts";
    default:
      return "js"; // .js/.mjs/.cjs — retried as jsx on parse error
  }
}

// ---------------------------------------------------------------------------
// Imports / exports from oxc metadata
// ---------------------------------------------------------------------------

function buildImports(mod: OxcModule, program: RawNode, li: LineIndex): StaticImport[] {
  // Statement-level `import type { … }` from the AST (module metadata folds
  // statement- and inline-`type` into a single per-entry flag).
  const statementTypeOnly = new Map<number, boolean>();
  for (const stmt of nodeArray((program as unknown as Record<string, unknown>)["body"])) {
    if (stmt.type === "ImportDeclaration") {
      statementTypeOnly.set(stmt.start, str(stmt, "importKind") === "type");
    }
  }

  return mod.staticImports.map((imp) => {
    const specifiers: ImportSpecifier[] = imp.entries.map((e) => {
      const kind =
        e.importName.kind === "Default"
          ? "default"
          : e.importName.kind === "NamespaceObject"
            ? "namespace"
            : "named";
      const importedName =
        kind === "named" ? (e.importName.name ?? "") : kind === "default" ? "default" : "*";
      return {
        kind,
        importedName,
        localName: e.localName.value,
        typeOnly: e.isType,
        span: li.span(e.localName.start, e.localName.end),
      };
    });
    return {
      source: imp.moduleRequest.value,
      sourceSpan: li.span(imp.moduleRequest.start, imp.moduleRequest.end),
      specifiers,
      sideEffect: specifiers.length === 0,
      typeOnly: statementTypeOnly.get(imp.start) ?? false,
      span: li.span(imp.start, imp.end),
    };
  });
}

function buildExports(mod: OxcModule, li: LineIndex): ExportRecord[] {
  const out: ExportRecord[] = [];
  for (const exp of mod.staticExports) {
    for (const e of exp.entries) {
      const span = li.span(e.start, e.end);
      if (e.moduleRequest !== null) {
        const source = e.moduleRequest.value;
        const sourceSpan = li.span(e.moduleRequest.start, e.moduleRequest.end);
        if (e.importName.kind === "AllButDefault") {
          out.push({ kind: "star-reexport", source, sourceSpan, typeOnly: e.isType, span });
        } else {
          // `export { x } from`, `export { x as y } from`, or `export * as ns from`.
          const importedName = e.importName.kind === "All" ? "*" : (e.importName.name ?? "");
          out.push({
            kind: "named-reexport",
            exportedName: e.exportName.name ?? "",
            importedName,
            source,
            sourceSpan,
            typeOnly: e.isType,
            span,
          });
        }
      } else {
        const isDefault = e.exportName.kind === "Default";
        const localNameKind =
          e.localName.kind === "Name" || e.localName.kind === "Default" ? e.localName.kind : "None";
        out.push({
          kind: "local",
          exportedName: isDefault ? "default" : (e.exportName.name ?? ""),
          localNameKind,
          localName: e.localName.name,
          isDefault,
          typeOnly: e.isType,
          span,
        });
      }
    }
  }
  return out;
}
