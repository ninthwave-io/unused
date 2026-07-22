/** Compiled-in Elixir conventions prepared from one bounded frontend inventory. */

import { relative, sep } from "node:path";
import {
  defineElixirAtomRoleSummary,
  type ElixirAtomRoleSummaryProvider,
} from "../elixir/atom-role-summaries.js";
import { extractElixirScriptCommandRoots } from "../elixir/script-references.js";
import type { ConventionPlugin, GraphContribution, RepositoryAnalysisContext } from "./types.js";

const repositoryScriptRootCache = new WeakMap<
  RepositoryAnalysisContext,
  Promise<GraphContribution>
>();

const ectoOrigin = { pluginId: "convention:ecto", dependency: "ecto" } as const;
const propagate = "propagate-to-result" as const;
const consume = "consume-data" as const;
const selector = "invocation-selector" as const;
const ectoSummary = (
  module: string,
  name: string,
  arity: number,
  roles: Parameters<typeof defineElixirAtomRoleSummary>[3],
) => defineElixirAtomRoleSummary(module, name, arity, roles, { origin: ectoOrigin });

/** Semantic summaries owned by the compiled-in Ecto convention plugin. */
export const ectoElixirAtomRoleSummaryProvider: ElixirAtomRoleSummaryProvider = {
  id: "convention:ecto",
  dependency: "ecto",
  summaries: [
    ectoSummary("Ecto.Changeset", "change", 1, { 0: propagate }),
    ectoSummary("Ecto.Changeset", "change", 2, { 0: propagate, 1: propagate }),
    ectoSummary("Ecto.Changeset", "cast", 3, {
      0: propagate,
      1: propagate,
      2: propagate,
    }),
    ectoSummary("Ecto.Changeset", "cast", 4, {
      0: propagate,
      1: propagate,
      2: propagate,
      3: propagate,
    }),
    ectoSummary("Ecto.Changeset", "put_change", 3, {
      0: propagate,
      1: propagate,
      2: propagate,
    }),
    ectoSummary("Ecto.Changeset", "force_change", 3, {
      0: propagate,
      1: propagate,
      2: propagate,
    }),
    ectoSummary("Ecto.Changeset", "delete_change", 2, { 0: propagate, 1: consume }),
    ectoSummary("Ecto.Changeset", "get_change", 2, { 0: propagate, 1: consume }),
    ectoSummary("Ecto.Changeset", "get_change", 3, {
      0: propagate,
      1: consume,
      2: propagate,
    }),
    ectoSummary("Ecto.Changeset", "get_field", 2, { 0: propagate, 1: consume }),
    ectoSummary("Ecto.Changeset", "get_field", 3, {
      0: propagate,
      1: consume,
      2: propagate,
    }),
    ectoSummary("Ecto.Changeset", "validate_inclusion", 3, {
      0: propagate,
      1: propagate,
      2: propagate,
    }),
    ectoSummary("Ecto.Changeset", "validate_inclusion", 4, {
      0: propagate,
      1: propagate,
      2: propagate,
      3: propagate,
    }),
    ectoSummary("Ecto.Changeset", "apply_changes", 1, { 0: propagate }),
    ectoSummary("Ecto.Type", "cast", 2, { 0: selector, 1: propagate }),
    ectoSummary("Ecto.Type", "load", 2, { 0: selector, 1: propagate }),
    ectoSummary("Ecto.Type", "dump", 2, { 0: selector, 1: propagate }),
    ectoSummary("Ecto.Type", "equal?", 3, { 0: selector, 1: consume, 2: consume }),
    ectoSummary("Ecto.Type", "embed_as", 2, { 0: selector, 1: consume }),
    ectoSummary("Ecto.Type", "type", 1, { 0: selector }),
  ],
};

/** Registered pre-graph convention capability; it has no post-graph additions. */
export const ectoElixirConventionPlugin: ConventionPlugin & {
  readonly elixirAtomRoleSummaryProvider: ElixirAtomRoleSummaryProvider;
} = {
  kind: "convention",
  id: "convention:ecto",
  version: "0.1.0",
  languages: ["ex"],
  elixirAtomRoleSummaryProvider: ectoElixirAtomRoleSummaryProvider,
  applies: () => false,
  async analyze() {
    return {};
  },
};

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
