/** Repository-coordinate rebasing for nested frontend graph fragments. */

import { posix } from "node:path";
import { assertOwnedGraphTransferSource, transferOwnedGraph } from "../../core/ir/graph.js";
import {
  dependencyId,
  endpointId,
  entrypointId,
  fileId,
  type HazardAnnotation,
  type HazardEffect,
  type IREdge,
  IRGraph,
  type IRNode,
  type Site,
  symbolId,
} from "../../core/ir/index.js";
import type { FrontendClaimInputs, GraphContribution, PluginDiagnostic } from "./types.js";

type IdLookup = Pick<ReadonlyMap<string, string>, "get">;
type OwnedRecordRole = "node" | "edge" | "hazard" | "site";

interface PreparedOwnedHazard {
  readonly file: string;
  readonly carrierSymbol?: string;
  readonly subtreePrefix?: string;
  readonly effect?: HazardEffect;
}

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

/**
 * A validated, single-use transfer of an exclusively owned graph.
 *
 * Preparation validates every rewritten identity, path, provenance site, and
 * node-id collision before mutation. `commit` consumes the local-coordinate
 * graph: callers must not retain or reuse the original frontend result.
 */
export interface OwnedGraphRebasePlan {
  readonly context: RebaseContext;
  prepareContribution(contribution: GraphContribution): void;
  prepareDiagnostic(diagnostic: PluginDiagnostic): void;
  commit(): IRGraph;
}

export function prepareOwnedGraphRebase(
  graph: IRGraph,
  rootRelDir: string,
  context: RebaseContext = createRebaseContext(rootRelDir),
): OwnedGraphRebasePlan {
  if (context.prefix === "") {
    let committed = false;
    return {
      context,
      prepareContribution: () => {},
      prepareDiagnostic: () => {},
      commit() {
        if (committed) throw new Error("owned graph rebase plan was already consumed");
        committed = true;
        return graph;
      },
    };
  }

  assertOwnedGraphTransferSource(graph);
  const canonicalSourceFiles = new Map<string, string>();
  const entrypointDestinationIds = new Set<string>();
  const hazardRecords = new WeakSet<HazardAnnotation>();
  const preparedSharedSites = new WeakSet<Site>();
  const preparedHazards = new WeakMap<HazardAnnotation, PreparedOwnedHazard>();
  const sites: Site[] = [];
  const siteFiles: string[] = [];
  let committed = false;

  const assertRole = (record: object, role: OwnedRecordRole, label: string): void => {
    const existing =
      role !== "node" && hasOwnedNodeRole(record)
        ? "node"
        : hazardRecords.has(record as HazardAnnotation)
          ? "hazard"
          : role !== "edge" && hasOwnedEdgeRole(record)
            ? "edge"
            : undefined;
    if (existing !== undefined && existing !== role) {
      throw new Error(
        `${label} cannot be transferred because the same record has incompatible ${existing} and ${role} roles`,
      );
    }
    if (role === "hazard") hazardRecords.add(record as HazardAnnotation);
  };
  const prepareSite = (site: Site): void => {
    assertRole(site, "site", "provenance site");
    assertOwnedRecord(site, "provenance site");
    const path = canonicalPath(context, site.file);
    sites.push(site);
    siteFiles.push(path);
  };
  const prepareSharedSite = (site: Site): void => {
    assertRole(site, "site", "provenance site");
    if (preparedSharedSites.has(site)) return;
    prepareSite(site);
    preparedSharedSites.add(site);
    // Metadata and deferred contributions prepared before commit must retain
    // this exact site object. Commit updates its file after all validation.
    context.sites.set(site, site);
  };
  const prepareSourceFile = (path: string): void => {
    const canonical = canonicalPath(context, path);
    const existing = canonicalSourceFiles.get(canonical);
    if (existing !== undefined && existing !== path) {
      throw new Error(`owned graph rebase produced duplicate node id for path: ${canonical}`);
    }
    canonicalSourceFiles.set(canonical, path);
  };
  const prepareNode = (node: IRNode): void => {
    assertRole(node, "node", `graph node ${node.id}`);
    assertOwnedRecord(node, `graph node ${node.id}`);
    const expectedId = localNodeId(node);
    if (node.id !== expectedId) {
      throw new Error(`owned graph node id does not match its identity fields: ${node.id}`);
    }
    if (node.kind === "file") prepareSourceFile(node.path);
    else if (node.kind === "symbol" || node.kind === "entrypoint") {
      prepareSourceFile(node.file);
    }
    // A fixed prefix plus an injective canonical path map preserves file and
    // symbol identity. Entrypoint ids also embed a prefixed target id in an
    // unescaped delimiter grammar, so validate that smaller root set exactly.
    const destinationId = ownedNodeId(node, context);
    if (node.kind === "entrypoint") {
      if (entrypointDestinationIds.has(destinationId)) {
        throw new Error(`owned graph rebase produced duplicate entrypoint id: ${destinationId}`);
      }
      entrypointDestinationIds.add(destinationId);
    }
  };
  const prepareEdge = (edge: IREdge): void => {
    assertRole(edge, "edge", `graph edge ${edge.from} -> ${edge.to}`);
    assertOwnedRecord(edge, `graph edge ${edge.from} -> ${edge.to}`);
    prepareSite(edge.site);
  };
  const prepareHazard = (hazard: HazardAnnotation): void => {
    assertRole(hazard, "hazard", `graph hazard ${hazard.hazardClass}`);
    if (preparedHazards.has(hazard)) return;
    assertOwnedRecord(hazard, `graph hazard ${hazard.hazardClass}`);
    prepareSite(hazard.site);
    const carrierSymbol = hazard.carrierSymbol;
    const subtreePrefix = hazard.subtreePrefix;
    const effect = prepareOwnedHazardEffect(hazard.effect, graph, context);
    const fileNode = graph.getNode(hazard.file);
    const carrierNode = carrierSymbol === undefined ? undefined : graph.getNode(carrierSymbol);
    preparedHazards.set(hazard, {
      file: fileNode === undefined ? hazard.file : ownedNodeId(fileNode, context),
      ...(carrierSymbol === undefined
        ? {}
        : {
            carrierSymbol:
              carrierNode === undefined
                ? prefixNodeId(carrierSymbol, context.prefix)
                : ownedNodeId(carrierNode, context),
          }),
      ...(subtreePrefix === undefined || subtreePrefix === ""
        ? {}
        : { subtreePrefix: canonicalPath(context, subtreePrefix) }),
      ...(effect === undefined ? {} : { effect }),
    });
  };

  for (const node of graph.nodes()) prepareNode(node);
  for (const edge of graph.edges()) prepareEdge(edge);
  for (const hazard of graph.hazards()) prepareHazard(hazard);

  return {
    context,
    prepareContribution(contribution) {
      if (committed) throw new Error("cannot prepare a consumed owned graph rebase plan");
      for (const node of contribution.nodes ?? []) {
        assertRole(node, "node", `contribution node ${node.id}`);
        assertOwnedRecord(node, `contribution node ${node.id}`);
        rebaseNode(node, context);
      }
      for (const edge of contribution.edges ?? []) prepareEdge(edge);
      for (const hazard of contribution.hazards ?? []) prepareHazard(hazard);
      for (const diagnostic of contribution.diagnostics ?? []) {
        if (diagnostic.site !== undefined) prepareSharedSite(diagnostic.site);
      }
      for (const edge of contribution.edges ?? []) prepareSharedSite(edge.site);
      for (const hazard of contribution.hazards ?? []) prepareSharedSite(hazard.site);
    },
    prepareDiagnostic(diagnostic) {
      if (committed) throw new Error("cannot prepare a consumed owned graph rebase plan");
      if (diagnostic.site !== undefined) prepareSharedSite(diagnostic.site);
    },
    commit() {
      if (committed) throw new Error("owned graph rebase plan was already consumed");
      // A Site prepared earlier can be presented later as a contribution
      // node/edge/hazard. Recheck after all preparation, while every record is
      // still local and before the first owned mutation.
      for (const site of sites) assertRole(site, "site", "provenance site");
      committed = true;
      for (let index = 0; index < sites.length; index += 1) {
        const site = sites[index];
        const file = siteFiles[index];
        if (site !== undefined && file !== undefined) setOwnedField(site, "file", file);
      }
      const transferredHazards = new WeakSet<HazardAnnotation>();
      const transferred = transferOwnedGraph(graph, {
        node(node) {
          rebaseOwnedNode(node, context);
        },
        edge(edge) {
          rebaseOwnedEdge(edge, graph);
        },
        hazard(hazard) {
          if (transferredHazards.has(hazard)) return;
          transferredHazards.add(hazard);
          rebaseOwnedHazard(hazard, preparedHazards.get(hazard) as PreparedOwnedHazard);
        },
      });
      canonicalSourceFiles.clear();
      entrypointDestinationIds.clear();
      sites.length = 0;
      siteFiles.length = 0;
      context.paths.clear();
      return transferred;
    },
  };
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
  for (const node of contribution.nodes ?? []) {
    ids.set(node.id, rebaseNode(node, context).id);
  }
  const prepareId = (id: string): void => {
    if (ids.has(id)) return;
    const owner = ownerGraph.getNode(id);
    if (owner !== undefined) ids.set(id, rebaseNode(owner, context).id);
  };
  for (const edge of contribution.edges ?? []) {
    prepareId(edge.from);
    prepareId(edge.to);
  }
  for (const hazard of contribution.hazards ?? []) {
    prepareId(hazard.file);
    if (hazard.carrierSymbol !== undefined) prepareId(hazard.carrierSymbol);
    if (hazard.effect?.scope.kind === "symbols") {
      for (const id of hazard.effect.scope.ids) prepareId(id);
    }
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

function rebaseEdge(edge: IREdge, context: RebaseContext, ids: IdLookup): IREdge {
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
  ids: IdLookup,
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

function assertOwnedRecord(value: object, label: string): void {
  const prototype = Object.getPrototypeOf(value);
  if (
    (prototype !== Object.prototype && prototype !== null) ||
    !Object.isExtensible(value) ||
    Object.isFrozen(value)
  ) {
    throw new Error(`${label} cannot be transferred because it is not mutable`);
  }
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
    if (!("writable" in descriptor) || !descriptor.writable || !descriptor.configurable) {
      throw new Error(`${label} cannot be transferred because it is not fully writable`);
    }
  }
}

function hasOwnedEdgeRole(value: object): boolean {
  return Object.hasOwn(value, "kind") && Object.hasOwn(value, "from") && Object.hasOwn(value, "to");
}

function hasOwnedNodeRole(value: object): boolean {
  return Object.hasOwn(value, "id") && Object.hasOwn(value, "kind");
}

function assertStableNestedRecord(value: unknown, label: string): asserts value is object {
  if (typeof value !== "object" || value === null) {
    throw new Error(`${label} cannot be transferred because it is not stable data`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${label} cannot be transferred because it is not stable data`);
  }
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
    if (!("value" in descriptor)) {
      throw new Error(`${label} cannot be transferred because it is not stable data`);
    }
  }
}

function assertStableNestedArray(
  value: unknown,
  label: string,
): asserts value is readonly unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    throw new Error(`${label} cannot be transferred because it is not stable data`);
  }
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
    if (!("value" in descriptor)) {
      throw new Error(`${label} cannot be transferred because it is not stable data`);
    }
  }
}

function prepareOwnedHazardEffect(
  effect: HazardEffect | undefined,
  graph: IRGraph,
  context: RebaseContext,
): HazardEffect | undefined {
  if (effect === undefined) return undefined;
  assertStableNestedRecord(effect, "graph hazard effect");
  const scope = effect.scope;
  assertStableNestedRecord(scope, "graph hazard effect scope");
  assertStableNestedArray(effect.worlds, "graph hazard effect worlds");
  const worlds = [...effect.worlds];
  if (scope.kind !== "symbols") {
    return { ...effect, scope: { kind: scope.kind }, worlds };
  }
  const ids = scope.ids;
  assertStableNestedArray(ids, "graph hazard effect symbol ids");
  return {
    ...effect,
    worlds,
    scope: {
      kind: "symbols",
      ids: ids.map((id) => {
        if (typeof id !== "string") {
          throw new Error("graph hazard effect symbol id is not stable data");
        }
        const node = graph.getNode(id);
        return node === undefined ? prefixNodeId(id, context.prefix) : ownedNodeId(node, context);
      }),
    },
  };
}

function ownedNodeId(node: IRNode, context: RebaseContext): string {
  switch (node.kind) {
    case "file":
      return fileId(canonicalPath(context, node.path));
    case "symbol":
      return symbolId(canonicalPath(context, node.file), node.exportedName);
    case "entrypoint": {
      const file = canonicalPath(context, node.file);
      const targetSymbol =
        node.targetSymbol === undefined
          ? undefined
          : prefixNodeId(node.targetSymbol, context.prefix);
      return entrypointId(node.entryKind, file, targetSymbol);
    }
    case "dependency":
      return dependencyId(node.packageName);
    case "endpoint":
      return endpointId(node.protocol, node.route);
  }
}

function localNodeId(node: IRNode): string {
  switch (node.kind) {
    case "file":
      return fileId(node.path);
    case "symbol":
      return symbolId(node.file, node.exportedName);
    case "entrypoint":
      return entrypointId(node.entryKind, node.file, node.targetSymbol);
    case "dependency":
      return dependencyId(node.packageName);
    case "endpoint":
      return endpointId(node.protocol, node.route);
  }
}

function rebaseOwnedNode(node: IRNode, context: RebaseContext): void {
  setOwnedField(node, "id", ownedNodeId(node, context));
  switch (node.kind) {
    case "file":
      setOwnedField(node, "path", canonicalPath(context, node.path));
      break;
    case "symbol":
      setOwnedField(node, "file", canonicalPath(context, node.file));
      break;
    case "entrypoint":
      setOwnedField(node, "file", canonicalPath(context, node.file));
      if (node.targetSymbol !== undefined) {
        setOwnedField(node, "targetSymbol", prefixNodeId(node.targetSymbol, context.prefix));
      }
      break;
    case "dependency":
    case "endpoint":
      break;
  }
}

function rebaseOwnedEdge(edge: IREdge, graph: IRGraph): void {
  setOwnedField(edge, "from", graph.getNode(edge.from)?.id ?? edge.from);
  setOwnedField(edge, "to", graph.getNode(edge.to)?.id ?? edge.to);
}

function rebaseOwnedHazard(hazard: HazardAnnotation, prepared: PreparedOwnedHazard): void {
  setOwnedField(hazard, "file", prepared.file);
  if (prepared.carrierSymbol !== undefined) {
    setOwnedField(hazard, "carrierSymbol", prepared.carrierSymbol);
  }
  if (prepared.subtreePrefix !== undefined) {
    setOwnedField(hazard, "subtreePrefix", prepared.subtreePrefix);
  }
  if (prepared.effect !== undefined) setOwnedField(hazard, "effect", prepared.effect);
}

function setOwnedField<T extends object, K extends keyof T>(target: T, key: K, value: T[K]): void {
  (target as { -readonly [P in keyof T]: T[P] })[key] = value;
}
