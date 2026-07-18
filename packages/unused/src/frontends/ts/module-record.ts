/**
 * `frontends/ts` — per-file module record (T2.1, phasing.md M2).
 *
 * The `ModuleRecord` is the frontend's file-local IR: everything the TS/JS
 * frontend extracts from a single source file *before* module resolution
 * (T2.2) and graph assembly (T2.3). It is the **narrow, documented surface**
 * the rest of the frontend builds on; downstream tasks consume these records
 * and must not reach into the extractor internals.
 *
 * Design invariants (architecture.md §3/§4, CLAUDE.md non-negotiables):
 *  - **Provenance**: every record carries a {@link Span} (start/end offsets +
 *    1-based lines) so why-paths and report lines render from stored data,
 *    never re-analysis.
 *  - **Degrade toward alive**: whenever a mechanism cannot be classified
 *    with confidence (computed `import()`/`require()`, `import =`/`export =`,
 *    parse errors) the extractor emits a {@link HazardMarker} rather than a
 *    confident absence. A hazard is the frontend's "keep this alive" signal;
 *    core (M3) attaches the downgrade semantics.
 *
 * This module contains **types only** — no oxc dependency — so it can be
 * imported freely by resolution/IR code and by tests.
 */

/** Language oxc-parser was asked to parse a file as. */
export type SourceLang = "ts" | "tsx" | "js" | "jsx";

/**
 * Source span. `start`/`end` are UTF-16 code-unit offsets (oxc-parser emits
 * UTF-16 offsets == JS string indices — verified against the pinned
 * 0.140.0 build). `startLine`/`endLine` are 1-based inclusive, matching the
 * claim-schema {@link Span in core} SARIF region mapping (PRD §4). Provenance
 * requires start/end line at minimum (architecture.md §3); offsets are kept
 * for precise slicing and de-duplication.
 */
export interface Span {
  start: number;
  end: number;
  startLine: number;
  endLine: number;
}

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

/** A single binding pulled in by a static `import` statement. */
export interface ImportSpecifier {
  /**
   * - `named`    — `import { x }` / `import { x as y }`
   * - `default`  — `import x from …`
   * - `namespace`— `import * as ns from …`
   *
   * NOTE for consumers: for a `namespace` specifier, T2.1 records a value
   * {@link ReferenceSite} on the namespace binding itself but does **not**
   * resolve `ns.member` accesses to individual source exports (member names
   * are skipped). A referenced namespace import must therefore be treated as
   * keeping the *whole* export surface of `source` alive (degrade toward
   * alive); per-member granularity is deferred.
   */
  kind: "named" | "default" | "namespace";
  /**
   * The name as exported by the target module: the imported identifier for
   * `named`, the literal `"default"` for `default`, `"*"` for `namespace`.
   */
  importedName: string;
  /** The local binding this specifier introduces into the importing module. */
  localName: string;
  /**
   * Effective per-specifier type-only flag — `true` for **both**
   * `import type { X }` (statement-level) and `import { type X }` (inline).
   * oxc collapses both forms into this flag; {@link StaticImport.typeOnly}
   * distinguishes the statement-level form when that matters.
   */
  typeOnly: boolean;
  /** Span of the local binding identifier. */
  span: Span;
}

/** A static `import` statement (side-effect imports have zero specifiers). */
export interface StaticImport {
  /** Module specifier string (`from "…"`). */
  source: string;
  /** Span of the specifier string literal. */
  sourceSpan: Span;
  /** Empty ⇒ a side-effect import (`import "./x"`). */
  specifiers: ImportSpecifier[];
  /** `true` ⇒ side-effect-only import (keeps the target file alive, binds nothing). */
  sideEffect: boolean;
  /** Statement-level `import type { … }` (distinct from inline `import { type X }`). */
  typeOnly: boolean;
  /** Span of the whole import statement. */
  span: Span;
}

// ---------------------------------------------------------------------------
// Dynamic imports / require
// ---------------------------------------------------------------------------

/** A dynamic `import(...)` expression. */
export interface DynamicImport {
  /** String-literal specifier, or `null` when the argument is a computed expression. */
  source: string | null;
  /** `true` ⇒ computed argument ⇒ a {@link HazardMarker} was also emitted. */
  computed: boolean;
  /** Span of the argument expression. */
  argSpan: Span;
  /** Span of the whole `import(...)` expression. */
  span: Span;
}

/** A CommonJS `require(...)` call to the (unshadowed) global `require`. */
export interface RequireCall {
  /** String-literal specifier, or `null` when the argument is computed. */
  source: string | null;
  /** `true` ⇒ computed argument ⇒ a {@link HazardMarker} was also emitted. */
  computed: boolean;
  argSpan: Span;
  span: Span;
}

/**
 * A `TSImportType` — an inline module reference in a **type** position, e.g.
 * `let x: import('./svc.js').Service`. It introduces no local binding, so it is
 * not a {@link StaticImport}; it is a static, type-only *module edge*.
 *
 * Recording it is FP-critical: a file whose only reference to a module is a
 * `TSImportType` must still keep that module alive (the unmodelled-⇒-alive
 * invariant, architecture.md §4). Before T2.1 this was silently dropped.
 */
export interface TypeImportRecord {
  /** Module specifier inside `import('…')`. */
  source: string;
  /** Span of the specifier string literal. */
  sourceSpan: Span;
  /**
   * Root identifier of the qualifier after the module — `Service` in
   * `import('./x').Service`, `A` in `import('./x').A.B`; `null` for a bare
   * module type (`import('./x')`) or `typeof import('./x')`. Consumers join it
   * against the source module's exports for export-level liveness of that name;
   * when absent/unresolvable, keep the whole module surface alive (degrade
   * toward alive — the export-level claim for that name degrades safely).
   */
  qualifier: string | null;
  /**
   * `typeof import('./x')` — a value-flavoured type query over the module's
   * value namespace. Classification (documented): still a **type-only, static
   * module edge** (no runtime import); `typeof` selects the module's exported
   * *values*, so treat it as keeping the module's value+type surface alive.
   */
  typeQuery: boolean;
  /** Span of the whole `import('…')…` type. */
  span: Span;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

/**
 * A binding exported from *this* module (`export const x`, `export { x }`,
 * `export default …`).
 *
 * NOTE for consumers (verified against oxc 0.140.0): `export { a }` (no `from`)
 * where `a` is an imported **named or default** binding is NOT surfaced as a
 * `local` export — oxc back-fills the origin, so it appears as a
 * {@link NamedReExport} with `source` set (a re-export edge, architecture.md
 * §3). Only a re-export of a **namespace** import (`import * as ns …; export
 * { ns }`) and genuinely module-local bindings surface as `local`.
 */
export interface LocalExport {
  kind: "local";
  /** Public name; `"default"` for a default export. */
  exportedName: string;
  /** Local binding name; `null` for an anonymous default (`export default function () {}`). */
  localName: string | null;
  isDefault: boolean;
  /** `export type { X }` / `export { type X }` / `export type T = …`. */
  typeOnly: boolean;
  span: Span;
}

/** A named re-export (`export { x } from "…"`, `export { x as y } from "…"`, `export * as ns from "…"`). */
export interface NamedReExport {
  kind: "named-reexport";
  /** Public name under which this module re-exports the binding. */
  exportedName: string;
  /** Name in the *source* module; `"*"` for `export * as ns from "…"`. */
  importedName: string;
  source: string;
  sourceSpan: Span;
  typeOnly: boolean;
  span: Span;
}

/** A star re-export (`export * from "…"`) — forwards the whole surface of `source` (default excluded). */
export interface StarReExport {
  kind: "star-reexport";
  source: string;
  sourceSpan: Span;
  typeOnly: boolean;
  span: Span;
}

export type ExportRecord = LocalExport | NamedReExport | StarReExport;

// ---------------------------------------------------------------------------
// References
// ---------------------------------------------------------------------------

export type ReferencePosition = "value" | "type";

/**
 * A use-site of an imported local binding, classified by position. Produced
 * by the context-flip AST walk (ADR 0005 two-sided type rule): both value and
 * type positions are **real references**. Sites that a local declaration
 * shadows are *not* recorded (see the scope tracker in `scope.ts`).
 */
export interface ReferenceSite {
  /** The imported local binding this site references. */
  localName: string;
  position: ReferencePosition;
  span: Span;
}

// ---------------------------------------------------------------------------
// Hazards (the "degrade toward alive" markers)
// ---------------------------------------------------------------------------

/**
 * Parse- and resolution-level hazard classes. The full hazard *registry*
 * (downgrade semantics + confidence caps) is M3 (T3.1); these markers are the
 * frontend's raw signals that syntax cannot prove a reference absent here.
 *
 * `computed-*`/`import-equals`/`export-assignment`/`parse-error` are emitted by
 * T2.1 (parse/extract). `unresolvable-import` is emitted by T2.2 (resolution)
 * when a static, string-literal specifier cannot be resolved to a file or a
 * package: the import edge cannot be dropped (its target is unknown, not
 * absent), so it degrades toward alive with the import-site span
 * (see {@link file resolve.ts} `unresolvableToHazard`).
 *
 * Two M3 markers are emitted by extraction as *candidates* the IR layer
 * finalises:
 *  - `checker-only-type-relationship` — a `declare module '...'` augmentation or
 *    a `declare global` block: declaration merging is a checker-only relationship
 *    the reference graph cannot see, so the file's exports keep-alive (T3.1b).
 *  - `emit-decorator-metadata` — the file contains a decorator. This is only a
 *    hazard when tsconfig `emitDecoratorMetadata` is enabled, which extraction
 *    does not know; the IR layer (`emitIR`) drops the marker unless the project
 *    passes `emitDecoratorMetadata: true`.
 */
export type HazardKind =
  | "computed-dynamic-import"
  | "computed-require"
  | "computed-cjs-exports"
  | "import-equals"
  | "export-assignment"
  | "parse-error"
  | "unresolvable-import"
  | "checker-only-type-relationship"
  | "emit-decorator-metadata";

export interface HazardMarker {
  kind: HazardKind;
  /** One-line human-readable description (feeds the M3 report/why-path). */
  detail: string;
  span: Span;
  /**
   * For a computed `import()`/`require()` (the `directory-subtree`-scoped
   * hazards, M3 registry): the **static prefix** of the specifier as written in
   * source — e.g. `"./mods/"` for `` import(`./mods/${x}.js`) ``. The IR layer
   * resolves it against the importing file to a repo-relative `subtreePrefix`.
   * Absent ⇒ no static prefix ⇒ the importer's whole package is in scope.
   */
  scopePrefix?: string;
}

// ---------------------------------------------------------------------------
// Suppression
// ---------------------------------------------------------------------------

/**
 * A captured `/* unused:ignore <reason> *\/` directive sitting immediately
 * above a declaration. The reason is **mandatory** (PRD §6); a directive with
 * no reason is still captured with `valid: false` + `reasonMissing: true` so
 * M6 can render the "reason required" warning rather than silently dropping it.
 */
export interface SuppressionRecord {
  /** Trimmed reason text, or `null` when the directive omitted a reason. */
  reason: string | null;
  /** `false` ⇒ the directive is malformed (reason missing). */
  valid: boolean;
  reasonMissing: boolean;
  /** Best-effort name of the anchored declaration (for reporting); `null` if not derivable. */
  targetName: string | null;
  /** Span from the declaration's effective leading edge (incl. decorators) to its end. */
  targetSpan: Span;
  /** Span of the directive comment itself. */
  commentSpan: Span;
}

// ---------------------------------------------------------------------------
// Parse diagnostics
// ---------------------------------------------------------------------------

/** A non-fatal oxc parse diagnostic. Presence also yields a `parse-error` hazard. */
export interface ParseDiagnostic {
  message: string;
}

// ---------------------------------------------------------------------------
// The record
// ---------------------------------------------------------------------------

/**
 * Everything the frontend extracts from one source file. All arrays are
 * present (possibly empty). Consumers (T2.2 resolution, T2.3 IR) read
 * `imports`/`dynamicImports`/`requires`/`typeImports`/`exports` for edges,
 * `references` for per-binding liveness, `hazards` to degrade toward alive,
 * and `suppressions` to annotate claims.
 */
export interface ModuleRecord {
  /** Path as discovered (absolute). Made repo-relative later by the IR layer. */
  filePath: string;
  /** Language oxc actually parsed the file as (after any js→jsx fallback). */
  lang: SourceLang;
  imports: StaticImport[];
  dynamicImports: DynamicImport[];
  requires: RequireCall[];
  /** Inline `import('…')` module edges appearing in type positions (`TSImportType`). */
  typeImports: TypeImportRecord[];
  exports: ExportRecord[];
  references: ReferenceSite[];
  suppressions: SuppressionRecord[];
  hazards: HazardMarker[];
  parseErrors: ParseDiagnostic[];
}
