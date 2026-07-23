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
 * Claims carry `language = "ex"` and use the same value in ADR 0006's
 * canonical-id language slot, so an Elixir claim id can never collide with a
 * TypeScript one.
 * Public functions are `export`-kind subjects named `Mod.fun/arity`; modules are
 * `export`-kind subjects named `Mod`; files are `file` subjects (v1 — documented
 * in ADR 0011).
 */

import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import {
  computePartitionedReachability,
  emitClaims,
  evaluateHazards,
  type HazardEvaluation,
  type PartitionedReachability,
} from "../../core/analysis/index.js";
import {
  type ClaimRun,
  computeSummary,
  type Provenance,
  SCHEMA_VERSION,
} from "../../core/claims/index.js";
import { entrypointId, fileId, IRGraph } from "../../core/ir/index.js";
import { createFrontendConfigContribution } from "../config-projection.js";
import {
  applyConfigSymbolEntrypoints,
  graphSymbolLanguages,
} from "../config-symbol-entrypoints.js";
import { collectFrontendClaimAnnotations } from "../plugins/claim-annotations.js";
import type {
  FrontendClaimInputs,
  FrontendLocalGraph,
  GraphContribution,
  PluginDiagnostic,
} from "../plugins/types.js";
import type { AnalyzeInternalOptions, AnalyzeOptions, AnalyzeResult } from "../ts/analyze.js";
import {
  applyConfigSuppressions,
  assertUnambiguousWorkspaceKeys,
  collectConfigEntrypoints,
  computeConfigHash,
  isClaimable,
  loadConfig,
  warnOnEmptyConfigMatches,
} from "../ts/config.js";
import { discoverProjectInventory, filterGitignoredRelativePaths } from "../ts/discover.js";
import type { ElixirAtomRoleSummaryProvider } from "./atom-role-summaries.js";
import { detectElixirProject } from "./detect.js";
import { emitElixirIR } from "./emit.js";
import { ElixirFrontendError, runTracer } from "./runner.js";
import { extractElixirRuntimeConventions } from "./runtime-references.js";
import { extractElixirScriptCommandRoots, extractElixirScriptFacts } from "./script-references.js";

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
  readonly claimInputs: FrontendClaimInputs;
  readonly provenance: Provenance;
  readonly hazardEvaluation: HazardEvaluation;
  readonly deferredContributions?: ReadonlyMap<string, GraphContribution>;
}

export interface AnalyzeElixirInternalOptions extends AnalyzeInternalOptions {
  readonly atomRoleSummaryProviders?: readonly ElixirAtomRoleSummaryProvider[];
}

const ELIXIR_RUNTIME_PLUGIN_ID = "convention:elixir-runtime";
const ELIXIR_SCRIPTS_PLUGIN_ID = "convention:elixir-scripts";
const ELIXIR_RUNTIME_HAZARDS = new Set([
  "elixir-behaviour-callback",
  "elixir-computed-atom-escape",
  "elixir-dynamic-dispatch",
  "elixir-phoenix-runtime",
]);

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
  internal: AnalyzeElixirInternalOptions = {},
): Promise<AnalyzeElixirWithGraph> {
  return (await analyzeElixirProjectGraph(
    rootDir,
    options,
    internal,
    false,
  )) as AnalyzeElixirWithGraph;
}

/** Graph-only frontend path used before repository-wide reachability and claims. */
export async function analyzeElixirProjectFragment(
  rootDir: string,
  options: AnalyzeOptions = {},
  internal: AnalyzeElixirInternalOptions = {},
): Promise<FrontendLocalGraph> {
  return (await analyzeElixirProjectGraph(rootDir, options, internal, true)) as FrontendLocalGraph;
}

async function analyzeElixirProjectGraph(
  rootDir: string,
  options: AnalyzeOptions,
  internal: AnalyzeElixirInternalOptions,
  fragmentOnly: boolean,
): Promise<AnalyzeElixirWithGraph | FrontendLocalGraph> {
  const start = Date.now();
  const now = options.now ?? new Date();
  const version = options.toolVersion ?? DEFAULT_TOOL_VERSION;
  const performance = options.performance;

  const workspaceStarted = performance?.now();
  const project = detectElixirProject(rootDir);
  if (project === null) {
    throw new ElixirFrontendError(`not an Elixir project: no mix.exs found in ${rootDir}.`);
  }
  const config =
    internal.resolvedConfig ?? (await loadConfig(project.projectDir, options.configPath));
  if (fragmentOnly) performance?.increment("workspaces");
  else performance?.set("workspaces", 1);
  if (workspaceStarted !== undefined) {
    performance?.finish("workspace-config-detection", workspaceStarted);
  }

  const inventoryStarted = performance?.now();
  const visibleElixirSourceFiles =
    internal.elixirSourceFiles ??
    (
      await discoverProjectInventory(project.projectDir, {
        ...(options.gitignore === undefined ? {} : { gitignore: options.gitignore }),
      })
    ).elixirSourceFiles;
  if (inventoryStarted !== undefined) {
    performance?.finish("discovery-gitignore", inventoryStarted);
  }

  // The one place user code runs (disclosed). Throws on every refusal path.
  const parsingStarted = performance?.now();
  const traceResult = runTracer(project.projectDir);
  if (parsingStarted !== undefined) performance?.finish("parsing", parsingStarted);

  const conventionStarted = performance?.now();
  const appName = readAppName(project.mixExsPath) ?? basename(project.projectDir);
  const configUnits = [{ rootRelDir: "", name: appName }] as const;
  assertUnambiguousWorkspaceKeys(config, configUnits);

  // Config roots: modules named as tokens in config/*.exs are kept alive.
  const projectModules = new Set(traceResult.modules.map((m) => m.mod));
  const configReferencedModules = scanConfigModuleReferences(project.projectDir, projectModules);

  const runtimeConventions = extractElixirRuntimeConventions(
    project.projectDir,
    traceResult,
    internal.atomRoleSummaryProviders,
  );
  const scriptFacts = extractElixirScriptFacts(
    project.projectDir,
    visibleElixirSourceFiles,
    traceResult,
  );
  const scriptsDeferred = internal.deferredConventions?.includes("elixir-scripts") === true;
  const scriptContribution = mergeGraphContributions(
    scriptFacts.contribution,
    scriptsDeferred
      ? {}
      : await extractElixirScriptCommandRoots(
          project.projectDir,
          new Set(scriptFacts.files),
          options.gitignore !== false,
        ),
  );
  performance?.increment("resolutionAttempts", scriptFacts.resolutionAttempts);
  if (conventionStarted !== undefined) {
    performance?.finish("convention-config-roots", conventionStarted);
  }

  const graphStarted = performance?.now();
  let graph = emitElixirIR({
    traceResult,
    configReferencedModules,
    runtimeReferences: runtimeConventions.references,
    dynamicDispatches: runtimeConventions.dynamicDispatches,
  });
  const deferredContributions = new Map<string, GraphContribution>();
  if (internal.deferredConventions?.includes("elixir-runtime") === true) {
    const deferred = deferElixirRuntimeContribution(graph);
    graph = deferred.graph;
    deferredContributions.set(ELIXIR_RUNTIME_PLUGIN_ID, deferred.contribution);
  }
  if (scriptsDeferred) {
    if ((scriptContribution.nodes?.length ?? 0) > 0) {
      deferredContributions.set(ELIXIR_SCRIPTS_PLUGIN_ID, scriptContribution);
    }
  } else {
    addGraphContribution(graph, scriptContribution);
  }
  const symbolCount = graph.nodes().filter((node) => node.kind === "symbol").length;
  const edgeCount = graph.edges().length;
  if (fragmentOnly) {
    performance?.increment("symbols", symbolCount);
    performance?.increment("edges", edgeCount);
  } else {
    performance?.set("symbols", symbolCount);
    performance?.set("edges", edgeCount);
  }
  if (graphStarted !== undefined) performance?.finish("graph-construction", graphStarted);

  // Per-file line counts for `file`-claim spans (core does no file I/O).
  const fileLineCounts = new Map<string, number>(scriptFacts.fileLineCounts);
  const distinctFiles = new Set<string>();
  for (const mod of traceResult.modules) distinctFiles.add(mod.file);
  for (const fn of traceResult.functions) distinctFiles.add(fn.file);
  for (const file of scriptFacts.files) distinctFiles.add(file);
  const discoveryStarted = performance?.now();
  const analyzedFiles =
    options.gitignore === false
      ? [...distinctFiles]
      : await filterGitignoredRelativePaths(project.projectDir, [...distinctFiles]);
  if (fragmentOnly) performance?.increment("files", analyzedFiles.length);
  else performance?.set("files", analyzedFiles.length);
  if (discoveryStarted !== undefined) {
    performance?.finish("discovery-gitignore", discoveryStarted);
  }
  const analyzedFileSet = new Set(analyzedFiles);
  const configRootsStarted = performance?.now();
  for (const hit of collectConfigEntrypoints(analyzedFiles, config, configUnits)) {
    graph.addNode({
      kind: "entrypoint",
      id: entrypointId("production", hit.file),
      entryKind: "production",
      file: hit.file,
      reason: hit.reason,
    });
  }
  if (configRootsStarted !== undefined) {
    performance?.finish("convention-config-roots", configRootsStarted);
  }
  for (const rel of distinctFiles) {
    if (fileLineCounts.has(fileId(rel))) continue;
    try {
      const content = readFileSync(join(project.projectDir, rel), "utf8");
      fileLineCounts.set(fileId(rel), countLines(content));
    } catch {
      // A file the tracer knew about but we cannot read (generated, moved) —
      // fall back to the core `[1, 1]` placeholder.
    }
  }

  if (internal.deferConfigSymbolEntrypoints !== true) {
    applyConfigSymbolEntrypoints({
      graph,
      config,
      units: configUnits,
      symbolLanguages: graphSymbolLanguages(graph, "ex"),
      ...(performance === undefined ? {} : { performance }),
    });
  }
  const provenance: Provenance = {
    analyzer: ANALYZER_NAME,
    version,
    generatedAt: now.toISOString(),
  };
  const claimInputs: FrontendClaimInputs = {
    fileLineCounts,
    units: configUnits,
    analysisFiles: analyzedFileSet,
    claimableFiles: new Set(analyzedFiles.filter((file) => isClaimable(file, config, configUnits))),
  };

  const diagnostics =
    traceResult.testPartition === "complete" ? [] : [incompleteTestPartitionDiagnostic("ex:.")];
  if (fragmentOnly) {
    return {
      graph,
      provenance,
      claimInputs,
      claimAnnotations: collectFrontendClaimAnnotations({
        graph,
        config,
        units: configUnits,
        claimInputs,
      }),
      configuration: createFrontendConfigContribution(config, configUnits, "ex", analyzedFiles, {
        presetsShadowed: internal.boundaryPresetsShadowed === true,
      }),
      metadata: {
        projectName: appName,
        fileCount: analyzedFiles.length,
        workspaceCount: 1,
        configHash: computeConfigHash(config),
        gateThreshold: config.gate?.threshold ?? "high",
        completeness: {
          production: "complete",
          config: "complete",
          test: traceResult.testPartition,
        },
      },
      ...(deferredContributions.size === 0 ? {} : { deferredContributions }),
      diagnostics,
    };
  }

  const reachability = computePartitionedReachability(graph, performance);

  const hazardEvaluation = evaluateHazards({
    graph,
    reachability,
    dependencies: [],
    ...(performance === undefined ? {} : { performance }),
  });
  const emittedClaims = emitClaims({
    graph,
    reachability,
    provenance,
    fileLineCounts,
    language: CLAIM_LANGUAGE,
    hazardEvaluation,
    ...(performance === undefined ? {} : { performance }),
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
  performance?.set("claims", claims.length);

  const run: ClaimRun = {
    schemaVersion: SCHEMA_VERSION,
    tool: { name: "unused", version },
    run: {
      root: project.projectDir,
      configHash: computeConfigHash(config),
      startedAt: now.toISOString(),
      durationMs: Date.now() - start,
      boundaries: [
        {
          status: traceResult.testPartition === "complete" ? "complete" : "partial",
          pluginId: "language:elixir",
          boundaryId: "ex:.",
          language: "ex",
          fileCount: analyzedFiles.length,
          workspaceCount: 1,
          partitions: {
            production: "complete",
            config: "complete",
            test: traceResult.testPartition,
          },
        },
      ],
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
    ...(diagnostics.length === 0 ? {} : { diagnostics }),
  };
  return {
    result,
    graph,
    reachability,
    claimInputs,
    provenance,
    hazardEvaluation,
    ...(deferredContributions.size === 0 ? {} : { deferredContributions }),
  };
}

function addGraphContribution(graph: IRGraph, contribution: GraphContribution): void {
  for (const node of contribution.nodes ?? []) graph.addNode(node);
  for (const edge of contribution.edges ?? []) graph.addEdge(edge);
  for (const hazard of contribution.hazards ?? []) graph.addHazard(hazard);
}

function mergeGraphContributions(
  first: GraphContribution,
  second: GraphContribution,
): GraphContribution {
  return {
    nodes: [...(first.nodes ?? []), ...(second.nodes ?? [])],
    edges: [...(first.edges ?? []), ...(second.edges ?? [])],
    hazards: [...(first.hazards ?? []), ...(second.hazards ?? [])],
    diagnostics: [...(first.diagnostics ?? []), ...(second.diagnostics ?? [])],
  };
}

function incompleteTestPartitionDiagnostic(boundaryId: string): PluginDiagnostic {
  return {
    pluginId: "language:elixir",
    boundaryId,
    severity: "warning",
    code: "elixir-test-partition-incomplete",
    message:
      "test compilation was incomplete under isolated --no-start analysis; potentially test-reachable subjects were conservatively kept alive",
  };
}

function deferElixirRuntimeContribution(graph: IRGraph): {
  readonly graph: IRGraph;
  readonly contribution: GraphContribution;
} {
  const deferredNodeIds = new Set(
    graph
      .nodes()
      .filter((node) => node.kind === "entrypoint" && node.reason === "phoenix-endpoint-router")
      .map((node) => node.id),
  );
  const nodes = graph.nodes().filter((node) => deferredNodeIds.has(node.id));
  const edges = graph
    .edges()
    .filter((edge) => edge.kind === "references" && edge.referenceKind === "runtime-resolved");
  const hazards = graph
    .hazards()
    .filter((hazard) => ELIXIR_RUNTIME_HAZARDS.has(hazard.hazardClass));
  const deferredEdges = new Set(edges);
  const deferredHazards = new Set(hazards);
  const retained = new IRGraph();
  for (const node of graph.nodes()) if (!deferredNodeIds.has(node.id)) retained.addNode(node);
  for (const edge of graph.edges()) if (!deferredEdges.has(edge)) retained.addEdge(edge);
  for (const hazard of graph.hazards())
    if (!deferredHazards.has(hazard)) retained.addHazard(hazard);
  return { graph: retained, contribution: { nodes, edges, hazards } };
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
