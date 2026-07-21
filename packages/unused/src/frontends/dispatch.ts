/** Repository-level polyglot orchestration (ADR 0013). */

import { basename, resolve } from "node:path";
import {
  computePartitionedReachability,
  emitClaims,
  type PartitionedReachability,
} from "../core/analysis/index.js";
import { type Claim, computeSummary, SCHEMA_VERSION } from "../core/claims/index.js";
import { entrypointId, IRGraph, type IRNode } from "../core/ir/index.js";
import { analyzeElixirProjectWithGraph } from "./elixir/index.js";
import { BUILT_IN_PLUGINS, claimAnnotationKey } from "./plugins/builtins.js";
import { PluginRegistry } from "./plugins/registry.js";
import {
  executePluginOperation,
  type FrontendGraphFragment,
  type GraphContribution,
  type RepositoryAnalysisContext,
} from "./plugins/types.js";
import { type AnalyzeOptions, type AnalyzeResult, analyzeProjectWithGraph } from "./ts/analyze.js";
import {
  applyConfigSuppressions,
  collectConfigEntrypoints,
  computeConfigHash,
  isClaimable,
  isIgnoredDependency,
  loadConfig,
  warnOnEmptyConfigMatches,
} from "./ts/config.js";
import { discoverProjectInventory } from "./ts/discover.js";

export interface AnalyzeAutoWithGraph {
  readonly result: AnalyzeResult;
  readonly graph: IRGraph;
  readonly reachability: PartitionedReachability;
  /** Internal completeness/counter metadata; never included in canonical JSON. */
  readonly boundaries: readonly BoundaryRunMetadata[];
}

export interface BoundaryRunMetadata {
  readonly status: "complete";
  readonly pluginId: string;
  readonly boundaryId: string;
  readonly language: string;
  readonly fileCount: number;
  readonly workspaceCount: number;
}

export async function analyzeProjectAuto(
  rootDir: string,
  options: AnalyzeOptions = {},
): Promise<AnalyzeResult> {
  return (await analyzeProjectAutoWithGraph(rootDir, options)).result;
}

/**
 * Analyze every supported boundary visible from `rootDir`. Single-root runs use
 * their existing composition entry to preserve pre-plugin output exactly;
 * nested or mixed runs merge graph fragments before one reachability pass.
 */
export async function analyzeProjectAutoWithGraph(
  rootDir: string,
  options: AnalyzeOptions = {},
): Promise<AnalyzeAutoWithGraph> {
  const started = Date.now();
  const root = resolve(rootDir);
  const inventory = await discoverProjectInventory(root, {
    ...(options.gitignore === undefined ? {} : { gitignore: options.gitignore }),
  });
  const context: RepositoryAnalysisContext = {
    rootDir: root,
    gitignore: options.gitignore !== false,
    manifests: {
      packageJsonDirs: inventory.packageRootDirs,
      mixExsDirs: inventory.mixProjectDirs,
      cargoTomlDirs: inventory.cargoProjectDirs,
      rustSourceFiles: inventory.rustSourceFiles,
    },
    now: options.now ?? new Date(),
    toolVersion: options.toolVersion ?? "0.1.0",
    ...(options.configPath === undefined ? {} : { configPath: resolve(root, options.configPath) }),
    ...(options.performance === undefined ? {} : { performance: options.performance }),
  };
  const registry = new PluginRegistry(BUILT_IN_PLUGINS);
  const discovered = (
    await Promise.all(
      registry.languagePlugins().map(async (plugin) => ({
        plugin,
        boundaries: await executePluginOperation(plugin.id, undefined, () =>
          plugin.discover(context),
        ),
      })),
    )
  ).flatMap(({ plugin, boundaries }) => boundaries.map((boundary) => ({ plugin, boundary })));
  discovered.sort((a, b) =>
    a.boundary.id < b.boundary.id ? -1 : a.boundary.id > b.boundary.id ? 1 : 0,
  );

  // The historical no-manifest fallback and root-only paths stay byte-compatible.
  if (discovered.length === 0) {
    const analysis = await analyzeProjectWithGraph(root, options);
    return {
      ...analysis,
      boundaries: [
        {
          status: "complete",
          pluginId: "language:typescript",
          boundaryId: "ts:fallback",
          language: "ts",
          fileCount: analysis.result.fileCount,
          workspaceCount: analysis.result.workspaceCount,
        },
      ],
    };
  }
  if (
    discovered.length === 1 &&
    discovered[0]?.boundary.rootRelDir === "" &&
    (discovered[0].plugin.language === "ts" || discovered[0].plugin.language === "ex")
  ) {
    const selected = discovered[0];
    const analysis = await (selected.plugin.language === "ex"
      ? analyzeElixirProjectWithGraph(root, options)
      : analyzeProjectWithGraph(root, options));
    return {
      ...analysis,
      boundaries: [
        {
          status: "complete",
          pluginId: selected.plugin.id,
          boundaryId: selected.boundary.id,
          language: selected.plugin.language,
          fileCount: analysis.result.fileCount,
          workspaceCount: analysis.result.workspaceCount,
        },
      ],
    };
  }

  const fragments: FrontendGraphFragment[] = [];
  for (const { plugin, boundary } of discovered) {
    fragments.push(
      await executePluginOperation(plugin.id, boundary.id, () => plugin.analyze(context, boundary)),
    );
  }
  const graph = mergeFragments(fragments);

  for (const plugin of registry.conventionPlugins()) {
    for (const fragment of fragments) {
      if (!plugin.languages.includes(fragment.language)) continue;
      const pluginContext = { repository: context, fragment };
      if (!(await plugin.applies(pluginContext))) continue;
      addContribution(
        graph,
        await executePluginOperation(plugin.id, fragment.boundary.id, () =>
          plugin.analyze(pluginContext),
        ),
        plugin.id,
      );
    }
  }
  for (const plugin of registry.bridgePlugins()) {
    const languages = new Set(fragments.map((fragment) => fragment.language));
    if (!plugin.requiredLanguages.every((language) => languages.has(language))) continue;
    const pluginContext = { repository: context, fragments, graph };
    if (!(await plugin.applies(pluginContext))) continue;
    addContribution(
      graph,
      await executePluginOperation(plugin.id, undefined, () => plugin.analyze(pluginContext)),
      plugin.id,
    );
  }

  const config = await loadConfig(root, context.configPath);
  const units = repositoryUnits(fragments);
  const analyzedFiles = [
    ...new Set(fragments.flatMap((f) => [...f.claimInputs.analysisFiles])),
  ].sort();
  for (const hit of collectConfigEntrypoints(analyzedFiles, config, units)) {
    graph.addNode({
      kind: "entrypoint",
      id: entrypointId("production", hit.file),
      entryKind: "production",
      file: hit.file,
      reason: hit.reason,
    });
  }
  warnOnEmptyConfigMatches(config, analyzedFiles, analyzedFiles, units);

  const reachability = computePartitionedReachability(graph, options.performance);
  let claims = fragments.flatMap((fragment) =>
    emitClaims({
      graph,
      reachability,
      provenance: fragment.provenance,
      language: fragment.language,
      ...fragment.claimInputs,
      ...(options.performance === undefined ? {} : { performance: options.performance }),
    }).map((claim) => applyClaimAnnotation(claim, fragment)),
  );
  claims = claims.filter((claim) =>
    claim.subject.kind === "dependency"
      ? !isIgnoredDependency(claim.subject.name, config)
      : isClaimable(claim.subject.loc.file, config, units),
  );
  claims = applyConfigSuppressions(claims, config, units, analyzedFiles).sort(byClaimId);

  const now = context.now;
  const rootTypeScript = fragments.find(
    (fragment) => fragment.language === "ts" && fragment.boundary.rootRelDir === "",
  );
  const rootProject =
    rootTypeScript ?? fragments.find((fragment) => fragment.boundary.rootRelDir === "");
  options.performance?.set("files", analyzedFiles.length);
  options.performance?.set(
    "symbols",
    graph.nodes().filter((node) => node.kind === "symbol").length,
  );
  options.performance?.set("edges", graph.edges().length);
  options.performance?.set("claims", claims.length);
  options.performance?.set("workspaces", units.length);
  const result: AnalyzeResult = {
    schemaVersion: SCHEMA_VERSION,
    tool: { name: "unused", version: context.toolVersion },
    run: {
      root,
      configHash: computeConfigHash(config),
      startedAt: now.toISOString(),
      durationMs: Date.now() - started,
    },
    claims,
    summary: computeSummary(claims, { ciSecondsPerTestFile: config.ciSecondsPerTestFile }),
    productionEntrypointCount: reachability.production.productionEntrypointFiles.size,
    fileCount: analyzedFiles.length,
    workspaceCount: units.length,
    repoName: rootProject?.metadata.projectName ?? basename(root),
    units,
    gateThreshold: config.gate?.threshold ?? "high",
  };
  return {
    result,
    graph,
    reachability,
    boundaries: fragments.map((fragment) => ({
      status: "complete",
      pluginId: fragment.pluginId,
      boundaryId: fragment.boundary.id,
      language: fragment.language,
      fileCount: fragment.metadata.fileCount,
      workspaceCount: fragment.metadata.workspaceCount,
    })),
  };
}

function mergeFragments(fragments: readonly FrontendGraphFragment[]): IRGraph {
  const graph = new IRGraph();
  for (const fragment of fragments) {
    addContribution(
      graph,
      {
        nodes: fragment.graph.nodes(),
        edges: fragment.graph.edges(),
        hazards: fragment.graph.hazards(),
      },
      fragment.pluginId,
    );
  }
  return graph;
}

function addContribution(graph: IRGraph, contribution: GraphContribution, pluginId: string): void {
  for (const node of contribution.nodes ?? []) addNodeChecked(graph, node, pluginId);
  for (const edge of contribution.edges ?? []) graph.addEdge(edge);
  for (const hazard of contribution.hazards ?? []) graph.addHazard(hazard);
}

function addNodeChecked(graph: IRGraph, node: IRNode, pluginId: string): void {
  const existing = graph.getNode(node.id);
  if (existing !== undefined && JSON.stringify(existing) !== JSON.stringify(node)) {
    throw new Error(`plugin ${pluginId} produced conflicting graph node id ${node.id}`);
  }
  graph.addNode(node);
}

function repositoryUnits(
  fragments: readonly FrontendGraphFragment[],
): Array<{ readonly rootRelDir: string; readonly name: string | null }> {
  const byRoot = new Map<string, { readonly rootRelDir: string; readonly name: string | null }>();
  for (const fragment of fragments) {
    for (const unit of fragment.claimInputs.units) {
      const existing = byRoot.get(unit.rootRelDir);
      if (existing === undefined || (existing.name === null && unit.name !== null)) {
        byRoot.set(unit.rootRelDir, unit);
      }
    }
  }
  return [...byRoot.values()].sort((a, b) =>
    a.rootRelDir === ""
      ? -1
      : b.rootRelDir === ""
        ? 1
        : a.rootRelDir < b.rootRelDir
          ? -1
          : a.rootRelDir > b.rootRelDir
            ? 1
            : 0,
  );
}

function applyClaimAnnotation(claim: Claim, fragment: FrontendGraphFragment): Claim {
  const annotation = fragment.claimAnnotations.get(
    claimAnnotationKey(
      claim.subject.kind,
      claim.subject.loc.file,
      "name" in claim.subject ? claim.subject.name : undefined,
    ),
  );
  if (annotation === undefined) return claim;
  return {
    ...claim,
    ...(annotation.suppression === undefined ? {} : { suppression: annotation.suppression }),
    ...(annotation.evidence === undefined ? {} : { evidence: annotation.evidence }),
    subject: {
      ...claim.subject,
      loc: {
        ...claim.subject.loc,
        ...(annotation.package === undefined ? {} : { package: annotation.package }),
      },
    },
  } as Claim;
}

function byClaimId(a: Claim, b: Claim): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
