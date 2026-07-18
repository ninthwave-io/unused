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
 */

import { createHash } from "node:crypto";
import type { Dirent } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, dirname, join, relative, resolve as resolvePath, sep } from "node:path";
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
/** Quoted string literals in JS/TS source (single/double, escape-aware; template strings skipped). */
const STRING_LITERAL_RE = /(['"])((?:\\.|(?!\1)[^\\\r\n])*)\1/g;

export interface AnalyzeOptions {
  /** Injectable clock for deterministic runs/tests. Defaults to `new Date()`. */
  readonly now?: Date;
  /** Tool/analyzer version stamped into the run and every claim. */
  readonly toolVersion?: string;
}

/**
 * Analyse the project rooted at `rootDir` and return a full {@link ClaimRun}.
 * Deterministic given a fixed clock: claims are id-sorted and reachability is
 * built from the deterministically-constructed IR.
 */
export async function analyzeProject(
  rootDir: string,
  options: AnalyzeOptions = {},
): Promise<ClaimRun> {
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
  const graph = emitIR({ projectRoot: root, records, resolver });

  // Fix 2: expand wildcard subpath exports into production entrypoints.
  const pkg = await readRootPackageJson(root);
  seedWildcardExportEntrypoints(graph, root, files, pkg);

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
  return CONFIG_ROOT_RE.test(name) || DOTRC_RE.test(name);
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
