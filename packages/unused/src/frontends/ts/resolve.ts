/**
 * Module resolution for the TS/JS frontend (T2.2, phasing.md M2).
 *
 * Turns every specifier a {@link ModuleRecord} can carry — static import
 * sources, named/star re-export sources, string-literal `import()`/`require()`
 * arguments, and `TSImportType` (`import('…')`) sources — into a **closed,
 * documented {@link Resolution} outcome** for a given project root. Resolution
 * is the second correctness-critical core deliverable (ADR 0005): a wrong edge
 * here is a wrong reachability answer, which is a false positive.
 *
 * ## Stack (ADR 0005, research 2026-07 §1)
 *  - **oxc-resolver** (enhanced-resolve port) does the actual filesystem walk:
 *    `exports`/`imports` maps with conditions, self-references, node_modules,
 *    directory/index, and — via `extensionAlias` — the NodeNext ESM habit of
 *    writing `./x.js` for a `./x.ts` source (our own codebase does this).
 *  - **get-tsconfig** discovers the project's tsconfig (resolving the `extends`
 *    chain) and exposes a `paths`/`baseUrl` matcher. The tsconfig is fed to
 *    oxc-resolver (`tsconfig.configFile`), which applies `paths`/`baseUrl`
 *    during resolution; the get-tsconfig matcher is used to *classify* a bare
 *    specifier that failed to resolve — an alias-shaped one is a broken alias
 *    (a hazard), a package-shaped one is an external dependency.
 *
 * ## The false-positive contract
 *  - The {@link Resolution} union is **closed**. A specifier is `internal`,
 *    `outside-project`, `external`, `builtin`, or `unresolvable`.
 *  - `unresolvable` is **never a crash and never silently dropped**: it carries
 *    the import-site span and converts to a {@link HazardMarker} via
 *    {@link unresolvableToHazard} (degrade toward alive — an edge whose target
 *    is *unknown*, not *absent*, must keep that target reachable).
 *  - **Deterministic**: same inputs → same outputs. oxc-resolver / get-tsconfig
 *    are pure over the filesystem; the builtin set is fixed per Node version;
 *    package-name extraction and classification are pure string/path logic;
 *    {@link resolveModuleRecord} emits results in a fixed order.
 *
 * ## Conditions (documented default)
 * {@link DEFAULT_CONDITIONS} = `["types", "import", "node", "default"]`. We do
 * source-level liveness analysis, so we prefer, in order: `types` (reach a
 * package's `.d.ts`/typed entrypoint), `import` (ESM source — our own `.ts` via
 * `extensionAlias`), `node`, then `default` as the catch-all. We deliberately
 * omit `require` and `browser`: conditional `exports`/`browser` remapping is an
 * explicitly-modelled M3 hazard class (architecture.md §4), so we pick one
 * deterministic condition set here rather than silently following bundler-only
 * remaps. Callers may override via {@link ResolverOptions.conditionNames}.
 *
 * ## `.d.ts` re-resolution (FP-critical)
 * `types`-first has a trap: an internal exports map like
 * `{ "./comp": { "types": "./comp.d.ts", "import": "./comp.ts" } }` resolves to
 * the *declaration*, so the real `comp.ts` — the runtime implementation — would
 * lose its only incoming edge and be flagged a confident false "unused". So when
 * an **internal** resolution lands on a declaration file, we re-resolve the same
 * specifier with a **source-first** condition set (conditions minus `types`): if
 * that yields a non-declaration source, that source is the resolution and the
 * `.d.ts` is recorded as {@link InternalResolution.declaration}; if only the
 * declaration exists, we return {@link InternalDeclarationResolution} —
 * keep-alive, never a dead-end. (Declarations resolved *inside `node_modules`*
 * are left as `external`: a dependency's `.d.ts` is fine as-is.)
 *
 * ## URL / scheme specifiers
 * `import("https://esm.sh/x")`, `data:` URIs, `file:` URLs and Windows drive
 * paths (`C:\\…`) carry a `scheme:` before the first `/`. These are not npm
 * packages; classifying them `external` would fabricate a phantom dependency
 * (`https:`, `data:text`, `C:\\…`). They are `unresolvable` (hazard). `node:` is
 * exempt — it is handled as a builtin first.
 *
 * ## Platform / determinism caveats
 *  - Deterministic **per platform**: same inputs → same outputs on a given host.
 *  - **Case-insensitive filesystems diverge**: macOS/Windows resolve `./Foo.js`
 *    to a `foo.ts` on disk; Linux does not. Both outcomes degrade toward alive
 *    (`internal` vs `unresolvable`-hazard), but the classification can differ
 *    across platforms — accepted, and never a confident false "unused".
 *  - **`.ts` wins over a same-name `.js`**: with both `x.ts` and `x.js` present,
 *    {@link RESOLVE_EXTENSIONS} probes `.ts` first (matching tsc/Knip). A
 *    hand-authored `x.js` shadowed by an `x.ts` can therefore look unused —
 *    accepted and documented.
 *
 * ## Symlink policy (consistent with discover.ts)
 * discover.ts does **not** follow symlinks; neither does resolution
 * (`symlinks: false` — oxc-resolver keeps the requested path, it does not
 * `realpath()` through a symlink). Two consequences, both represented rather
 * than hidden:
 *  - A resolution can land on a real file **outside** the project root
 *    (`../` escapes, a monorepo sibling). That is `outside-project`, not
 *    `unresolvable` and not `internal` — T2.3 treats it as a keep-alive edge to
 *    an un-analyzed module, **never a dead-end**.
 *  - A resolution can land on a path **inside** the root that discovery never
 *    collected (a symlinked file discovery skipped, or `dist/`/`node_modules`).
 *    When the {@link ResolverOptions.discoveredFiles} set is supplied it is the
 *    authority: an internal path absent from it is downgraded to
 *    `outside-project` for the same reason.
 */

import { builtinModules } from "node:module";
import { dirname, resolve as resolvePath, sep } from "node:path";
import { createPathsMatcher, getTsconfig, type PathsMatcher } from "get-tsconfig";
import { type NapiResolveOptions, ResolverFactory } from "oxc-resolver";
import type { HazardMarker, ModuleRecord, Span } from "./module-record.js";

// ---------------------------------------------------------------------------
// Outcome union (closed)
// ---------------------------------------------------------------------------

/** Resolved to an absolute file path that is inside the analyzable project. */
export interface InternalResolution {
  readonly kind: "internal";
  /** Absolute path of the resolved file (inside the project root). */
  readonly path: string;
  /**
   * Companion `.d.ts` when the specifier's `types` condition pointed at a
   * declaration and we re-resolved to this source file (see the `.d.ts`
   * re-resolution policy in the file header). Present only in that case.
   */
  readonly declaration?: string;
}

/**
 * Resolved to a `.d.ts`/`.d.mts`/`.d.cts` **declaration** inside the project for
 * which no non-declaration source could be found (a declaration-only module, or
 * a package whose exports map exposes only a `types` condition). T2.3 must treat
 * this as **keep-alive** for the target module — hazard-equivalent, never a
 * dead-end (a declaration has no runtime body to flag "unused", but its presence
 * as an import target proves the module is referenced).
 */
export interface InternalDeclarationResolution {
  readonly kind: "internal-declaration";
  /** Absolute path of the resolved declaration file (inside the project root). */
  readonly path: string;
}

/**
 * Resolved to a real file that the analysis does not own: outside the project
 * root, or inside it but not in the discovered file set (symlink-skipped,
 * `dist/`, …). A keep-alive edge to an un-analyzed module — **not** a dead-end.
 */
export interface OutsideProjectResolution {
  readonly kind: "outside-project";
  readonly path: string;
}

/**
 * A bare specifier that names an npm package (resolved into `node_modules`, or
 * not installed but syntactically a package). Feeds M3 dependency claims.
 */
export interface ExternalResolution {
  readonly kind: "external";
  /** Package name, scope-aware: `@scope/pkg/sub` → `@scope/pkg`, `lodash/fp` → `lodash`. */
  readonly packageName: string;
  /** Subpath after the package name (`sub` in `@scope/pkg/sub`), or `null` for a bare package. */
  readonly subpath: string | null;
  /** Absolute resolved path when the package is installed; `null` when it is not. */
  readonly path: string | null;
}

/** A Node.js builtin (`node:`-prefixed, or a bare builtin such as `fs`). */
export interface BuiltinResolution {
  readonly kind: "builtin";
  /** Canonical module id with any `node:` prefix stripped (`fs`, `fs/promises`, `path`). */
  readonly name: string;
}

/**
 * A static, string-literal specifier that could not be resolved to a file or a
 * package. **Hazard-ready**: {@link unresolvableToHazard} maps it to a
 * `unresolvable-import` {@link HazardMarker} carrying the import-site span.
 */
export interface UnresolvableResolution {
  readonly kind: "unresolvable";
  /** Human-readable reason (feeds the M3 report/why-path). */
  readonly reason: string;
}

export type Resolution =
  | InternalResolution
  | InternalDeclarationResolution
  | OutsideProjectResolution
  | ExternalResolution
  | BuiltinResolution
  | UnresolvableResolution;

/** Which specifier slot of a {@link ModuleRecord} a resolution came from. */
export type SpecifierOrigin = "import" | "re-export" | "dynamic-import" | "require" | "type-import";

/**
 * One resolved specifier: the original string, the importing file, where in
 * the record it came from, the import-site span (for hazards/provenance), and
 * the {@link Resolution} outcome. Everything a graph edge (T2.3) needs.
 */
export interface ResolvedSpecifier {
  readonly specifier: string;
  readonly importer: string;
  readonly origin: SpecifierOrigin;
  readonly span: Span;
  readonly outcome: Resolution;
}

// ---------------------------------------------------------------------------
// Resolver configuration
// ---------------------------------------------------------------------------

/** Documented default `exports`/`imports` condition set — see the file header. */
export const DEFAULT_CONDITIONS = ["types", "import", "node", "default"] as const;

/**
 * Extensions oxc-resolver probes, TS source first. Includes `.d.ts` family for
 * ambient declaration targets and `.json` for `resolveJsonModule`-style imports.
 */
const RESOLVE_EXTENSIONS = [
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".d.ts",
  ".d.mts",
  ".d.cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".json",
];

/**
 * NodeNext extension remapping: a `./x.js` specifier resolves to a `./x.ts`
 * source (and the `.mjs`/`.cjs`/`.jsx` analogues). Critical — our own codebase
 * writes `.js` specifiers for `.ts` files (ADR 0005, verbatimModuleSyntax).
 */
const EXTENSION_ALIAS: Record<string, string[]> = {
  ".js": [".ts", ".tsx", ".js", ".jsx"],
  ".jsx": [".tsx", ".jsx"],
  ".mjs": [".mts", ".mjs"],
  ".cjs": [".cts", ".cjs"],
};

/** Package `main`-field preference: typed entrypoint, then ESM, then classic. */
const MAIN_FIELDS = ["types", "module", "main"];

export interface ResolverOptions {
  /** Absolute path to the project (analysis) root. */
  readonly projectRoot: string;
  /**
   * The discovered, analyzable file set (absolute paths, as `discover.ts`
   * emits). When supplied it is the authority for `internal` vs
   * `outside-project`: an internal path not in the set is `outside-project`
   * (symlink-skipped / excluded), so T2.3 never mistakes it for a dead-end.
   */
  readonly discoveredFiles?: ReadonlySet<string>;
  /** Override {@link DEFAULT_CONDITIONS}. */
  readonly conditionNames?: readonly string[];
}

const BUILTIN_SET: ReadonlySet<string> = new Set(builtinModules);

// ---------------------------------------------------------------------------
// Resolver
// ---------------------------------------------------------------------------

/**
 * A per-project resolver. Construct once per project root and reuse across all
 * of its files — it holds oxc-resolver's factory (and its cache) plus the
 * discovered tsconfig. Cheap to call; deterministic.
 */
export class Resolver {
  /** Absolute, normalized project root. */
  readonly projectRoot: string;
  /** Absolute path to the tsconfig applied (bounded to the project root), or `null`. */
  readonly tsconfigPath: string | null;

  private readonly factory: ResolverFactory;
  /**
   * A clone of {@link factory} with the `types` condition removed, used to
   * re-resolve a specifier that landed on a `.d.ts` to its real source (see the
   * `.d.ts` re-resolution policy in the file header). `null` when the condition
   * set has no `types` (nothing to re-resolve past).
   */
  private readonly sourceFactory: ResolverFactory | null;
  private readonly pathsMatcher: PathsMatcher | null;
  private readonly discovered: ReadonlySet<string> | null;

  constructor(options: ResolverOptions) {
    this.projectRoot = resolvePath(options.projectRoot);
    this.discovered = options.discoveredFiles ?? null;

    // Discover the tsconfig via get-tsconfig (walks up, resolving `extends`).
    // Bound it to the project root: a fixture/package with no tsconfig of its
    // own must not silently inherit an ancestor repo's `paths`.
    const found = getTsconfig(this.projectRoot);
    const bounded = found !== null && isInside(found.path, this.projectRoot) ? found : null;
    this.tsconfigPath = bounded?.path ?? null;
    this.pathsMatcher = bounded !== null ? createPathsMatcher(bounded) : null;

    const conditions = [...(options.conditionNames ?? DEFAULT_CONDITIONS)];
    const factoryOptions: NapiResolveOptions = {
      extensions: RESOLVE_EXTENSIONS,
      extensionAlias: EXTENSION_ALIAS,
      conditionNames: conditions,
      mainFields: MAIN_FIELDS,
      // discover.ts does not follow symlinks; keep resolution consistent.
      symlinks: false,
    };
    // Set `tsconfig` only when present — `exactOptionalPropertyTypes` forbids an
    // explicit `undefined` on the optional oxc-resolver option.
    if (this.tsconfigPath !== null) {
      factoryOptions.tsconfig = { configFile: this.tsconfigPath, references: "auto" };
    }
    this.factory = new ResolverFactory(factoryOptions);

    // Source-first clone (shares the cache) for `.d.ts` re-resolution.
    const sourceConditions = conditions.filter((c) => c !== "types");
    this.sourceFactory =
      sourceConditions.length < conditions.length
        ? this.factory.cloneWithOptions({ conditionNames: sourceConditions })
        : null;
  }

  /** Resolve one specifier from `importer`, carrying its import-site `span`. */
  resolve(
    specifier: string,
    importer: string,
    span: Span,
    origin: SpecifierOrigin,
  ): ResolvedSpecifier {
    return { specifier, importer, origin, span, outcome: this.classify(specifier, importer) };
  }

  private classify(specifier: string, importer: string): Resolution {
    // 1. Builtins first — oxc-resolver is not configured to resolve them
    //    (`builtinModules` off), so it would report them as unresolvable.
    const builtin = builtinNameOf(specifier);
    if (builtin !== null) return { kind: "builtin", name: builtin };

    // 2. URL / scheme specifiers (`https:`, `data:`, `file:`, `C:\…`) are not
    //    packages — classify as unresolvable rather than fabricate a phantom
    //    dependency named after the scheme. (`node:` handled above.)
    const scheme = schemeOf(specifier);
    if (scheme !== null) {
      return {
        kind: "unresolvable",
        reason: `URL/scheme specifier '${specifier}' is not a module`,
      };
    }

    // 3. Filesystem resolution. oxc-resolver never throws for a miss — it
    //    returns `{ error }` — so this is crash-free by construction.
    const dir = dirname(importer);
    const result = this.factory.sync(dir, specifier);
    const path = result.path ?? null;
    if (path !== null) return this.classifyResolvedPath(specifier, path, dir);
    return this.classifyFailure(specifier, result.error);
  }

  private classifyResolvedPath(specifier: string, path: string, dir: string): Resolution {
    if (isInNodeModules(path)) {
      // A dependency's own `.d.ts` is a fine external resolution — do not
      // re-resolve; M3 dependency claims only need the package name.
      const packageName = packageNameOf(specifier) ?? packageNameFromNodeModulesPath(path);
      return {
        kind: "external",
        packageName: packageName ?? specifier,
        subpath: subpathOf(specifier),
        path,
      };
    }

    // Internal (or, per the discovered-set authority, outside-project).
    if (!isDeclarationFile(path)) return this.internalOutcome(path);

    // The specifier resolved to an internal `.d.ts`. Re-resolve source-first to
    // recover the real implementation; only dead-end-free outcomes result.
    if (this.sourceFactory !== null) {
      const src = this.sourceFactory.sync(dir, specifier).path ?? null;
      if (src !== null && !isDeclarationFile(src) && !isInNodeModules(src)) {
        const srcOutcome = this.internalOutcome(src);
        // Attach the declaration as a companion when the source stayed internal.
        return srcOutcome.kind === "internal"
          ? { kind: "internal", path: src, declaration: path }
          : srcOutcome;
      }
    }
    // Declaration-only: keep-alive, never a dead-end. Respect the discovered-set
    // authority (a declaration outside the analyzable set is outside-project).
    if (
      isInside(path, this.projectRoot) &&
      !(this.discovered !== null && !this.discovered.has(path))
    ) {
      return { kind: "internal-declaration", path };
    }
    return { kind: "outside-project", path };
  }

  /** Internal vs outside-project for a path already known to be non-node_modules. */
  private internalOutcome(path: string): InternalResolution | OutsideProjectResolution {
    if (isInside(path, this.projectRoot)) {
      if (this.discovered !== null && !this.discovered.has(path)) {
        return { kind: "outside-project", path };
      }
      return { kind: "internal", path };
    }
    return { kind: "outside-project", path };
  }

  private classifyFailure(specifier: string, error: string | undefined): Resolution {
    const reason = error ?? `cannot resolve '${specifier}'`;

    // A relative/absolute or package-internal (`#…`) specifier that misses is a
    // genuinely broken edge — a hazard, never re-read as an external package.
    if (specifier.startsWith(".") || specifier.startsWith("/") || specifier.startsWith("#")) {
      return { kind: "unresolvable", reason };
    }

    // A bare specifier that matched a tsconfig `paths` alias but did not resolve
    // is a broken alias (the alias target is missing) — a hazard, not a phantom
    // external dependency named after the alias prefix.
    if (this.pathsMatcher !== null && this.pathsMatcher(specifier).length > 0) {
      return { kind: "unresolvable", reason: `unresolved tsconfig path alias '${specifier}'` };
    }

    // Otherwise a bare specifier is an external package (possibly not installed
    // — M3 dependency claims still want the name). Fall back to unresolvable
    // only if it is not even a syntactically valid package specifier.
    const packageName = packageNameOf(specifier);
    if (packageName !== null) {
      return { kind: "external", packageName, subpath: subpathOf(specifier), path: null };
    }
    return { kind: "unresolvable", reason };
  }
}

// ---------------------------------------------------------------------------
// Record-level API
// ---------------------------------------------------------------------------

/**
 * Resolve **every** specifier a {@link ModuleRecord} carries, in a fixed order
 * (imports → re-export sources → string-literal dynamic imports → string-literal
 * requires → type-imports; source order within each). Computed dynamic imports
 * and requires (`source: null`) are already hazards from T2.1 and are skipped.
 */
export function resolveModuleRecord(record: ModuleRecord, resolver: Resolver): ResolvedSpecifier[] {
  const out: ResolvedSpecifier[] = [];
  const at = record.filePath;

  for (const imp of record.imports) {
    out.push(resolver.resolve(imp.source, at, imp.sourceSpan, "import"));
  }
  for (const exp of record.exports) {
    if (exp.kind === "named-reexport" || exp.kind === "star-reexport") {
      out.push(resolver.resolve(exp.source, at, exp.sourceSpan, "re-export"));
    }
  }
  for (const dyn of record.dynamicImports) {
    if (dyn.source !== null) {
      out.push(resolver.resolve(dyn.source, at, dyn.argSpan, "dynamic-import"));
    }
  }
  for (const req of record.requires) {
    if (req.source !== null) {
      out.push(resolver.resolve(req.source, at, req.argSpan, "require"));
    }
  }
  for (const ti of record.typeImports) {
    out.push(resolver.resolve(ti.source, at, ti.sourceSpan, "type-import"));
  }

  return out;
}

/**
 * Convert an `unresolvable` outcome into a `unresolvable-import`
 * {@link HazardMarker} anchored at the import-site span (degrade toward alive).
 * Throws only on misuse (a non-unresolvable outcome) — never on user input.
 */
export function unresolvableToHazard(resolved: ResolvedSpecifier): HazardMarker {
  if (resolved.outcome.kind !== "unresolvable") {
    throw new Error(`not an unresolvable resolution: ${resolved.outcome.kind}`);
  }
  return {
    kind: "unresolvable-import",
    detail: `unresolvable ${describeOrigin(resolved.origin)} '${resolved.specifier}' (${resolved.outcome.reason})`,
    span: resolved.span,
  };
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * The builtin module id for a specifier, or `null`. `node:`-prefixed specifiers
 * are always builtins (prefix stripped); a bare specifier is a builtin only if
 * it is in Node's `builtinModules` set (so `node:test` is a builtin but bare
 * `test` is not — matching Node's own addressing rules).
 */
function builtinNameOf(specifier: string): string | null {
  if (specifier.startsWith("node:")) return specifier.slice("node:".length);
  if (BUILTIN_SET.has(specifier)) return specifier;
  return null;
}

/**
 * Scope-aware npm package name of a bare specifier, or `null` when the
 * specifier is relative, absolute, package-internal (`#…`), or malformed.
 */
export function packageNameOf(specifier: string): string | null {
  if (
    specifier === "" ||
    specifier.startsWith(".") ||
    specifier.startsWith("/") ||
    specifier.startsWith("#") ||
    // URL/scheme specifiers (`https:`, `data:`, `C:\…`) are never packages —
    // guard here too so no caller can fabricate a scheme-named dependency.
    schemeOf(specifier) !== null
  ) {
    return null;
  }
  const parts = specifier.split("/");
  if (specifier.startsWith("@")) {
    const scope = parts[0];
    const name = parts[1];
    if (scope === undefined || name === undefined || scope === "@" || name === "") return null;
    return `${scope}/${name}`;
  }
  const head = parts[0];
  return head === undefined || head === "" ? null : head;
}

/** Subpath after the package name (`sub/deep` for `pkg/sub/deep`), or `null`. */
function subpathOf(specifier: string): string | null {
  const name = packageNameOf(specifier);
  if (name === null || specifier.length <= name.length + 1) return null;
  const rest = specifier.slice(name.length + 1);
  return rest === "" ? null : rest;
}

/** Recover a package name from a resolved `node_modules/<pkg>` path. */
function packageNameFromNodeModulesPath(path: string): string | null {
  const segments = path.split(sep);
  const idx = segments.lastIndexOf("node_modules");
  const first = idx >= 0 ? segments[idx + 1] : undefined;
  if (first === undefined || first === "") return null;
  if (first.startsWith("@")) {
    const second = segments[idx + 2];
    return second !== undefined && second !== "" ? `${first}/${second}` : first;
  }
  return first;
}

/** Does an absolute path contain a `node_modules` segment? */
function isInNodeModules(path: string): boolean {
  return path.split(sep).includes("node_modules");
}

/** Is this a TypeScript declaration file (`.d.ts` / `.d.mts` / `.d.cts`)? */
function isDeclarationFile(path: string): boolean {
  const lower = path.toLowerCase();
  return lower.endsWith(".d.ts") || lower.endsWith(".d.mts") || lower.endsWith(".d.cts");
}

/**
 * The URL/scheme of a specifier (`https`, `data`, `file`, or a Windows drive
 * letter `C`), or `null` when there is no scheme before the first `/`. A colon
 * that appears only after a slash is a path segment, not a scheme. `node:` is
 * caught here too but is handled earlier as a builtin.
 */
function schemeOf(specifier: string): string | null {
  const colon = specifier.indexOf(":");
  if (colon <= 0) return null;
  const slash = specifier.indexOf("/");
  if (slash >= 0 && slash < colon) return null;
  const scheme = specifier.slice(0, colon);
  return /^[a-zA-Z][a-zA-Z\d+.-]*$/.test(scheme) ? scheme : null;
}

/** Is `path` equal to, or contained within, `root`? (Segment-boundary safe.) */
function isInside(path: string, root: string): boolean {
  if (path === root) return true;
  const prefix = root.endsWith(sep) ? root : root + sep;
  return path.startsWith(prefix);
}

function describeOrigin(origin: SpecifierOrigin): string {
  switch (origin) {
    case "import":
      return "import";
    case "re-export":
      return "re-export source";
    case "dynamic-import":
      return "dynamic import";
    case "require":
      return "require";
    case "type-import":
      return "type import";
  }
}
