/** Repository-level polyglot orchestration (ADR 0013). */

import { basename, resolve } from "node:path";
import {
  computePartitionedReachability,
  createClaimEmissionContext,
  createHazardEvaluationContext,
  emitClaims,
  evaluateHazards,
  type HazardEvaluation,
  type PartitionedReachability,
} from "../core/analysis/index.js";
import {
  type AnalysisBoundary,
  type Claim,
  computeSummary,
  SCHEMA_VERSION,
} from "../core/claims/index.js";
import { entrypointId, IRGraph, type IRNode, type Site } from "../core/ir/index.js";
import type { ConfigMatchProjection } from "./config-contract.js";
import {
  applyConfiguredSymbolRoots,
  collectConfiguredSymbolRoots,
  configuredSymbolSelectorInventory,
} from "./config-symbol-entrypoints.js";
import { analyzeElixirProjectWithGraph } from "./elixir/index.js";
import { BUILT_IN_PLUGINS } from "./plugins/builtins.js";
import { claimAnnotationKey } from "./plugins/claim-annotations.js";
import { collectElixirAtomRoleSummaryProviders } from "./plugins/elixir-role-summary-providers.js";
import { prefixRepositoryPath } from "./plugins/rebase.js";
import { PluginRegistry } from "./plugins/registry.js";
import {
  type AnalyzerPlugin,
  executePluginOperation,
  type FrontendConfigContribution,
  type FrontendGraphFragment,
  type GraphContribution,
  type PluginDiagnostic,
  type RepositoryAnalysisContext,
  requireAnalyzerBoundaryMetadata,
} from "./plugins/types.js";
import { type AnalyzeOptions, type AnalyzeResult, analyzeProjectWithGraph } from "./ts/analyze.js";
import {
  applyConfigSuppressions,
  assertUnambiguousWorkspaceKeys,
  ConfigError,
  collectConfigEntrypoints,
  computeAggregateConfigHash,
  type EntrySymbolLanguage,
  isClaimable,
  isIgnoredDependency,
  loadConfig,
  type UnusedConfig,
  warnOnEmptyConfigMatches,
} from "./ts/config.js";
import { discoverProjectInventory } from "./ts/discover.js";
import { globToRegExp } from "./ts/glob.js";

export interface AnalyzeAutoWithGraph {
  readonly result: AnalyzeResult;
  readonly graph: IRGraph;
  readonly reachability: PartitionedReachability;
  /** Internal access to the same completion records also published at `result.run.boundaries`. */
  readonly boundaries: readonly BoundaryRunMetadata[];
  /** One central evaluation per claim-emitting frontend fragment. */
  readonly hazardEvaluations: readonly HazardEvaluation[];
}

export type BoundaryRunMetadata = AnalysisBoundary;

interface AnalyzeAutoInternalOptions {
  /** Test seam for proving registry-driven topology parity; not a runtime loading API. */
  readonly plugins?: readonly AnalyzerPlugin[];
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
  internal: AnalyzeAutoInternalOptions = {},
): Promise<AnalyzeAutoWithGraph> {
  const started = Date.now();
  const root = resolve(rootDir);
  const repositoryConfigStarted = options.performance?.now();
  const repositoryConfig = await loadConfig(root, options.configPath);
  if (repositoryConfigStarted !== undefined) {
    options.performance?.finish("workspace-config-detection", repositoryConfigStarted);
  }
  const discoveryStarted = options.performance?.now();
  const inventory = await discoverProjectInventory(root, {
    ...(options.gitignore === undefined ? {} : { gitignore: options.gitignore }),
  });
  if (discoveryStarted !== undefined) {
    options.performance?.finish("discovery-gitignore", discoveryStarted);
  }
  const registry = new PluginRegistry(internal.plugins ?? BUILT_IN_PLUGINS);
  const elixirAtomRoleSummaryProviders = collectElixirAtomRoleSummaryProviders(
    registry.conventionPlugins(),
  );
  const context: RepositoryAnalysisContext = {
    rootDir: root,
    gitignore: options.gitignore !== false,
    manifests: {
      packageJsonDirs: inventory.packageRootDirs,
      mixExsDirs: inventory.mixProjectDirs,
      cargoTomlDirs: inventory.cargoProjectDirs,
      elixirSourceFiles: inventory.elixirSourceFiles,
      rustSourceFiles: inventory.rustSourceFiles,
    },
    now: options.now ?? new Date(),
    toolVersion: options.toolVersion ?? "0.1.0",
    elixirAtomRoleSummaryProviders,
    repositoryConfig,
    ...(options.performance === undefined ? {} : { performance: options.performance }),
  };
  const workspaceStarted = options.performance?.now();
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
  if (workspaceStarted !== undefined) {
    options.performance?.finish("workspace-config-detection", workspaceStarted);
  }
  discovered.sort((a, b) =>
    a.boundary.id < b.boundary.id ? -1 : a.boundary.id > b.boundary.id ? 1 : 0,
  );

  // Root-only paths retain their established analysis behavior; this layer
  // replaces only the new public completion metadata.
  if (discovered.length === 0) {
    const analysis = await analyzeProjectWithGraph(root, options, {
      resolvedConfig: repositoryConfig,
    });
    const boundaries: readonly BoundaryRunMetadata[] = [
      deriveDirectBoundaryMetadata({
        analyzerBoundaries: analysis.result.run.boundaries,
        pluginId: "language:typescript",
        boundaryId: "ts:fallback",
        language: "ts",
        fileCount: analysis.result.fileCount,
        workspaceCount: analysis.result.workspaceCount,
      }),
    ];
    return {
      ...analysis,
      result: withCompletedBoundaries(analysis.result, boundaries),
      boundaries,
      hazardEvaluations: [analysis.hazardEvaluation],
    };
  }
  if (
    discovered.length === 1 &&
    discovered[0]?.boundary.rootRelDir === "" &&
    (discovered[0].plugin.language === "ts" || discovered[0].plugin.language === "ex")
  ) {
    const selected = discovered[0];
    const analysis = await (selected.plugin.language === "ex"
      ? analyzeElixirProjectWithGraph(root, options, {
          atomRoleSummaryProviders: elixirAtomRoleSummaryProviders,
          elixirSourceFiles: inventory.elixirSourceFiles,
          resolvedConfig: repositoryConfig,
        })
      : analyzeProjectWithGraph(root, options, { resolvedConfig: repositoryConfig }));
    const boundaries: readonly BoundaryRunMetadata[] = [
      deriveDirectBoundaryMetadata({
        analyzerBoundaries: analysis.result.run.boundaries,
        pluginId: selected.plugin.id,
        boundaryId: selected.boundary.id,
        language: selected.plugin.language,
        fileCount: analysis.result.fileCount,
        workspaceCount: analysis.result.workspaceCount,
      }),
    ];
    return {
      ...analysis,
      result: withCompletedBoundaries(analysis.result, boundaries),
      boundaries,
      hazardEvaluations: [analysis.hazardEvaluation],
    };
  }

  const fragments: FrontendGraphFragment[] = [];
  for (const { plugin, boundary } of discovered) {
    fragments.push(
      await executePluginOperation(plugin.id, boundary.id, () => plugin.analyze(context, boundary)),
    );
  }
  const mergeStarted = options.performance?.now();
  const graph = mergeFragments(fragments);
  const contributionDiagnostics = new RepositoryDiagnosticAccumulator();
  if (mergeStarted !== undefined) options.performance?.finish("graph-construction", mergeStarted);
  const symbolLanguages = new Map<string, "ts" | "ex" | "rs">();
  const symbolBoundaries = new Map<string, string>();
  const fileLanguages = new Map<string, Set<"ts" | "ex" | "rs">>();
  for (const fragment of fragments) {
    const language = entrySymbolLanguage(fragment.language);
    if (language === undefined) continue;
    for (const file of fragment.claimInputs.analysisFiles) {
      const languages = fileLanguages.get(file);
      if (languages === undefined) fileLanguages.set(file, new Set([language]));
      else languages.add(language);
    }
    recordContributionSymbolLanguages(symbolLanguages, fragment.graph.nodes(), language);
    recordContributionSymbolBoundaries(
      symbolBoundaries,
      fragment.graph.nodes(),
      fragment.boundary.id,
    );
  }

  for (const plugin of registry.conventionPlugins()) {
    for (const fragment of fragments) {
      if (!plugin.languages.includes(fragment.language)) continue;
      const pluginContext = { repository: context, fragment };
      if (!(await plugin.applies(pluginContext))) continue;
      const conventionStarted = options.performance?.now();
      const contribution = await executePluginOperation(plugin.id, fragment.boundary.id, () =>
        plugin.analyze(pluginContext),
      );
      addContribution(
        graph,
        contribution,
        {
          scope: "boundary",
          pluginId: plugin.id,
          boundaryId: fragment.boundary.id,
        },
        contributionDiagnostics,
      );
      const language = entrySymbolLanguage(fragment.language);
      if (language !== undefined) {
        recordContributionSymbolLanguages(symbolLanguages, contribution.nodes ?? [], language);
        recordContributionSymbolBoundaries(
          symbolBoundaries,
          contribution.nodes ?? [],
          fragment.boundary.id,
        );
      }
      if (conventionStarted !== undefined) {
        options.performance?.finish("convention-config-roots", conventionStarted);
      }
    }
  }
  for (const plugin of registry.bridgePlugins()) {
    const languages = new Set(fragments.map((fragment) => fragment.language));
    if (!plugin.requiredLanguages.every((language) => languages.has(language))) continue;
    const pluginContext = { repository: context, fragments, graph };
    if (!(await plugin.applies(pluginContext))) continue;
    const bridgeStarted = options.performance?.now();
    const contribution = await executePluginOperation(plugin.id, undefined, () =>
      plugin.analyze(pluginContext),
    );
    addContribution(
      graph,
      contribution,
      { scope: "repository", pluginId: plugin.id },
      contributionDiagnostics,
    );
    for (const node of contribution.nodes ?? []) {
      if (node.kind !== "symbol") continue;
      const languages = fileLanguages.get(node.file);
      if (languages?.size === 1) {
        symbolLanguages.set(node.id, [...languages][0] as "ts" | "ex" | "rs");
      }
    }
    if (bridgeStarted !== undefined) {
      options.performance?.finish("graph-construction", bridgeStarted);
    }
  }

  const config = repositoryConfig;
  const rootPolicy = repositoryWideConfig(config);
  const workspacePolicy = workspaceOnlyConfig(config);
  const fragmentWorkspacePolicies = fragments.map((fragment) =>
    workspacePolicyForUnits(workspacePolicy, fragment.claimInputs.units),
  );
  const workspaceWarningScopes = indexRepositoryWorkspaceWarningScopes(workspacePolicy, fragments);
  const units = repositoryUnits(fragments);
  assertUnambiguousWorkspaceKeys(
    config,
    fragments.flatMap((fragment) => fragment.claimInputs.units),
  );
  const localConfigGroups = groupLocalConfigurations(fragments);
  const localSuppressionMatchers = compileLocalSuppressionMatchers(localConfigGroups);
  const localSuppressionClaimMatches = new Map<string, Set<string>>();
  const analyzedFiles = [
    ...new Set(fragments.flatMap((f) => [...f.claimInputs.analysisFiles])),
  ].sort();
  for (const hit of collectRepositoryConfigEntrypoints(
    fragments,
    rootPolicy,
    fragmentWorkspacePolicies,
  )) {
    graph.addNode({
      kind: "entrypoint",
      id: entrypointId("production", hit.file),
      entryKind: "production",
      file: hit.file,
      reason: hit.reason,
    });
  }
  const configuredSymbolRoots = [
    ...collectRepositoryConfiguredSymbolRoots(fragments, config),
    ...localConfigGroups.flatMap((group) => group.configuredSymbolRoots),
  ];
  applyConfiguredSymbolRoots({
    graph,
    roots: configuredSymbolRoots,
    symbolLanguages,
    symbolBoundaries,
    ...(options.performance === undefined ? {} : { performance: options.performance }),
  });
  warnOnEmptyConfigMatches(rootPolicy, analyzedFiles, analyzedFiles, []);
  warnOnRepositoryWorkspaceFileMatches(workspacePolicy, workspaceWarningScopes);

  const reachability = computePartitionedReachability(graph, options.performance);
  const hazardContext = createHazardEvaluationContext(graph);
  const claimContext = createClaimEmissionContext(graph);
  const hazardEvaluations = fragments.map((fragment) =>
    evaluateHazards({
      graph,
      reachability,
      context: hazardContext,
      units: fragment.claimInputs.units,
      analysisFiles: fragment.claimInputs.analysisFiles,
      dependencies: fragment.claimInputs.dependencies ?? [],
      ...(options.performance === undefined ? {} : { performance: options.performance }),
    }),
  );
  let claims = fragments.flatMap((fragment, index) => {
    const hazardEvaluation = hazardEvaluations[index];
    if (hazardEvaluation === undefined) return [];
    const emitted = emitClaims({
      graph,
      reachability,
      provenance: fragment.provenance,
      language: fragment.language,
      ...fragment.claimInputs,
      hazardEvaluation,
      context: claimContext,
      ...(options.performance === undefined ? {} : { performance: options.performance }),
    })
      .map((claim) => applyClaimAnnotation(claim, fragment))
      .filter((claim) =>
        claim.subject.kind === "dependency"
          ? !isIgnoredDependency(claim.subject.name, config)
          : isClaimable(
              claim.subject.loc.file,
              fragmentWorkspacePolicies[index] as UnusedConfig,
              fragment.claimInputs.units,
            ) && isClaimable(claim.subject.loc.file, rootPolicy, []),
      );
    const configured = applyConfigSuppressions(
      emitted,
      fragmentWorkspacePolicies[index] as UnusedConfig,
      fragment.claimInputs.units,
      [...fragment.claimInputs.analysisFiles],
      { emitWarnings: false },
    );
    recordLocalSuppressionClaimMatches(
      fragment.boundary.id,
      configured,
      localSuppressionMatchers,
      localSuppressionClaimMatches,
    );
    return configured;
  });
  claims = applyConfigSuppressions(claims, rootPolicy, [], analyzedFiles).sort(byClaimId);
  warnOnRepositoryWorkspaceSuppressionMatches(workspacePolicy, workspaceWarningScopes, claims);
  warnOnLocalConfigMatches(localConfigGroups, localSuppressionClaimMatches);

  const now = context.now;
  const rootTypeScript = fragments.find(
    (fragment) => fragment.language === "ts" && fragment.boundary.rootRelDir === "",
  );
  const rootProject =
    rootTypeScript ?? fragments.find((fragment) => fragment.boundary.rootRelDir === "");
  const boundaries = fragments.map(completedBoundary);
  options.performance?.set("files", analyzedFiles.length);
  options.performance?.set(
    "symbols",
    graph.nodes().filter((node) => node.kind === "symbol").length,
  );
  options.performance?.set("edges", graph.edges().length);
  options.performance?.set("claims", claims.length);
  options.performance?.set("workspaces", units.length);
  const diagnostics = [
    ...fragments.flatMap((fragment) => fragment.diagnostics),
    ...contributionDiagnostics.values(),
    ...configPolicyDiagnostics(localConfigGroups),
  ].sort(byDiagnostic);
  const result: AnalyzeResult = {
    schemaVersion: SCHEMA_VERSION,
    tool: { name: "unused", version: context.toolVersion },
    run: {
      root,
      configHash: computeAggregateConfigHash(
        config,
        localConfigGroups.map((group) => ({
          boundaryId: `config:${group.rootRelDir}`,
          fingerprint: group.configuration.analysisFingerprint,
          hasEffectivePolicy: group.configuration.hasEffectiveAnalysisPolicy,
        })),
      ),
      startedAt: now.toISOString(),
      durationMs: Date.now() - started,
      boundaries,
    },
    claims,
    summary: computeSummary(claims, { ciSecondsPerTestFile: config.ciSecondsPerTestFile }),
    productionEntrypointCount: reachability.production.productionEntrypointFiles.size,
    fileCount: analyzedFiles.length,
    workspaceCount: units.length,
    repoName: rootProject?.metadata.projectName ?? basename(root),
    units,
    gateThreshold: config.gate?.threshold ?? "high",
    ...(diagnostics.length === 0 ? {} : { diagnostics }),
  };
  return {
    result,
    graph,
    reachability,
    boundaries,
    hazardEvaluations,
  };
}

function entrySymbolLanguage(language: string): "ts" | "ex" | "rs" | undefined {
  return language === "ts" || language === "ex" || language === "rs" ? language : undefined;
}

function recordContributionSymbolLanguages(
  symbolLanguages: Map<string, "ts" | "ex" | "rs">,
  nodes: readonly IRNode[],
  language: "ts" | "ex" | "rs",
): void {
  for (const node of nodes) {
    if (node.kind === "symbol") symbolLanguages.set(node.id, language);
  }
}

function recordContributionSymbolBoundaries(
  symbolBoundaries: Map<string, string>,
  nodes: readonly IRNode[],
  boundaryId: string,
): void {
  for (const node of nodes) {
    if (node.kind === "symbol") symbolBoundaries.set(node.id, boundaryId);
  }
}

interface LocalConfigGroup {
  readonly rootRelDir: string;
  readonly fragments: readonly FrontendGraphFragment[];
  readonly configuration: FrontendConfigContribution;
  readonly configuredSymbolRoots: readonly FrontendConfigContribution["configuredSymbolRoots"][number][];
  readonly configMatchInventory: readonly ConfigMatchProjection[];
}

function groupLocalConfigurations(fragments: readonly FrontendGraphFragment[]): LocalConfigGroup[] {
  const byRoot = new Map<string, FrontendGraphFragment[]>();
  for (const fragment of fragments) {
    if (fragment.boundary.rootRelDir === "") continue;
    const bucket = byRoot.get(fragment.boundary.rootRelDir);
    if (bucket === undefined) byRoot.set(fragment.boundary.rootRelDir, [fragment]);
    else bucket.push(fragment);
  }
  return [...byRoot.entries()]
    .sort(([a], [b]) => compareCodeUnits(a, b))
    .map(([rootRelDir, unsorted]) => {
      const grouped = [...unsorted].sort((a, b) => compareCodeUnits(a.boundary.id, b.boundary.id));
      assertCompleteLocalConfigContributions(
        rootRelDir,
        grouped.map((fragment) => fragment.configuration),
      );
      const owner = grouped[0] as FrontendGraphFragment;
      const configuration = owner.configuration as FrontendConfigContribution;
      assertConsistentFrontendConfigContributions(
        rootRelDir,
        grouped.map((fragment) => fragment.configuration as FrontendConfigContribution),
      );
      const inventory = configuration.configuredSymbolSelectorInventory;
      const roots = grouped.flatMap(
        (fragment) => (fragment.configuration as FrontendConfigContribution).configuredSymbolRoots,
      );
      for (const selector of inventory) {
        const owners = grouped.filter((fragment) => fragment.language === selector.language);
        if (owners.length === 0) {
          throw new ConfigError(
            `unused.config in boundary ${JSON.stringify(rootRelDir)} has ${selector.label} for ` +
              `${selector.language} but no ${selector.language} frontend exists at that boundary. ` +
              "Fix: move the selector to the matching boundary or repository config.",
          );
        }
        if (owners.length > 1) {
          throw new ConfigError(
            `unused.config in boundary ${JSON.stringify(rootRelDir)} ambiguously owns ` +
              `${owners.length} ${selector.language} frontends. Fix: make the project boundary unique.`,
          );
        }
      }
      const expectedLabels = inventory.map((selector) => selector.label).sort(compareCodeUnits);
      const actualLabels = roots
        .map((root) => root.label.replace(`boundary ${rootRelDir} `, ""))
        .sort(compareCodeUnits);
      if (JSON.stringify(actualLabels) !== JSON.stringify(expectedLabels)) {
        throw new ConfigError(
          `incomplete local configuration projection at boundary ${JSON.stringify(rootRelDir)}. ` +
            "Fix: ensure each exact selector is emitted once by its owning language frontend.",
        );
      }
      return {
        rootRelDir,
        fragments: grouped,
        configuration,
        configuredSymbolRoots: roots,
        configMatchInventory: mergeConfigMatchInventory(rootRelDir, grouped),
      };
    });
}

/** Every non-root language frontend participates in physical config ownership. */
export function assertCompleteLocalConfigContributions(
  rootRelDir: string,
  contributions: readonly (FrontendConfigContribution | undefined)[],
): asserts contributions is readonly FrontendConfigContribution[] {
  if (contributions.some((contribution) => contribution === undefined)) {
    throw new ConfigError(
      `incomplete local configuration ownership at boundary ${JSON.stringify(rootRelDir)}. ` +
        "Fix: every language frontend must emit a configuration contribution, including empty policy.",
    );
  }
}

/** Internal consistency seam exported for adversarial contract tests. */
export function assertConsistentFrontendConfigContributions(
  rootRelDir: string,
  contributions: readonly FrontendConfigContribution[],
): void {
  const identity = contributions[0] && configContributionIdentity(contributions[0]);
  for (const contribution of contributions.slice(1)) {
    if (configContributionIdentity(contribution) !== identity) {
      throw new ConfigError(
        `inconsistent local configuration contributions at boundary ${JSON.stringify(rootRelDir)}. ` +
          "Fix: ensure language frontends share one physical boundary policy.",
      );
    }
  }
}

function mergeConfigMatchInventory(
  rootRelDir: string,
  fragments: readonly FrontendGraphFragment[],
): ConfigMatchProjection[] {
  assertConsistentApplicableSuppressionScopes(
    rootRelDir,
    fragments.map(
      (fragment) => (fragment.configuration as FrontendConfigContribution).configMatchInventory,
    ),
  );
  const merged = new Map<string, ConfigMatchProjection>();
  for (const fragment of fragments) {
    for (const item of (fragment.configuration as FrontendConfigContribution)
      .configMatchInventory) {
      const existing = merged.get(item.id);
      if (existing === undefined) {
        merged.set(item.id, item);
        continue;
      }
      if (configMatchShape(existing) !== configMatchShape(item)) {
        throw new ConfigError(
          `inconsistent local config warning projection at boundary ${JSON.stringify(rootRelDir)} for ${item.id}. ` +
            "Fix: ensure same-root frontends read one physical config.",
        );
      }
      merged.set(item.id, {
        ...existing,
        fileMatched: existing.fileMatched || item.fileMatched,
        ...(existing.workspaceMatches === undefined && item.workspaceMatches === undefined
          ? {}
          : {
              workspaceMatches: uniqueWorkspaceMatches([
                ...(existing.workspaceMatches ?? []),
                ...(item.workspaceMatches ?? []),
              ]),
            }),
      });
    }
  }
  const inventory = [...merged.values()].sort((a, b) => compareCodeUnits(a.id, b.id));
  assertUnambiguousProjectedWorkspaceMatches(rootRelDir, inventory);
  return inventory;
}

/** Applicable scopes must agree; non-owning language misses are intentionally ignored. */
export function assertConsistentApplicableSuppressionScopes(
  rootRelDir: string,
  inventories: readonly (readonly ConfigMatchProjection[])[],
): void {
  const scopesById = new Map<string, Set<string>>();
  for (const inventory of inventories) {
    const applicableWorkspaces = new Set(
      inventory
        .filter((item) => item.category === "workspace" && (item.workspaceMatches?.length ?? 0) > 0)
        .map((item) => item.workspaceKey as string),
    );
    for (const item of inventory) {
      if (item.category !== "suppression") continue;
      if (item.workspaceKey !== undefined && !applicableWorkspaces.has(item.workspaceKey)) {
        continue;
      }
      if (item.scopeRootRelDir === undefined) {
        throw new ConfigError(
          `local config suppression ${item.label} at boundary ${JSON.stringify(rootRelDir)} omitted its applicable scope. ` +
            "Fix: project the authoritative config unit scope.",
        );
      }
      const scopes = scopesById.get(item.id) ?? new Set<string>();
      scopes.add(item.scopeRootRelDir);
      scopesById.set(item.id, scopes);
    }
  }
  for (const [id, scopes] of scopesById) {
    if (scopes.size > 1) {
      throw new ConfigError(
        `inconsistent applicable local suppression scopes at boundary ${JSON.stringify(rootRelDir)} for ${id}. ` +
          "Fix: ensure same-root frontends project the same owning unit.",
      );
    }
  }
}

/** Cross-language validation for matches no single frontend can observe alone. */
export function assertUnambiguousProjectedWorkspaceMatches(
  rootRelDir: string,
  inventory: readonly ConfigMatchProjection[],
): void {
  for (const item of inventory) {
    if (item.category !== "workspace") continue;
    const directoryRoots = new Set(
      item.workspaceMatches
        ?.filter((match) => match.role === "directory")
        .map((match) => match.rootRelDir) ?? [],
    );
    const nameRoots = new Set(
      item.workspaceMatches
        ?.filter((match) => match.role === "name")
        .map((match) => match.rootRelDir) ?? [],
    );
    if (
      directoryRoots.size > 0 &&
      [...nameRoots].some((nameRoot) => !directoryRoots.has(nameRoot))
    ) {
      throw new ConfigError(
        `unused.config in boundary ${JSON.stringify(rootRelDir)} has workspace key ${JSON.stringify(item.workspaceKey)} that identifies a physical directory and an ecosystem name at another workspace. ` +
          "Fix: use unambiguous root-relative directory keys.",
      );
    }
  }
}

function uniqueWorkspaceMatches(
  matches: readonly { readonly role: "directory" | "name"; readonly rootRelDir: string }[],
): readonly { readonly role: "directory" | "name"; readonly rootRelDir: string }[] {
  const unique = new Map<string, (typeof matches)[number]>();
  for (const match of matches) unique.set(`${match.role}\0${match.rootRelDir}`, match);
  return [...unique.values()].sort(
    (a, b) => compareCodeUnits(a.rootRelDir, b.rootRelDir) || compareCodeUnits(a.role, b.role),
  );
}

function configMatchShape(item: ConfigMatchProjection): string {
  return JSON.stringify({
    category: item.category,
    label: item.label,
    workspaceKey: item.workspaceKey ?? null,
    pattern: item.pattern ?? null,
    patterns: item.patterns ?? null,
    claimKinds: item.claimKinds ?? null,
  });
}

interface LocalSuppressionMatcher {
  readonly id: string;
  readonly kinds: ReadonlySet<Claim["subject"]["kind"]>;
  readonly scopeRootRelDir: string;
  readonly patterns: readonly RegExp[];
}

function compileLocalSuppressionMatchers(
  groups: readonly LocalConfigGroup[],
): ReadonlyMap<string, readonly LocalSuppressionMatcher[]> {
  const byBoundary = new Map<string, LocalSuppressionMatcher[]>();
  for (const group of groups) {
    for (const fragment of group.fragments) {
      const inventory = (fragment.configuration as FrontendConfigContribution).configMatchInventory;
      const applicableWorkspaces = new Set(
        inventory
          .filter(
            (item) => item.category === "workspace" && (item.workspaceMatches?.length ?? 0) > 0,
          )
          .map((item) => item.workspaceKey as string),
      );
      const matchers = inventory
        .filter((item) => item.category === "suppression")
        .filter(
          (item) => item.workspaceKey === undefined || applicableWorkspaces.has(item.workspaceKey),
        )
        .map((item) => ({
          id: item.id,
          kinds: new Set(item.claimKinds ?? []),
          scopeRootRelDir: item.scopeRootRelDir ?? fragment.boundary.rootRelDir,
          patterns: (item.patterns ?? []).map(globToRegExp),
        }));
      byBoundary.set(fragment.boundary.id, matchers);
    }
  }
  return byBoundary;
}

function recordLocalSuppressionClaimMatches(
  boundaryId: string,
  claims: readonly Claim[],
  matchersByBoundary: ReadonlyMap<string, readonly LocalSuppressionMatcher[]>,
  matchesByBoundary: Map<string, Set<string>>,
): void {
  const matchers = matchersByBoundary.get(boundaryId) ?? [];
  const matched = matchesByBoundary.get(boundaryId) ?? new Set<string>();
  for (const claim of claims) {
    for (const matcher of matchers) {
      if (!matcher.kinds.has(claim.subject.kind)) continue;
      const relative = relativeToScope(claim.subject.loc.file, matcher.scopeRootRelDir);
      if (relative !== undefined && matcher.patterns.some((pattern) => pattern.test(relative))) {
        matched.add(matcher.id);
      }
    }
  }
  matchesByBoundary.set(boundaryId, matched);
}

function relativeToScope(file: string, rootRelDir: string): string | undefined {
  if (rootRelDir === "") return file;
  if (file === rootRelDir) return "";
  return file.startsWith(`${rootRelDir}/`) ? file.slice(rootRelDir.length + 1) : undefined;
}

function warnOnLocalConfigMatches(
  groups: readonly LocalConfigGroup[],
  claimMatches: ReadonlyMap<string, ReadonlySet<string>>,
): void {
  for (const group of groups) {
    const location = `boundary ${JSON.stringify(group.rootRelDir)}`;
    const unmatchedWorkspaces = new Set(
      group.configMatchInventory
        .filter((item) => item.category === "workspace" && !item.fileMatched)
        .map((item) => item.workspaceKey as string),
    );
    for (const item of group.configMatchInventory) {
      if (
        item.category !== "workspace" &&
        item.workspaceKey !== undefined &&
        unmatchedWorkspaces.has(item.workspaceKey)
      ) {
        continue;
      }
      if (item.category === "workspace") {
        if (!item.fileMatched) {
          console.warn(
            `[unused] ${location} config "workspaces" key "${item.label}" matched no workspace package (by directory or name) — check for a typo.`,
          );
        }
        continue;
      }
      if (item.category === "entry" || item.category === "project") {
        if (!item.fileMatched) {
          console.warn(
            `[unused] ${location} config "${item.label}" pattern "${item.pattern}" matched no files — check for a typo.`,
          );
        }
        continue;
      }
      if (!item.fileMatched) {
        console.warn(
          `[unused] ${location} config "${item.label}" files globs matched no files — check for a typo.`,
        );
        continue;
      }
      const claimMatched = group.fragments.some((fragment) =>
        claimMatches.get(fragment.boundary.id)?.has(item.id),
      );
      if (!claimMatched) {
        console.warn(
          `[unused] ${location} config "${item.label}" matched no current ${(item.claimKinds ?? []).join("/")} claims — suppression may be stale.`,
        );
      }
    }
  }
}

function configContributionIdentity(configuration: FrontendConfigContribution): string {
  return JSON.stringify({
    fingerprint: configuration.analysisFingerprint,
    effective: configuration.hasEffectiveAnalysisPolicy,
    gate: configuration.localGateThreshold ?? null,
    ci: configuration.localCiSecondsPerTestFile ?? null,
    selectorInventory: configuration.configuredSymbolSelectorInventory,
    matchInventory: configuration.configMatchInventory
      .map((item) => ({ id: item.id, shape: configMatchShape(item) }))
      .sort((a, b) => compareCodeUnits(a.id, b.id)),
  });
}

function configPolicyDiagnostics(
  groups: readonly LocalConfigGroup[],
): FrontendGraphFragment["diagnostics"][number][] {
  return groups.flatMap((group) => {
    const owner = group.fragments[0] as FrontendGraphFragment;
    const diagnostics: FrontendGraphFragment["diagnostics"][number][] = [];
    if (group.configuration.localGateThreshold !== undefined) {
      diagnostics.push({
        pluginId: owner.pluginId,
        boundaryId: owner.boundary.id,
        severity: "warning",
        code: "BOUNDARY_GATE_POLICY_IGNORED",
        message:
          `boundary-local gate.threshold=${group.configuration.localGateThreshold} at ` +
          `${group.rootRelDir} is ignored during repository analysis; configure the aggregate ` +
          "gate at the repository root",
      });
    }
    if (group.configuration.localCiSecondsPerTestFile !== undefined) {
      diagnostics.push({
        pluginId: owner.pluginId,
        boundaryId: owner.boundary.id,
        severity: "warning",
        code: "BOUNDARY_CI_ECONOMICS_IGNORED",
        message:
          `boundary-local ciSecondsPerTestFile=${group.configuration.localCiSecondsPerTestFile} ` +
          `at ${group.rootRelDir} is ignored during repository analysis; configure summary ` +
          "economics at the repository root",
      });
    }
    return diagnostics;
  });
}

function byDiagnostic(
  a: FrontendGraphFragment["diagnostics"][number],
  b: FrontendGraphFragment["diagnostics"][number],
): number {
  return (
    compareCodeUnits(a.boundaryId ?? "", b.boundaryId ?? "") ||
    compareCodeUnits(a.pluginId, b.pluginId) ||
    compareCodeUnits(a.code, b.code) ||
    compareCodeUnits(a.severity, b.severity) ||
    compareCodeUnits(a.message, b.message) ||
    compareCodeUnits(a.site?.file ?? "", b.site?.file ?? "") ||
    (a.site?.span.start ?? -1) - (b.site?.span.start ?? -1) ||
    (a.site?.span.end ?? -1) - (b.site?.span.end ?? -1) ||
    (a.site?.span.startLine ?? -1) - (b.site?.span.startLine ?? -1) ||
    (a.site?.span.endLine ?? -1) - (b.site?.span.endLine ?? -1)
  );
}

function completedBoundary(fragment: FrontendGraphFragment): BoundaryRunMetadata {
  return {
    status: fragment.metadata.completeness.test === "incomplete" ? "partial" : "complete",
    pluginId: fragment.pluginId,
    boundaryId: fragment.boundary.id,
    language: fragment.language,
    fileCount: fragment.metadata.fileCount,
    workspaceCount: fragment.metadata.workspaceCount,
    partitions: fragment.metadata.completeness,
  };
}

/** Internal direct-path adapter; exported only so its fail-closed contract is regression-tested. */
export function deriveDirectBoundaryMetadata(input: {
  readonly analyzerBoundaries: readonly AnalysisBoundary[];
  readonly pluginId: string;
  readonly boundaryId: string;
  readonly language: string;
  readonly fileCount: number;
  readonly workspaceCount: number;
}): BoundaryRunMetadata {
  const localBoundary = requireAnalyzerBoundaryMetadata(input.analyzerBoundaries, input.pluginId);
  return {
    status: localBoundary.status,
    pluginId: input.pluginId,
    boundaryId: input.boundaryId,
    language: input.language,
    fileCount: input.fileCount,
    workspaceCount: input.workspaceCount,
    partitions: localBoundary.partitions,
  };
}

function withCompletedBoundaries(
  result: AnalyzeResult,
  boundaries: readonly BoundaryRunMetadata[],
): AnalyzeResult {
  return { ...result, run: { ...result.run, boundaries } };
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
      {
        scope: "boundary",
        pluginId: fragment.pluginId,
        boundaryId: fragment.boundary.id,
      },
    );
  }
  return graph;
}

type ContributionDiagnosticOwner =
  | {
      readonly scope: "boundary";
      readonly pluginId: string;
      readonly boundaryId: string;
    }
  | {
      readonly scope: "repository";
      readonly pluginId: string;
    };

/** Collect diagnostics only when their graph contribution is actually applied. */
class RepositoryDiagnosticAccumulator {
  private readonly diagnostics: PluginDiagnostic[] = [];

  add(contribution: GraphContribution, owner: ContributionDiagnosticOwner): void {
    for (const diagnostic of contribution.diagnostics ?? []) {
      this.diagnostics.push({
        pluginId: owner.pluginId,
        ...(owner.scope === "boundary" ? { boundaryId: owner.boundaryId } : {}),
        severity: diagnostic.severity,
        code: diagnostic.code,
        message: diagnostic.message,
        ...(diagnostic.site === undefined
          ? {}
          : { site: validateRepositoryDiagnosticSite(diagnostic.site) }),
      });
    }
  }

  values(): readonly PluginDiagnostic[] {
    return [...this.diagnostics];
  }
}

function validateRepositoryDiagnosticSite(site: Site): Site {
  const file = prefixRepositoryPath("", site.file);
  return file === site.file ? site : { ...site, file };
}

function addContribution(
  graph: IRGraph,
  contribution: GraphContribution,
  owner: ContributionDiagnosticOwner,
  diagnostics?: RepositoryDiagnosticAccumulator,
): void {
  for (const node of contribution.nodes ?? []) addNodeChecked(graph, node, owner.pluginId);
  for (const edge of contribution.edges ?? []) graph.addEdge(edge);
  for (const hazard of contribution.hazards ?? []) graph.addHazard(hazard);
  diagnostics?.add(contribution, owner);
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

function repositoryConfigUnitsForLanguage(
  fragments: readonly FrontendGraphFragment[],
  language: EntrySymbolLanguage,
): Array<{ readonly rootRelDir: string; readonly name: string | null }> {
  const units = new Map<string, { readonly rootRelDir: string; readonly name: string | null }>();
  for (const fragment of fragments) {
    if (fragment.language !== language) continue;
    for (const unit of fragment.claimInputs.units) {
      const key = `${unit.rootRelDir}\0${unit.name ?? ""}`;
      units.set(key, unit);
    }
  }
  return [...units.values()].sort(
    (a, b) =>
      (a.rootRelDir === ""
        ? -1
        : b.rootRelDir === ""
          ? 1
          : compareCodeUnits(a.rootRelDir, b.rootRelDir)) ||
      compareCodeUnits(a.name ?? "", b.name ?? ""),
  );
}

function collectRepositoryConfiguredSymbolRoots(
  fragments: readonly FrontendGraphFragment[],
  config: UnusedConfig,
): FrontendConfigContribution["configuredSymbolRoots"][number][] {
  const inventory = configuredSymbolSelectorInventory(config);
  const languages = [...new Set(inventory.map((selector) => selector.language))].sort(
    compareCodeUnits,
  );
  return languages.flatMap((language) => {
    const units = repositoryConfigUnitsForLanguage(fragments, language);
    if (units.length === 0) {
      const selector = inventory.find((item) => item.language === language);
      throw new ConfigError(
        `unused.config has ${selector?.label ?? "entrySymbols"} for ${language} but no ${language} frontend exists. ` +
          "Fix: remove the selector or add the matching language boundary.",
      );
    }
    return collectConfiguredSymbolRoots(config, units, { language });
  });
}

function collectRepositoryConfigEntrypoints(
  fragments: readonly FrontendGraphFragment[],
  rootPolicy: UnusedConfig,
  fragmentWorkspacePolicies: readonly UnusedConfig[],
): Array<{ readonly file: string; readonly reason: string }> {
  const analyzedFiles = [
    ...new Set(fragments.flatMap((fragment) => [...fragment.claimInputs.analysisFiles])),
  ];
  const hits = collectConfigEntrypoints(analyzedFiles, rootPolicy, []);
  for (const [index, fragment] of fragments.entries()) {
    hits.push(
      ...collectConfigEntrypoints(
        [...fragment.claimInputs.analysisFiles],
        fragmentWorkspacePolicies[index] as UnusedConfig,
        fragment.claimInputs.units,
      ),
    );
  }
  const byFile = new Map<string, { readonly file: string; readonly reason: string }>();
  for (const hit of hits) if (!byFile.has(hit.file)) byFile.set(hit.file, hit);
  return [...byFile.values()].sort((a, b) => compareCodeUnits(a.file, b.file));
}

function repositoryWideConfig(config: UnusedConfig): UnusedConfig {
  return { ...config, workspaces: {} };
}

function workspaceOnlyConfig(config: UnusedConfig): UnusedConfig {
  return {
    ...config,
    entry: [],
    entrySymbols: [],
    project: [],
    suppressions: [],
    ignoreDependencies: [],
  };
}

function workspacePolicyForUnits(
  workspacePolicy: UnusedConfig,
  units: readonly { readonly rootRelDir: string; readonly name: string | null }[],
): UnusedConfig {
  const keys = new Set<string>();
  for (const unit of units) {
    if (unit.rootRelDir !== "" && workspacePolicy.workspaces[unit.rootRelDir] !== undefined) {
      keys.add(unit.rootRelDir);
    }
    if (unit.name !== null && workspacePolicy.workspaces[unit.name] !== undefined) {
      keys.add(unit.name);
    }
  }
  const workspaces: Record<string, UnusedConfig["workspaces"][string]> = {};
  for (const key of [...keys].sort(compareCodeUnits)) {
    workspaces[key] = workspacePolicy.workspaces[key] as UnusedConfig["workspaces"][string];
  }
  return { ...workspacePolicy, workspaces };
}

function warnOnRepositoryWorkspaceFileMatches(
  workspacePolicy: UnusedConfig,
  index: RepositoryWorkspaceWarningIndex,
): void {
  for (const key of Object.keys(workspacePolicy.workspaces).sort(compareCodeUnits)) {
    const scope = index.scopes.get(key);
    const config = oneWorkspaceConfig(workspacePolicy, key);
    if (scope === undefined) {
      warnOnEmptyConfigMatches(config, [], [], []);
      continue;
    }
    warnOnEmptyConfigMatches(config, scope.files, scope.files, [scope.virtualUnit]);
  }
}

function warnOnRepositoryWorkspaceSuppressionMatches(
  workspacePolicy: UnusedConfig,
  index: RepositoryWorkspaceWarningIndex,
  claims: readonly Claim[],
): void {
  const claimsByKey = new Map<string, Claim[]>();
  for (const claim of claims) {
    for (const key of index.keysByFile.get(claim.subject.loc.file) ?? []) {
      const scope = index.scopes.get(key);
      const relativeFile = scope?.repositoryToPackageRelative(claim.subject.loc.file);
      if (relativeFile === undefined) continue;
      const scoped = claimsByKey.get(key) ?? [];
      scoped.push({
        ...claim,
        subject: {
          ...claim.subject,
          loc: { ...claim.subject.loc, file: relativeFile },
        },
      } as Claim);
      claimsByKey.set(key, scoped);
    }
  }
  for (const key of Object.keys(workspacePolicy.workspaces).sort(compareCodeUnits)) {
    const scope = index.scopes.get(key);
    if (scope === undefined) continue;
    applyConfigSuppressions(
      claimsByKey.get(key) ?? [],
      oneWorkspaceConfig(workspacePolicy, key),
      [scope.virtualUnit],
      scope.files,
    );
  }
}

function oneWorkspaceConfig(config: UnusedConfig, key: string): UnusedConfig {
  const override = config.workspaces[key];
  return { ...config, workspaces: override === undefined ? {} : { [key]: override } };
}

interface RepositoryWorkspaceWarningScope {
  readonly files: readonly string[];
  readonly virtualUnit: { readonly rootRelDir: ""; readonly name: string };
  repositoryToPackageRelative(file: string): string | undefined;
}

interface RepositoryWorkspaceWarningIndex {
  readonly scopes: ReadonlyMap<string, RepositoryWorkspaceWarningScope>;
  /** Each claim file maps to at most its physical-directory and ecosystem-name keys. */
  readonly keysByFile: ReadonlyMap<string, readonly string[]>;
}

function indexRepositoryWorkspaceWarningScopes(
  workspacePolicy: UnusedConfig,
  fragments: readonly FrontendGraphFragment[],
): RepositoryWorkspaceWarningIndex {
  const allUnits = fragments.flatMap((fragment) => fragment.claimInputs.units);
  const physicalRoots = new Set(allUnits.map((unit) => unit.rootRelDir));
  const rootsByName = new Map<string, Set<string>>();
  for (const unit of allUnits) {
    if (unit.name === null) continue;
    const roots = rootsByName.get(unit.name) ?? new Set<string>();
    roots.add(unit.rootRelDir);
    rootsByName.set(unit.name, roots);
  }
  const directoryFiles = new Map<string, Set<string>>();
  const nameFiles = new Map<string, Map<string, Set<string>>>();
  for (const fragment of fragments) {
    const fragmentRoots = new Set(fragment.claimInputs.units.map((unit) => unit.rootRelDir));
    const candidateFiles = new Set([
      ...fragment.claimInputs.analysisFiles,
      ...(fragment.claimInputs.dependencies ?? []).map((dependency) => dependency.loc.file),
    ]);
    for (const file of candidateFiles) {
      const root = owningPhysicalRoot(file, fragmentRoots);
      if (root === undefined) continue;
      appendIndexedFile(directoryFiles, root, file);
      for (const unit of fragment.claimInputs.units) {
        if (unit.rootRelDir !== root || unit.name === null) continue;
        const byRoot = nameFiles.get(unit.name) ?? new Map<string, Set<string>>();
        appendIndexedFile(byRoot, root, file);
        nameFiles.set(unit.name, byRoot);
      }
    }
  }
  const scopes = new Map<string, RepositoryWorkspaceWarningScope>();
  const keysByFile = new Map<string, string[]>();
  for (const key of Object.keys(workspacePolicy.workspaces).sort(compareCodeUnits)) {
    const selectedRoots = physicalRoots.has(key) ? new Set([key]) : rootsByName.get(key);
    if (selectedRoots === undefined || selectedRoots.size === 0) continue;
    const indexedFiles = physicalRoots.has(key) ? directoryFiles : nameFiles.get(key);
    const repositoryFiles = new Set(
      [...selectedRoots].flatMap((root) => [...(indexedFiles?.get(root) ?? [])]),
    );
    const toRelative = (file: string): string | undefined => {
      if (!repositoryFiles.has(file)) return undefined;
      for (const root of selectedRoots) {
        if (root === "") return file;
        if (file === root || file.startsWith(`${root}/`)) return file.slice(root.length + 1);
      }
      return undefined;
    };
    const files = [...repositoryFiles]
      .flatMap((file) => {
        const relative = toRelative(file);
        return relative === undefined ? [] : [relative];
      })
      .sort(compareCodeUnits);
    scopes.set(key, {
      files,
      virtualUnit: { rootRelDir: "", name: key },
      repositoryToPackageRelative: toRelative,
    });
    for (const file of repositoryFiles) {
      const keys = keysByFile.get(file) ?? [];
      keys.push(key);
      keysByFile.set(file, keys);
    }
  }
  return { scopes, keysByFile };
}

function appendIndexedFile(index: Map<string, Set<string>>, key: string, file: string): void {
  const files = index.get(key) ?? new Set<string>();
  files.add(file);
  index.set(key, files);
}

function owningPhysicalRoot(file: string, physicalRoots: ReadonlySet<string>): string | undefined {
  let candidate = file;
  while (candidate !== "") {
    const separator = candidate.lastIndexOf("/");
    candidate = separator < 0 ? "" : candidate.slice(0, separator);
    if (physicalRoots.has(candidate)) return candidate;
  }
  return physicalRoots.has("") ? "" : undefined;
}

function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function applyClaimAnnotation(claim: Claim, fragment: FrontendGraphFragment): Claim {
  const annotation = fragment.claimAnnotations.get(
    claimAnnotationKey(
      claim.subject.kind,
      claim.subject.loc.file,
      "name" in claim.subject ? claim.subject.name : undefined,
    ),
  );
  const packageName = packageForClaim(fragment, claim);
  if (annotation === undefined && packageName === undefined) return claim;
  return {
    ...claim,
    ...(claim.suppression !== undefined || annotation?.suppression === undefined
      ? {}
      : { suppression: annotation.suppression }),
    ...(annotation?.evidence === undefined ? {} : { evidence: annotation.evidence }),
    subject: {
      ...claim.subject,
      loc: {
        ...claim.subject.loc,
        ...(annotation?.package === undefined && packageName === undefined
          ? {}
          : { package: annotation?.package ?? packageName }),
      },
    },
  } as Claim;
}

function packageForClaim(fragment: FrontendGraphFragment, claim: Claim): string | undefined {
  if (fragment.claimInputs.units.length <= 1) return undefined;
  const file = claim.subject.loc.file;
  let owner: FrontendGraphFragment["claimInputs"]["units"][number] | undefined;
  for (const unit of fragment.claimInputs.units) {
    if (
      unit.rootRelDir !== "" &&
      file !== unit.rootRelDir &&
      !file.startsWith(`${unit.rootRelDir}/`)
    ) {
      continue;
    }
    if (owner === undefined || unit.rootRelDir.length > owner.rootRelDir.length) owner = unit;
  }
  return owner?.name ?? undefined;
}

function byClaimId(a: Claim, b: Claim): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
