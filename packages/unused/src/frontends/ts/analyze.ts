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

import { createHash } from "node:crypto";
import type { Dirent } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, dirname, join, relative, resolve as resolvePath, sep } from "node:path";
import { getTsconfig } from "get-tsconfig";
import { computeReachability, emitClaims } from "../../core/analysis/index.js";
import {
  type ClaimRun,
  computeSummary,
  type Provenance,
  SCHEMA_VERSION,
} from "../../core/claims/index.js";
import { entrypointId, fileId, type IRGraph, type Site } from "../../core/ir/index.js";
import { discover } from "./discover.js";
import { emitIR, type PackageJsonLike } from "./emit.js";
import { parseSource } from "./parse.js";
import { Resolver } from "./resolve.js";

const ANALYZER_NAME = "ts-reference-graph";
const DEFAULT_TOOL_VERSION = "0.1.0";
const SOURCE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"] as const;
const CONFIG_SCAN_EXCLUDED_DIRS = new Set(["node_modules", "dist"]);
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
}

/**
 * {@link analyzeProject}'s return value: the PRD §4 wire format plus one
 * out-of-band, non-schema field callers need to disambiguate `claims: []`.
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
 */
export interface AnalyzeResult extends ClaimRun {
  /** Count of production entrypoint files found before claim emission. */
  readonly productionEntrypointCount: number;
}

/**
 * Analyse the project rooted at `rootDir` and return a full {@link
 * AnalyzeResult} (a {@link ClaimRun} plus the disambiguating entrypoint
 * count above). Deterministic given a fixed clock: claims are id-sorted and
 * reachability is built from the deterministically-constructed IR.
 */
export async function analyzeProject(
  rootDir: string,
  options: AnalyzeOptions = {},
): Promise<AnalyzeResult> {
  const start = Date.now();
  const now = options.now ?? new Date();
  const version = options.toolVersion ?? DEFAULT_TOOL_VERSION;
  const root = resolvePath(rootDir);

  // discover → read → parse (single read per file, reused for line counts + scan).
  const files = await discover(root);
  const contents = await Promise.all(files.map((f) => readFile(f, "utf8")));
  const records = files.map((file, i) => parseSource(file, contents[i] as string));
  const contentByAbs = new Map(files.map((file, i) => [file, contents[i] as string]));

  const fileLineCounts = new Map<string, number>();
  files.forEach((file, i) => {
    fileLineCounts.set(fileId(toPosixRel(root, file)), countLines(contents[i] as string));
  });

  // resolve → emit IR (production entrypoints from main/module/exports/bin + fallback).
  const resolver = new Resolver({ projectRoot: root, discoveredFiles: new Set(files) });
  const tsconfigOptions = readTsconfigOptions(root);
  const graph = emitIR({
    projectRoot: root,
    records,
    resolver,
    emitDecoratorMetadata: tsconfigOptions.emitDecoratorMetadata,
  });

  // Fix 2: expand wildcard subpath exports into production entrypoints.
  const pkg = await readRootPackageJson(root);
  seedWildcardExportEntrypoints(graph, root, files, pkg);

  // T3.1b: files reachable only under a package.json condition/browser branch the
  // analyzer's single condition set does not select keep-alive (no-claim); a
  // tsconfig with `references` caps the whole package (medium — see the registry).
  addConditionalExportsDivergenceHazards(graph, root, resolver, files, pkg);
  if (tsconfigOptions.hasReferences) addProjectReferencesHazard(graph);

  // One config-tree walk: JSON config files + the set of package-root directories.
  const jsonFiles: string[] = [];
  const packageRootDirs = new Set<string>();
  await walkConfigTree(root, jsonFiles, packageRootDirs);

  // Fix 1: config roots become `config` reachability seeds (never claimed).
  const configRoots = files.filter(
    (file) => isConfigRootName(basename(file)) && packageRootDirs.has(dirname(file)),
  );
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

  // T3.6: interim test-file recognition (ahead of full tier-2 / M5). Files
  // matching zero-config test conventions become `test` reachability roots —
  // everything reachable from them is kept alive and they are never claimed, so
  // nothing reachable only from a test is flagged at any confidence. The
  // `test-only` verdict and the production/test partition report stay M5.
  const packageRootRels = new Set([...packageRootDirs].map((dir) => toPosixRel(root, dir)));
  for (const file of files) {
    const rel = toPosixRel(root, file);
    if (!isTestFilePath(rel, packageRootRels)) continue;
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
  const referenced = await scanConfigReferences(root, files, jsonFiles, configRoots, contentByAbs);
  for (const abs of referenced) {
    const rel = toPosixRel(root, abs);
    const site: Site = { file: rel, span: { start: 0, end: 0, startLine: 1, endLine: 1 } };
    graph.addHazard({
      file: fileId(rel),
      hazardClass: "config-referenced-file",
      detail: "path referenced as a string literal in a project config file",
      site,
    });
  }

  // reachability → claims.
  const reachability = computeReachability(graph);
  const provenance: Provenance = {
    analyzer: ANALYZER_NAME,
    version,
    generatedAt: now.toISOString(),
  };
  const claims = emitClaims({ graph, reachability, provenance, fileLineCounts });

  return {
    schemaVersion: SCHEMA_VERSION,
    tool: { name: "unused", version },
    run: {
      root,
      configHash: configHash(graph, root),
      startedAt: now.toISOString(),
      durationMs: Date.now() - start,
    },
    claims,
    summary: computeSummary(claims),
    productionEntrypointCount: reachability.productionEntrypointFiles.size,
  };
}

// ---------------------------------------------------------------------------
// Fix 2 — wildcard subpath exports
// ---------------------------------------------------------------------------

/**
 * Seed a production entrypoint for every discovered file matched by a wildcard
 * `exports` target. We expand against the literal prefix before `*` and keep the
 * whole matched subtree alive — a wildcard export means that subtree IS the
 * public API, so over-approximating here only costs recall, never precision.
 */
function seedWildcardExportEntrypoints(
  graph: IRGraph,
  root: string,
  files: readonly string[],
  pkg: PackageJsonLike | null,
): void {
  if (pkg === null) return;
  const targets = collectStringLeaves(pkg.exports).filter((t) => t.includes("*"));
  for (const target of targets) {
    const star = target.indexOf("*");
    const prefixLit = target.slice(0, star);
    let matchPrefix = resolvePath(root, prefixLit);
    if (prefixLit.endsWith("/")) matchPrefix += sep;
    for (const file of files) {
      if (file.startsWith(matchPrefix)) {
        const rel = toPosixRel(root, file);
        graph.addNode({
          kind: "entrypoint",
          id: entrypointId("production", rel),
          entryKind: "production",
          file: rel,
          reason: "exports:wildcard",
        });
      }
    }
  }
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
// Fix 1/3 — config roots + config-referenced files
// ---------------------------------------------------------------------------

function isConfigRootName(name: string): boolean {
  return CONFIG_ROOT_RE.test(name) || DOTRC_RE.test(name) || TOOL_CONFIG_ROOT_RE.test(name);
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

/** Walk the project tree once: collect `*.json` config files and package-root dirs. */
async function walkConfigTree(
  dir: string,
  jsonOut: string[],
  packageRootDirs: Set<string>,
): Promise<void> {
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (CONFIG_SCAN_EXCLUDED_DIRS.has(entry.name)) continue;
      await walkConfigTree(full, jsonOut, packageRootDirs);
    } else if (entry.isFile()) {
      if (entry.name === "package.json") packageRootDirs.add(dir);
      if (entry.name.toLowerCase().endsWith(".json") && !LOCKFILE_NAMES.has(entry.name)) {
        jsonOut.push(full);
      }
    }
  }
}

/**
 * Absolute paths of discovered source files referenced as a string in a JSON
 * config or a config root's own source. Size-capped and lockfile-excluded.
 */
async function scanConfigReferences(
  root: string,
  discoveredAbs: readonly string[],
  jsonFiles: readonly string[],
  configRoots: readonly string[],
  contentByAbs: ReadonlyMap<string, string>,
): Promise<Set<string>> {
  const discovered = new Set(discoveredAbs);
  const referenced = new Set<string>();

  const matchStrings = (strings: Iterable<string>, fromDir: string): void => {
    for (const value of strings) {
      for (const candidate of candidatePaths(value, root, fromDir)) {
        if (discovered.has(candidate)) referenced.add(candidate);
      }
    }
  };

  // JSON configs (jest.config.json setupFiles, etc.).
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
    matchStrings(collectStringLeaves(parsed), dirname(jsonFile));
  }

  // Config-root sources (jest.config.js / vitest.config.ts string paths).
  for (const configRoot of configRoots) {
    const source = contentByAbs.get(configRoot);
    if (source === undefined) continue;
    matchStrings(stringLiteralsOf(source), dirname(configRoot));
  }

  return referenced;
}

/** Extract quoted string literals from JS/TS source (best-effort, keep-alive only). */
function stringLiteralsOf(source: string): string[] {
  const out: string[] = [];
  STRING_LITERAL_RE.lastIndex = 0;
  let match: RegExpExecArray | null = STRING_LITERAL_RE.exec(source);
  while (match !== null) {
    if (match[2] !== undefined) out.push(match[2]);
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
} {
  let found: ReturnType<typeof getTsconfig>;
  try {
    found = getTsconfig(root);
  } catch {
    found = null;
  }
  if (found === null || !isInsideRoot(found.path, root)) {
    return { emitDecoratorMetadata: false, hasReferences: false };
  }
  const config = found.config as {
    compilerOptions?: { emitDecoratorMetadata?: unknown };
    references?: unknown;
  };
  return {
    emitDecoratorMetadata: config.compilerOptions?.emitDecoratorMetadata === true,
    hasReferences: Array.isArray(config.references) && config.references.length > 0,
  };
}

/**
 * A tsconfig `references` array composes this project with sibling TS projects
 * that may consume its files across the project boundary — a use the
 * single-project reference graph cannot see. Cap the whole package at medium
 * (directory-subtree with an empty prefix matches every file). Deliberately
 * blunt; real cross-project analysis is post-v1 (see the registry rationale).
 */
function addProjectReferencesHazard(graph: IRGraph): void {
  graph.addHazard({
    file: fileId("tsconfig.json"),
    hazardClass: "project-references",
    detail:
      "tsconfig `references` composes this project with sibling projects that may consume its files across the project boundary (whole-package cap, medium)",
    site: { file: "tsconfig.json", span: { ...CONFIG_SITE_SPAN } },
    // no subtreePrefix ⇒ "" ⇒ the whole package is in scope
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
  const from = join(root, "package.json");
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

/** A deterministic, config-comparison hash (PRD §4 `run.configHash`). */
function configHash(graph: IRGraph, root: string): string {
  const entrypoints = graph
    .entrypoints()
    .map((e) => `${e.entryKind}:${e.file}:${e.reason}`)
    .sort();
  const payload = JSON.stringify({ root: toPosixRel(root, root), entrypoints });
  return createHash("sha256").update(payload, "utf8").digest("hex").slice(0, 12);
}

/** Absolute path → POSIX, project-relative. */
function toPosixRel(root: string, abs: string): string {
  return relative(root, abs).split(sep).join("/");
}
