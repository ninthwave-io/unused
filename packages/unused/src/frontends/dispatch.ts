/**
 * Language dispatch for the CLI (ADR 0003/0011): pick the frontend(s) for a
 * project from its manifests and merge their claims into one {@link
 * AnalyzeResult}.
 *
 *  - `package.json` present, no `mix.exs`  ⇒ the TypeScript frontend.
 *  - `mix.exs` present, no `package.json`  ⇒ the Elixir frontend.
 *  - both present                          ⇒ run both, concatenate claims,
 *    recompute the summary over the union. The TS result is the base for the
 *    out-of-band header/baseline fields (`units`, `gateThreshold`, `repoName`);
 *    Elixir claims fall under the root unit for baseline purposes (mixed-language
 *    per-unit baselines are post-v1).
 *  - neither                               ⇒ the TS frontend (which reports "no
 *    entrypoints"), preserving today's behaviour.
 *
 * Living in `frontends/` keeps it on the correct side of the boundary rules
 * (a frontend may compose frontends; only cli/reporters/mcp are off-limits).
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  computePartitionedReachability,
  type PartitionedReachability,
} from "../core/analysis/index.js";
import { computeSummary } from "../core/claims/index.js";
import { IRGraph } from "../core/ir/index.js";
import { analyzeElixirProjectWithGraph } from "./elixir/index.js";
import { type AnalyzeOptions, type AnalyzeResult, analyzeProjectWithGraph } from "./ts/analyze.js";
import { applyConfigSuppressions, loadConfig, warnOnEmptyConfigMatches } from "./ts/config.js";
import { filterGitignoredRelativePaths } from "./ts/discover.js";

export interface AnalyzeAutoWithGraph {
  readonly result: AnalyzeResult;
  readonly graph: IRGraph;
  readonly reachability: PartitionedReachability;
}

/**
 * Analyze `rootDir`, auto-selecting the language frontend(s). Elixir refusals
 * (`ElixirFrontendError`) propagate to the CLI, which maps them to exit 2 with a
 * clear message. A TS-and-Elixir repo where Elixir refuses is a hard error (we
 * do not silently drop half the analysis).
 */
export async function analyzeProjectAuto(
  rootDir: string,
  options: AnalyzeOptions = {},
): Promise<AnalyzeResult> {
  return (await analyzeProjectAutoWithGraph(rootDir, options)).result;
}

/** Analyze the auto-detected language set and retain the merged graph for why/planning. */
export async function analyzeProjectAutoWithGraph(
  rootDir: string,
  options: AnalyzeOptions = {},
): Promise<AnalyzeAutoWithGraph> {
  const hasPackageJson = existsSync(join(rootDir, "package.json"));
  const hasMixExs = existsSync(join(rootDir, "mix.exs"));

  if (hasMixExs && !hasPackageJson) {
    return analyzeElixirProjectWithGraph(rootDir, options);
  }
  if (!hasMixExs) {
    return analyzeProjectWithGraph(rootDir, options);
  }

  // Both manifests present: run both, merge.
  const internal = { emitConfigMatchWarnings: false } as const;
  const [ts, elixir] = await Promise.all([
    analyzeProjectWithGraph(rootDir, options, internal),
    analyzeElixirProjectWithGraph(rootDir, options, internal),
  ]);
  const config = await loadConfig(rootDir, options.configPath);
  const graph = mergeGraphs(ts.graph, elixir.graph);
  const graphFiles = [...graph.nodes()]
    .filter((node) => node.kind === "file")
    .map((node) => node.path)
    .sort();
  const analyzedFiles =
    options.gitignore === false
      ? graphFiles
      : await filterGitignoredRelativePaths(rootDir, graphFiles);

  // A mixed run has one config contract, so diagnostics evaluate the complete
  // language union once rather than warning over two partial inventories.
  warnOnEmptyConfigMatches(config, analyzedFiles, analyzedFiles, ts.result.units);
  const claims = applyConfigSuppressions(
    [...ts.result.claims, ...elixir.result.claims],
    config,
    ts.result.units,
    analyzedFiles,
  ).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const result: AnalyzeResult = {
    ...ts.result,
    claims,
    summary: computeSummary(claims, { ciSecondsPerTestFile: config.ciSecondsPerTestFile }),
    productionEntrypointCount:
      ts.result.productionEntrypointCount + elixir.result.productionEntrypointCount,
    fileCount: ts.result.fileCount + elixir.result.fileCount,
  };
  return { result, graph, reachability: computePartitionedReachability(graph) };
}

function mergeGraphs(...graphs: readonly IRGraph[]): IRGraph {
  const merged = new IRGraph();
  for (const graph of graphs) {
    for (const node of graph.nodes()) merged.addNode(node);
    for (const edge of graph.edges()) merged.addEdge(edge);
    for (const hazard of graph.hazards()) merged.addHazard(hazard);
  }
  return merged;
}
