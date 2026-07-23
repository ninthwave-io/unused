/** Built-in language adapters proving ADR 0013's internal plugin contracts. */

import { relative, sep } from "node:path";
import type { Evidence, Suppression } from "../../core/claims/index.js";
import { analyzeElixirProjectWithGraph } from "../elixir/index.js";
import { analyzeRustProjectWithGraph } from "../rust/index.js";
import { type AnalyzeOptions, analyzeProjectWithGraph } from "../ts/analyze.js";
import { selectProjectBoundaries } from "./boundaries.js";
import {
  ectoElixirConventionPlugin,
  elixirRuntimeConventionPlugin,
  elixirScriptConventionPlugin,
} from "./elixir-conventions.js";
import {
  prefixRepositoryPath,
  rebaseClaimInputs,
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
  GraphContribution,
  LanguageFrontendPlugin,
  RepositoryAnalysisContext,
} from "./types.js";
import { requireAnalyzerBoundaryMetadata } from "./types.js";
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

function fragment(
  pluginId: string,
  language: string,
  boundary: Parameters<LanguageFrontendPlugin["analyze"]>[1],
  analysis: Awaited<ReturnType<typeof analyzeProjectWithGraph>> & {
    readonly deferredContributions?: ReadonlyMap<string, GraphContribution>;
  },
): FrontendGraphFragment {
  const localBoundary = requireAnalyzerBoundaryMetadata(analysis.result.run.boundaries, pluginId);
  const claimAnnotations = new Map<
    string,
    {
      readonly suppression?: Suppression;
      readonly package?: string;
      readonly evidence?: readonly Evidence[];
    }
  >();
  for (const claim of analysis.result.claims) {
    claimAnnotations.set(
      claimAnnotationKey(
        claim.subject.kind,
        prefixRepositoryPath(boundary.rootRelDir, claim.subject.loc.file),
        "name" in claim.subject ? claim.subject.name : undefined,
      ),
      {
        ...(claim.suppression === undefined ? {} : { suppression: claim.suppression }),
        ...(claim.subject.loc.package === undefined ? {} : { package: claim.subject.loc.package }),
        ...(claim.evidence[0]?.source === "reference-graph" ? {} : { evidence: claim.evidence }),
      },
    );
  }
  return {
    pluginId,
    language,
    boundary,
    graph: rebaseGraph(analysis.graph, boundary.rootRelDir),
    provenance: analysis.provenance,
    metadata: {
      projectName: analysis.result.repoName,
      fileCount: analysis.result.fileCount,
      workspaceCount: analysis.result.workspaceCount,
      configHash: analysis.result.run.configHash,
      gateThreshold: analysis.result.gateThreshold,
      completeness: localBoundary.partitions,
    },
    claimInputs: rebaseClaimInputs(analysis.claimInputs, boundary.rootRelDir),
    claimAnnotations,
    ...(analysis.deferredContributions === undefined
      ? {}
      : {
          deferredContributions: new Map(
            [...analysis.deferredContributions].map(([id, contribution]) => [
              id,
              rebaseGraphContribution(contribution, analysis.graph, boundary.rootRelDir),
            ]),
          ),
        }),
    diagnostics: (analysis.result.diagnostics ?? []).map((diagnostic) => ({
      ...diagnostic,
      boundaryId: boundary.id,
    })),
  };
}

export function claimAnnotationKey(kind: string, file: string, name?: string): string {
  return `${kind}\0${file}\0${name ?? ""}`;
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
    const analysis = await analyzeProjectWithGraph(boundary.rootDir, analyzeOptions(context), {
      emitConfigMatchWarnings: false,
      deferConfigSymbolEntrypoints: true,
      deferredConventions: ["github-actions-run", "taskfile-command", "native-config-script"],
    });
    return fragment(this.id, this.language, boundary, analysis);
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
    const analysis = await analyzeElixirProjectWithGraph(
      boundary.rootDir,
      analyzeOptions(context),
      {
        emitConfigMatchWarnings: false,
        deferConfigSymbolEntrypoints: true,
        deferredConventions: ["elixir-runtime", "elixir-scripts"],
        atomRoleSummaryProviders: context.elixirAtomRoleSummaryProviders ?? [],
        elixirSourceFiles: filesWithinBoundary(
          boundary.rootDir,
          context.manifests.elixirSourceFiles,
        ),
      },
    );
    return fragment(this.id, this.language, boundary, analysis);
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
    const analysis = await analyzeRustProjectWithGraph(boundary.rootDir, analyzeOptions(context), {
      emitConfigMatchWarnings: false,
      deferConfigSymbolEntrypoints: true,
      sourceFiles: context.manifests.rustSourceFiles,
    });
    return fragment(this.id, this.language, boundary, analysis);
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
