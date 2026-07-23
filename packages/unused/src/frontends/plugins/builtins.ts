/** Built-in language adapters proving ADR 0013's internal plugin contracts. */

import { relative, sep } from "node:path";
import { analyzeElixirProjectFragment } from "../elixir/index.js";
import { analyzeRustProjectFragment } from "../rust/index.js";
import { type AnalyzeOptions, analyzeProjectFragment } from "../ts/analyze.js";
import { selectProjectBoundaries } from "./boundaries.js";
import { claimAnnotationKey } from "./claim-annotations.js";
import {
  ectoElixirConventionPlugin,
  elixirRuntimeConventionPlugin,
  elixirScriptConventionPlugin,
} from "./elixir-conventions.js";
import { exMoneyElixirConventionPlugin } from "./ex-money-conventions.js";
import { moneyElixirConventionPlugin } from "./money-conventions.js";
import {
  createRebaseContext,
  prefixRepositoryPath,
  prepareOwnedGraphRebase,
  rebaseClaimInputs,
  rebaseDiagnostic,
  rebaseGraph,
  rebaseGraphContribution,
} from "./rebase.js";
import {
  partitionRustSourceCandidates,
  rustSourceCandidatesForBoundary,
} from "./rust-boundaries.js";
import {
  rustlerBridgePlugin,
  rustlerElixirConventionPlugin,
  rustlerRustConventionPlugin,
} from "./rustler.js";
import type {
  AnalyzerPlugin,
  FrontendGraphFragment,
  FrontendLocalGraph,
  LanguageFrontendPlugin,
  ProjectBoundary,
  RepositoryAnalysisContext,
} from "./types.js";
import { typescriptConfigCarriersConventionPlugin } from "./typescript-conventions.js";

const PLUGIN_VERSION = "0.1.0";

function analyzeOptions(context: RepositoryAnalysisContext): AnalyzeOptions {
  return {
    now: context.now,
    toolVersion: context.toolVersion,
    gitignore: context.gitignore,
    ...(context.performance === undefined ? {} : { performance: context.performance }),
  };
}

export function createFrontendFragment(
  pluginId: string,
  language: string,
  boundary: Parameters<LanguageFrontendPlugin["analyze"]>[1],
  analysis: FrontendLocalGraph,
): FrontendGraphFragment {
  return buildFrontendFragment(pluginId, language, boundary, analysis, false);
}

/**
 * Transfer an internal analyzer result into repository coordinates.
 *
 * The caller relinquishes `analysis` and every object reachable from it. The
 * returned fragment owns the same graph records; reusing the local result after
 * this call is unsupported. Direct analyzer APIs use `createFrontendFragment`
 * and retain copy-on-rebase semantics.
 */
export function consumeFrontendLocalGraph(
  pluginId: string,
  language: string,
  boundary: Parameters<LanguageFrontendPlugin["analyze"]>[1],
  analysis: FrontendLocalGraph,
): FrontendGraphFragment {
  return buildFrontendFragment(pluginId, language, boundary, analysis, true);
}

function buildFrontendFragment(
  pluginId: string,
  language: string,
  boundary: Parameters<LanguageFrontendPlugin["analyze"]>[1],
  analysis: FrontendLocalGraph,
  consume: boolean,
): FrontendGraphFragment {
  const rebase = createRebaseContext(boundary.rootRelDir);
  const ownedPlan = consume
    ? prepareOwnedGraphRebase(analysis.graph, boundary.rootRelDir, rebase)
    : undefined;
  if (ownedPlan !== undefined) {
    for (const contribution of analysis.deferredContributions?.values() ?? []) {
      ownedPlan.prepareContribution(contribution);
    }
    for (const diagnostic of analysis.diagnostics) ownedPlan.prepareDiagnostic(diagnostic);
  }
  const claimAnnotations = new Map(
    [...analysis.claimAnnotations].map(([key, annotation]) => {
      const [kind, file, name] = key.split("\0");
      if (kind === undefined || file === undefined || name === undefined) {
        throw new Error(`invalid frontend claim annotation key: ${key}`);
      }
      const rebasedName =
        kind === "file" || kind === "test"
          ? prefixRepositoryPath(boundary.rootRelDir, name)
          : name || undefined;
      return [
        claimAnnotationKey(kind, prefixRepositoryPath(boundary.rootRelDir, file), rebasedName),
        annotation,
      ] as const;
    }),
  );
  const claimInputs = rebaseClaimInputs(analysis.claimInputs, boundary.rootRelDir, rebase);
  const deferredContributions =
    analysis.deferredContributions === undefined
      ? undefined
      : new Map(
          [...analysis.deferredContributions].map(([id, contribution]) => [
            id,
            rebaseGraphContribution(contribution, analysis.graph, boundary.rootRelDir, rebase),
          ]),
        );
  const diagnostics = analysis.diagnostics.map((diagnostic) => ({
    ...rebaseDiagnostic(diagnostic, boundary.rootRelDir, rebase),
    boundaryId: boundary.id,
  }));
  const configuration =
    analysis.configuration === undefined
      ? undefined
      : {
          ...analysis.configuration,
          configuredSymbolRoots: analysis.configuration.configuredSymbolRoots.map((root) => ({
            ...root,
            file: prefixRepositoryPath(boundary.rootRelDir, root.file),
            label:
              boundary.rootRelDir === ""
                ? root.label
                : `boundary ${boundary.rootRelDir} ${root.label}`,
            boundaryId: boundary.id,
          })),
          configMatchInventory: analysis.configuration.configMatchInventory.map((item) => ({
            ...item,
            ...(item.scopeRootRelDir === undefined
              ? {}
              : {
                  scopeRootRelDir: prefixRepositoryPath(boundary.rootRelDir, item.scopeRootRelDir),
                }),
            ...(item.workspaceMatches === undefined
              ? {}
              : {
                  workspaceMatches: item.workspaceMatches.map((match) => ({
                    ...match,
                    rootRelDir: prefixRepositoryPath(boundary.rootRelDir, match.rootRelDir),
                  })),
                }),
          })),
        };
  // This is intentionally the final potentially mutating operation: every
  // path/site/id and all metadata surfaces were validated and prepared above.
  const graph =
    ownedPlan === undefined
      ? rebaseGraph(analysis.graph, boundary.rootRelDir, rebase)
      : ownedPlan.commit();
  return {
    pluginId,
    language,
    boundary,
    graph,
    provenance: analysis.provenance,
    metadata: analysis.metadata,
    claimInputs,
    claimAnnotations,
    ...(configuration === undefined ? {} : { configuration }),
    ...(deferredContributions === undefined ? {} : { deferredContributions }),
    diagnostics,
  };
}

export const typescriptLanguagePlugin: LanguageFrontendPlugin = {
  kind: "language",
  id: "language:typescript",
  version: PLUGIN_VERSION,
  language: "ts",
  capabilities: {
    files: true,
    symbols: true,
    dependencies: true,
    testPartition: true,
    configPartition: true,
    compilerExecution: false,
    mutation: true,
  },
  async discover(context) {
    return selectProjectBoundaries(context.rootDir, context.manifests.packageJsonDirs, {
      language: "ts",
      manifestName: "package.json",
      projectKind: "npm-workspace",
    });
  },
  async analyze(context, boundary) {
    const analysis = await analyzeProjectFragment(boundary.rootDir, analyzeOptions(context), {
      emitConfigMatchWarnings: false,
      deferConfigSymbolEntrypoints: true,
      deferredConventions: ["github-actions-run", "taskfile-command", "native-config-script"],
      ...(boundary.rootRelDir === "" ? { resolvedConfig: context.repositoryConfig } : {}),
      ...(context.repositoryConfig.presets === undefined
        ? {}
        : { forcedPresets: context.repositoryConfig.presets }),
      boundaryPresetsShadowed: context.repositoryConfig.presets !== undefined,
    });
    return consumeMeasuredFrontendLocalGraph(this.id, this.language, boundary, analysis, context);
  },
};

export const elixirLanguagePlugin: LanguageFrontendPlugin = {
  kind: "language",
  id: "language:elixir",
  version: PLUGIN_VERSION,
  language: "ex",
  capabilities: {
    files: true,
    symbols: true,
    dependencies: false,
    testPartition: true,
    configPartition: true,
    compilerExecution: true,
    mutation: false,
  },
  async discover(context) {
    return selectProjectBoundaries(context.rootDir, context.manifests.mixExsDirs, {
      language: "ex",
      manifestName: "mix.exs",
      projectKind: "mix",
    });
  },
  async analyze(context, boundary) {
    const analysis = await analyzeElixirProjectFragment(boundary.rootDir, analyzeOptions(context), {
      emitConfigMatchWarnings: false,
      deferConfigSymbolEntrypoints: true,
      deferredConventions: ["elixir-runtime", "elixir-scripts"],
      atomRoleSummaryProviders: context.elixirAtomRoleSummaryProviders ?? [],
      elixirSourceFiles: filesWithinBoundary(boundary.rootDir, context.manifests.elixirSourceFiles),
      ...(boundary.rootRelDir === "" ? { resolvedConfig: context.repositoryConfig } : {}),
      boundaryPresetsShadowed: context.repositoryConfig.presets !== undefined,
    });
    return consumeMeasuredFrontendLocalGraph(this.id, this.language, boundary, analysis, context);
  },
};

export const rustLanguagePlugin: LanguageFrontendPlugin = {
  kind: "language",
  id: "language:rust",
  version: PLUGIN_VERSION,
  language: "rs",
  capabilities: {
    files: true,
    symbols: true,
    dependencies: false,
    testPartition: true,
    configPartition: true,
    compilerExecution: true,
    mutation: false,
  },
  async discover(context) {
    const boundaries = selectProjectBoundaries(context.rootDir, context.manifests.cargoTomlDirs, {
      language: "rs",
      manifestName: "Cargo.toml",
      projectKind: "cargo-workspace",
    });
    return partitionRustSourceCandidates(
      context.rootDir,
      boundaries,
      context.manifests.rustSourceFiles,
    ).boundaries;
  },
  async analyze(context, boundary) {
    const analysis = await analyzeRustProjectFragment(boundary.rootDir, analyzeOptions(context), {
      emitConfigMatchWarnings: false,
      deferConfigSymbolEntrypoints: true,
      sourceFiles: rustSourceCandidatesForBoundary(boundary),
      ...(boundary.rootRelDir === "" ? { resolvedConfig: context.repositoryConfig } : {}),
      boundaryPresetsShadowed: context.repositoryConfig.presets !== undefined,
    });
    return consumeMeasuredFrontendLocalGraph(this.id, this.language, boundary, analysis, context);
  },
};

export const BUILT_IN_LANGUAGE_PLUGINS = [
  elixirLanguagePlugin,
  rustLanguagePlugin,
  typescriptLanguagePlugin,
] as const;

export const BUILT_IN_PLUGINS: readonly AnalyzerPlugin[] = [
  ...BUILT_IN_LANGUAGE_PLUGINS,
  ectoElixirConventionPlugin,
  elixirRuntimeConventionPlugin,
  elixirScriptConventionPlugin,
  exMoneyElixirConventionPlugin,
  moneyElixirConventionPlugin,
  rustlerElixirConventionPlugin,
  rustlerRustConventionPlugin,
  typescriptConfigCarriersConventionPlugin,
  rustlerBridgePlugin,
];

function filesWithinBoundary(rootDir: string, files: readonly string[]): string[] {
  return files.filter((file) => {
    const rel = relative(rootDir, file).split(sep).join("/");
    return rel !== ".." && !rel.startsWith("../") && !rel.startsWith("/");
  });
}

function consumeMeasuredFrontendLocalGraph(
  pluginId: string,
  language: string,
  boundary: ProjectBoundary,
  analysis: FrontendLocalGraph,
  context: RepositoryAnalysisContext,
): FrontendGraphFragment {
  const started = context.performance?.now();
  const fragment = consumeFrontendLocalGraph(pluginId, language, boundary, analysis);
  if (started !== undefined) context.performance?.finish("graph-construction", started);
  return fragment;
}
