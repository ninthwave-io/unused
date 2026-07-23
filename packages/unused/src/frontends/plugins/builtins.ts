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
  rebaseClaimInputs,
  rebaseDiagnostic,
  rebaseGraph,
  rebaseGraphContribution,
} from "./rebase.js";
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
  RepositoryAnalysisContext,
} from "./types.js";
import { typescriptConfigCarriersConventionPlugin } from "./typescript-conventions.js";

const PLUGIN_VERSION = "0.1.0";

function analyzeOptions(context: RepositoryAnalysisContext): AnalyzeOptions {
  return {
    now: context.now,
    toolVersion: context.toolVersion,
    gitignore: context.gitignore,
    ...(context.configPath === undefined ? {} : { configPath: context.configPath }),
    ...(context.performance === undefined ? {} : { performance: context.performance }),
  };
}

export function createFrontendFragment(
  pluginId: string,
  language: string,
  boundary: Parameters<LanguageFrontendPlugin["analyze"]>[1],
  analysis: FrontendLocalGraph,
): FrontendGraphFragment {
  const rebase = createRebaseContext(boundary.rootRelDir);
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
  return {
    pluginId,
    language,
    boundary,
    graph: rebaseGraph(analysis.graph, boundary.rootRelDir, rebase),
    provenance: analysis.provenance,
    metadata: analysis.metadata,
    claimInputs: rebaseClaimInputs(analysis.claimInputs, boundary.rootRelDir, rebase),
    claimAnnotations,
    ...(analysis.deferredContributions === undefined
      ? {}
      : {
          deferredContributions: new Map(
            [...analysis.deferredContributions].map(([id, contribution]) => [
              id,
              rebaseGraphContribution(contribution, analysis.graph, boundary.rootRelDir, rebase),
            ]),
          ),
        }),
    diagnostics: analysis.diagnostics.map((diagnostic) => ({
      ...rebaseDiagnostic(diagnostic, boundary.rootRelDir, rebase),
      boundaryId: boundary.id,
    })),
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
    });
    return createFrontendFragment(this.id, this.language, boundary, analysis);
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
    });
    return createFrontendFragment(this.id, this.language, boundary, analysis);
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
    return selectProjectBoundaries(context.rootDir, context.manifests.cargoTomlDirs, {
      language: "rs",
      manifestName: "Cargo.toml",
      projectKind: "cargo-workspace",
    });
  },
  async analyze(context, boundary) {
    const analysis = await analyzeRustProjectFragment(boundary.rootDir, analyzeOptions(context), {
      emitConfigMatchWarnings: false,
      deferConfigSymbolEntrypoints: true,
      sourceFiles: context.manifests.rustSourceFiles,
    });
    return createFrontendFragment(this.id, this.language, boundary, analysis);
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
