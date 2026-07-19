/**
 * Counterfactual deletion planning (ADR 0012).
 *
 * Plans are read-only projections over the captured IR. They are deliberately
 * not claims: this module never calls claim emission, changes confidence, or
 * participates in gates/baselines. It removes a resolved subject from a cloned
 * graph, applies the re-export edits that removal necessarily entails,
 * recomputes the three reachability partitions, and reports subjects that were
 * reachable before but are unreachable afterward.
 */

import {
  type DeletionPlan,
  type DeletionPlanConsequenceSubject,
  type DeletionPlanStage,
  type DeletionPlanSubject,
  type ReExportEdit,
  SCHEMA_VERSION,
} from "../claims/types.js";
import { fileId, type IREdge, IRGraph, type IRNode, symbolId } from "../ir/index.js";
import { computePartitionedReachability, type PartitionedReachability } from "./reachability.js";

export type {
  DeletionPlan,
  DeletionPlanConsequenceSubject,
  DeletionPlanStage,
  DeletionPlanSubject,
  ReExportEdit,
};

export interface ComputeDeletionPlanInput {
  readonly graph: IRGraph;
  /** Reachability captured for the same graph before the counterfactual. */
  readonly reachability: PartitionedReachability;
  /** Already-resolved subject; resolution remains the caller's concern. */
  readonly subject: DeletionPlanSubject;
}

/** Compute a deterministic, language-agnostic counterfactual deletion plan. */
export function computeDeletionPlan(input: ComputeDeletionPlanInput): DeletionPlan {
  const { graph, reachability, subject } = input;
  if (subject.kind === "dependency") {
    return {
      schemaVersion: SCHEMA_VERSION,
      selected: subject,
      supported: false,
      unsupportedReason: "dependency deletion has no graph cascade model",
      reExportEdits: [],
      stages: [],
    };
  }

  const selectedNodeIds = resolveSelectedNodeIds(graph, subject);
  if (selectedNodeIds.size === 0) {
    return {
      schemaVersion: SCHEMA_VERSION,
      selected: subject,
      supported: false,
      unsupportedReason: "selected subject is not present in the captured graph",
      reExportEdits: [],
      stages: [],
    };
  }

  const removedNodeIds = new Set(selectedNodeIds);
  const reExportEdits = collectReExportClosure(graph, removedNodeIds);
  const counterfactual = cloneWithout(graph, removedNodeIds);
  const after = computePartitionedReachability(counterfactual);
  const newlyDead = newlyDeadSubjects(graph, reachability, after, removedNodeIds);
  const distance = causalDistances(graph, selectedNodeIds, removedNodeIds);
  const stages = stageSubjects(graph, newlyDead, distance);

  return {
    schemaVersion: SCHEMA_VERSION,
    selected: subject,
    supported: true,
    reExportEdits,
    stages,
  };
}

function resolveSelectedNodeIds(graph: IRGraph, subject: DeletionPlanSubject): Set<string> {
  if (subject.kind === "dependency") return new Set();
  if (subject.kind === "export") {
    const id = symbolId(subject.file, subject.name ?? "");
    return graph.hasNode(id) ? new Set([id]) : new Set();
  }

  const id = fileId(subject.file);
  if (!graph.hasNode(id)) return new Set();
  const ids = new Set<string>([id]);
  for (const node of graph.nodes()) {
    if (node.kind === "symbol" && node.file === subject.file) ids.add(node.id);
  }
  return ids;
}

/**
 * A named forwarding symbol cannot remain after its target is removed. Remove
 * such symbols recursively and capture every required source edit. A star
 * re-export contributes an edit but not removal of its whole forwarding file.
 */
function collectReExportClosure(graph: IRGraph, removedNodeIds: Set<string>): ReExportEdit[] {
  const edits = new Map<string, ReExportEdit>();
  const unavailableSurfaceNames = new Map<string, Set<string>>();
  for (const id of removedNodeIds) {
    const node = graph.getNode(id);
    if (
      node?.kind === "symbol" &&
      !surfaceNameHasUniqueOrigin(graph, fileId(node.file), node.exportedName, removedNodeIds)
    ) {
      addSurfaceName(unavailableSurfaceNames, fileId(node.file), node.exportedName);
    }
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const edge of graph.edges()) {
      if (edge.kind !== "references" || edge.referenceKind !== "re-export") continue;
      const source = graph.getNode(edge.from);
      const target = graph.getNode(edge.to);

      if (removedNodeIds.has(edge.to)) {
        if (
          target?.kind === "symbol" &&
          surfaceNameHasUniqueOrigin(
            graph,
            fileId(target.file),
            target.exportedName,
            removedNodeIds,
          )
        ) {
          continue;
        }
        const edit = reExportEdit(edge, source, target);
        edits.set(reExportEditKey(edit), edit);
        if (source?.kind === "symbol" && !source.local) {
          if (!removedNodeIds.has(source.id)) {
            removedNodeIds.add(source.id);
            changed = true;
          }
          if (
            !surfaceNameHasUniqueOrigin(
              graph,
              fileId(source.file),
              source.exportedName,
              removedNodeIds,
            )
          ) {
            changed =
              addSurfaceName(unavailableSurfaceNames, fileId(source.file), source.exportedName) ||
              changed;
          }
        }
        continue;
      }

      const unavailableNames = unavailableSurfaceNames.get(edge.to);
      if (unavailableNames === undefined) continue;

      // A star statement remains valid when one forwarded name disappears. It
      // only carries that now-unavailable name to its own file surface. Default
      // is deliberately excluded by ECMAScript star-export semantics.
      if (source?.kind === "file" && edge.name === "*") {
        for (const name of unavailableNames) {
          if (
            name !== "default" &&
            !surfaceNameHasUniqueOrigin(graph, source.id, name, removedNodeIds)
          ) {
            changed = addSurfaceName(unavailableSurfaceNames, source.id, name) || changed;
          }
        }
        continue;
      }

      // A downstream named re-export through a star-resolved file becomes
      // invalid when that exact source name disappears. Remove its specifier,
      // then continue the closure under its public alias. Namespace re-exports
      // (`export * as ns`) remain valid and are intentionally left untouched.
      if (
        source?.kind === "symbol" &&
        !source.local &&
        edge.name !== undefined &&
        edge.name !== "*" &&
        unavailableNames.has(edge.name)
      ) {
        const edit = reExportEdit(edge, source, target);
        edits.set(reExportEditKey(edit), edit);
        if (!removedNodeIds.has(source.id)) {
          removedNodeIds.add(source.id);
          changed = true;
        }
        if (
          !surfaceNameHasUniqueOrigin(
            graph,
            fileId(source.file),
            source.exportedName,
            removedNodeIds,
          )
        ) {
          changed =
            addSurfaceName(unavailableSurfaceNames, fileId(source.file), source.exportedName) ||
            changed;
        }
      }
    }
  }
  return [...edits.values()].sort(compareReExportEdits);
}

function addSurfaceName(
  namesByFile: Map<string, Set<string>>,
  fileNodeId: string,
  name: string,
): boolean {
  const names = namesByFile.get(fileNodeId);
  if (names === undefined) {
    namesByFile.set(fileNodeId, new Set([name]));
    return true;
  }
  const previousSize = names.size;
  names.add(name);
  return names.size !== previousSize;
}

/**
 * Whether a file still exposes `name` through exactly one distinct surviving
 * origin after the currently planned removals. ECMAScript star resolution is
 * unavailable for both zero and multiple origins; converging forwarding paths
 * to the same local binding remain one origin.
 */
export function surfaceNameHasUniqueOrigin(
  graph: IRGraph,
  fileNodeId: string,
  name: string,
  removedNodeIds: ReadonlySet<string>,
): boolean {
  type ResolutionState =
    | { readonly kind: "file"; readonly id: string; readonly name: string }
    | { readonly kind: "symbol"; readonly id: string };
  const queue: ResolutionState[] = [{ kind: "file", id: fileNodeId, name }];
  const visited = new Set<string>();
  const origins = new Set<string>();

  while (queue.length > 0 && origins.size <= 1) {
    const state = queue.shift();
    if (state === undefined) break;
    const stateKey =
      state.kind === "file" ? `file\0${state.id}\0${state.name}` : `symbol\0${state.id}`;
    if (visited.has(stateKey)) continue;
    visited.add(stateKey);

    if (state.kind === "file") {
      if (removedNodeIds.has(state.id)) continue;
      const file = graph.getNode(state.id);
      if (file?.kind !== "file") continue;
      const direct = graph.getNode(symbolId(file.path, state.name));
      if (direct?.kind === "symbol" && !removedNodeIds.has(direct.id)) {
        queue.push({ kind: "symbol", id: direct.id });
        continue;
      }
      if (state.name === "default") continue;
      for (const edge of graph.outEdges(state.id)) {
        if (edge.kind !== "references" || edge.referenceKind !== "re-export" || edge.name !== "*") {
          continue;
        }
        const target = graph.getNode(edge.to);
        if (target?.kind === "file") {
          queue.push({ kind: "file", id: target.id, name: state.name });
        }
      }
      continue;
    }

    const symbol = graph.getNode(state.id);
    if (symbol?.kind !== "symbol") continue;
    if (removedNodeIds.has(symbol.id)) {
      queue.push({ kind: "file", id: fileId(symbol.file), name: symbol.exportedName });
      continue;
    }
    // Default assignment expressions (and anonymous defaults) have their own
    // synthetic export binding. Oxc may still report the expression's spelling
    // in `localName`; only `Name` proves declaration-binding identity.
    if (symbol.localNameKind !== undefined && symbol.localNameKind !== "Name") {
      origins.add(`synthetic\0${symbol.id}`);
      continue;
    }
    if (symbol.local) {
      origins.add(`local\0${symbol.file}\0${symbol.localName ?? symbol.exportedName}`);
      continue;
    }
    for (const edge of graph.outEdges(symbol.id)) {
      if (edge.kind !== "references" || edge.referenceKind !== "re-export") continue;
      const target = graph.getNode(edge.to);
      if (target?.kind === "symbol") {
        queue.push({ kind: "symbol", id: target.id });
      } else if (target?.kind === "file" && edge.name !== undefined) {
        if (edge.name === "*") {
          if (!removedNodeIds.has(target.id)) origins.add(`namespace\0${target.id}`);
        } else {
          queue.push({ kind: "file", id: target.id, name: edge.name });
        }
      }
    }
  }
  return origins.size === 1;
}

function reExportEdit(
  edge: IREdge,
  source: IRNode | undefined,
  target: IRNode | undefined,
): ReExportEdit {
  const targetFile =
    target?.kind === "file"
      ? target.path
      : target?.kind === "symbol"
        ? target.file
        : subjectFileFromId(edge.to);
  return {
    kind: "remove-re-export",
    file: edge.site.file,
    line: edge.site.span.startLine,
    ...(source?.kind === "symbol" ? { exportedName: source.exportedName } : {}),
    targetFile,
    ...(target?.kind === "symbol" ? { targetName: target.exportedName } : {}),
    site: edge.site,
  };
}

function reExportEditKey(edit: ReExportEdit): string {
  return `${edit.file}\0${edit.site.span.start}\0${edit.exportedName ?? ""}\0${edit.targetFile}\0${edit.targetName ?? ""}`;
}

function compareReExportEdits(a: ReExportEdit, b: ReExportEdit): number {
  return (
    compare(a.file, b.file) ||
    a.site.span.start - b.site.span.start ||
    compare(a.exportedName ?? "", b.exportedName ?? "") ||
    compare(a.targetFile, b.targetFile) ||
    compare(a.targetName ?? "", b.targetName ?? "")
  );
}

function cloneWithout(graph: IRGraph, removedNodeIds: ReadonlySet<string>): IRGraph {
  const clone = new IRGraph();
  const removedFiles = new Set<string>();
  for (const id of removedNodeIds) {
    const node = graph.getNode(id);
    if (node?.kind === "file") removedFiles.add(node.path);
  }

  for (const node of graph.nodes()) {
    if (removedNodeIds.has(node.id)) continue;
    if (node.kind === "entrypoint" && removedFiles.has(node.file)) continue;
    clone.addNode(node);
  }
  for (const edge of graph.edges()) {
    if (removedNodeIds.has(edge.from)) continue;
    if (removedNodeIds.has(edge.to)) {
      const target = graph.getNode(edge.to);
      if (
        edge.kind === "references" &&
        target?.kind === "symbol" &&
        edge.site.file !== target.file &&
        surfaceNameHasUniqueOrigin(graph, fileId(target.file), target.exportedName, removedNodeIds)
      ) {
        clone.addEdge({
          ...edge,
          to: fileId(target.file),
          name: edge.name ?? target.exportedName,
        });
      }
      continue;
    }
    clone.addEdge(edge);
  }
  for (const hazard of graph.hazards()) {
    if (removedNodeIds.has(hazard.file) || removedFiles.has(hazard.site.file)) continue;
    clone.addHazard(hazard);
  }
  return clone;
}

function newlyDeadSubjects(
  graph: IRGraph,
  before: PartitionedReachability,
  after: PartitionedReachability,
  removedNodeIds: ReadonlySet<string>,
): DeletionPlanConsequenceSubject[] {
  const beforeFiles = reachableFiles(before);
  const afterFiles = reachableFiles(after);
  const beforeSymbols = reachableSymbols(before);
  const afterSymbols = reachableSymbols(after);
  const newlyDeadFiles = new Set<string>();

  for (const node of graph.nodes()) {
    if (node.kind !== "file" || removedNodeIds.has(node.id)) continue;
    if (beforeFiles.has(node.id) && !afterFiles.has(node.id)) newlyDeadFiles.add(node.path);
  }

  const subjects: DeletionPlanConsequenceSubject[] = [...newlyDeadFiles].map((file) => ({
    kind: "file",
    file,
  }));
  for (const node of graph.nodes()) {
    if (node.kind !== "symbol" || !node.local || removedNodeIds.has(node.id)) continue;
    if (newlyDeadFiles.has(node.file)) continue; // file claim subsumes its exports
    if (beforeSymbols.has(node.id) && !afterSymbols.has(node.id)) {
      subjects.push({
        kind: "export",
        file: node.file,
        name: node.exportedName,
        line: node.span.startLine,
      });
    }
  }
  return subjects.sort(compareSubjects);
}

function reachableFiles(reachability: PartitionedReachability): Set<string> {
  return new Set([
    ...reachability.production.reachableFiles,
    ...reachability.config.reachableFiles,
    ...reachability.test.reachableFiles,
  ]);
}

function reachableSymbols(reachability: PartitionedReachability): Set<string> {
  return new Set([
    ...reachability.production.reachableSymbols,
    ...reachability.config.reachableSymbols,
    ...reachability.test.reachableSymbols,
  ]);
}

/**
 * Shortest causal distance from the selected subject.
 *
 * A symbol's own outgoing references are direct consequences (distance +1).
 * File-level references require the symbol's owning file to become dead first,
 * so an initially selected symbol crosses reverse containment at +1. Symbols
 * reached later share their causal stage with a newly-dead owning file; that
 * structural hop is zero-cost, and the file's outgoing reference is the next
 * stage. File selections already seed both file and contained symbols at zero.
 */
function causalDistances(
  graph: IRGraph,
  seeds: ReadonlySet<string>,
  removedNodeIds: ReadonlySet<string>,
): ReadonlyMap<string, number> {
  const distance = new Map<string, number>();
  const queue: string[] = [];
  const reverseReExports = reverseRemovedReExports(graph, removedNodeIds);
  for (const seed of [...seeds].sort(compare)) {
    distance.set(seed, 0);
    queue.push(seed);
  }
  while (queue.length > 0) {
    queue.sort(
      (a, b) => (distance.get(a) as number) - (distance.get(b) as number) || compare(a, b),
    );
    const from = queue.shift() as string;
    const fromDistance = distance.get(from) as number;
    const node = graph.getNode(from);
    for (const forwarder of reverseReExports.get(from) ?? []) {
      relaxDistance(distance, queue, forwarder, fromDistance);
    }
    if (node?.kind === "symbol") {
      const owner = fileId(node.file);
      const ownerDistance = fromDistance === 0 ? 1 : fromDistance;
      relaxDistance(distance, queue, owner, ownerDistance);
    }
    const targets = graph
      .outEdges(from)
      .filter((edge) => edge.kind === "references")
      .map((edge) => edge.to)
      .sort(compare);
    for (const target of targets) {
      relaxDistance(distance, queue, target, fromDistance + 1);
    }
  }
  return distance;
}

/**
 * Named forwarding symbols removed with their target are structural edits,
 * not later liveness consequences. Traverse that reverse closure at zero cost
 * so every forwarding barrel owner lands in stage 1 and only its descendants
 * advance to stage 2.
 */
function reverseRemovedReExports(
  graph: IRGraph,
  removedNodeIds: ReadonlySet<string>,
): ReadonlyMap<string, readonly string[]> {
  const reverse = new Map<string, string[]>();
  for (const edge of graph.edges()) {
    if (
      edge.kind !== "references" ||
      edge.referenceKind !== "re-export" ||
      !removedNodeIds.has(edge.from) ||
      !removedNodeIds.has(edge.to)
    ) {
      continue;
    }
    const source = graph.getNode(edge.from);
    if (source?.kind !== "symbol" || source.local) continue;
    const forwarders = reverse.get(edge.to);
    if (forwarders === undefined) reverse.set(edge.to, [edge.from]);
    else forwarders.push(edge.from);
  }
  for (const forwarders of reverse.values()) forwarders.sort(compare);
  return reverse;
}

function relaxDistance(
  distance: Map<string, number>,
  queue: string[],
  nodeId: string,
  candidate: number,
): void {
  const current = distance.get(nodeId);
  if (current !== undefined && current <= candidate) return;
  distance.set(nodeId, candidate);
  if (!queue.includes(nodeId)) queue.push(nodeId);
}

function stageSubjects(
  graph: IRGraph,
  subjects: readonly DeletionPlanConsequenceSubject[],
  distance: ReadonlyMap<string, number>,
): DeletionPlanStage[] {
  const byStage = new Map<number, DeletionPlanConsequenceSubject[]>();
  for (const subject of subjects) {
    const nodeDistances =
      subject.kind === "export"
        ? [distance.get(symbolId(subject.file, subject.name ?? ""))]
        : [
            distance.get(fileId(subject.file)),
            ...graph
              .nodes()
              .filter((node) => node.kind === "symbol" && node.file === subject.file)
              .map((node) => distance.get(node.id)),
          ];
    const known = nodeDistances.filter(
      (value): value is number => value !== undefined && value > 0,
    );
    const stage = known.length > 0 ? Math.min(...known) : 1;
    const bucket = byStage.get(stage);
    if (bucket === undefined) byStage.set(stage, [subject]);
    else bucket.push(subject);
  }
  return [...byStage.entries()]
    .sort(([a], [b]) => a - b)
    .map(([stage, newlyDead]) => ({ stage, newlyDead: newlyDead.sort(compareSubjects) }));
}

function compareSubjects(
  a: DeletionPlanConsequenceSubject,
  b: DeletionPlanConsequenceSubject,
): number {
  return (
    compare(a.file, b.file) ||
    compare(a.kind, b.kind) ||
    compare(subjectName(a), subjectName(b)) ||
    subjectLine(a) - subjectLine(b)
  );
}

function subjectName(subject: DeletionPlanConsequenceSubject): string {
  return subject.kind === "file" ? "" : subject.name;
}

function subjectLine(subject: DeletionPlanConsequenceSubject): number {
  return subject.kind === "export" ? (subject.line ?? 0) : 0;
}

function subjectFileFromId(id: string): string {
  if (id.startsWith("file:")) return id.slice("file:".length);
  if (id.startsWith("symbol:")) return id.slice("symbol:".length).split("#", 1)[0] ?? id;
  return id;
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
