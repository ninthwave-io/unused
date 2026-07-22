/**
 * `analyzeProject` — the TS/JS frontend's composition entry (T2.4, phasing.md
 * M2). Wires the pipeline the earlier tasks built —
 * discover → parse → resolve → emit IR → reachability → claims — into a single
 * {@link ClaimRun} (the PRD §4 wire format).
 *
 * This module lives in `frontends/ts` because it performs file I/O and calls the
 * frontend (discover/parse/resolve/emit). The analysis itself is language-
 * agnostic and lives in `core/analysis`; this file only *composes* it. Core
 * never imports back (ADR 0003, dependency-cruiser).
 *
 * ## Entrypoint / keep-alive boundary hardening (T2.4 review)
 * Three confirmed high-confidence false-positive vectors are closed here, all at
 * the boundary between "what roots liveness" and "what is claimable":
 *
 *  1. **Config roots** (architecture.md §3 partition rule, pulled forward). A
 *     discovered source file whose basename matches a conservative config
 *     pattern (`*.config.{js,ts,mjs,cjs,mts,cts}`, or a `.*rc.{js,cjs,mjs}`) and
 *     that sits at a package root (a directory holding a `package.json`) is a
 *     **config root**: seeded as an `entryKind: "config"` reachability root (so
 *     its imported helpers stay alive) and never itself claimed. tsconfig* /
 *     package.json are non-source and already never claimed. YAML/JSONC configs
 *     remain M3 debt.
 *  2. **Wildcard subpath exports** (`"./*": "./src/*.js"`). `emitIR` skips `*`
 *     targets; here we expand each against the discovered file set (Node
 *     subpath-pattern semantics) and seed every match as a production entrypoint.
 *     A pattern we cannot expand confidently keep-alives its whole target
 *     subtree — never a silently-dropped public API.
 *  3. **Config-referenced files.** A discovered source file whose path appears
 *     as a **string** in any project `*.json` config *or* in a config root's own
 *     source (a jest `setupFiles` path, in `.json` or `.js`/`.ts`) is kept alive
 *     via a `config-referenced-file` hazard — a tool we do not model may load it.
 *     This can only *reduce* recall, never add a false positive.
 *
 * With **zero production entrypoints**, `core/analysis` emits no claims at all
 * (nothing anchors liveness) — the caller surfaces "no entrypoints detected".
 *
 * ## T3.1b — config-derived hazards composed here
 * Three M3 hazard classes need project config this composition layer reads:
 * `emitDecoratorMetadata` (a tsconfig `compilerOptions` flag, passed to `emitIR`
 * so a decorated file's candidate marker becomes a real hazard), `references` (a
 * tsconfig top-level array ⇒ a whole-package `project-references` cap), and
 * `conditional-exports-divergence` (package.json `exports` conditions / a
 * top-level `browser` remap whose non-selected branch's target files keep-alive).
 *
 * ## T3.6 — smoke-triage false-positive fixes (M3-gate)
 * Two of the four T3.6 fixes are composed here (the other two live in the
 * frontend `extract.ts`/`emit.ts` and core `claims.ts`/`reachability.ts`):
 *  - **Interim test-file recognition** — {@link isTestFilePath} seeds a `test`
 *    reachability root for every zero-config test file. Test-reachable code is
 *    kept alive (never claimed); the `test-only` verdict + partition report are
 *    M5. This is the M3-interim staging of tier-2, not tier-2 itself.
 *  - **Tool-invoked config-root widening** — {@link TOOL_CONFIG_ROOT_RE} adds
 *    `gulpfile`/`Gruntfile`/`webpack.config`/`rollup.config`/`karma.conf` to the
 *    config-root set (loaded by a tool by filename convention, not an import).
 */

import { readFile, stat } from "node:fs/promises";
import { basename, dirname, join, relative, resolve as resolvePath, sep } from "node:path";
import { getTsconfig } from "get-tsconfig";
import {
  computePartitionedReachability,
  emitClaims,
  type PartitionedReachability,
  type PerformanceTracker,
} from "../../core/analysis/index.js";
import {
  type Claim,
  type ClaimRun,
  computeSummary,
  type Provenance,
  SCHEMA_VERSION,
} from "../../core/claims/index.js";
import {
  dependencyId,
  entrypointId,
  fileId,
  type IRGraph,
  type Site,
} from "../../core/ir/index.js";
import type { FrontendClaimInputs, PluginDiagnostic } from "../plugins/types.js";
import {
  applyConfigSuppressions,
  type ConfigUnit,
  collectConfigEntrypoints,
  computeConfigHash,
  filterFilesByConfig,
  type GateThreshold,
  isClaimable,
  isIgnoredDependency,
  loadConfig,
  warnOnEmptyConfigMatches,
} from "./config.js";
import {
  browserCarrierRoots,
  browserRuntimeAssetReferences,
  type ConventionSource,
  cdkNodejsFunctionReferences,
  githubActionsRunRoots,
  k6PackageScriptRoots,
  mswWorkerRoots,
  nativeConfigScriptRoots,
  taskfileCommandRoots,
  viteVitestConfigReferences,
} from "./convention-references.js";
import { addConfigTokens, computeUnusedDependencies } from "./dependencies.js";
import { discoverProjectInventory } from "./discover.js";
import { type EmitPackageUnit, emitIR, type PackageJsonLike } from "./emit.js";
import { parseSource } from "./parse.js";
import {
  activePresetsForUnit,
  cdkAppEntrypoints,
  matchPresetEntryPatterns,
  storybookStoryEntrypoints,
  viteHtmlEntrypoints,
} from "./presets.js";
import { packageNameOf, Resolver } from "./resolve.js";
import { detectWorkspaces, type WorkspaceLayout } from "./workspaces.js";

const ANALYZER_NAME = "ts-reference-graph";
const DEFAULT_TOOL_VERSION = "0.1.0";
const SOURCE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"] as const;
/** Lockfiles are large machine-generated JSON and never reference source — skip. */
const LOCKFILE_NAMES = new Set(["package-lock.json", "npm-shrinkwrap.json"]);
/** Cap per-config-file read in the string scan (defends against a huge generated JSON). */
const CONFIG_FILE_SIZE_CAP = 4 * 1024 * 1024;
/** `foo.config.ts` etc. (any source ext). */
const CONFIG_ROOT_RE = /\.config\.(js|ts|mjs|cjs|mts|cts)$/i;
/** `.eslintrc.js`, `.babelrc.cjs` etc. (hidden ⇒ not discovered today, kept for completeness). */
const DOTRC_RE = /^\.[^./]*rc\.(js|cjs|mjs)$/i;
/**
 * Tool-invoked config roots loaded by a tool by filename convention, not by an
 * import edge (T3.6 widening): `gulpfile.*`, `Gruntfile.*`, `webpack.config.*`,
 * `rollup.config.*`, `karma.conf.*` (incl. `.babel`/`.dev`-infixed variants like
 * `gulpfile.babel.js`, `webpack.config.dev.ts`). `webpack.config.js` /
 * `rollup.config.js` already match {@link CONFIG_ROOT_RE}; listing them keeps the
 * intent explicit and covers the infixed forms it misses. Anchored at `^` so
 * `gulpfilehelper.js` (no boundary) is not a config root; the trailing `.` (or a
 * lone basename) requires a real extension boundary.
 */
const TOOL_CONFIG_ROOT_RE = /^(gulpfile|gruntfile|webpack\.config|rollup\.config|karma\.conf)\./i;
/** A `*.test.*` / `*.spec.*` basename (the `test`/`spec` segment right before the ext). */
const TEST_FILE_RE = /\.(test|spec|e2e|cy)\.[^.]+$/i;
/** Quoted string literals in JS/TS source (single/double, escape-aware; template strings skipped). */
const STRING_LITERAL_RE = /(['"])((?:\\.|(?!\1)[^\\\r\n])*)\1/g;

export interface AnalyzeOptions {
  /** Injectable clock for deterministic runs/tests. Defaults to `new Date()`. */
  readonly now?: Date;
  /** Tool/analyzer version stamped into the run and every claim. */
  readonly toolVersion?: string;
  /**
   * `--config <path>` (T4.3, PRD §6): load config from this path (resolved
   * against `rootDir`) instead of auto-discovering `unused.config.jsonc` /
   * `.json` at the root. A path that doesn't exist is a {@link ConfigError}
   * (CLI exit 3), never a silent fall-through to the zero-config default.
   */
  readonly configPath?: string;
  /** Respect nested `.gitignore` rules unless the CLI passed `--no-gitignore`. */
  readonly gitignore?: boolean;
  /** Opt-in phase timings and work counters; normal runs leave this absent. */
  readonly performance?: PerformanceTracker;
}

/** Frontend-composition controls that are intentionally absent from CLI options. */
export interface AnalyzeInternalOptions {
  /** Defer config-match diagnostics so mixed dispatch can evaluate the language union once. */
  readonly emitConfigMatchWarnings?: boolean;
  /** Convention families owned by repository plugins instead of this composition path. */
  readonly deferredConventions?: readonly DeferredConventionId[];
  /** Shared gitignore-bounded inventory supplied to the Elixir frontend. */
  readonly elixirSourceFiles?: readonly string[];
}

export type DeferredConventionId =
  | "github-actions-run"
  | "taskfile-command"
  | "native-config-script"
  | "elixir-scripts"
  | "elixir-runtime";

/**
 * {@link analyzeProject}'s return value: the PRD §4 wire format plus
 * out-of-band, non-schema fields used by human and CI surfaces.
 *
 * An empty `claims` array is genuinely ambiguous on its own: it is the
 * outcome of (a) a project with production entrypoints where nothing is
 * dead — a legitimately clean run — as well as (b) a project with **zero**
 * production entrypoints, where nothing anchors liveness and the analyzer
 * conservatively proves nothing (see the module docstring above and
 * `core/analysis/claims.ts`'s `productionEntrypointFiles.size === 0` guard).
 * Those two cases demand different UX (T2.5): silence for (a), a visible
 * warning for (b). `productionEntrypointCount` is exactly the
 * `reachability.productionEntrypointFiles.size` value `claims.ts` itself
 * guards on, plumbed up so the caller doesn't have to re-detect entrypoints
 * independently (which would drift from this file's wildcard-export and
 * config-root handling — see Fix 1/2 above).
 *
 * `fileCount`, `workspaceCount`, and `repoName` (T6.1, docs/design/cli-ux.md
 * §2 header — "acme-web (1,284 files, 3 workspaces) — 4.2s") are likewise
 * out-of-band: the header needs repo identity and scale figures the claim
 * schema itself has no field for (PRD §4 fixes the `ClaimRun` shape; these
 * three are analysis-time facts a reporter needs alongside it, not inside
 * it). The CLI strips these non-schema fields before any `--json`/SARIF
 * output, exactly as it already did for `productionEntrypointCount`.
 *
 * `units` and `gateThreshold` (M7, docs/phasing.md T7.1/T7.2) serve
 * `unused baseline`/`unused check`: baselines are written and diffed
 * per-workspace (`.unused/baseline.jsonl`, root + one per member), and the
 * gate needs the resolved threshold without re-loading config a second time.
 */
export interface AnalyzeResult extends ClaimRun {
  /** Deterministic out-of-band diagnostics rendered to stderr, never JSON stdout. */
  readonly diagnostics?: readonly PluginDiagnostic[];
  /** Count of production entrypoint files found before claim emission. */
  readonly productionEntrypointCount: number;
  /**
   * Number of files discovered and parsed for this run after `.gitignore`
   * handling. Config `project` does NOT reduce this count: it narrows
   * claimability only, not graph visibility — a file outside `project` (e.g. a
   * build script that imports analysed source) is still discovered, parsed,
   * and counted here, even though it can never itself receive a claim.
   */
  readonly fileCount: number;
  /** Number of package units in this run: 1 outside a monorepo, root + members inside one. */
  readonly workspaceCount: number;
  /** Root `package.json` `name`, or the root directory's basename when absent. */
  readonly repoName: string;
  /**
   * Every package unit in this run, root first (`rootRelDir: ""`) then each
   * workspace member — the same partition `annotateClaimPackages` tags
   * `subject.loc.package` from, exposed so `unused baseline`/`unused check`
   * (M7) can locate `.unused/baseline.jsonl` per unit without re-detecting
   * the workspace layout themselves.
   */
  readonly units: readonly { readonly rootRelDir: string; readonly name: string | null }[];
  /**
   * The resolved gate confidence floor (`unused check`'s default `"high"`,
   * or config `gate.threshold` — PRD §6/cli-ux §3) computed once here so the
   * CLI does not need a second `loadConfig` call to answer "what does the
   * gate compare against".
   */
  readonly gateThreshold: GateThreshold;
}

/**
 * {@link analyzeProjectWithGraph}'s return value: the {@link AnalyzeResult} the
 * reporters/CI surfaces consume, plus the reference-graph {@link IRGraph} and
 * the per-partition {@link PartitionedReachability} that produced it.
 *
 * The graph and reachability are deliberately NOT on {@link AnalyzeResult}: the
 * default report / `--json` / SARIF paths must never see them (the CLI's
 * out-of-band-field strip keeps `--json` equal to the claim-run schema). Only
 * the M8 `why`/MCP surfaces — which answer for ANY symbol, not just claimed-dead
 * ones, and render reference paths from stored provenance (PRD §5/§8) — need the
 * live graph and predecessor maps, so they call this entry instead.
 */
export interface AnalyzeWithGraph {
  readonly result: AnalyzeResult;
  /** The reference-graph IR the run was computed over (`why_alive` path queries). */
  readonly graph: IRGraph;
  /** The three per-partition reachability walks (production/config/test), with predecessor maps. */
  readonly reachability: PartitionedReachability;
  /** Inputs needed to re-emit this frontend's claims after repository graph merge. */
  readonly claimInputs: FrontendClaimInputs;
  readonly provenance: Provenance;
}

/**
 * Analyse the project rooted at `rootDir` and return a full {@link
 * AnalyzeResult} (a {@link ClaimRun} plus the disambiguating entrypoint
 * count above). Deterministic given a fixed clock: claims are id-sorted and
 * reachability is built from the deterministically-constructed IR.
 *
 * Thin wrapper over {@link analyzeProjectWithGraph} that drops the graph and
 * reachability — every existing caller (default report, `--json`, SARIF,
 * `unused check`/`baseline`) wants only the claim run, and never the live IR.
 */
export async function analyzeProject(
  rootDir: string,
  options: AnalyzeOptions = {},
): Promise<AnalyzeResult> {
  return (await analyzeProjectWithGraph(rootDir, options)).result;
}

/**
 * The full analysis: the {@link AnalyzeResult} plus the reference graph and
 * per-partition reachability it was derived from (M8 `why`/MCP — see
 * {@link AnalyzeWithGraph}). Byte-identical claim output to {@link
 * analyzeProject}; it simply also returns the two internals the why-path query
 * needs to answer for any symbol without re-analysis.
 */
export async function analyzeProjectWithGraph(
  rootDir: string,
  options: AnalyzeOptions = {},
  internal: AnalyzeInternalOptions = {},
): Promise<AnalyzeWithGraph> {
  const start = Date.now();
  const now = options.now ?? new Date();
  const version = options.toolVersion ?? DEFAULT_TOOL_VERSION;
  const root = resolvePath(rootDir);
  const performance = options.performance;
  const workspaceStarted = performance?.now();

  // T4.3 config (PRD §6, ADR 0010): `unused.config.jsonc`/`.json` at the root,
  // or `--config <path>`. Throws `ConfigError` on a missing `--config` target,
  // malformed JSON/JSONC, or a schema violation — the CLI maps it to exit 3.
  // Absent a config file this is `EMPTY_CONFIG`, under which every config-aware
  // step below is a documented no-op (the no-config regression contract).
  const config = await loadConfig(root, options.configPath);

  // Workspace auto-detect (T4.2, PRD §6). Throws `UnsupportedProjectError` on a
  // Yarn PnP layout BEFORE any analysis — a refusal, never a silent mis-answer;
  // the CLI maps the throw to exit 2 and surfaces the message.
  const layout = await detectWorkspaces(root);

  // Package units: the root package plus every workspace member. Each is its own
  // entrypoint set; all share ONE graph so cross-workspace imports resolve.
  const rootPkg = await readRootPackageJson(root);
  const units = buildPackageUnits(root, rootPkg, layout);
  const isWorkspace = layout.manager !== null;
  // Sibling-name resolution: `package name → member dir`, so a bare import of a
  // workspace member classifies internal (its source), never external (T4.2).
  const workspacePackages = isWorkspace ? buildWorkspaceMap(units) : undefined;
  const configUnits: ConfigUnit[] = units.map((u) => ({ rootRelDir: u.rootRelDir, name: u.name }));
  performance?.set("workspaces", units.length);
  if (workspaceStarted !== undefined) {
    performance?.finish("workspace-config-detection", workspaceStarted);
  }

  // discover → read → parse (single read per file, reused for line counts + scan).
  // Excluded-member subtrees (a would-be workspace member removed by a negative
  // glob) are dropped from the analyzable set entirely: they get no entrypoints,
  // so keeping their sources in scope would flag externally-built files as dead.
  // Out-of-scope like `node_modules`/`dist` — an import of one resolves
  // outside-project (keep-alive), never a claim. Project/suppression config is
  // deliberately graph-preserving (`filterFilesByConfig` returns its input
  // unchanged); `.gitignore` discovery is the only user-controlled filesystem
  // exclusion here and can be disabled with `--no-gitignore`.
  const excludedPrefixes = layout.excludedDirs.map((dir) => `${dir}/`);
  const useGitignore = options.gitignore !== false;
  const discoveryStarted = performance?.now();
  const inventory = await discoverProjectInventory(root, { gitignore: useGitignore });
  const discovered = inventory.sourceFiles
    .filter((file) => !isUnderExcluded(toPosixRel(root, file), excludedPrefixes))
    .map((file) => ({ abs: file, rel: toPosixRel(root, file) }));
  const scopedRel = new Set(
    filterFilesByConfig(
      discovered.map((d) => d.rel),
      config,
      configUnits,
    ),
  );
  const files = discovered.filter((d) => scopedRel.has(d.rel)).map((d) => d.abs);
  const jsonFiles = inventory.jsonFiles.filter(
    (file) =>
      !isUnderExcluded(toPosixRel(root, file), excludedPrefixes) &&
      !LOCKFILE_NAMES.has(basename(file)),
  );
  const packageRootDirs = new Set(
    inventory.packageRootDirs.filter((dir) => {
      const rel = toPosixRel(root, dir);
      return rel === "" || !isUnderExcluded(`${rel}/`, excludedPrefixes);
    }),
  );
  performance?.set("files", files.length);
  if (discoveryStarted !== undefined) performance?.finish("discovery-gitignore", discoveryStarted);
  const parsingStarted = performance?.now();
  const contents = await Promise.all(files.map((f) => readFile(f, "utf8")));
  const records = files.map((file, i) => parseSource(file, contents[i] as string));
  const contentByAbs = new Map(files.map((file, i) => [file, contents[i] as string]));

  const fileLineCounts = new Map<string, number>();
  files.forEach((file, i) => {
    fileLineCounts.set(fileId(toPosixRel(root, file)), countLines(contents[i] as string));
  });
  if (parsingStarted !== undefined) performance?.finish("parsing", parsingStarted);

  // resolve → emit IR (per-package production entrypoints from main/module/exports/bin).
  const discoveredSet = new Set(files);
  const rootResolver = new Resolver({
    projectRoot: root,
    discoveredFiles: discoveredSet,
    ...(workspacePackages !== undefined ? { workspacePackages } : {}),
    ...(performance === undefined ? {} : { performance }),
  });
  // T4.6 (M4 smoke "worst finding"): resolution must honour the OWNING workspace
  // member's tsconfig (`paths`/`baseUrl`/`extends`) for files under that member,
  // not just the monorepo root's. Build one resolver per member, each discovering
  // its tsconfig from the member's own directory (`projectRoot` stays the analysis
  // root, so internal/outside classification and the discovered-set authority are
  // unchanged — only tsconfig discovery is per-member). A member with no tsconfig
  // of its own walks up to the root's ⇒ root behaviour unchanged. Single-package:
  // only the root entry, so emitIR resolves every file with `rootResolver` —
  // byte-identical to the pre-T4.6 single-resolver path.
  const resolversByUnitDir = new Map<string, Resolver>([[root, rootResolver]]);
  if (isWorkspace) {
    for (const unit of units) {
      if (unit.rootRelDir === "") continue; // the root unit uses rootResolver
      resolversByUnitDir.set(
        unit.dir,
        new Resolver({
          projectRoot: root,
          discoveredFiles: discoveredSet,
          tsconfigDir: unit.dir,
          ...(workspacePackages !== undefined ? { workspacePackages } : {}),
          ...(performance === undefined ? {} : { performance }),
        }),
      );
    }
  }
  // emitDecoratorMetadata / project `references`: any package's tsconfig triggers
  // it (over-approximating the keep-alive only costs recall, never precision).
  const tsconfigOptions = readTsconfigOptionsForUnits(units);
  const graphStarted = performance?.now();
  const resolutionBefore = performance?.phaseTotal("module-resolution") ?? 0;
  const graph = emitIR({
    projectRoot: root,
    records,
    resolver: rootResolver,
    emitDecoratorMetadata: tsconfigOptions.emitDecoratorMetadata,
    // Single-package analysis omits `packages`/`resolversByUnitDir` → emitIR's
    // byte-identical one-unit path (every file resolved with `rootResolver`).
    ...(isWorkspace ? { packages: units, resolversByUnitDir } : {}),
  });
  if (graphStarted !== undefined && performance !== undefined) {
    const total = performance.elapsedSince(graphStarted);
    const resolution = performance.phaseTotal("module-resolution") - resolutionBefore;
    performance.emitAccumulated("module-resolution", resolution);
    performance.addDuration("graph-construction", Math.max(0, total - resolution), true);
  }

  // Fix 2 + T3.1b, per package: expand each unit's wildcard `exports` subpaths into
  // production entrypoints, and keep-alive files reachable only under a non-selected
  // package.json condition/browser branch.
  const conventionStarted = performance?.now();
  for (const unit of units) {
    const unresolvedWildcardSubpaths = seedWildcardExportEntrypoints(
      graph,
      root,
      unit.dir,
      files,
      unit.packageJson,
    );
    // A wildcard `exports` subpath that matched no project source file — even
    // after the dist/**→src/** remap — means a declared slice of the public API
    // could not be resolved (typically an unbuilt `dist/`). Cap the whole package
    // (the same `unresolvable-entrypoint-target` project hazard the singular-target
    // path raises in `emit.ts`): with the public surface incomplete, no file can
    // be proven dead. Sited at the OWNING unit's package.json so the whole-package
    // cap scopes to that member, not the whole monorepo (T4.2). Never silent — the
    // pre-fix behaviour dropped these wildcards with no signal at all.
    if (unresolvedWildcardSubpaths.length > 0) {
      const pkgRel = unit.rootRelDir === "" ? "package.json" : `${unit.rootRelDir}/package.json`;
      graph.addHazard({
        file: fileId(pkgRel),
        hazardClass: "unresolvable-entrypoint-target",
        detail:
          `${unresolvedWildcardSubpaths.length} wildcard exports subpath pattern(s) ` +
          `(e.g. \`${unresolvedWildcardSubpaths[0]}\`) matched no project source file, even after a ` +
          "dist/**→src/** remap — the declared public API is incomplete (unbuilt dist/? misconfigured " +
          "exports?), so no file can be proven dead. Whole-package cap: medium.",
        site: { file: pkgRel, span: { ...CONFIG_SITE_SPAN } },
      });
    }
    addConditionalExportsDivergenceHazards(
      graph,
      root,
      unit.dir,
      resolversByUnitDir.get(unit.dir) ?? rootResolver,
      files,
      unit.packageJson,
    );
  }
  // A tsconfig with `references` composes projects across the project boundary
  // (registry). The cap covers BOTH the referencing unit AND every referenced
  // unit: a referenced leaf (a `composite` package with no `references` of its
  // own) has its files consumed across the boundary — possibly by projects
  // outside this analysis — so its exports cannot be proven dead either (reviewer
  // fix). Each cap is sited at the OWNING unit's tsconfig, so it scopes to that
  // member, not the whole monorepo.
  const projectReferenceCapUnits = new Set<string>();
  for (const unit of units) {
    const referencedDirs = unitOwnTsconfigReferenceDirs(unit.dir);
    if (referencedDirs === null) continue;
    projectReferenceCapUnits.add(unit.rootRelDir); // the referencing unit
    for (const refDir of referencedDirs) {
      const owner = ownerUnitRootRelDir(units, refDir);
      if (owner !== null) projectReferenceCapUnits.add(owner); // the referenced unit
    }
  }
  for (const rootRelDir of projectReferenceCapUnits) addProjectReferencesHazard(graph, rootRelDir);

  // T4.3: config `entry` globs ADDITIVELY seed production entrypoints, on top
  // of auto-detection (never replacing it). Matched only against the
  // graph-visible `files` set. `project` affects claimability only; suppression
  // is applied after claims are emitted. No-op against `EMPTY_CONFIG`.
  const filesRel = files.map((file) => toPosixRel(root, file));
  const analyzedFileSet = new Set(filesRel);
  const conventionSources: ConventionSource[] = files.map((file) => ({
    file: toPosixRel(root, file),
    source: contentByAbs.get(file) ?? "",
  }));
  for (const hit of collectConfigEntrypoints(filesRel, config, configUnits)) {
    seedProductionEntrypoint(graph, hit.file, hit.reason);
  }

  // Reviewer-adopted optional item: warn (stderr) when an entry/project glob
  // or a workspaces key matches nothing — typo self-detection,
  // Knip parity. Diagnostic only; never affects claims. No-op against
  // `EMPTY_CONFIG`.
  if (internal.emitConfigMatchWarnings !== false) {
    warnOnEmptyConfigMatches(
      config,
      discovered.map((d) => d.rel),
      filesRel,
      configUnits,
    );
  }

  // T4.4: framework presets (vite/next), per package unit — auto-activated on
  // a marker config file/dependency, or forced uniformly by config `presets`
  // (see `presets.ts`). A file matched by an active preset's `entryPatterns`
  // (Next's `pages/**`/`app/**` convention files, middleware, instrumentation)
  // becomes a production entrypoint the same way a config `entry` glob does —
  // which is already sufficient to keep the WHOLE file's export surface alive
  // (T2.4's surface-live rule), satisfying PRD's "kept alive, never claimable"
  // note for API routes with no separate mechanism. Vite additionally scans
  // any top-level `index.html` for `<script src>` module references. No-op
  // when no preset is active for a unit (auto-detect finds no marker and
  // `config.presets` is unset) — the T4.4 no-config/no-marker regression path.
  for (const unit of units) {
    const activePresets = await activePresetsForUnit(config, unit.dir);
    if (activePresets.length === 0) continue;
    // The unit's files, package-relative — the carrier presets (vite index.html,
    // storybook story globs, cdk `cdk.json#app`) all match against this set.
    // Computed once per unit, shared across its active presets.
    const unitFilesPkgRel = new Set(
      filesRel
        .filter((rel) => unit.rootRelDir === "" || rel.startsWith(`${unit.rootRelDir}/`))
        .map((rel) => (unit.rootRelDir === "" ? rel : rel.slice(unit.rootRelDir.length + 1))),
    );
    const unitSources = conventionSources.filter(
      (source) => ownerUnitForFile(units, source.file) === unit,
    );
    for (const preset of activePresets) {
      for (const hit of matchPresetEntryPatterns(preset, filesRel, unit.rootRelDir)) {
        seedProductionEntrypoint(graph, hit.file, hit.reason);
      }
      // Carrier presets read their own config file directly and seed the entry
      // files it references (vite's index.html carrier, storybook's `stories`
      // glob in `.storybook/main.*`, cdk's `cdk.json#app`).
      const carrierHits =
        preset.name === "vite"
          ? await viteHtmlEntrypoints(unit.dir, unit.rootRelDir, unitFilesPkgRel)
          : preset.name === "storybook"
            ? // Storybook resolves its `stories` globs root-relative and matches
              // the WHOLE file set, so an aggregator that collects a sibling
              // package's stories seeds them wherever they land (reviewer fix).
              await storybookStoryEntrypoints(unit.dir, unit.rootRelDir, filesRel)
            : preset.name === "cdk"
              ? await cdkAppEntrypoints(unit.dir, unit.rootRelDir, unitFilesPkgRel)
              : [];
      for (const hit of carrierHits) seedProductionEntrypoint(graph, hit.file, hit.reason);

      if (preset.name === "cdk") {
        for (const reference of cdkNodejsFunctionReferences(
          root,
          unit,
          unitSources,
          analyzedFileSet,
        )) {
          addConventionReference(graph, reference);
        }
      }
    }
  }

  // Source-carried conventions become graph edges: dead callers do not keep
  // their targets alive, while reachable config/browser callers propagate
  // liveness exactly like a resolved dynamic import.
  for (const unit of units) {
    const unitSources = conventionSources.filter(
      (source) => ownerUnitForFile(units, source.file) === unit,
    );
    const references = [
      ...browserRuntimeAssetReferences(unit, unitSources, analyzedFileSet),
      ...viteVitestConfigReferences(root, unit, unitSources, analyzedFileSet),
    ];
    for (const reference of references) {
      addConventionReference(graph, reference);
    }
  }

  // External config carriers have no graph node of their own, so their explicit
  // targets become config roots. Browser HTML/extension manifests are runtime
  // production carriers and therefore contribute production roots.
  for (const unit of units) {
    for (const hit of mswWorkerRoots(unit, analyzedFileSet)) {
      seedConfigEntrypoint(graph, hit.file, hit.reason);
    }
    for (const hit of k6PackageScriptRoots(root, unit, analyzedFileSet)) {
      seedConfigEntrypoint(graph, hit.file, hit.reason);
    }
  }
  const configCarrierHits = [
    ...(internal.deferredConventions?.includes("github-actions-run") === true
      ? []
      : await githubActionsRunRoots(root, analyzedFileSet, useGitignore)),
    ...(internal.deferredConventions?.includes("taskfile-command") === true
      ? []
      : await taskfileCommandRoots(root, analyzedFileSet, useGitignore)),
    ...(internal.deferredConventions?.includes("native-config-script") === true
      ? []
      : await nativeConfigScriptRoots(root, analyzedFileSet, useGitignore)),
  ];
  for (const hit of configCarrierHits) {
    seedConfigEntrypoint(graph, hit.file, hit.reason);
  }
  for (const hit of await browserCarrierRoots(root, units, analyzedFileSet, useGitignore)) {
    seedProductionEntrypoint(graph, hit.file, hit.reason);
  }

  // Fix 1: config roots become `config` reachability seeds (never claimed).
  // A `.storybook/*` config file (non-test) is also a config root: Storybook
  // loads main/preview/decorators/handlers/etc., which import real app code that
  // must stay alive (reference-codebase smoke — app modules referenced ONLY by a
  // `.storybook` config would otherwise be confident false positives).
  const configRoots = files.filter((file) => {
    const rel = toPosixRel(root, file);
    return (
      isStorybookConfigFile(rel) ||
      (isConfigRootName(basename(file)) && packageRootDirs.has(dirname(file)))
    );
  });
  for (const file of configRoots) {
    const rel = toPosixRel(root, file);
    graph.addNode({
      kind: "entrypoint",
      id: entrypointId("config", rel),
      entryKind: "config",
      file: rel,
      reason: "config-root",
    });
  }

  // Zero-config test-file recognition. Files matching test conventions become
  // `test` reachability roots (a partition, architecture §3). Under M5 (T5.1/
  // T5.2) code reachable only from these roots is claimed `test-only` (not
  // silently kept alive as in the M3 interim), and a test exercising only such
  // code is flagged a zombie. `testFileRels` also drives dependency test-only
  // classification (a dep referenced solely from these files, T5.2 point 4).
  const packageRootRels = new Set([...packageRootDirs].map((dir) => toPosixRel(root, dir)));
  const testFileRels = new Set<string>();
  for (const file of files) {
    const rel = toPosixRel(root, file);
    if (!isTestFilePath(rel, packageRootRels)) continue;
    testFileRels.add(rel);
    graph.addNode({
      kind: "entrypoint",
      id: entrypointId("test", rel),
      entryKind: "test",
      file: rel,
      reason: "test-file",
    });
  }

  // Fix 3: keep alive any source file referenced as a string in a JSON config or
  // in a config root's own source (closes `.json` and `.js`/`.ts` config paths).
  // The same pass collects the config/scripts token corpus for T4.1's
  // `config-named-dependency` keep-alive.
  const configScan = await scanConfigReferences(root, files, jsonFiles, configRoots, contentByAbs);
  for (const [abs, site] of configScan.referenced) {
    const rel = toPosixRel(root, abs);
    graph.addHazard({
      file: fileId(rel),
      hazardClass: "config-referenced-file",
      detail: "path referenced as a string literal in a project config file",
      site,
    });
  }

  // T4.1: dependency claims. The declared-vs-referenced + keep-alive decision
  // (per-workspace `dependencies`, `@types`/bin/JSX-runtime/`workspace:`/config
  // rules) is TS/JS-specific and computed here; core stamps id/confidence.
  // JSX runtime: automatic JSX can live in `.js`/`.mjs` (CRA-style), not only
  // `.tsx`/`.jsx`, so the runtime package is kept alive whenever the automatic
  // runtime is configured and any source file exists (blunt, false-positive-proof).
  // T4.3: `ignoreDependencies` drops any matching claim before it reaches
  // core — names or glob patterns (e.g. `"@internal/*"`), same engine as
  // `entry`/`project`/`suppressions`. No-op against `EMPTY_CONFIG`.
  const dependencies = computeUnusedDependencies({
    root,
    units,
    graph,
    files,
    fileContents: contentByAbs,
    jsxRuntimePackages: files.length > 0 ? tsconfigOptions.jsxRuntimePackages : new Set<string>(),
    configTokens: configScan.configTokens,
    testFiles: testFileRels,
  }).filter((dep) => !isIgnoredDependency(dep.packageName, config));
  if (conventionStarted !== undefined) {
    performance?.finish("convention-config-roots", conventionStarted);
  }
  performance?.set("symbols", graph.nodes().filter((node) => node.kind === "symbol").length);
  performance?.set("edges", graph.edges().length);

  // partitioned reachability → claims (T5.1: production/config/test partitions).
  const reachability = computePartitionedReachability(graph, performance);
  const provenance: Provenance = {
    analyzer: ANALYZER_NAME,
    version,
    generatedAt: now.toISOString(),
  };
  // T4.3 (reviewer fix): `project` narrows CLAIMABILITY, not discovery — an
  // out-of-project file was already parsed above (so it acts as an importer),
  // it just can never
  // itself be claimed. Applied post-`emitClaims` rather than pre-filtering
  // the graph, since core has no config concept and must not import it
  // (ADR 0003/dependency-cruiser); dependency claims are exempt (`project` is
  // a source-file scope, package.json's `dependencies` map is not). No-op
  // against `EMPTY_CONFIG` (`isClaimable` always returns `true`).
  // Own package name(s) → dependency ids, so a test that imports the analyzed
  // package by its own name (resolving external) is not mis-flagged a zombie
  // (T5.5 hardening; `emitZombieTestClaims`).
  const selfDependencyIds = new Set<string>();
  for (const unit of units) {
    if (unit.name !== null) selfDependencyIds.add(dependencyId(unit.name));
  }
  const claimInputs: FrontendClaimInputs = {
    fileLineCounts,
    dependencies,
    selfDependencyIds,
    units: units.map((unit) => ({ rootRelDir: unit.rootRelDir, name: unit.name })),
    analysisFiles: new Set(filesRel),
    claimableFiles: new Set(filesRel.filter((file) => isClaimable(file, config, configUnits))),
  };

  const emittedClaims = emitClaims({
    graph,
    reachability,
    provenance,
    fileLineCounts,
    dependencies,
    selfDependencyIds,
    // Workspace-unit boundaries so a whole-package hazard cap (a computed
    // require/import with no static prefix, an unresolvable entrypoint, a
    // tsconfig `references`) scopes to the OWNING unit, not the whole run (T4/
    // reference-codebase smoke §4.3). Single-package: one root unit ⇒ whole-run, as before.
    units: units.map((u) => ({ rootRelDir: u.rootRelDir })),
    ...(performance === undefined ? {} : { performance }),
  }).filter(
    (claim) =>
      claim.subject.kind === "dependency" ||
      isClaimable(claim.subject.loc.file, config, configUnits),
  );

  const claims = applyConfigSuppressions(
    emittedClaims,
    config,
    configUnits,
    files.map((file) => toPosixRel(root, file)),
    { emitWarnings: internal.emitConfigMatchWarnings !== false },
  );

  // Populate `subject.loc.package` in a monorepo (schema field; each claim tagged
  // with its owning workspace package). The claim `id` excludes package, so this
  // never churns ids — single-package output is byte-identical (no field added).
  if (isWorkspace) annotateClaimPackages(claims, units);

  const result: AnalyzeResult = {
    schemaVersion: SCHEMA_VERSION,
    tool: { name: "unused", version },
    run: {
      root,
      configHash: computeConfigHash(config),
      startedAt: now.toISOString(),
      durationMs: Date.now() - start,
      boundaries: [
        {
          status: "complete",
          pluginId: "language:typescript",
          boundaryId: "ts:.",
          language: "ts",
          fileCount: files.length,
          workspaceCount: units.length,
          partitions: { production: "complete", config: "complete", test: "complete" },
        },
      ],
    },
    claims,
    // T5.3: config `ciSecondsPerTestFile` overrides the zombie-tests
    // CI-seconds average; `undefined` (no config, or the field unset) falls
    // through to `computeSummary`'s own default.
    summary: computeSummary(claims, { ciSecondsPerTestFile: config.ciSecondsPerTestFile }),
    productionEntrypointCount: reachability.production.productionEntrypointFiles.size,
    fileCount: files.length,
    workspaceCount: units.length,
    repoName: nameOfPackage(rootPkg) ?? basename(root),
    units: units.map((u) => ({ rootRelDir: u.rootRelDir, name: u.name })),
    gateThreshold: config.gate?.threshold ?? "high",
  };
  return { result, graph, reachability, claimInputs, provenance };
}

// ---------------------------------------------------------------------------
// Shared: seed a production entrypoint node (T2.3 wildcard exports; T4.3
// config `entry`; T4.4 presets — every additive-entrypoint mechanism funnels
// through this one call so the node shape never drifts between them).
// ---------------------------------------------------------------------------

function seedProductionEntrypoint(graph: IRGraph, rel: string, reason: string): void {
  graph.addNode({
    kind: "entrypoint",
    id: entrypointId("production", rel),
    entryKind: "production",
    file: rel,
    reason,
  });
}

function seedConfigEntrypoint(graph: IRGraph, rel: string, reason: string): void {
  graph.addNode({
    kind: "entrypoint",
    id: entrypointId("config", rel),
    entryKind: "config",
    file: rel,
    reason,
  });
}

function addConventionReference(
  graph: IRGraph,
  reference: {
    readonly fromFile: string;
    readonly targetFile: string;
    readonly site: Site;
  },
): void {
  graph.addEdge({
    kind: "references",
    referenceKind: "dynamic-resolved",
    from: fileId(reference.fromFile),
    to: fileId(reference.targetFile),
    site: reference.site,
  });
}

// ---------------------------------------------------------------------------
// Fix 2 — wildcard subpath exports
// ---------------------------------------------------------------------------

/**
 * Seed a production entrypoint for every discovered file matched by a wildcard
 * `exports` subpath pattern. We expand against the literal prefix before `*` and
 * keep the whole matched subtree alive — a wildcard export means that subtree IS
 * the public API, so over-approximating here only costs recall, never precision.
 *
 * **dist/**→src/** remap (parity with the singular-target path, T3.6).** A
 * wildcard target commonly points into a build output that does not exist on an
 * unbuilt clone (`"./utils/*": "./dist/utils/*.js"`, source under `src/utils/`).
 * When the literal prefix matches no file we retry the prefix with its leading
 * `dist/` segment rewritten to `src/`, exactly as `emit.ts` does for singular
 * `main`/`exports`/`bin` targets — otherwise the wildcard silently seeds zero
 * entrypoints and its (public, possibly tested) source files are mis-claimed
 * dead (the M5 hono `./utils/*` regression).
 *
 * Returns the wildcard **subpath keys** that matched no source file even after
 * the remap — a declared slice of the public API that could not be resolved.
 * The caller raises an `unresolvable-entrypoint-target` hazard for these, so an
 * unresolvable wildcard is never dropped silently. Grouping by subpath (rather
 * than per condition target) means a subpath whose `import` condition resolves
 * to source is NOT reported just because its `types`/`require` conditions point
 * at other unbuilt directories.
 */
function seedWildcardExportEntrypoints(
  graph: IRGraph,
  root: string,
  packageDir: string,
  files: readonly string[],
  pkg: PackageJsonLike | null,
): string[] {
  if (pkg === null) return [];
  const unresolved: string[] = [];
  for (const { subpath, targets } of collectWildcardSubpaths(pkg.exports)) {
    let matched = 0;
    for (const target of targets) {
      const prefixLit = target.slice(0, target.indexOf("*"));
      let hits = filesUnderWildcardPrefix(prefixLit, packageDir, files);
      if (hits.length === 0) {
        const remapped = remapDistPrefixToSrc(prefixLit);
        if (remapped !== null) hits = filesUnderWildcardPrefix(remapped, packageDir, files);
      }
      for (const file of hits) {
        seedProductionEntrypoint(graph, toPosixRel(root, file), "exports:wildcard");
      }
      matched += hits.length;
    }
    if (matched === 0) unresolved.push(subpath);
  }
  return unresolved;
}

/**
 * Wildcard `exports` subpaths, grouped by subpath key. Only a subpath **key**
 * containing `*` is a pattern (Node subpath-pattern semantics: a pattern key
 * requires a pattern target); its wildcard target strings are the `*`-bearing
 * string leaves of its value (across all conditions). A bare-string or
 * conditions-object (`"."`-sugar) `exports` has no pattern subpaths.
 */
function collectWildcardSubpaths(
  exportsValue: unknown,
): Array<{ subpath: string; targets: string[] }> {
  if (exportsValue === null || typeof exportsValue !== "object" || Array.isArray(exportsValue)) {
    return [];
  }
  const out: Array<{ subpath: string; targets: string[] }> = [];
  for (const [key, value] of Object.entries(exportsValue as Record<string, unknown>)) {
    if (!key.includes("*")) continue;
    const targets = collectStringLeaves(value).filter((t) => t.includes("*"));
    if (targets.length > 0) out.push({ subpath: key, targets });
  }
  return out;
}

/**
 * Discovered files (absolute) whose path starts with a wildcard target's literal
 * prefix, resolved relative to the OWNING package's directory (the root in
 * single-package analysis, a member in a monorepo). A trailing `/` prefix is
 * anchored at the directory boundary.
 */
function filesUnderWildcardPrefix(
  prefixLit: string,
  packageDir: string,
  files: readonly string[],
): string[] {
  let matchPrefix = resolvePath(packageDir, prefixLit);
  if (prefixLit.endsWith("/")) matchPrefix += sep;
  return files.filter((file) => file.startsWith(matchPrefix));
}

/**
 * Rewrite a wildcard prefix's leading `dist/` segment to `src/`
 * (`./dist/utils/` → `src/utils/`), mirroring `emit.ts`'s singular-target remap.
 * Only the leading `dist/` is swapped; `null` when the prefix is not under
 * `dist/` (no remap applies).
 */
function remapDistPrefixToSrc(prefixLit: string): string | null {
  const rel = prefixLit.replace(/^\.\//, "");
  if (!rel.startsWith("dist/")) return null;
  return `src/${rel.slice("dist/".length)}`;
}

/** Every string leaf of a package.json value (subpaths + conditions). */
function collectStringLeaves(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(collectStringLeaves);
  if (value !== null && typeof value === "object") {
    return Object.values(value as Record<string, unknown>).flatMap(collectStringLeaves);
  }
  return [];
}

async function readRootPackageJson(root: string): Promise<PackageJsonLike | null> {
  try {
    const parsed = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as unknown;
    return parsed !== null && typeof parsed === "object" ? (parsed as PackageJsonLike) : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// T4.2 — workspace package units
// ---------------------------------------------------------------------------

/** A package whose entrypoints seed liveness, plus its name (for the sibling map + claim tagging). */
interface AnalyzeUnit extends EmitPackageUnit {
  /** The package's `package.json` `name`, or `null`. */
  readonly name: string | null;
}

/**
 * The package units for a run: the root package first (its `rootRelDir` is `""`),
 * then every workspace member. In single-package analysis this is just the root.
 */
function buildPackageUnits(
  root: string,
  rootPkg: PackageJsonLike | null,
  layout: WorkspaceLayout,
): AnalyzeUnit[] {
  const units: AnalyzeUnit[] = [
    { dir: root, rootRelDir: "", packageJson: rootPkg, name: nameOfPackage(rootPkg) },
  ];
  for (const member of layout.members) {
    units.push({
      dir: member.dir,
      rootRelDir: member.rootRelDir,
      packageJson: member.packageJson,
      name: member.name,
    });
  }
  return units;
}

/** `package name → absolute directory` for every named unit (the sibling-resolution map). */
function buildWorkspaceMap(units: readonly AnalyzeUnit[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const unit of units) {
    if (unit.name !== null && !map.has(unit.name)) map.set(unit.name, unit.dir);
  }
  return map;
}

/** Deepest package unit owning a root-relative source path (root is fallback). */
function ownerUnitForFile(units: readonly AnalyzeUnit[], file: string): AnalyzeUnit {
  let owner = units[0] as AnalyzeUnit;
  for (const unit of units) {
    if (
      unit.rootRelDir !== "" &&
      (file === unit.rootRelDir || file.startsWith(`${unit.rootRelDir}/`)) &&
      unit.rootRelDir.length > owner.rootRelDir.length
    ) {
      owner = unit;
    }
  }
  return owner;
}

/**
 * `emitDecoratorMetadata` / JSX-runtime packages across all package units: any
 * unit's tsconfig enabling `emitDecoratorMetadata` flips it on for the run
 * (over-approximating the keep-alive costs recall, never precision), and every
 * unit with an automatic-runtime `jsx` setting contributes its runtime package
 * (`jsxImportSource` value, default `react`) to the keep-alive set (T4.1).
 *
 * Project `references` is handled SEPARATELY, per unit (see
 * {@link unitOwnTsconfigReferenceDirs}): its cap must be sited at the OWNING
 * unit's tsconfig — the referencing unit AND each referenced unit — so it scopes
 * to those members, not the whole monorepo, so it cannot be collapsed into a
 * single run-wide boolean here.
 */
function readTsconfigOptionsForUnits(units: readonly AnalyzeUnit[]): {
  emitDecoratorMetadata: boolean;
  jsxRuntimePackages: Set<string>;
} {
  let emitDecoratorMetadata = false;
  const jsxRuntimePackages = new Set<string>();
  for (const unit of units) {
    const opts = readTsconfigOptions(unit.dir);
    emitDecoratorMetadata = emitDecoratorMetadata || opts.emitDecoratorMetadata;
    if (opts.jsxAutomatic) {
      const source = opts.jsxImportSource ?? "react";
      jsxRuntimePackages.add(packageNameOf(source) ?? source);
    }
  }
  return { emitDecoratorMetadata, jsxRuntimePackages };
}

/**
 * The absolute directories the tsconfig `unitDir` OWNS (located at `unitDir`
 * itself, not inherited from an ancestor) references via its top-level
 * `references` array, or `null` when it has none / the tsconfig is inherited.
 * Only a unit's own tsconfig triggers its `project-references` cap — a member
 * that merely inherits a root tsconfig's `references` is not itself a composite
 * project. Each `references[].path` (a directory or a `tsconfig.json` file path,
 * package-relative) is resolved to its containing directory so the caller can map
 * it to the referenced workspace unit.
 */
function unitOwnTsconfigReferenceDirs(unitDir: string): string[] | null {
  let found: ReturnType<typeof getTsconfig>;
  try {
    found = getTsconfig(unitDir);
  } catch {
    found = null;
  }
  if (found === null) return null;
  // The resolved tsconfig must be the unit's OWN (its directory === unitDir),
  // not an ancestor's inherited config.
  if (resolvePath(dirname(found.path)) !== resolvePath(unitDir)) return null;
  const references = (found.config as { references?: unknown }).references;
  if (!Array.isArray(references) || references.length === 0) return null;
  const dirs: string[] = [];
  for (const ref of references) {
    const refPath = (ref as { path?: unknown } | null)?.path;
    if (typeof refPath !== "string" || refPath === "") continue;
    let abs = resolvePath(unitDir, refPath);
    if (/\.json$/i.test(abs)) abs = dirname(abs); // a direct tsconfig path ⇒ its directory
    dirs.push(abs);
  }
  return dirs;
}

/**
 * The `rootRelDir` of the workspace unit that owns absolute directory `dir` (an
 * exact unit-directory match, or the deepest unit containing it), or `null` when
 * no unit owns it (a referenced project outside the analyzed workspace — its cap
 * has nowhere to land, which is fine: an unanalysed referenced project cannot be
 * claimed here anyway).
 */
function ownerUnitRootRelDir(units: readonly AnalyzeUnit[], dir: string): string | null {
  const target = resolvePath(dir);
  let best: AnalyzeUnit | null = null;
  for (const unit of units) {
    const unitAbs = resolvePath(unit.dir);
    if (target === unitAbs || target.startsWith(`${unitAbs}${sep}`)) {
      if (best === null || unit.dir.length > best.dir.length) best = unit;
    }
  }
  return best === null ? null : best.rootRelDir;
}

/**
 * Tag each claim with the workspace package that owns its file (`subject.loc.package`).
 * A file is owned by the deepest unit whose directory contains it; a file under no
 * member falls to the root package (analysed as today). Root-owned files stay
 * untagged when the root `package.json` declares no `name`.
 */
function annotateClaimPackages(claims: readonly Claim[], units: readonly AnalyzeUnit[]): void {
  const byDepth = [...units].sort((a, b) => b.rootRelDir.length - a.rootRelDir.length);
  for (const claim of claims) {
    const file = claim.subject.loc.file;
    const owner = byDepth.find(
      (u) => u.rootRelDir === "" || file === u.rootRelDir || file.startsWith(`${u.rootRelDir}/`),
    );
    if (owner?.name != null) claim.subject.loc.package = owner.name;
  }
}

/** Read a parsed package.json's `name`, or `null`. */
function nameOfPackage(pkg: PackageJsonLike | null): string | null {
  const name = (pkg as { name?: unknown } | null)?.name;
  return typeof name === "string" && name !== "" ? name : null;
}

/** Is `rel` (root-relative POSIX) inside any excluded-member subtree? */
function isUnderExcluded(rel: string, excludedPrefixes: readonly string[]): boolean {
  return excludedPrefixes.some((prefix) => rel.startsWith(prefix));
}

// ---------------------------------------------------------------------------
// Fix 1/3 — config roots + config-referenced files
// ---------------------------------------------------------------------------

function isConfigRootName(name: string): boolean {
  return CONFIG_ROOT_RE.test(name) || DOTRC_RE.test(name) || TOOL_CONFIG_ROOT_RE.test(name);
}

/**
 * Is `rel` (root-relative POSIX) a Storybook config file — a non-test source
 * file inside a `.storybook/` directory? These are seeded as `config`
 * reachability roots so the app code they import (decorators, MSW handlers,
 * store-reset helpers) stays alive and is never claimed. Test files under
 * `.storybook/__tests__/` are excluded — they are ordinary test roots, tracked
 * by {@link isTestFilePath}, not Storybook configuration.
 */
function isStorybookConfigFile(rel: string): boolean {
  const segs = rel.split("/");
  const idx = segs.indexOf(".storybook");
  if (idx === -1) return false;
  if (segs.slice(idx + 1).includes("__tests__")) return false;
  const base = segs[segs.length - 1] ?? "";
  return !TEST_FILE_RE.test(base);
}

/**
 * Zero-config test-file recognition (T3.6, interim). A repo-relative POSIX path
 * is a test root when its basename matches `*.test.*` / `*.spec.*` / `*.e2e.*` /
 * `*.cy.*`, or it lives under a `__tests__/` or `cypress/` directory (anywhere —
 * both conventions are distinctive enough to trust at any depth), or under a
 * `test/`, `tests/`, `spec/`, or `e2e/` directory that sits directly at a
 * package root. The root-anchored names are anchored so an unrelated
 * `src/test/` utility directory is not mistaken for a test tree. Over-recognition is safe here — a test
 * root only keeps code alive, never flags it — so this errs toward keep-alive.
 */
function isTestFilePath(rel: string, packageRootRels: ReadonlySet<string>): boolean {
  const segs = rel.split("/");
  const base = segs[segs.length - 1] ?? "";
  if (TEST_FILE_RE.test(base)) return true;
  // Directory segments only (exclude the filename at segs.length - 1).
  for (let i = 0; i < segs.length - 1; i++) {
    const seg = segs[i];
    if (seg === "__tests__" || seg === "cypress") return true;
    if (seg === "test" || seg === "tests" || seg === "spec" || seg === "e2e") {
      const prefix = segs.slice(0, i).join("/");
      if (packageRootRels.has(prefix)) return true;
    }
  }
  return false;
}

/**
 * Scans every JSON config and config-root source once, returning both:
 *  - `referenced` — absolute paths of discovered source files named as a string,
 *    mapped to the config source that named them (the
 *    `config-referenced-file` keep-alive input and provenance);
 *  - `configTokens` — the identifier-ish tokens of every scanned config string
 *    and (package.json being a JSON config) every `scripts` value, the corpus a
 *    `config-named-dependency` keep-alive matches a dependency name against
 *    (T4.1). Size-capped and lockfile-excluded.
 */
async function scanConfigReferences(
  root: string,
  discoveredAbs: readonly string[],
  jsonFiles: readonly string[],
  configRoots: readonly string[],
  contentByAbs: ReadonlyMap<string, string>,
): Promise<{ referenced: Map<string, Site>; configTokens: Set<string> }> {
  const discovered = new Set(discoveredAbs);
  const referenced = new Map<string, Site>();
  const configTokens = new Set<string>();

  const matchPaths = (strings: Iterable<LocatedStringLiteral>, sourceFile: string): void => {
    for (const literal of strings) {
      for (const candidate of candidatePaths(literal.value, root, dirname(sourceFile))) {
        if (discovered.has(candidate)) {
          const sourceRel = toPosixRel(root, sourceFile);
          const previous = referenced.get(candidate);
          if (
            previous !== undefined &&
            (previous.file < sourceRel ||
              (previous.file === sourceRel && previous.span.start <= literal.span.start))
          ) {
            continue;
          }
          referenced.set(candidate, {
            file: sourceRel,
            span: literal.span,
          });
        }
      }
    }
  };
  const addTokens = (strings: Iterable<string>): void => {
    for (const value of strings) addConfigTokens(configTokens, value);
  };

  // JSON configs (jest.config.json setupFiles, package.json scripts, etc.).
  for (const jsonFile of jsonFiles) {
    let raw: string;
    try {
      if ((await stat(jsonFile)).size > CONFIG_FILE_SIZE_CAP) continue;
      raw = await readFile(jsonFile, "utf8");
    } catch {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    // Path matching considers every string VALUE (a `name`/`version` is harmless
    // there), while preserving the literal's truthful config-source span.
    const stringValues = new Set(collectStringLeaves(parsed));
    matchPaths(
      locatedStringLiteralsOf(raw).filter((literal) => stringValues.has(literal.value)),
      jsonFile,
    );
    // Config-named tokens: from a package.json only the config-bearing fields
    // (`scripts`, `eslintConfig`, …), never its metadata — a workspace member's
    // own `name` must not keep a sibling's `workspace:` dependency alive (T4.1).
    addTokens(
      basename(jsonFile) === "package.json"
        ? packageJsonConfigLeaves(parsed)
        : collectStringLeaves(parsed),
    );
  }

  // Config-root sources (jest.config.js / vitest.config.ts string paths).
  for (const configRoot of configRoots) {
    const source = contentByAbs.get(configRoot);
    if (source === undefined) continue;
    const literals = locatedStringLiteralsOf(source);
    matchPaths(literals, configRoot);
    addTokens(literals.map((literal) => literal.value));
  }

  return { referenced, configTokens };
}

/**
 * package.json top-level fields that are metadata / resolution / dependency
 * declarations rather than tool configuration — excluded from the
 * `config-named-dependency` token corpus so a package's own `name` (and, in a
 * monorepo, a sibling's) never keeps a dependency alive. Everything else
 * (`scripts` and in-manifest tool configs like `eslintConfig`, `prettier`,
 * `jest`, `husky`, `lint-staged`, …) is scanned.
 */
const PACKAGE_JSON_NON_CONFIG_FIELDS: ReadonlySet<string> = new Set([
  "name",
  "version",
  "description",
  "keywords",
  "homepage",
  "bugs",
  "license",
  "author",
  "contributors",
  "funding",
  "files",
  "main",
  "module",
  "browser",
  "types",
  "typings",
  "exports",
  "imports",
  "bin",
  "man",
  "directories",
  "repository",
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "peerDependenciesMeta",
  "bundleDependencies",
  "bundledDependencies",
  "optionalDependencies",
  "overrides",
  "resolutions",
  "engines",
  "os",
  "cpu",
  "libc",
  "private",
  "publishConfig",
  "workspaces",
  "type",
  "packageManager",
  "sideEffects",
]);

/** String leaves of a package.json's config-bearing fields only (see the denylist above). */
function packageJsonConfigLeaves(parsed: unknown): string[] {
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return [];
  const out: string[] = [];
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (PACKAGE_JSON_NON_CONFIG_FIELDS.has(key)) continue;
    out.push(...collectStringLeaves(value));
  }
  return out;
}

interface LocatedStringLiteral {
  readonly value: string;
  readonly span: Site["span"];
}

/** Extract quoted literals with truthful source offsets/lines (best-effort). */
function locatedStringLiteralsOf(source: string): LocatedStringLiteral[] {
  const out: LocatedStringLiteral[] = [];
  STRING_LITERAL_RE.lastIndex = 0;
  let nextNewline = source.indexOf("\n");
  let line = 1;
  let match: RegExpExecArray | null = STRING_LITERAL_RE.exec(source);
  while (match !== null) {
    if (match[2] !== undefined) {
      const start = match.index;
      const end = STRING_LITERAL_RE.lastIndex;
      while (nextNewline >= 0 && nextNewline < start) {
        line += 1;
        nextNewline = source.indexOf("\n", nextNewline + 1);
      }
      const startLine = line;
      let value = match[2];
      if (match[1] === '"') {
        try {
          value = JSON.parse(match[0]) as string;
        } catch {
          // A JS/TS double-quoted literal need not be valid standalone JSON.
        }
      }
      out.push({ value, span: { start, end, startLine, endLine: startLine } });
    }
    match = STRING_LITERAL_RE.exec(source);
  }
  return out;
}

/**
 * Absolute-path candidates a config string could denote, resolved two ways.
 * We try the literal path plus every source extension on its extension-less
 * stem — so a NodeNext-style `./x.js` reference matches an `x.ts` on disk (the
 * `.js`→`.ts` habit), and an extension-less `./x` matches `x.ts`/`x.tsx`/…
 */
function candidatePaths(value: string, root: string, fromDir: string): string[] {
  if (value === "" || value.length > 1024) return [];
  const out = new Set<string>();
  for (const base of [resolvePath(root, value), resolvePath(fromDir, value)]) {
    out.add(base);
    const stem = stripSourceExtension(base);
    for (const ext of SOURCE_EXTENSIONS) out.add(stem + ext);
  }
  return [...out];
}

function stripSourceExtension(path: string): string {
  const lower = path.toLowerCase();
  for (const ext of SOURCE_EXTENSIONS) {
    if (lower.endsWith(ext)) return path.slice(0, path.length - ext.length);
  }
  return path;
}

// ---------------------------------------------------------------------------
// T3.1b — tsconfig-driven hazards (emitDecoratorMetadata gate, project references)
// ---------------------------------------------------------------------------

/** A repo-relative site anchored at the package/tsconfig config, for config-derived hazards. */
const CONFIG_SITE_SPAN = { start: 0, end: 0, startLine: 1, endLine: 1 } as const;

/**
 * Read the two `compilerOptions`/top-level tsconfig fields M3 needs, resolved
 * through the `extends` chain by get-tsconfig and bounded to the project root
 * (a package without its own tsconfig must not inherit an ancestor repo's
 * options). Missing/unreadable ⇒ both `false` (degrade toward alive is safe:
 * no decorator-metadata cap, no whole-package reference cap).
 */
function readTsconfigOptions(root: string): {
  emitDecoratorMetadata: boolean;
  hasReferences: boolean;
  jsxAutomatic: boolean;
  jsxImportSource: string | null;
} {
  let found: ReturnType<typeof getTsconfig>;
  try {
    found = getTsconfig(root);
  } catch {
    found = null;
  }
  if (found === null || !isInsideRoot(found.path, root)) {
    return {
      emitDecoratorMetadata: false,
      hasReferences: false,
      jsxAutomatic: false,
      jsxImportSource: null,
    };
  }
  const config = found.config as {
    compilerOptions?: { emitDecoratorMetadata?: unknown; jsx?: unknown; jsxImportSource?: unknown };
    references?: unknown;
  };
  const jsx = config.compilerOptions?.jsx;
  const importSource = config.compilerOptions?.jsxImportSource;
  return {
    emitDecoratorMetadata: config.compilerOptions?.emitDecoratorMetadata === true,
    hasReferences: Array.isArray(config.references) && config.references.length > 0,
    // Only the automatic runtime injects an unseen runtime-package import
    // (`react-jsx`/`react-jsxdev`); the classic runtime requires an explicit
    // `React` import, which the reference graph already sees.
    jsxAutomatic: jsx === "react-jsx" || jsx === "react-jsxdev",
    jsxImportSource: typeof importSource === "string" && importSource !== "" ? importSource : null,
  };
}

/**
 * A tsconfig `references` array composes this project with sibling TS projects
 * that may consume its files across the project boundary — a use the
 * single-project reference graph cannot see. Cap the whole OWNING package at
 * medium (directory-subtree with an empty prefix ⇒ the site's owning unit).
 * Sited at the unit's own `tsconfig.json` (`<rootRelDir>/tsconfig.json`), so the
 * claim engine scopes the cap to that workspace member, not the whole monorepo.
 * Deliberately blunt; real cross-project analysis is post-v1 (registry rationale).
 */
function addProjectReferencesHazard(graph: IRGraph, rootRelDir: string): void {
  const tsconfigRel = rootRelDir === "" ? "tsconfig.json" : `${rootRelDir}/tsconfig.json`;
  graph.addHazard({
    file: fileId(tsconfigRel),
    hazardClass: "project-references",
    detail:
      "tsconfig `references` composes this project with sibling projects that may consume its files across the project boundary (whole-package cap, medium)",
    site: { file: tsconfigRel, span: { ...CONFIG_SITE_SPAN } },
    // no subtreePrefix ⇒ "" ⇒ the hazard site's owning workspace unit is in scope
  });
}

/**
 * Keep-alive (no-claim) every file that is only the target of a package.json
 * `exports`/`imports` condition, or a top-level `browser` remap, that the
 * analyzer's single condition set (types → import → node → default) does not
 * select. We resolve one branch; the other branch's files have no inbound edge
 * under that set yet are the genuine module under another condition, so they
 * must not be claimable (T3.1b, `conditional-exports-divergence`).
 */
function addConditionalExportsDivergenceHazards(
  graph: IRGraph,
  root: string,
  packageDir: string,
  resolver: Resolver,
  files: readonly string[],
  pkg: PackageJsonLike | null,
): void {
  if (pkg === null) return;
  const withFields = pkg as PackageJsonLike & { imports?: unknown; browser?: unknown };
  const candidates = new Set<string>();
  collectDivergentExportsTargets(pkg.exports, candidates);
  collectDivergentExportsTargets(withFields.imports, candidates); // `#`-subpath imports diverge too
  collectBrowserFieldTargets(withFields.browser, candidates);
  if (candidates.size === 0) return;

  const discovered = new Set(files);
  // Condition targets are package-relative — resolve them from the owning
  // package's package.json (the root in single-package analysis, a member otherwise).
  const from = join(packageDir, "package.json");
  const seen = new Set<string>();
  for (const spec of candidates) {
    const norm = normalizeRelTarget(spec);
    if (norm === null) continue;
    const outcome = resolver.resolve(norm, from, { ...CONFIG_SITE_SPAN }, "import").outcome;
    if (outcome.kind !== "internal" && outcome.kind !== "internal-declaration") continue;
    if (!discovered.has(outcome.path)) continue;
    const rel = toPosixRel(root, outcome.path);
    if (seen.has(rel)) continue;
    seen.add(rel);
    graph.addHazard({
      file: fileId(rel),
      hazardClass: "conditional-exports-divergence",
      detail: `resolved only under a non-selected package.json condition/browser remap (\`${spec}\`); the analyzer resolves with one condition set, so this branch's target is kept alive`,
      site: { file: rel, span: { ...CONFIG_SITE_SPAN } },
    });
  }
}

/**
 * Collect the string targets of any `exports` **or** `imports` subpath whose
 * conditions map to more than one distinct **runtime** target (declaration
 * `.d.ts` targets — the `types` condition — do not count as a runtime
 * divergence). Both maps share a shape: subpath/entry keys (`.`-prefixed for
 * `exports`, `#`-prefixed for `imports`) whose values are targets or condition
 * objects. The selected branch is included too; for `exports` it is already an
 * entrypoint, so re-marking is harmless; for `imports` the non-selected branch
 * is the whole point (entrypoint detection never reads `imports`).
 */
function collectDivergentExportsTargets(node: unknown, out: Set<string>): void {
  if (node === null || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const e of node) collectDivergentExportsTargets(e, out);
    return;
  }
  const obj = node as Record<string, unknown>;
  const keys = Object.keys(obj);
  if (keys.length === 0) return;
  const isSubpathMap = keys.every((k) => k.startsWith(".") || k.startsWith("#"));
  if (isSubpathMap) {
    for (const key of keys) processExportsSubpathTarget(obj[key], out);
  } else {
    processExportsSubpathTarget(obj, out); // a bare conditions object (sugar for ".")
  }
}

function processExportsSubpathTarget(target: unknown, out: Set<string>): void {
  const leaves = new Set<string>();
  for (const leaf of collectStringLeaves(target)) {
    if (leaf.includes("*")) continue;
    if (/\.d\.[mc]?ts$/i.test(leaf)) continue; // a `types` target, not a runtime divergence
    leaves.add(leaf);
  }
  if (leaves.size >= 2) for (const leaf of leaves) out.add(leaf);
}

/**
 * Collect relative-path targets of a top-level `browser` field — a string
 * (`"browser": "./index.browser.js"`) or the values of the object remap form
 * (`{ "./impl.js": "./impl.browser.js", "crypto": "./crypto-shim.js" }`). Values
 * that are `false` (stub-outs) or bare package names are skipped: only files.
 * The `browser` field is the divergent branch entrypoint detection never reads.
 */
function collectBrowserFieldTargets(browser: unknown, out: Set<string>): void {
  if (typeof browser === "string") {
    if (browser.startsWith(".")) out.add(browser);
    return;
  }
  if (browser === null || typeof browser !== "object" || Array.isArray(browser)) return;
  for (const value of Object.values(browser as Record<string, unknown>)) {
    if (typeof value === "string" && value.startsWith(".")) out.add(value);
  }
}

/** Prefix a bare-relative target with `./` (package.json targets are package-relative); skip wildcards. */
function normalizeRelTarget(target: string): string | null {
  if (target === "" || target.includes("*")) return null;
  if (target.startsWith("./") || target.startsWith("../") || target.startsWith("/")) return target;
  return `./${target}`;
}

/** Is `p` equal to, or contained within, `root`? (Segment-boundary safe.) */
function isInsideRoot(p: string, root: string): boolean {
  const abs = resolvePath(p);
  const r = resolvePath(root);
  if (abs === r) return true;
  return abs.startsWith(r.endsWith(sep) ? r : r + sep);
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function countLines(source: string): number {
  if (source.length === 0) return 1;
  return source.split(/\r\n|\r|\n/).length;
}

/** Absolute path → POSIX, project-relative. */
function toPosixRel(root: string, abs: string): string {
  return relative(root, abs).split(sep).join("/");
}
