/**
 * `frontends/ts` — TS/JS frontend public surface (architecture.md §1, ADR 0005).
 *
 * Discovery, parse (oxc-parser), reference/symbol extraction. Emits the
 * file-local {@link ModuleRecord} IR only; must never import cli, reporters,
 * or mcp. Module resolution (T2.2), IR assembly (T2.3), and reachability
 * (T2.4) build on top of this narrow surface — keep it small and documented.
 */
export { discover } from "./discover.js";
export type {
  DynamicImport,
  ExportRecord,
  HazardKind,
  HazardMarker,
  ImportSpecifier,
  LocalExport,
  ModuleRecord,
  NamedReExport,
  ParseDiagnostic,
  ReferencePosition,
  ReferenceSite,
  RequireCall,
  SourceLang,
  Span,
  StarReExport,
  StaticImport,
  SuppressionRecord,
  TypeImportRecord,
} from "./module-record.js";
export { parseFile, parseSource } from "./parse.js";

/** Placeholder module marker retained for the boundary/dependency-cruiser smoke test. */
export const TS_FRONTEND_MODULE = "frontends/ts" as const;
