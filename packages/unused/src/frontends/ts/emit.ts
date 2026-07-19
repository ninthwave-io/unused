/**
 * IR assembly for the TS/JS frontend (T2.3, phasing.md M2). Turns the
 * per-file {@link ModuleRecord}s (T2.1) + module {@link Resolver} (T2.2) into the
 * language-agnostic reference-graph {@link IRGraph} (architecture.md §3).
 *
 * The emitter lives in `frontends/ts` because it reads frontend records and calls
 * the frontend resolver; it writes only `core/ir` shapes. The reverse import —
 * `core/ir` reaching into a frontend — is forbidden (ADR 0003, dependency-cruiser).
 *
 * ## Mapping rules (architecture.md §3; spec T2.3)
 *  - static named/default import → a `references`/`static` edge from the importing
 *    **file** to the target **export symbol**, joined per-specifier by the
 *    imported name against the target file's export surface. When the name is not
 *    a symbol the target file directly declares (it is forwarded by `export *`, or
 *    genuinely absent) the edge targets the **file** and carries the name, so
 *    T2.4 can resolve it through the star chain (conservative — never a dead-end).
 *  - namespace import (`import * as ns`) → a `references`/`static` edge to the
 *    target **file** (keeps the whole export surface alive; per-member namespace
 *    tracking is a deferred recall improvement).
 *  - named re-export (`export { x } from`) → a symbol in this file whose
 *    `references`/`re-export` edge forwards to the origin symbol; `export * as ns`
 *    forwards the whole target surface. star re-export (`export * from`) → a
 *    **file-level** `references`/`re-export` edge (names unknown here; resolved
 *    conservatively by T2.4).
 *  - the namespace re-export boundary case `import * as ns from "./b"; export { ns }`
 *    → a `ns` symbol in the export surface whose `re-export` edge points at b's
 *    file: b's liveness rides the explicit chain (import edge + exported `ns`).
 *  - side-effect import (`import "./x"`) → a `references`/`side-effect` edge to the
 *    file (alive, binds no symbol — its exports stay individually flaggable).
 *  - string-literal `import()` / `require()` that resolved → `references`/
 *    `dynamic-resolved` edge to the file surface.
 *  - `TSImportType` (`import("./x").T`) → a type-only `references`/`static` edge to
 *    the file (qualifier-level join deferred; keep the whole surface alive).
 *  - computed `import()`/`require()`, `import =`/`export =`, parse errors,
 *    unresolvable imports, `outside-project` → **hazard annotations** on the file;
 *    `internal-declaration` (and a `.d.ts` companion of an imported source) →
 *    keep-alive `references`/`hazard` **edges** to the declaration file. Keep-alive
 *    downgrade semantics land in T2.4/M3; here they are recorded with provenance.
 *  - external package → a `dependency` node + a `references` edge (feeds M4).
 *    Node builtins are ignored (not a tracked dependency in v1).
 *
 * Every edge and hazard annotation carries the referencing site's span
 * (architecture.md §3). Construction is deterministic: files are fed in discovery
 * (sorted) order and each record is walked imports → exports → dynamic → require →
 * type-imports in source order.
 */

import { readFileSync } from "node:fs";
import { join, posix, relative, resolve as resolvePath, sep } from "node:path";
import {
  dependencyId,
  type EntrypointNode,
  fileId,
  type HazardClass,
  type IREdge,
  IRGraph,
  type ReferenceKind,
  type Site,
  symbolId,
} from "../../core/ir/index.js";
import type { ModuleRecord, Span } from "./module-record.js";
import type { Resolution, Resolver } from "./resolve.js";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** A `package.json` shape, as far as entrypoint detection reads it (all optional). */
export interface PackageJsonLike {
  main?: unknown;
  module?: unknown;
  exports?: unknown;
  bin?: unknown;
}

/**
 * One package whose entrypoints seed liveness (T4.2). In a monorepo the frontend
 * passes the root package plus every workspace member, so each gets its own
 * `main`/`module`/`exports`/`bin` entrypoint set inside the one shared graph.
 * Single-package analysis omits {@link EmitInput.packages} entirely (behaviour is
 * byte-identical to the pre-T4.2 single-root path).
 */
export interface EmitPackageUnit {
  /** Absolute path to the package directory (base for resolving its entry targets). */
  readonly dir: string;
  /** POSIX, root-relative directory (`""` for the root package, else e.g. `packages/app`). */
  readonly rootRelDir: string;
  /** The package's parsed `package.json`, or `null` when it declares none. */
  readonly packageJson: PackageJsonLike | null;
}

export interface EmitInput {
  /** Absolute path to the analysis (project) root. */
  projectRoot: string;
  /**
   * Records for the **full** discovered file set (absolute `filePath`s). Internal
   * resolutions are expected to land on files that have a record; a target
   * without one still gets a bare file node (never a silent drop).
   */
  records: readonly ModuleRecord[];
  /**
   * The T2.2 resolver for this project (the root/default resolver). Used for
   * every specifier in single-package analysis, and for root-owned files (and as
   * the fallback) in a monorepo. See {@link resolversByUnitDir}.
   */
  resolver: Resolver;
  /**
   * Per-workspace-member resolvers, keyed by the member's **absolute directory**
   * (T4.6). When present, each importing file resolves through its *deepest
   * owning* member's resolver — so a member's own
   * `tsconfig.json#paths`/`baseUrl`/`extends` govern module resolution for the
   * files under it (the workspace-member-`paths` fix) — and each unit's
   * entrypoint detection uses its own resolver. A file under no member (a
   * root-owned file) falls back to {@link resolver}. Omitted for single-package
   * analysis, where {@link resolver} resolves every file — byte-identical to the
   * pre-T4.6 single-resolver path. Passed together with {@link packages}.
   */
  resolversByUnitDir?: ReadonlyMap<string, Resolver>;
  /**
   * The project's `package.json`. `undefined` ⇒ read `<root>/package.json` from
   * disk (missing/invalid ⇒ zero-config fallback). `null` ⇒ treat as absent.
   */
  packageJson?: PackageJsonLike | null;
  /**
   * tsconfig `compilerOptions.emitDecoratorMetadata` (T3.1b). Extraction emits an
   * `emit-decorator-metadata` candidate marker for every decorated file; that
   * marker only becomes a real hazard annotation when this flag is `true`
   * (decorator metadata is a runtime-reference mechanism only under this option).
   * Absent/`false` ⇒ decorated files carry no decorator-metadata hazard. In a
   * monorepo the composition layer ORs this across all packages' tsconfigs
   * (over-approximating the keep-alive costs recall, never precision).
   */
  emitDecoratorMetadata?: boolean;
  /**
   * The packages whose entrypoints seed liveness (T4.2). In a monorepo: the root
   * package plus every workspace member (each detected against its own
   * `package.json`, rooted at its own directory). Omitted for single-package
   * analysis, where the root `package.json` (or {@link packageJson}) is the sole
   * entrypoint source — the byte-identical pre-T4.2 path.
   */
  packages?: readonly EmitPackageUnit[];
}

/** Assemble the reference-graph IR for one project. */
export function emitIR(input: EmitInput): IRGraph {
  const root = resolvePath(input.projectRoot);
  const rel = (abs: string): string => toPosixRel(root, abs);
  const graph = new IRGraph();

  // Per-unit resolver selection (T4.6). A file is owned by the deepest workspace
  // member whose directory contains it; that member's resolver (its own tsconfig
  // `paths`/`baseUrl`/`extends`) resolves the file's specifiers, else the root
  // resolver. Absent map ⇒ the single root resolver for every file — the
  // byte-identical single-package path.
  const resolversByUnitDir = input.resolversByUnitDir ?? null;
  const unitsByDepth =
    resolversByUnitDir !== null && input.packages !== undefined
      ? [...input.packages].sort((a, b) => resolvePath(b.dir).length - resolvePath(a.dir).length)
      : [];
  const resolverForFile = (absFilePath: string): Resolver => {
    if (resolversByUnitDir === null) return input.resolver;
    for (const unit of unitsByDepth) {
      if (isUnderDir(absFilePath, resolvePath(unit.dir))) {
        return resolversByUnitDir.get(unit.dir) ?? input.resolver;
      }
    }
    return input.resolver;
  };

  const site = (fileRel: string, span: Span): Site => ({ file: fileRel, span });
  const ensureFile = (fileRel: string): void => {
    const id = fileId(fileRel);
    if (!graph.hasNode(id)) graph.addNode({ kind: "file", id, path: fileRel });
  };
  const addDependency = (packageName: string): string => {
    const id = dependencyId(packageName);
    if (!graph.hasNode(id)) graph.addNode({ kind: "dependency", id, packageName });
    return id;
  };

  // --- Phase 1: file + symbol nodes, exports/contains edges, surface map ---
  // surface: fileRel -> (exportedName -> symbolId). Built for ALL files before
  // any join in phase 2 (a named import joins against another file's surface).
  const surface = new Map<string, Map<string, string>>();

  for (const record of input.records) {
    const fileRel = rel(record.filePath);
    ensureFile(fileRel);
    const nsLocals = namespaceLocalsOf(record);
    const suppressionByName = suppressionsByName(record);
    const names = new Map<string, string>();

    for (const exp of record.exports) {
      if (exp.kind === "star-reexport") continue; // no named symbol (surface unknown here)
      const exportedName = exp.exportedName;
      const id = symbolId(fileRel, exportedName);
      const isNamespaceReexport =
        exp.kind === "local" && exp.localName !== null && nsLocals.has(exp.localName);
      const isLocal = exp.kind === "local" && !isNamespaceReexport;
      const isDefault = exp.kind === "local" ? exp.isDefault : exportedName === "default";
      const localName = exp.kind === "local" ? exp.localName : null;
      const suppression =
        suppressionByName.get(exportedName) ??
        (localName !== null ? suppressionByName.get(localName) : undefined);

      graph.addNode({
        kind: "symbol",
        id,
        file: fileRel,
        exportedName,
        ...(exp.kind === "local" ? { localNameKind: exp.localNameKind } : {}),
        ...(isLocal && localName !== null && localName !== exportedName ? { localName } : {}),
        isDefault,
        typeOnly: exp.typeOnly,
        local: isLocal,
        span: exp.span,
        ...(suppression !== undefined ? { suppression } : {}),
      });
      graph.addEdge(
        structuralEdge(
          "exports",
          fileId(fileRel),
          id,
          site(fileRel, exp.span),
          exportedName,
          exp.typeOnly,
        ),
      );
      // `contains` = declared here. Forwarded (re-export) symbols are not declared.
      if (isLocal) {
        graph.addEdge(
          structuralEdge(
            "contains",
            fileId(fileRel),
            id,
            site(fileRel, exp.span),
            exportedName,
            exp.typeOnly,
          ),
        );
      }
      names.set(exportedName, id);
    }
    surface.set(fileRel, names);
  }

  // --- Phase 2: reference edges + hazards ---------------------------------
  for (const record of input.records) {
    const fileRel = rel(record.filePath);
    const fileNode = fileId(fileRel);
    const nsLocals = namespaceLocalsOf(record);
    // Resolve this file's specifiers through its owning workspace member's
    // resolver (member tsconfig `paths`), root resolver otherwise (T4.6).
    const recordResolver = resolverForFile(record.filePath);
    // localName -> target file rel (internal namespace import), for `export { ns }`.
    const namespaceTargets = new Map<string, string | null>();

    // Emit a reference edge to a resolved target, joining a named specifier to the
    // target file's export symbol where possible; file-level otherwise.
    const emitNamed = (
      refKind: ReferenceKind,
      from: string,
      ownerFileRel: string,
      outcome: Resolution,
      name: string,
      s: Site,
      typeOnly: boolean,
    ): void => {
      if (outcome.kind === "internal") {
        const targetRel = rel(outcome.path);
        ensureFile(targetRel);
        keepDeclarationCompanion(outcome, from, s);
        const sym = surface.get(targetRel)?.get(name);
        const to = sym ?? fileId(targetRel);
        graph.addEdge(referencesEdge(refKind, from, to, s, name, typeOnly));
      } else {
        emitNonInternal(refKind, from, ownerFileRel, outcome, s, name, typeOnly);
      }
    };

    // Emit a file-level reference edge (namespace / dynamic / require / type-import
    // / star): the whole target surface, never joined to a single symbol.
    const emitFileLevel = (
      refKind: ReferenceKind,
      from: string,
      ownerFileRel: string,
      outcome: Resolution,
      s: Site,
      name: string | undefined,
      typeOnly: boolean,
    ): void => {
      if (outcome.kind === "internal") {
        const targetRel = rel(outcome.path);
        ensureFile(targetRel);
        keepDeclarationCompanion(outcome, from, s);
        graph.addEdge(referencesEdge(refKind, from, fileId(targetRel), s, name, typeOnly));
      } else {
        emitNonInternal(refKind, from, ownerFileRel, outcome, s, name, typeOnly);
      }
    };

    // Non-internal outcomes: dependency edge / keep-alive declaration edge /
    // hazard annotation. builtins are ignored.
    const emitNonInternal = (
      refKind: ReferenceKind,
      from: string,
      ownerFileRel: string,
      outcome: Resolution,
      s: Site,
      name: string | undefined,
      typeOnly: boolean,
    ): void => {
      switch (outcome.kind) {
        case "external": {
          const depId = addDependency(outcome.packageName);
          graph.addEdge(referencesEdge(refKind, from, depId, s, name, typeOnly));
          return;
        }
        case "internal-declaration": {
          const declRel = rel(outcome.path);
          ensureFile(declRel);
          graph.addEdge(
            hazardEdge(from, fileId(declRel), s, "internal-declaration", name, typeOnly),
          );
          return;
        }
        case "outside-project": {
          graph.addHazard({
            file: fileId(ownerFileRel),
            hazardClass: "outside-project",
            detail: `resolves outside the analyzable project: ${rel(outcome.path)}`,
            site: s,
          });
          return;
        }
        case "unresolvable": {
          graph.addHazard({
            file: fileId(ownerFileRel),
            hazardClass: "unresolvable-import",
            detail: outcome.reason,
            site: s,
          });
          return;
        }
        case "builtin":
          return; // Node builtin — not a tracked dependency in v1.
      }
    };

    // Keep an imported source's `.d.ts` companion alive (it is discovered but has
    // no other importer; flagging it would be a false positive on a live pair).
    const keepDeclarationCompanion = (outcome: Resolution, from: string, s: Site): void => {
      if (outcome.kind !== "internal" || outcome.declaration === undefined) return;
      const declRel = rel(outcome.declaration);
      ensureFile(declRel);
      graph.addEdge(hazardEdge(from, fileId(declRel), s, "declaration-companion", undefined, true));
    };

    // 2a. static imports (named/default/namespace) + side-effect imports.
    for (const imp of record.imports) {
      const outcome = recordResolver.resolve(
        imp.source,
        record.filePath,
        imp.sourceSpan,
        "import",
      ).outcome;
      if (imp.sideEffect) {
        emitFileLevel(
          "side-effect",
          fileNode,
          fileRel,
          outcome,
          site(fileRel, imp.sourceSpan),
          undefined,
          false,
        );
        continue;
      }
      for (const s of imp.specifiers) {
        const spec = site(fileRel, s.span);
        if (s.kind === "namespace") {
          namespaceTargets.set(s.localName, outcome.kind === "internal" ? rel(outcome.path) : null);
          emitFileLevel("static", fileNode, fileRel, outcome, spec, "*", s.typeOnly);
        } else {
          emitNamed("static", fileNode, fileRel, outcome, s.importedName, spec, s.typeOnly);
        }
      }
    }

    // 2b. re-exports (named + star) and the namespace re-export local export.
    for (const exp of record.exports) {
      if (exp.kind === "named-reexport") {
        const symId = symbolId(fileRel, exp.exportedName);
        const outcome = recordResolver.resolve(
          exp.source,
          record.filePath,
          exp.sourceSpan,
          "re-export",
        ).outcome;
        const s = site(fileRel, exp.sourceSpan);
        if (exp.importedName === "*") {
          emitFileLevel("re-export", symId, fileRel, outcome, s, "*", exp.typeOnly);
        } else {
          emitNamed("re-export", symId, fileRel, outcome, exp.importedName, s, exp.typeOnly);
        }
      } else if (exp.kind === "star-reexport") {
        const outcome = recordResolver.resolve(
          exp.source,
          record.filePath,
          exp.sourceSpan,
          "re-export",
        ).outcome;
        emitFileLevel(
          "re-export",
          fileNode,
          fileRel,
          outcome,
          site(fileRel, exp.sourceSpan),
          "*",
          exp.typeOnly,
        );
      } else if (exp.localName !== null && nsLocals.has(exp.localName)) {
        // `import * as ns from "./b"; export { ns }` — the exported ns symbol
        // forwards b's whole surface. b's liveness rides this explicit edge.
        const target = namespaceTargets.get(exp.localName) ?? null;
        if (target !== null) {
          ensureFile(target);
          const symId = symbolId(fileRel, exp.exportedName);
          graph.addEdge(
            referencesEdge(
              "re-export",
              symId,
              fileId(target),
              site(fileRel, exp.span),
              "*",
              exp.typeOnly,
            ),
          );
        }
      }
    }

    // 2c. string-literal dynamic import() → dynamic-resolved (computed ⇒ hazard, below).
    for (const dyn of record.dynamicImports) {
      if (dyn.source === null) continue;
      const outcome = recordResolver.resolve(
        dyn.source,
        record.filePath,
        dyn.argSpan,
        "dynamic-import",
      ).outcome;
      emitFileLevel(
        "dynamic-resolved",
        fileNode,
        fileRel,
        outcome,
        site(fileRel, dyn.argSpan),
        undefined,
        false,
      );
    }

    // 2d. string-literal require() → dynamic-resolved.
    for (const req of record.requires) {
      if (req.source === null) continue;
      const outcome = recordResolver.resolve(
        req.source,
        record.filePath,
        req.argSpan,
        "require",
      ).outcome;
      emitFileLevel(
        "dynamic-resolved",
        fileNode,
        fileRel,
        outcome,
        site(fileRel, req.argSpan),
        undefined,
        false,
      );
    }

    // 2e. TSImportType → type-only static edge to the file surface.
    for (const ti of record.typeImports) {
      const outcome = recordResolver.resolve(
        ti.source,
        record.filePath,
        ti.sourceSpan,
        "type-import",
      ).outcome;
      emitFileLevel(
        "static",
        fileNode,
        fileRel,
        outcome,
        site(fileRel, ti.sourceSpan),
        ti.qualifier ?? undefined,
        true,
      );
    }

    // 2f. parse/extract hazards already captured on the record (computed-*,
    // computed-cjs-exports, import-equals, export-assignment, parse-error,
    // checker-only-type-relationship, and the gated emit-decorator-metadata).
    // Suppressions were attached to their symbol nodes in phase 1. For the
    // `directory-subtree`-scoped computed classes, resolve the source-relative
    // static prefix against the importing file into the repo-relative
    // `subtreePrefix` the claim engine matches file paths against (M3 registry).
    for (const hz of record.hazards) {
      // A decorated file is only an `emit-decorator-metadata` hazard when the
      // project compiles with `emitDecoratorMetadata` (the runtime-metadata
      // mechanism); otherwise the candidate marker is dropped here.
      if (hz.kind === "emit-decorator-metadata" && input.emitDecoratorMetadata !== true) continue;
      const subtreePrefix =
        hz.kind === "computed-dynamic-import" || hz.kind === "computed-require"
          ? resolveSubtreePrefix(fileRel, hz.scopePrefix ?? "")
          : undefined;
      graph.addHazard({
        file: fileNode,
        hazardClass: hz.kind,
        detail: hz.detail,
        site: site(fileRel, hz.span),
        ...(subtreePrefix !== undefined ? { subtreePrefix } : {}),
      });
    }

    // 2g. intra-file reachability (the aws-lambda cluster fix). A top-level
    // exported symbol that references a sibling — directly, or through private
    // module-scope bindings — keeps that sibling alive. We flatten the
    // extractor's local-name adjacency into export→export `static` edges: for
    // each exported symbol, the exported siblings transitively reachable through
    // the (possibly private) intra-file reference chain. Reachability only walks
    // these once the source symbol is itself reached, so a dead symbol's
    // intra-file uses stay dead — precise, never an over-reach.
    emitIntraFileEdges(graph, fileRel, record, site);
  }

  // --- Phase 3: production entrypoints, per workspace package (T4.2) -------
  // Each package unit (the root, plus every workspace member in a monorepo) is
  // detected against its OWN package.json, rooted at its OWN directory, so its
  // `main`/`module`/`exports`/`bin` targets become entrypoints; the resulting
  // package-relative hits are re-based to root-relative for the shared graph.
  // Single-package analysis (no `packages`) is the degenerate one-unit case and
  // stays byte-identical to the pre-T4.2 single-root path.
  const recordRels = new Set(input.records.map((r) => rel(r.filePath)));
  const units: readonly EmitPackageUnit[] = input.packages ?? [
    {
      dir: root,
      rootRelDir: "",
      packageJson: input.packageJson === undefined ? readPackageJson(root) : input.packageJson,
    },
  ];
  for (const unit of units) {
    // Detect each unit's entrypoints through its own resolver (T4.6); entry
    // targets are package-relative, so this matches the pre-T4.6 single-resolver
    // result while keeping the owning-member tsconfig consistent per unit.
    const unitResolver = resolversByUnitDir?.get(unit.dir) ?? input.resolver;
    const detection = detectProductionEntrypointsWithDiagnostics(
      unit.packageJson,
      unit.dir,
      unitResolver,
      { fallbackFiles: unitRelativeFiles(recordRels, unit.rootRelDir) },
    );
    for (const hit of detection.hits) {
      const fileRel = joinRootRel(unit.rootRelDir, hit.file);
      ensureFile(fileRel);
      graph.addNode(entrypointNode(fileRel, hit.reason));
    }

    // T3.6 (the hono trap): a declared entrypoint target that resolved to nothing
    // internal — even after the `dist/**`→`src/**` remap — means the declared
    // public API is incomplete (typically an unbuilt `dist/`). Emit a project-scope
    // `unresolvable-entrypoint-target` hazard (whole-package medium cap): with the
    // public-API surface broken, no file can be confidently proven dead. This
    // replaces M2's silent collapse to a single `index.*` fallback. Sited at the
    // OWNING unit's package.json so the claim engine's whole-package cap scopes to
    // that workspace member (T4.2), never the whole monorepo — a member with an
    // unbuilt `dist/` does not cap its siblings.
    if (detection.unresolvedTargets.length > 0) {
      const [first] = detection.unresolvedTargets;
      const pkgRel = joinRootRel(unit.rootRelDir, "package.json");
      graph.addHazard({
        file: fileId(pkgRel),
        hazardClass: "unresolvable-entrypoint-target",
        detail:
          `${detection.unresolvedTargets.length} declared package.json entrypoint target(s) ` +
          `could not be resolved to a project file (e.g. \`${first}\`) — the declared public ` +
          "API is incomplete (unbuilt dist/? misconfigured exports?), so no file can be proven " +
          "dead. Whole-package cap: medium.",
        site: { file: pkgRel, span: { ...ENTRY_SPAN } },
      });
    }
  }

  return graph;
}

// ---------------------------------------------------------------------------
// Entrypoint detection (freezes the zero-config entry contract; spec T2.3.1)
// ---------------------------------------------------------------------------

/** One detected production entrypoint: a rooted file (POSIX rel) + why. */
export interface EntrypointHit {
  file: string;
  reason: string;
}

export interface EntrypointOptions {
  /**
   * POSIX-relative paths that exist in the analyzed set — the zero-config
   * fallback is chosen from these when no package.json entry field resolved.
   */
  fallbackFiles?: ReadonlySet<string>;
}

/** Candidate fallback files, in preference order (documented zero-config contract). */
const FALLBACK_CANDIDATES = ["index.ts", "src/index.ts", "index.js", "src/index.js"] as const;

/** Source extensions tried when remapping a `dist/**` entrypoint target to `src/**` (T3.6). */
const SRC_REMAP_EXTENSIONS = [
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
] as const;

const ENTRY_SPAN: Span = { start: 0, end: 0, startLine: 1, endLine: 1 };

/**
 * Diagnostics from entrypoint detection (T3.6): the resolved entrypoint hits
 * plus the declared targets that resolved to nothing internal (even after the
 * `dist/**`→`src/**` remap). A non-empty {@link unresolvedTargets} means the
 * declared public API is incomplete — the caller raises an
 * `unresolvable-entrypoint-target` hazard.
 */
export interface EntrypointDetection {
  readonly hits: EntrypointHit[];
  readonly unresolvedTargets: string[];
}

/**
 * Resolve a project's production entrypoints (spec T2.3.1). Reads `main`,
 * `module`, `exports` (**all** conditions' string targets), and `bin` (string and
 * object forms) via the T2.2 resolver; each target that resolves to an internal
 * file becomes an entrypoint. De-duplicated by file, first field wins
 * (main → module → exports → bin) for a stable `reason`.
 *
 * **Zero-config fallback**: with no declared entry field at all, the first of
 * `index.ts`, `src/index.ts`, `index.js`, `src/index.js` present in the analyzed
 * set is the entrypoint. With none, the project has **no** entrypoints — T2.4
 * treats an entrypoint-less package conservatively (nothing is a confident root,
 * so exports are not proven dead). Wildcard (`*`) exports subpaths are skipped in
 * M2 (glob expansion is M4).
 *
 * This thin wrapper returns only the hits; callers needing the unbuilt-entrypoint
 * signal use {@link detectProductionEntrypointsWithDiagnostics} (T3.6), which also
 * applies the `dist/**`→`src/**` remap and reports unresolved declared targets.
 */
export function detectProductionEntrypoints(
  pkg: PackageJsonLike | null,
  projectRoot: string,
  resolver: Resolver,
  options?: EntrypointOptions,
): EntrypointHit[] {
  return detectProductionEntrypointsWithDiagnostics(pkg, projectRoot, resolver, options).hits;
}

/**
 * Like {@link detectProductionEntrypoints}, but also reports the declared
 * targets that could not be resolved (T3.6). Resolution order per target:
 *  1. resolve the declared specifier normally;
 *  2. if that fails and the target is under `dist/`, try the same subpath under
 *     `src/` with source extensions (a documented, deliberately-narrow heuristic
 *     for the common "analyzed before `npm run build`" case — `dist/` is absent
 *     but its `src/` sources are present); a remapped hit is a production
 *     entrypoint;
 *  3. otherwise the target is unresolved.
 *
 * **No silent fallback on a broken entry (T3.6):** the zero-config `index.*`
 * fallback fires ONLY when the package declared no resolvable/unresolvable entry
 * targets at all (a genuinely entrypoint-less package). When declared targets
 * existed but failed to resolve, we do NOT quietly collapse to `index.*` (M2's
 * bug — it discarded the rest of a multi-subpath `exports` map); the caller
 * raises the `unresolvable-entrypoint-target` hazard instead.
 */
export function detectProductionEntrypointsWithDiagnostics(
  pkg: PackageJsonLike | null,
  projectRoot: string,
  resolver: Resolver,
  options?: EntrypointOptions,
): EntrypointDetection {
  const root = resolvePath(projectRoot);
  const rel = (abs: string): string => toPosixRel(root, abs);
  const from = join(root, "package.json");
  const fallbackFiles = options?.fallbackFiles;
  const hits: EntrypointHit[] = [];
  const unresolvedTargets: string[] = [];
  const seen = new Set<string>();

  const add = (fileRel: string, reason: string): void => {
    if (seen.has(fileRel)) return;
    seen.add(fileRel);
    hits.push({ file: fileRel, reason });
  };
  const tryTarget = (target: unknown, reason: string): void => {
    const norm = normalizeEntryTarget(target);
    if (norm === null) return; // wildcard / non-string: not a declared resolvable target
    const outcome = resolver.resolve(norm, from, ENTRY_SPAN, "import").outcome;
    if (outcome.kind === "internal" || outcome.kind === "internal-declaration") {
      add(rel(outcome.path), reason);
      return;
    }
    const remapped = remapDistTargetToSrc(norm, fallbackFiles);
    if (remapped !== null) {
      add(remapped, `${reason}:remapped-src`);
      return;
    }
    unresolvedTargets.push(typeof target === "string" ? target : String(target));
  };

  if (pkg !== null) {
    if (typeof pkg.main === "string") tryTarget(pkg.main, "main");
    if (typeof pkg.module === "string") tryTarget(pkg.module, "module");
    for (const target of collectExportsTargets(pkg.exports)) tryTarget(target, "exports");
    for (const target of collectBinTargets(pkg.bin)) tryTarget(target, "bin");
  }

  // Zero-config fallback only when nothing was declared at all (no hit AND no
  // unresolved declared target). A declared-but-broken entry is NOT masked here.
  if (hits.length === 0 && unresolvedTargets.length === 0 && fallbackFiles !== undefined) {
    for (const cand of FALLBACK_CANDIDATES) {
      if (fallbackFiles.has(cand)) {
        add(cand, `fallback:${cand}`);
        break;
      }
    }
  }

  return { hits, unresolvedTargets };
}

/**
 * The `dist/**`→`src/**` remap (T3.6, documented heuristic). A declared target
 * `./dist/helper/accepts/index.js` becomes the first of
 * `src/helper/accepts/index.{ts,tsx,mts,cts,js,…}` that exists in the analyzed
 * file set. Only the leading `dist/` segment is swapped and only the source-file
 * extension varies — a deliberately narrow rewrite, never a fuzzy search. `.d.ts`
 * (a `types` condition) is stripped too, so its source `.ts` can be recovered.
 * Returns the matched repo-relative path, or `null` when no candidate exists.
 */
function remapDistTargetToSrc(
  norm: string,
  fallbackFiles: ReadonlySet<string> | undefined,
): string | null {
  if (fallbackFiles === undefined) return null;
  const relTarget = norm.replace(/^\.\//, "");
  if (!relTarget.startsWith("dist/")) return null;
  const underSrc = `src/${relTarget.slice("dist/".length)}`;
  const stem = underSrc.replace(/\.d\.[cm]?ts$/i, "").replace(/\.[cm]?[jt]sx?$/i, "");
  for (const ext of SRC_REMAP_EXTENSIONS) {
    const candidate = stem + ext;
    if (fallbackFiles.has(candidate)) return candidate;
  }
  return null;
}

/** Every string leaf of a package.json `exports` value (all subpaths + conditions). */
function collectExportsTargets(exports: unknown): string[] {
  if (typeof exports === "string") return [exports];
  if (Array.isArray(exports)) return exports.flatMap(collectExportsTargets);
  if (exports !== null && typeof exports === "object") {
    return Object.values(exports as Record<string, unknown>).flatMap(collectExportsTargets);
  }
  return [];
}

/** package.json `bin` targets: a string, or the values of an object form. */
function collectBinTargets(bin: unknown): string[] {
  if (typeof bin === "string") return [bin];
  if (bin !== null && typeof bin === "object") {
    return Object.values(bin as Record<string, unknown>).filter(
      (v): v is string => typeof v === "string",
    );
  }
  return [];
}

/**
 * Normalize a package.json entry target for resolution. Entry fields are always
 * package-relative even without a leading `./` (`"main": "src/index.ts"`), so a
 * bare relative target is prefixed — otherwise oxc-resolver would treat it as an
 * external package. Wildcard and non-string targets are skipped.
 */
function normalizeEntryTarget(target: unknown): string | null {
  if (typeof target !== "string" || target === "" || target.includes("*")) return null;
  if (target.startsWith("./") || target.startsWith("../") || target.startsWith("/")) return target;
  return `./${target}`;
}

function readPackageJson(root: string): PackageJsonLike | null {
  try {
    const raw = readFileSync(join(root, "package.json"), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    return parsed !== null && typeof parsed === "object" ? (parsed as PackageJsonLike) : null;
  } catch {
    return null;
  }
}

function entrypointNode(fileRel: string, reason: string): EntrypointNode {
  return {
    kind: "entrypoint",
    id: `entrypoint:production:${fileRel}`,
    entryKind: "production",
    file: fileRel,
    reason,
  };
}

// ---------------------------------------------------------------------------
// Edge builders (omit optional fields rather than set them undefined —
// exactOptionalPropertyTypes) + small pure helpers
// ---------------------------------------------------------------------------

/**
 * Flatten a file's intra-file reference adjacency (top-level local name →
 * top-level local name, exported or private) into export→export `static`
 * reference edges (the aws-lambda cluster fix). For each exported symbol, a DFS
 * over the adjacency collects the exported siblings it can reach *through* any
 * private module-scope bindings on the way (`handle` → `getProcessor` →
 * `const albProcessor = new ALBProcessor()` → `ALBProcessor`), and one edge is
 * emitted to each. Private intermediaries are not IR nodes, so the transitive
 * hop is materialised here rather than walked at reachability time.
 *
 * Edges are anchored at the owning symbol's declaration span (the flattened
 * transitive edge has no single use-site). They only ever *add* reachability
 * from an already-reached symbol, so this can lower false positives but never
 * introduce one.
 */
function emitIntraFileEdges(
  graph: IRGraph,
  fileRel: string,
  record: ModuleRecord,
  site: (fileRel: string, span: Span) => Site,
): void {
  if (record.intraFileRefs.length === 0) return;

  // Exported local bindings: their local name → (symbol id, declaration span).
  // Only locally-declared exports have a body that can reference siblings;
  // re-export forwards are handled by the star-chain machinery, not here.
  const exportedLocal = new Map<string, { readonly sym: string; readonly span: Span }>();
  for (const exp of record.exports) {
    if (exp.kind === "local" && exp.localName !== null) {
      const localName = exp.localName;
      if (!exportedLocal.has(localName)) {
        exportedLocal.set(localName, { sym: symbolId(fileRel, exp.exportedName), span: exp.span });
      }
    }
  }
  if (exportedLocal.size === 0) return;

  // Adjacency over ALL top-level local names (exported + private intermediaries).
  const adj = new Map<string, string[]>();
  for (const ref of record.intraFileRefs) {
    const bucket = adj.get(ref.from);
    if (bucket === undefined) adj.set(ref.from, [ref.to]);
    else bucket.push(ref.to);
  }

  for (const [ownerLocal, owner] of exportedLocal) {
    // DFS from the owner over the (private-inclusive) adjacency; emit an edge to
    // every distinct exported symbol reached (excluding the owner itself).
    const seen = new Set<string>([ownerLocal]);
    const stack = [...(adj.get(ownerLocal) ?? [])];
    while (stack.length > 0) {
      const name = stack.pop() as string;
      if (seen.has(name)) continue;
      seen.add(name);
      const target = exportedLocal.get(name);
      if (target !== undefined && target.sym !== owner.sym) {
        graph.addEdge(
          referencesEdge("static", owner.sym, target.sym, site(fileRel, owner.span), name, false),
        );
      }
      for (const next of adj.get(name) ?? []) if (!seen.has(next)) stack.push(next);
    }
  }
}

function referencesEdge(
  referenceKind: ReferenceKind,
  from: string,
  to: string,
  site: Site,
  name: string | undefined,
  typeOnly: boolean,
): IREdge {
  return {
    kind: "references",
    referenceKind,
    from,
    to,
    site,
    ...(name !== undefined ? { name } : {}),
    ...(typeOnly ? { typeOnly } : {}),
  };
}

function hazardEdge(
  from: string,
  to: string,
  site: Site,
  hazardClass: HazardClass,
  name: string | undefined,
  typeOnly: boolean,
): IREdge {
  return {
    kind: "references",
    referenceKind: "hazard",
    from,
    to,
    site,
    hazardClass,
    ...(name !== undefined ? { name } : {}),
    ...(typeOnly ? { typeOnly } : {}),
  };
}

function structuralEdge(
  kind: "exports" | "contains",
  from: string,
  to: string,
  site: Site,
  name: string,
  typeOnly: boolean,
): IREdge {
  return {
    kind,
    from,
    to,
    site,
    name,
    ...(typeOnly ? { typeOnly } : {}),
  };
}

/** Local binding names introduced by `import * as ns` specifiers in a record. */
function namespaceLocalsOf(record: ModuleRecord): Set<string> {
  const out = new Set<string>();
  for (const imp of record.imports) {
    for (const s of imp.specifiers) {
      if (s.kind === "namespace") out.add(s.localName);
    }
  }
  return out;
}

/** Suppressions keyed by the anchored declaration name (for symbol attachment). */
function suppressionsByName(
  record: ModuleRecord,
): Map<string, { reason: string | null; valid: boolean }> {
  const out = new Map<string, { reason: string | null; valid: boolean }>();
  for (const sup of record.suppressions) {
    if (sup.targetName === null) continue;
    if (!out.has(sup.targetName)) out.set(sup.targetName, { reason: sup.reason, valid: sup.valid });
  }
  return out;
}

/** Absolute path → POSIX, repo/project-relative. */
function toPosixRel(root: string, abs: string): string {
  return relative(root, abs).split(sep).join("/");
}

/** Is absolute `path` equal to, or contained within, absolute directory `dir`? (Segment-boundary safe.) */
function isUnderDir(path: string, dir: string): boolean {
  if (path === dir) return true;
  const prefix = dir.endsWith(sep) ? dir : dir + sep;
  return path.startsWith(prefix);
}

/**
 * Re-base the root-relative record set to a package's own directory (T4.2), so
 * the zero-config entrypoint fallback (`index.ts`, `src/index.ts`, …) is checked
 * package-relative. `rootRelDir === ""` (the root package) returns the set
 * unchanged. Files outside the package are dropped.
 */
function unitRelativeFiles(recordRels: ReadonlySet<string>, rootRelDir: string): Set<string> {
  if (rootRelDir === "") return new Set(recordRels);
  const prefix = `${rootRelDir}/`;
  const out = new Set<string>();
  for (const rel of recordRels) {
    if (rel.startsWith(prefix)) out.add(rel.slice(prefix.length));
  }
  return out;
}

/** Prefix a package-relative path with its root-relative directory (T4.2). */
function joinRootRel(rootRelDir: string, fileRel: string): string {
  return rootRelDir === "" ? fileRel : posix.join(rootRelDir, fileRel);
}

/**
 * Resolve a computed specifier's source-relative static prefix against the
 * importing file into a repo-relative path prefix the claim engine matches with
 * `startsWith` (the `directory-subtree` hazard scope, M3 registry). A trailing
 * `/` (a directory prefix like `./mods/`) is preserved so the match respects the
 * directory boundary; a non-directory stem (`./route-`) is kept verbatim. An
 * empty prefix ⇒ `""` ⇒ the importer's whole package (matches every file).
 *
 * **FP-critical (reviewer):** when the prefix resolves to the **repo root** —
 * `` import(`./${x}.js`) `` in a root-level file, or `` import(`../${x}.js`) ``
 * one directory down — `posix.join` yields `"."`, and a naive `"./"` prefix
 * matches NO repo-relative path (they never start with `./`). That would cap
 * ZERO files and leak every dynamically-reachable dead file as a *high*-
 * confidence claim. Root resolution therefore collapses to `""` (whole-package
 * scope). A prefix that escapes the project (`".."`) is left as-is: it correctly
 * matches no in-project file, because its targets genuinely live outside.
 */
function resolveSubtreePrefix(importerRel: string, rawPrefix: string): string {
  if (rawPrefix === "") return "";
  const slash = importerRel.lastIndexOf("/");
  const importerDir = slash === -1 ? "" : importerRel.slice(0, slash);
  const combined = posix.join(importerDir, rawPrefix);
  if (combined === "." || combined === "" || combined === "./") return ""; // repo root ⇒ whole package
  return rawPrefix.endsWith("/") && !combined.endsWith("/") ? `${combined}/` : combined;
}
