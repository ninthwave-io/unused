/** Built-in language adapters proving ADR 0013's internal plugin contracts. */

import type { Suppression } from "../../core/claims/index.js";
import { analyzeElixirProjectWithGraph } from "../elixir/index.js";
import { type AnalyzeOptions, analyzeProjectWithGraph } from "../ts/analyze.js";
import { selectProjectBoundaries } from "./boundaries.js";
import { prefixRepositoryPath, rebaseClaimInputs, rebaseGraph } from "./rebase.js";
import type {
  FrontendGraphFragment,
  LanguageFrontendPlugin,
  RepositoryAnalysisContext,
} from "./types.js";

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
  analysis: Awaited<ReturnType<typeof analyzeProjectWithGraph>>,
): FrontendGraphFragment {
  const claimAnnotations = new Map<
    string,
    {
      readonly suppression?: Suppression;
      readonly package?: string;
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
    },
    claimInputs: rebaseClaimInputs(analysis.claimInputs, boundary.rootRelDir),
    claimAnnotations,
    diagnostics: [],
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
      { emitConfigMatchWarnings: false },
    );
    return fragment(this.id, this.language, boundary, analysis);
  },
};

export const BUILT_IN_LANGUAGE_PLUGINS = [elixirLanguagePlugin, typescriptLanguagePlugin] as const;
