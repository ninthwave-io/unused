/**
 * `analyzeElixirProject` — the Elixir frontend's composition entry (ADR 0011),
 * mirroring `frontends/ts/analyze.ts`. Wires the pipeline —
 * detect → tracer-compile → config scan → emit IR → partitioned reachability →
 * claims — into a single {@link AnalyzeResult} (the same PRD §4 wire format the
 * TS frontend produces, so every reporter/CLI surface consumes it unchanged).
 *
 * The one difference from the TS frontend, disclosed in the assumption set: this
 * runs the project's compiler (`runTracer`). A project that cannot compile is
 * refused (a thrown {@link ElixirFrontendError}), never a silently-empty result.
 *
 * Claims carry `subject.language = "ex"` via the ADR 0006 id canonical string
 * (the `language` slot), so an Elixir claim id can never collide with a TS one.
 * Public functions are `export`-kind subjects named `Mod.fun/arity`; modules are
 * `export`-kind subjects named `Mod`; files are `file` subjects (v1 — documented
 * in ADR 0011).
 */

import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import {
  computePartitionedReachability,
  emitClaims,
  type PartitionedReachability,
} from "../../core/analysis/index.js";
import {
  type ClaimRun,
  computeSummary,
  type Provenance,
  SCHEMA_VERSION,
} from "../../core/claims/index.js";
import { entrypointId, fileId, type IRGraph } from "../../core/ir/index.js";
import type { AnalyzeInternalOptions, AnalyzeOptions, AnalyzeResult } from "../ts/analyze.js";
import {
  applyConfigSuppressions,
  collectConfigEntrypoints,
  computeConfigHash,
  isClaimable,
  loadConfig,
  warnOnEmptyConfigMatches,
} from "../ts/config.js";
import { filterGitignoredRelativePaths } from "../ts/discover.js";
import { detectElixirProject } from "./detect.js";
import { emitElixirIR } from "./emit.js";
import { ElixirFrontendError, runTracer } from "./runner.js";
import { extractElixirRuntimeReferences } from "./runtime-references.js";

/** Analyzer name stamped into provenance (distinct from the TS `ts-reference-graph`). */
const ANALYZER_NAME = "elixir-reference-graph";
const DEFAULT_TOOL_VERSION = "0.1.0";
const CLAIM_LANGUAGE = "ex";

/** An Elixir module reference in source: `Foo`, `Foo.Bar`, `Foo.Bar.Baz`. */
const MODULE_TOKEN_RE = /\b[A-Z][A-Za-z0-9_]*(?:\.[A-Z][A-Za-z0-9_]*)*\b/g;

export interface AnalyzeElixirWithGraph {
  readonly result: AnalyzeResult;
  readonly graph: IRGraph;
  readonly reachability: PartitionedReachability;
}

/**
 * Analyze the Elixir (mix) project rooted at `rootDir`. Throws an
 * {@link ElixirFrontendError} when the project is not an Elixir project, the
 * toolchain is absent, or the project cannot be compiled.
 */
export async function analyzeElixirProject(
  rootDir: string,
  options: AnalyzeOptions = {},
): Promise<AnalyzeResult> {
  return (await analyzeElixirProjectWithGraph(rootDir, options)).result;
}

export async function analyzeElixirProjectWithGraph(
  rootDir: string,
  options: AnalyzeOptions = {},
  internal: AnalyzeInternalOptions = {},
): Promise<AnalyzeElixirWithGraph> {
  const start = Date.now();
  const now = options.now ?? new Date();
  const version = options.toolVersion ?? DEFAULT_TOOL_VERSION;

  const project = detectElixirProject(rootDir);
  if (project === null) {
    throw new ElixirFrontendError(`not an Elixir project: no mix.exs found in ${rootDir}.`);
  }
  const config = await loadConfig(project.projectDir, options.configPath);

  // The one place user code runs (disclosed). Throws on every refusal path.
  const traceResult = runTracer(project.projectDir);
  const appName = readAppName(project.mixExsPath) ?? basename(project.projectDir);
  const configUnits = [{ rootRelDir: "", name: appName }] as const;

  // Config roots: modules named as tokens in config/*.exs are kept alive.
  const projectModules = new Set(traceResult.modules.map((m) => m.mod));
  const configReferencedModules = scanConfigModuleReferences(project.projectDir, projectModules);

  const runtimeReferences = extractElixirRuntimeReferences(project.projectDir, traceResult);
  const graph = emitElixirIR({ traceResult, configReferencedModules, runtimeReferences });

  // Per-file line counts for `file`-claim spans (core does no file I/O).
  const fileLineCounts = new Map<string, number>();
  const distinctFiles = new Set<string>();
  for (const mod of traceResult.modules) distinctFiles.add(mod.file);
  for (const fn of traceResult.functions) distinctFiles.add(fn.file);
  const analyzedFiles =
    options.gitignore === false
      ? [...distinctFiles]
      : await filterGitignoredRelativePaths(project.projectDir, [...distinctFiles]);
  const analyzedFileSet = new Set(analyzedFiles);
  for (const hit of collectConfigEntrypoints(analyzedFiles, config, configUnits)) {
    graph.addNode({
      kind: "entrypoint",
      id: entrypointId("production", hit.file),
      entryKind: "production",
      file: hit.file,
      reason: hit.reason,
    });
  }
  for (const rel of distinctFiles) {
    try {
      const content = readFileSync(join(project.projectDir, rel), "utf8");
      fileLineCounts.set(fileId(rel), countLines(content));
    } catch {
      // A file the tracer knew about but we cannot read (generated, moved) —
      // fall back to the core `[1, 1]` placeholder.
    }
  }

  const reachability = computePartitionedReachability(graph);
  const provenance: Provenance = {
    analyzer: ANALYZER_NAME,
    version,
    generatedAt: now.toISOString(),
  };

  const emittedClaims = emitClaims({
    graph,
    reachability,
    provenance,
    fileLineCounts,
    language: CLAIM_LANGUAGE,
  }).filter(
    (claim) =>
      analyzedFileSet.has(claim.subject.loc.file) &&
      (claim.subject.kind === "dependency" ||
        isClaimable(claim.subject.loc.file, config, configUnits)),
  );

  if (internal.emitConfigMatchWarnings !== false) {
    warnOnEmptyConfigMatches(config, analyzedFiles, analyzedFiles, configUnits);
  }
  const claims = applyConfigSuppressions(emittedClaims, config, configUnits, analyzedFiles, {
    emitWarnings: internal.emitConfigMatchWarnings !== false,
  });

  const run: ClaimRun = {
    schemaVersion: SCHEMA_VERSION,
    tool: { name: "unused", version },
    run: {
      root: project.projectDir,
      configHash: computeConfigHash(config),
      startedAt: now.toISOString(),
      durationMs: Date.now() - start,
    },
    claims,
    summary: computeSummary(claims, { ciSecondsPerTestFile: config.ciSecondsPerTestFile }),
  };

  const result: AnalyzeResult = {
    ...run,
    productionEntrypointCount: reachability.production.productionEntrypointFiles.size,
    fileCount: analyzedFiles.length,
    workspaceCount: 1,
    repoName: appName,
    units: [{ rootRelDir: "", name: appName }],
    gateThreshold: config.gate?.threshold ?? "high",
  };
  return { result, graph, reachability };
}

/**
 * Scan `config/*.exs` for module-name tokens, returning the subset that are
 * project modules. A module referenced only from config (e.g. an Ecto repo, a
 * Plug named in an endpoint's config) must never be flagged unused; config is
 * not part of the compiled module graph, so this is a deliberately conservative
 * text scan (it can only keep code alive, never add a false positive).
 */
export function scanConfigModuleReferences(
  projectDir: string,
  projectModules: ReadonlySet<string>,
): Set<string> {
  const found = new Set<string>();
  const configDir = join(projectDir, "config");
  let entries: string[];
  try {
    entries = readdirSync(configDir);
  } catch {
    return found;
  }
  for (const entry of entries) {
    if (!entry.endsWith(".exs")) continue;
    let content: string;
    try {
      content = readFileSync(join(configDir, entry), "utf8");
    } catch {
      continue;
    }
    const matches = content.match(MODULE_TOKEN_RE) ?? [];
    for (const token of matches) {
      // config tokens are written without the `Elixir.` prefix; the tracer's
      // `inspect`-form module names match that exactly (`MyApp.Repo`).
      if (projectModules.has(token)) found.add(token);
    }
  }
  return found;
}

/** Best-effort read of the app name from `mix.exs` (`app: :name`). */
function readAppName(mixExsPath: string): string | null {
  try {
    const content = readFileSync(mixExsPath, "utf8");
    const match = /\bapp:\s*:([a-z][a-z0-9_]*)/i.exec(content);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

function countLines(content: string): number {
  if (content.length === 0) return 1;
  let lines = 1;
  for (let i = 0; i < content.length; i += 1) {
    if (content.charCodeAt(i) === 10) lines += 1;
  }
  return content.endsWith("\n") ? lines - 1 : lines;
}
