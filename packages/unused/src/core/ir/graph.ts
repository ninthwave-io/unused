/**
 * The reference-graph store (T2.3, architecture.md §3). Language-agnostic:
 * imports only its sibling {@link ./types.js}, never a frontend (ADR 0003).
 *
 * A frontend builds a graph through {@link IRGraph.addNode}/{@link IRGraph.addEdge}/
 * {@link IRGraph.addHazard}; T2.4 (reachability + claims) reads it through the
 * documented query surface below. This class deliberately does **no**
 * reachability computation — that lives in T2.4, also in core.
 *
 * Construction order is preserved (edges/hazards keep insertion order); the
 * emitter feeds files in discovery (sorted) order, so a graph built twice from
 * the same inputs is identical. {@link ./serialize.js} sorts fully for snapshots.
 */

import {
  type EntrypointNode,
  fileId,
  type HazardAnnotation,
  type IREdge,
  type IRNode,
  type NodeKind,
  type SymbolNode,
} from "./types.js";

export class IRGraph {
  private readonly nodesById = new Map<string, IRNode>();
  private readonly edgeList: IREdge[] = [];
  private readonly hazardList: HazardAnnotation[] = [];
  /** from-node id → its out-edges, maintained incrementally for O(1) `outEdges`. */
  private readonly outIndex = new Map<string, IREdge[]>();

  // --- construction -------------------------------------------------------

  /** Add a node. Idempotent by id: the first insertion for an id wins. */
  addNode(node: IRNode): void {
    if (!this.nodesById.has(node.id)) this.nodesById.set(node.id, node);
  }

  /**
   * Add an edge. The caller guarantees `site` is present (the every-edge-has-a-
   * span invariant); this is also asserted so a frontend bug fails loudly rather
   * than silently producing an un-provenanced edge.
   */
  addEdge(edge: IREdge): void {
    if (edge.site === undefined) {
      throw new Error(
        `IR edge ${edge.kind} ${edge.from} -> ${edge.to} has no site (span required)`,
      );
    }
    this.edgeList.push(edge);
    const bucket = this.outIndex.get(edge.from);
    if (bucket === undefined) this.outIndex.set(edge.from, [edge]);
    else bucket.push(edge);
  }

  /** Add a hazard annotation (carries its own {@link Site}). */
  addHazard(annotation: HazardAnnotation): void {
    this.hazardList.push(annotation);
  }

  // --- queries T2.4 needs (minimal, documented) ---------------------------

  /** Node by id, or `undefined`. */
  getNode(id: string): IRNode | undefined {
    return this.nodesById.get(id);
  }

  /** `true` if a node with this id exists. */
  hasNode(id: string): boolean {
    return this.nodesById.has(id);
  }

  /**
   * Node lookup by (kind, id). The id already encodes the kind (see the id
   * helpers in {@link ./types.js}); this narrows the return type and asserts the
   * stored node's kind matches — the ergonomic "lookup by kind + identity" the
   * spec calls for.
   */
  nodeOfKind<K extends NodeKind>(kind: K, id: string): Extract<IRNode, { kind: K }> | undefined {
    const node = this.nodesById.get(id);
    if (node === undefined || node.kind !== kind) return undefined;
    return node as Extract<IRNode, { kind: K }>;
  }

  /** All entrypoint nodes (reachability roots), in insertion order. */
  entrypoints(): EntrypointNode[] {
    const out: EntrypointNode[] = [];
    for (const node of this.nodesById.values()) {
      if (node.kind === "entrypoint") out.push(node);
    }
    return out;
  }

  /** Out-edges of a node (every edge whose `from` is `nodeId`), in insertion order. */
  outEdges(nodeId: string): readonly IREdge[] {
    return this.outIndex.get(nodeId) ?? [];
  }

  /**
   * The export surface of a file: the symbol nodes reached by an `exports` edge
   * from the file node. Covers local exports and forwarded (re-export) symbols;
   * `export *` forwards names with no symbol, so a consumer resolving a specific
   * name must additionally walk the file's `re-export` out-edges (T2.4).
   */
  exportSurface(filePosixRelPath: string): SymbolNode[] {
    const out: SymbolNode[] = [];
    for (const edge of this.outEdges(fileId(filePosixRelPath))) {
      if (edge.kind !== "exports") continue;
      const target = this.nodesById.get(edge.to);
      if (target?.kind === "symbol") out.push(target);
    }
    return out;
  }

  // --- whole-graph accessors (serialisation, invariant walks) -------------

  nodes(): readonly IRNode[] {
    return [...this.nodesById.values()];
  }

  edges(): readonly IREdge[] {
    return this.edgeList;
  }

  hazards(): readonly HazardAnnotation[] {
    return this.hazardList;
  }
}

interface OwnedGraphStorage {
  readonly nodesById: Map<string, IRNode>;
  readonly edgeList: IREdge[];
  readonly hazardList: HazardAnnotation[];
  readonly outIndex: Map<string, IREdge[]>;
}

interface OwnedGraphTransfer {
  readonly node: (node: IRNode) => void;
  readonly edge: (edge: IREdge) => void;
  readonly hazard: (hazard: HazardAnnotation) => void;
}

function ownedStorage(graph: IRGraph): OwnedGraphStorage {
  return graph as unknown as OwnedGraphStorage;
}

/** @internal Validate the source index before an exclusive owned-storage transfer. */
export function assertOwnedGraphTransferSource(graph: IRGraph): void {
  for (const [key, node] of ownedStorage(graph).nodesById) {
    if (key !== node.id) {
      throw new Error(
        `owned graph transfer source index is stale: key ${key}, node identity ${node.id}`,
      );
    }
  }
}

/**
 * Rewrite exclusively owned graph storage without cloning it.
 *
 * @internal This module is not a package export. The caller must validate that
 * all transforms are total and non-throwing before calling this function.
 */
export function transferOwnedGraph(graph: IRGraph, options: OwnedGraphTransfer): IRGraph {
  const storage = ownedStorage(graph);
  const nodes = [...storage.nodesById.values()];
  for (const node of nodes) {
    options.node(node);
  }

  // Keep the old-key node index until edges and hazards have been rewritten.
  // Their callbacks can resolve an old endpoint id to the already-mutated
  // node object and read its new id without allocating an old→new id table.
  storage.outIndex.clear();
  for (let index = 0; index < storage.edgeList.length; index += 1) {
    const edge = storage.edgeList[index];
    if (edge === undefined) continue;
    options.edge(edge);
    if (edge.site === undefined) {
      throw new Error(
        `IR edge ${edge.kind} ${edge.from} -> ${edge.to} has no site (span required)`,
      );
    }
    const bucket = storage.outIndex.get(edge.from);
    if (bucket === undefined) storage.outIndex.set(edge.from, [edge]);
    else bucket.push(edge);
  }

  for (let index = 0; index < storage.hazardList.length; index += 1) {
    const hazard = storage.hazardList[index];
    if (hazard !== undefined) options.hazard(hazard);
  }

  storage.nodesById.clear();
  for (const node of nodes) {
    if (storage.nodesById.has(node.id)) {
      throw new Error(`owned graph transfer produced duplicate node id: ${node.id}`);
    }
    storage.nodesById.set(node.id, node);
  }
  return graph;
}
