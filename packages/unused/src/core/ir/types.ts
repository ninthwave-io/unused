/**
 * The language-agnostic reference-graph IR contract (T2.3, architecture.md §3).
 *
 * These are the node/edge/hazard shapes a language **frontend** emits and the
 * reachability + claim engine (T2.4, M3) consumes. This module is pure data +
 * pure id helpers and imports **nothing** — in particular nothing from
 * `frontends/*` (ADR 0003, enforced by dependency-cruiser). A frontend maps its
 * own records into these shapes; core reads them with zero language knowledge.
 *
 * ## The five invariants this file encodes
 *  1. **Nodes** are `symbol | file | dependency | endpoint | entrypoint`
 *     (architecture.md §3). `endpoint` is present but never constructed in v1;
 *     `entrypoint` carries `kind: production | test | config`. M2 emitted only
 *     `production`; M3 additionally emits `config` roots and (interim, ahead of
 *     M5) `test` roots — test-reachable code is simply kept alive, never claimed.
 *     The full production/test/config partition + `test-only` verdict remain M5.
 *  2. **Edges** are `references` (with a `referenceKind`) plus `exports`,
 *     `contains`, and a reserved `consumes` that is never emitted yet.
 *  3. **Provenance**: every edge AND every hazard annotation carries the
 *     referencing site's {@link Site} (file + span). There is no edge without a
 *     span — why-paths and report lines render from stored provenance, never
 *     re-analysis (architecture.md §3, CLAUDE.md non-negotiables).
 *  4. **Stable identity**: node ids are `kind + canonical identity`
 *     (POSIX-relative path, plus the export name for symbols) so construction
 *     and serialisation are deterministic across machines.
 *  5. **Hazard classes** are a **closed enum** ({@link HazardClass}) — the M3
 *     close-the-vocabulary item (T3.1). The scope/cap policy for each lives in
 *     the registry (`core/analysis/hazard-registry.ts`); this file owns only the
 *     vocabulary the IR is expressed in. The claim engine still degrades toward
 *     alive on any class the registry does not know (project-scope no-claim +
 *     a loud warning) — closure is compile-time, safety is runtime.
 */

// ---------------------------------------------------------------------------
// Provenance
// ---------------------------------------------------------------------------

/**
 * A source location. `file` is POSIX, repo-relative (matches the claim-schema
 * `Loc.file`). The span mirrors the frontend `Span` (UTF-16 offsets + 1-based
 * inclusive lines) structurally, but is **re-declared here** so core owns its
 * own type and never imports a frontend type. Structural typing lets a frontend
 * pass its `Span` straight through.
 */
export interface Site {
  /** POSIX, repo-relative path of the referencing file. */
  file: string;
  span: {
    start: number;
    end: number;
    startLine: number;
    endLine: number;
  };
}

// ---------------------------------------------------------------------------
// Hazard vocabulary (closed enum — M3 T3.1)
// ---------------------------------------------------------------------------

/**
 * The closed set of hazard classes the IR is expressed in (architecture.md §4).
 * A frontend cites one of these on a {@link HazardAnnotation} or a `hazard`
 * {@link IREdge}; the scope/cap policy for each lives in the registry
 * (`core/analysis/hazard-registry.ts`), which is typed against this enum so a
 * class can never be added here without a registry entry. Runtime code still
 * degrades toward alive on any string outside this set (see the registry).
 */
export type HazardClass =
  | "computed-dynamic-import"
  | "computed-require"
  | "computed-cjs-exports"
  | "config-referenced-file"
  | "unresolvable-import"
  | "outside-project"
  | "internal-declaration"
  | "declaration-companion"
  | "parse-error"
  | "import-equals"
  | "export-assignment"
  | "checker-only-type-relationship"
  | "emit-decorator-metadata"
  | "conditional-exports-divergence"
  | "project-references"
  | "unresolvable-entrypoint-target"
  | "jsx-runtime-dependency"
  | "bin-only-dependency"
  | "config-named-dependency"
  | "capacitor-platform-dependency"
  // Elixir frontend (ADR 0011). The vocabulary is language-agnostic by
  // construction, but these three classes are only ever cited by the Elixir
  // frontend; core applies their scope/cap with zero language knowledge, exactly
  // as for the TS classes above.
  | "elixir-behaviour-callback"
  | "elixir-dynamic-dispatch"
  | "elixir-phoenix-runtime"
  | "rustler-ambiguous-registration";

// ---------------------------------------------------------------------------
// Nodes
// ---------------------------------------------------------------------------

export type NodeKind = "symbol" | "file" | "dependency" | "endpoint" | "entrypoint";

/**
 * Production/test/config roots (architecture.md §3). All three are emitted in
 * M3: `production` anchors dead-code claims; `config` and `test` roots keep
 * their reachable code alive but never, on their own, license a dead claim
 * (test partitioning + the `test-only` verdict are M5).
 */
export type EntrypointKind = "production" | "test" | "config";

/** A discovered, analyzable source file. Identity: its POSIX repo-relative path. */
export interface FileNode {
  readonly kind: "file";
  readonly id: string;
  /** POSIX, repo-relative. */
  readonly path: string;
}

/**
 * A public export of a file. Identity: `<file>#<exportedName>`.
 *
 * `local` distinguishes a symbol **declared** in `file` (`export const x`) from
 * one **forwarded** by a re-export (`export { x } from "…"`,
 * `import * as ns …; export { ns }`). A local symbol is a liveness leaf; a
 * forwarded symbol has an outgoing `references`/`re-export` edge to its origin,
 * so reaching it propagates down the barrel chain (architecture.md §3).
 */
export interface SymbolNode {
  readonly kind: "symbol";
  readonly id: string;
  /** POSIX, repo-relative path of the file that exposes this symbol. */
  readonly file: string;
  /** Public export name; `"default"` for the default export. */
  readonly exportedName: string;
  /**
   * Frontend-local spelling when known. It is a declaration identity only when
   * `localNameKind` is `Name`; `Default` denotes the synthetic binding created
   * by a default assignment expression.
   */
  readonly localName?: string;
  /** Oxc local-name discriminator, retained for sound alias identity. */
  readonly localNameKind?: "Name" | "Default" | "None";
  readonly isDefault: boolean;
  /** `export type`/`import type`-only — a real reference, never downgraded (architecture.md §4). */
  readonly typeOnly: boolean;
  /** `true` ⇒ declared in `file`; `false` ⇒ forwarded via a re-export. */
  readonly local: boolean;
  /** Span of the export declaration / re-export entry. */
  readonly span: Site["span"];
  /**
   * A `/* unused:ignore <reason> *\/` directive anchored to this export's
   * declaration, carried through so claim emission can either attach a valid
   * suppression or warn on stderr and leave a malformed directive unsuppressed
   * (PRD §6). Present only when a directive anchored here; `reason` is `null`
   * for a malformed (reason-less) directive.
   */
  readonly suppression?: {
    readonly reason: string | null;
    readonly valid: boolean;
  };
}

/**
 * An external npm package (an `external` resolution). Identity: the package
 * name. Feeds M4 dependency claims; a dependency node is always alive (a leaf
 * leaving the analyzed world), never itself flagged by file/export reachability.
 */
export interface DependencyNode {
  readonly kind: "dependency";
  readonly id: string;
  readonly packageName: string;
}

/**
 * A cross-boundary endpoint (tier 3). **Type present, never constructed in
 * v1** — the schema is frozen so the endpoint→consumer join (`consumes`) can
 * land additively later (architecture.md §3, PRD §4).
 */
export interface EndpointNode {
  readonly kind: "endpoint";
  readonly id: string;
  readonly protocol: string;
  readonly route: string;
}

/**
 * A reachability root. M2 emits only `entryKind: "production"`.
 *
 * The entrypoint→file relationship is carried as the node's `file` field, **not
 * as an edge**: an entrypoint originates in `package.json` (a `main`/`exports`/
 * `bin` field), which the pipeline does not parse into spanned records, so there
 * is no referencing *site* to satisfy the every-edge-has-a-span invariant. T2.4
 * seeds reachability from each entrypoint's `file`. `reason` records which
 * package.json field (or the zero-config fallback) produced it, for why-paths.
 */
export interface EntrypointNode {
  readonly kind: "entrypoint";
  readonly id: string;
  readonly entryKind: EntrypointKind;
  /** POSIX, repo-relative path of the rooted file. */
  readonly file: string;
  /** e.g. `"main"`, `"module"`, `"exports"`, `"bin"`, `"fallback:src/index.ts"`. */
  readonly reason: string;
}

export type IRNode = FileNode | SymbolNode | DependencyNode | EndpointNode | EntrypointNode;

// ---------------------------------------------------------------------------
// Edges
// ---------------------------------------------------------------------------

/**
 * `references` — a referencing site to its target.
 * `exports`    — a file to a public export symbol it exposes (the export surface).
 * `contains`   — a file to a symbol **declared** in it (structural membership).
 * `consumes`   — convention facts joined by a bridge plugin. The first concrete
 *                use is Rustler: Elixir stub→endpoint→Rust NIF.
 *
 * In v1 `contains` is the locally-declared subset of `exports` (we model only
 * exported symbols); the split is kept so private declarations can join
 * `contains` without touching the export-surface meaning later.
 */
export type EdgeKind = "references" | "exports" | "contains" | "consumes";

/**
 * The `references`-edge sub-kind (architecture.md §3):
 *  - `static`          — a static import / type import (resolved statically).
 *  - `dynamic-resolved`— a string-literal `import()` / `require()` that resolved.
 *  - `runtime-resolved`— a literal runtime convention resolved to one symbol.
 *  - `re-export`       — a barrel edge (`export … from`), symbol- or file-level.
 *  - `side-effect`     — `import "./x"`: keeps the file alive, binds no symbol.
 *  - `hazard`          — a keep-alive edge whose target must stay reachable
 *                        because absence could not be proven (`internal-declaration`,
 *                        etc.); carries `hazardClass`.
 */
export type ReferenceKind =
  | "static"
  | "dynamic-resolved"
  | "runtime-resolved"
  | "re-export"
  | "side-effect"
  | "hazard";

export interface IREdge {
  readonly kind: EdgeKind;
  /** Present iff `kind === "references"`. */
  readonly referenceKind?: ReferenceKind;
  /** Source node id. */
  readonly from: string;
  /** Target node id. */
  readonly to: string;
  /** The referencing site — required on **every** edge (architecture.md §3). */
  readonly site: Site;
  /**
   * The imported/referenced/exported name, when one applies (a named import, a
   * named re-export, an export symbol). `"*"` for a namespace/star surface edge.
   * Absent for side-effect edges. Carried for why-paths and for T2.4's
   * resolve-name-through-a-star-chain step.
   */
  readonly name?: string;
  /** `true` for a type-only reference (annotation, `import type`, `TSImportType`). */
  readonly typeOnly?: boolean;
  /** Present iff `referenceKind === "hazard"` — the cited hazard class (closed enum). */
  readonly hazardClass?: HazardClass;
}

// ---------------------------------------------------------------------------
// Hazard annotations
// ---------------------------------------------------------------------------

/**
 * A hazard the frontend cites against a file: a mechanism where syntax could
 * not prove a reference absent, or an edge that leaves the analyzed world
 * (`outside-project`). Unlike a `hazard` **edge**, an annotation names no
 * in-graph target — it exists for provenance and for M3's confidence caps
 * (keep-alive semantics land in T2.4/M3). Every annotation carries a {@link Site}.
 */
export interface HazardAnnotation {
  /** Node id of the file the hazard attaches to. */
  readonly file: string;
  /** Cited hazard class (closed enum; scope/cap in the M3 registry). */
  readonly hazardClass: HazardClass;
  /** One-line human-readable "why" (feeds the M3 report/why-path). */
  readonly detail: string;
  readonly site: Site;
  /**
   * The concrete target of a `directory-subtree`-scoped hazard (registry): the
   * repo-relative path **prefix** every in-scope file starts with — e.g.
   * `"src/mods/"` for `import(`./mods/${x}.js`)` in `src/index.ts`. Absent (or
   * `""`) ⇒ the importer's whole package (no static prefix). Meaningless for
   * other scopes and ignored there.
   */
  readonly subtreePrefix?: string;
}

// ---------------------------------------------------------------------------
// Stable id helpers (kind + canonical identity)
// ---------------------------------------------------------------------------

/** `file:<posixRelPath>`. */
export function fileId(posixRelPath: string): string {
  return `file:${posixRelPath}`;
}

/** `symbol:<posixRelPath>#<exportedName>`. */
export function symbolId(posixRelPath: string, exportedName: string): string {
  return `symbol:${posixRelPath}#${exportedName}`;
}

/** `dependency:<packageName>`. */
export function dependencyId(packageName: string): string {
  return `dependency:${packageName}`;
}

/** `endpoint:<protocol>:<route>` (reserved; never emitted in v1). */
export function endpointId(protocol: string, route: string): string {
  return `endpoint:${protocol}:${route}`;
}

/** `entrypoint:<kind>:<posixRelPath>`. */
export function entrypointId(kind: EntrypointKind, posixRelPath: string): string {
  return `entrypoint:${kind}:${posixRelPath}`;
}
