/**
 * Deterministic debug serialisation of an {@link IRGraph} (T2.3, architecture.md
 * §3). `irToJSON` produces a plain, fully-sorted object so IR snapshot tests are
 * stable regardless of construction order and readable for hand-verification.
 *
 * Sorting is total: nodes by id; edges by a composite key (from, to, kind,
 * referenceKind, name, span); hazards by (file, class, span). Paths in the
 * output are POSIX repo-relative (they come from the node ids), never absolute —
 * snapshots are machine-independent.
 */

import type { HazardAnnotation, IREdge, IRGraph, IRNode } from "./index.js";

export interface IRJSON {
  nodes: IRNode[];
  edges: IREdge[];
  hazards: HazardAnnotation[];
}

/** A stable, snapshot-friendly view of the graph. */
export function irToJSON(graph: IRGraph): IRJSON {
  const nodes = [...graph.nodes()].sort((a, b) => cmp(a.id, b.id));
  const edges = [...graph.edges()].sort(edgeCmp);
  const hazards = [...graph.hazards()].sort(hazardCmp);
  return { nodes, edges, hazards };
}

function edgeCmp(a: IREdge, b: IREdge): number {
  return (
    cmp(a.from, b.from) ||
    cmp(a.to, b.to) ||
    cmp(a.kind, b.kind) ||
    cmp(a.referenceKind ?? "", b.referenceKind ?? "") ||
    cmp(a.name ?? "", b.name ?? "") ||
    cmp(a.hazardClass ?? "", b.hazardClass ?? "") ||
    cmp(a.partitions?.join("\0") ?? "", b.partitions?.join("\0") ?? "") ||
    (a.typeOnly ? 1 : 0) - (b.typeOnly ? 1 : 0) ||
    a.site.span.start - b.site.span.start ||
    a.site.span.end - b.site.span.end
  );
}

function hazardCmp(a: HazardAnnotation, b: HazardAnnotation): number {
  return (
    cmp(a.file, b.file) ||
    cmp(a.hazardClass, b.hazardClass) ||
    a.site.span.start - b.site.span.start ||
    a.site.span.end - b.site.span.end
  );
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
