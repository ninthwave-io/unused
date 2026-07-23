/** Repository-coordinate rebasing for nested frontend graph fragments. */

import { posix } from "node:path";
import {
  dependencyId,
  endpointId,
  entrypointId,
  fileId,
  type HazardAnnotation,
  type IREdge,
  IRGraph,
  type IRNode,
  type Site,
  symbolId,
} from "../../core/ir/index.js";
import type { FrontendClaimInputs, GraphContribution, PluginDiagnostic } from "./types.js";

/** Run-local canonicalization shared by every rebased part of one fragment. */
export interface RebaseContext {
  readonly prefix: string;
  readonly paths: Map<string, string>;
  readonly sites: WeakMap<Site, Site>;
}

export function createRebaseContext(rootRelDir: string): RebaseContext {
  return {
    prefix: normalizePrefix(rootRelDir),
    paths: new Map(),
    sites: new WeakMap(),
  };
}

/** Return a new graph whose file identities and provenance are repository-relative. */
export function rebaseGraph(
  graph: IRGraph,
  rootRelDir: string,
  context: RebaseContext = createRebaseContext(rootRelDir),
): IRGraph {
  const prefix = context.prefix;
  if (prefix === "") return graph;
  const rebased = new IRGraph();
  const ids = new Map<string, string>();
  for (const node of graph.nodes()) {
    const next = rebaseNode(node, context);
    ids.set(node.id, next.id);
    rebased.addNode(next);
  }
  for (const edge of graph.edges()) rebased.addEdge(rebaseEdge(edge, context, ids));
  for (const hazard of graph.hazards()) rebased.addHazard(rebaseHazard(hazard, context, ids));
  return rebased;
}

/** Rebase a deferred contribution whose edges can target nodes in `ownerGraph`. */
export function rebaseGraphContribution(
  contribution: GraphContribution,
  ownerGraph: IRGraph,
  rootRelDir: string,
  context: RebaseContext = createRebaseContext(rootRelDir),
): GraphContribution {
  const prefix = context.prefix;
  if (prefix === "") return contribution;
  const ids = new Map<string, string>();
  for (const node of [...ownerGraph.nodes(), ...(contribution.nodes ?? [])]) {
    ids.set(node.id, rebaseNode(node, context).id);
  }
  return {
    ...(contribution.nodes === undefined
      ? {}
      : { nodes: contribution.nodes.map((node) => rebaseNode(node, context)) }),
    ...(contribution.edges === undefined
      ? {}
      : { edges: contribution.edges.map((edge) => rebaseEdge(edge, context, ids)) }),
    ...(contribution.hazards === undefined
      ? {}
      : {
          hazards: contribution.hazards.map((hazard) => rebaseHazard(hazard, context, ids)),
        }),
    ...(contribution.diagnostics === undefined
      ? {}
      : {
          diagnostics: contribution.diagnostics.map((diagnostic) =>
            rebaseDiagnostic(diagnostic, rootRelDir, context),
          ),
        }),
  };
}

/** Rebase an analyzer/contribution diagnostic into repository coordinates. */
export function rebaseDiagnostic(
  diagnostic: PluginDiagnostic,
  rootRelDir: string,
  context: RebaseContext = createRebaseContext(rootRelDir),
): PluginDiagnostic {
  if (context.prefix === "" || diagnostic.site === undefined) return diagnostic;
  return { ...diagnostic, site: rebaseSite(diagnostic.site, context) };
}

/** Rebase claim metadata alongside its graph fragment. */
export function rebaseClaimInputs(
  input: FrontendClaimInputs,
  rootRelDir: string,
  context: RebaseContext = createRebaseContext(rootRelDir),
): FrontendClaimInputs {
  const prefix = context.prefix;
  if (prefix === "") return input;
  const rebasePath = (path: string): string => canonicalPath(context, path);
  const fileLineCounts = new Map<string, number>();
  for (const [id, lines] of input.fileLineCounts) {
    if (!id.startsWith("file:")) throw new Error(`expected file id, received: ${id}`);
    fileLineCounts.set(fileId(rebasePath(id.slice("file:".length))), lines);
  }
  return {
    fileLineCounts,
    ...(input.dependencies === undefined
      ? {}
      : {
          dependencies: input.dependencies.map((dependency) => ({
            ...dependency,
            loc: { ...dependency.loc, file: rebasePath(dependency.loc.file) },
          })),
        }),
    ...(input.selfDependencyIds === undefined
      ? {}
      : { selfDependencyIds: input.selfDependencyIds }),
    units: input.units.map((unit) => ({
      ...unit,
      rootRelDir: rebasePath(unit.rootRelDir),
    })),
    analysisFiles: new Set([...input.analysisFiles].map(rebasePath)),
    claimableFiles: new Set([...input.claimableFiles].map(rebasePath)),
  };
}

export function prefixRepositoryPath(rootRelDir: string, path: string): string {
  const prefix = normalizePrefix(rootRelDir);
  const suffix = normalizePath(path);
  return prefix === "" ? suffix : suffix === "" ? prefix : `${prefix}/${suffix}`;
}

function rebaseNode(node: IRNode, context: RebaseContext): IRNode {
  const { prefix } = context;
  switch (node.kind) {
    case "file": {
      const path = canonicalPath(context, node.path);
      return { ...node, id: fileId(path), path };
    }
    case "symbol": {
      const file = canonicalPath(context, node.file);
      return { ...node, id: symbolId(file, node.exportedName), file };
    }
    case "entrypoint": {
      const file = canonicalPath(context, node.file);
      const targetSymbol =
        node.targetSymbol === undefined ? undefined : prefixNodeId(node.targetSymbol, prefix);
      return {
        ...node,
        id: entrypointId(node.entryKind, file, targetSymbol),
        file,
        ...(targetSymbol === undefined ? {} : { targetSymbol }),
      };
    }
    case "dependency":
      return { ...node, id: dependencyId(node.packageName) };
    case "endpoint":
      return { ...node, id: endpointId(node.protocol, node.route) };
  }
}

function rebaseEdge(
  edge: IREdge,
  context: RebaseContext,
  ids: ReadonlyMap<string, string>,
): IREdge {
  return {
    ...edge,
    from: ids.get(edge.from) ?? edge.from,
    to: ids.get(edge.to) ?? edge.to,
    site: rebaseSite(edge.site, context),
  };
}

function rebaseHazard(
  hazard: HazardAnnotation,
  context: RebaseContext,
  ids: ReadonlyMap<string, string>,
): HazardAnnotation {
  const { prefix } = context;
  return {
    ...hazard,
    file: ids.get(hazard.file) ?? hazard.file,
    ...(hazard.carrierSymbol === undefined
      ? {}
      : {
          carrierSymbol:
            ids.get(hazard.carrierSymbol) ?? prefixNodeId(hazard.carrierSymbol, prefix),
        }),
    site: rebaseSite(hazard.site, context),
    ...(hazard.subtreePrefix === undefined || hazard.subtreePrefix === ""
      ? {}
      : { subtreePrefix: canonicalPath(context, hazard.subtreePrefix) }),
    ...(hazard.effect?.scope.kind !== "symbols"
      ? {}
      : {
          effect: {
            ...hazard.effect,
            scope: {
              kind: "symbols" as const,
              ids: hazard.effect.scope.ids.map(
                (symbol) => ids.get(symbol) ?? prefixNodeId(symbol, prefix),
              ),
            },
          },
        }),
  };
}

function prefixNodeId(id: string, prefix: string): string {
  if (id.startsWith("file:")) return fileId(prefixRepositoryPath(prefix, id.slice(5)));
  if (id.startsWith("symbol:")) {
    const separator = id.indexOf("#", 7);
    if (separator !== -1) {
      return symbolId(
        prefixRepositoryPath(prefix, id.slice(7, separator)),
        id.slice(separator + 1),
      );
    }
  }
  return id;
}

function rebaseSite(site: Site, context: RebaseContext): Site {
  const existing = context.sites.get(site);
  if (existing !== undefined) return existing;
  const rebased = { ...site, file: canonicalPath(context, site.file) };
  context.sites.set(site, rebased);
  return rebased;
}

function canonicalPath(context: RebaseContext, path: string): string {
  const normalized = normalizePath(path);
  const existing = context.paths.get(normalized);
  if (existing !== undefined) return existing;
  const rebased =
    context.prefix === ""
      ? normalized
      : normalized === ""
        ? context.prefix
        : `${context.prefix}/${normalized}`;
  context.paths.set(normalized, rebased);
  return rebased;
}

function normalizePrefix(path: string): string {
  return normalizePath(path).replace(/\/$/u, "");
}

function normalizePath(path: string): string {
  const slashPath = path.replaceAll("\\", "/");
  const normalized = slashPath === "" ? "" : posix.normalize(slashPath);
  if (
    posix.isAbsolute(normalized) ||
    /^[A-Za-z]:\//u.test(normalized) ||
    normalized === ".." ||
    normalized.startsWith("../")
  ) {
    throw new Error(`path must be repository-relative: ${path}`);
  }
  return normalized === "." ? "" : normalized;
}
