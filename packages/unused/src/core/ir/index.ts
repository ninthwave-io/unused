/**
 * `core/ir` — the language-agnostic reference-graph IR (architecture.md §3).
 *
 * The build target every language frontend emits and the reachability + claim
 * engine (T2.4, M3) consumes. Imports nothing from `frontends/*` (ADR 0003,
 * dependency-cruiser). See {@link ./types.js} for the contract, {@link ./graph.js}
 * for the store + queries, {@link ./serialize.js} for the debug serialisation.
 */

export { IRGraph } from "./graph.js";
export { type IRJSON, irToJSON } from "./serialize.js";
export {
  type DependencyNode,
  dependencyId,
  type EdgeKind,
  type EndpointNode,
  type EntrypointKind,
  type EntrypointNode,
  endpointId,
  entrypointId,
  type FileNode,
  fileId,
  type HazardAnnotation,
  type IREdge,
  type IRNode,
  type NodeKind,
  type ReferenceKind,
  type Site,
  type SymbolNode,
  symbolId,
} from "./types.js";
