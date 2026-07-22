/** Compiled-in Elixir conventions prepared from one bounded frontend inventory. */

import { relative, sep } from "node:path";
import { extractElixirScriptCommandRoots } from "../elixir/script-references.js";
import type { ConventionPlugin, GraphContribution, RepositoryAnalysisContext } from "./types.js";

const repositoryScriptRootCache = new WeakMap<
  RepositoryAnalysisContext,
  Promise<GraphContribution>
>();

export const elixirRuntimeConventionPlugin: ConventionPlugin = {
  kind: "convention",
  id: "convention:elixir-runtime",
  version: "0.1.0",
  languages: ["ex"],
  applies(context) {
    return context.fragment.deferredContributions?.has(this.id) === true;
  },
  async analyze(context) {
    return context.fragment.deferredContributions?.get(this.id) ?? {};
  },
};

export const elixirScriptConventionPlugin: ConventionPlugin = {
  kind: "convention",
  id: "convention:elixir-scripts",
  version: "0.1.0",
  languages: ["ex"],
  applies(context) {
    return context.fragment.deferredContributions?.has(this.id) === true;
  },
  async analyze(context) {
    const prepared = context.fragment.deferredContributions?.get(this.id) ?? {};
    const scriptFiles = new Set(
      (prepared.nodes ?? []).filter((node) => node.kind === "file").map((node) => node.path),
    );
    const roots = await repositoryScriptRoots(context.repository);
    const nodes = new Map((prepared.nodes ?? []).map((node) => [node.id, node]));
    for (const node of roots.nodes ?? []) {
      if (node.kind === "entrypoint" && scriptFiles.has(node.file)) nodes.set(node.id, node);
    }
    return {
      nodes: [...nodes.values()],
      ...(prepared.edges === undefined ? {} : { edges: prepared.edges }),
      ...(prepared.hazards === undefined ? {} : { hazards: prepared.hazards }),
      ...(prepared.diagnostics === undefined ? {} : { diagnostics: prepared.diagnostics }),
    };
  },
};

function repositoryScriptRoots(repository: RepositoryAnalysisContext): Promise<GraphContribution> {
  const cached = repositoryScriptRootCache.get(repository);
  if (cached !== undefined) return cached;
  const scripts = new Set(
    repository.manifests.elixirSourceFiles
      .map((file) => relative(repository.rootDir, file).split(sep).join("/"))
      .filter(
        (file) =>
          file.endsWith(".exs") &&
          file !== ".." &&
          !file.startsWith("../") &&
          !file.startsWith("/"),
      ),
  );
  const roots = extractElixirScriptCommandRoots(repository.rootDir, scripts, repository.gitignore);
  repositoryScriptRootCache.set(repository, roots);
  return roots;
}
