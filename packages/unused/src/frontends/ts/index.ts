/**
 * `frontends/ts` — TS/JS frontend public surface (architecture.md §1, ADR 0005).
 *
 * Discovery, parse (oxc-parser), reference/symbol extraction, module
 * resolution (oxc-resolver + get-tsconfig). Emits the file-local
 * {@link ModuleRecord} IR and resolved edges only; must never import cli,
 * reporters, or mcp. IR assembly (T2.3) and reachability (T2.4) build on top of
 * this narrow surface — keep it small and documented.
 */
export { discover } from "./discover.js";
export {
  detectProductionEntrypoints,
  type EmitInput,
  type EmitPackageUnit,
  type EntrypointHit,
  type EntrypointOptions,
  emitIR,
  type PackageJsonLike,
} from "./emit.js";
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
export type {
  BuiltinResolution,
  ExternalResolution,
  InternalDeclarationResolution,
  InternalResolution,
  OutsideProjectResolution,
  Resolution,
  ResolvedSpecifier,
  ResolverOptions,
  SpecifierOrigin,
  UnresolvableResolution,
} from "./resolve.js";
export {
  DEFAULT_CONDITIONS,
  packageNameOf,
  Resolver,
  resolveModuleRecord,
  unresolvableToHazard,
} from "./resolve.js";

export {
  detectWorkspaces,
  UnsupportedProjectError,
  type WorkspaceLayout,
  type WorkspaceManager,
  type WorkspaceMember,
} from "./workspaces.js";

/** Placeholder module marker retained for the boundary/dependency-cruiser smoke test. */
export const TS_FRONTEND_MODULE = "frontends/ts" as const;
