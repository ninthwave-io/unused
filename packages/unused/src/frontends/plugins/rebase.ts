/** Repository-coordinate rebasing for nested frontend graph fragments. */

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
import type { FrontendClaimInputs, GraphContribution } from "./types.js";

/** Return a new graph whose file identities and provenance are repository-relative. */
export function rebaseGraph(graph: IRGraph, rootRelDir: string): IRGraph {
  const prefix = normalizePrefix(rootRelDir);
  if (prefix === "") return graph;
  const rebased = new IRGraph();
  const ids = new Map<string, string>();
  for (const node of graph.nodes()) {
    const next = rebaseNode(node, prefix);
    ids.set(node.id, next.id);
    rebased.addNode(next);
  }
  for (const edge of graph.edges()) rebased.addEdge(rebaseEdge(edge, prefix, ids));
  for (const hazard of graph.hazards()) rebased.addHazard(rebaseHazard(hazard, prefix, ids));
  return rebased;
}

/** Rebase a deferred contribution whose edges can target nodes in `ownerGraph`. */
export function rebaseGraphContribution(
  contribution: GraphContribution,
  ownerGraph: IRGraph,
  rootRelDir: string,
): GraphContribution {
  const prefix = normalizePrefix(rootRelDir);
  if (prefix === "") return contribution;
  const ids = new Map<string, string>();
  for (const node of [...ownerGraph.nodes(), ...(contribution.nodes ?? [])]) {
    ids.set(node.id, rebaseNode(node, prefix).id);
  }
  return {
    ...(contribution.nodes === undefined
      ? {}
      : { nodes: contribution.nodes.map((node) => rebaseNode(node, prefix)) }),
    ...(contribution.edges === undefined
      ? {}
      : { edges: contribution.edges.map((edge) => rebaseEdge(edge, prefix, ids)) }),
    ...(contribution.hazards === undefined
      ? {}
      : {
          hazards: contribution.hazards.map((hazard) => rebaseHazard(hazard, prefix, ids)),
        }),
    ...(contribution.diagnostics === undefined
      ? {}
      : {
          diagnostics: contribution.diagnostics.map((diagnostic) => ({
            ...diagnostic,
            ...(diagnostic.site === undefined ? {} : { site: rebaseSite(diagnostic.site, prefix) }),
          })),
        }),
  };
}

/** Rebase claim metadata alongside its graph fragment. */
export function rebaseClaimInputs(
  input: FrontendClaimInputs,
  rootRelDir: string,
): FrontendClaimInputs {
  const prefix = normalizePrefix(rootRelDir);
  if (prefix === "") return input;
  const rebasePath = (path: string): string => prefixRepositoryPath(prefix, path);
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

function rebaseNode(node: IRNode, prefix: string): IRNode {
  switch (node.kind) {
    case "file": {
      const path = prefixRepositoryPath(prefix, node.path);
      return { ...node, id: fileId(path), path };
    }
    case "symbol": {
      const file = prefixRepositoryPath(prefix, node.file);
      return { ...node, id: symbolId(file, node.exportedName), file };
    }
    case "entrypoint": {
      const file = prefixRepositoryPath(prefix, node.file);
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

function rebaseEdge(edge: IREdge, prefix: string, ids: ReadonlyMap<string, string>): IREdge {
  return {
    ...edge,
    from: ids.get(edge.from) ?? edge.from,
    to: ids.get(edge.to) ?? edge.to,
    site: rebaseSite(edge.site, prefix),
  };
}

function rebaseHazard(
  hazard: HazardAnnotation,
  prefix: string,
  ids: ReadonlyMap<string, string>,
): HazardAnnotation {
  return {
    ...hazard,
    file: ids.get(hazard.file) ?? hazard.file,
    ...(hazard.carrierSymbol === undefined
      ? {}
      : {
          carrierSymbol:
            ids.get(hazard.carrierSymbol) ?? prefixNodeId(hazard.carrierSymbol, prefix),
        }),
    site: rebaseSite(hazard.site, prefix),
    ...(hazard.subtreePrefix === undefined || hazard.subtreePrefix === ""
      ? {}
      : { subtreePrefix: prefixRepositoryPath(prefix, hazard.subtreePrefix) }),
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

function rebaseSite(site: Site, prefix: string): Site {
  return { ...site, file: prefixRepositoryPath(prefix, site.file) };
}

function normalizePrefix(path: string): string {
  return normalizePath(path).replace(/\/$/u, "");
}

function normalizePath(path: string): string {
  const normalized = path
    .replaceAll("\\", "/")
    .replace(/^\.\//u, "")
    .replace(/\/{2,}/gu, "/");
  if (normalized.startsWith("/") || normalized === ".." || normalized.startsWith("../")) {
    throw new Error(`path must be repository-relative: ${path}`);
  }
  return normalized;
}
