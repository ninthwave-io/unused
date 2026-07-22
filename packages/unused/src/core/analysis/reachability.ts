/**
 * Forward reachability over the reference-graph IR (T2.4, phasing.md M2).
 *
 * Language-agnostic: imports only {@link ../ir/index.js}, never a frontend
 * (ADR 0003, dependency-cruiser). A frontend hands core a fully-built
 * {@link IRGraph}; this module seeds from production entrypoints and walks
 * forward, cycle-safe, recording *how* each node was first reached so
 * {@link whyReachable} (and M6's `why_alive`) can render a path from stored
 * provenance without re-analysis (architecture.md §3, PRD §8).
 *
 * ## The three FP-critical rules it implements (inherited from the T2.3 review)
 *  1. **Star-chain name resolution.** A `references`→file edge carrying a name
 *     means "resolve this name through the target's `re-export "*"` out-edges,
 *     RECURSIVELY". A single unambiguous resolution reaches only that origin
 *     symbol; an unresolved or ambiguous name keeps the target's **whole export
 *     surface** alive — a name is never silently dropped.
 *  2. **No blanket `exports` traversal.** An export surface becomes reachable
 *     only (a) from an entrypoint file (its public API is live by the PRD
 *     assumption set) or (b) via a file-level whole-surface edge — a namespace
 *     import (`*`), a `dynamic-resolved` require/import of a whole module, or a
 *     consumed star/namespace re-export. A `side-effect` edge reaches the FILE
 *     but leaves its exports individually flaggable.
 *  3. Hazard keep-alive is applied at claim time (see `claims.ts`), not here;
 *     reachability faithfully records what the edges say.
 *
 * The walk terminates on any graph, including the circular star-chain fixture
 * (`__testfixtures__/circular-reexport`): every mark is idempotent and only a
 * genuine state change re-enqueues a node.
 */

import {
  type EntrypointKind,
  type EntrypointNode,
  fileId,
  type IREdge,
  type IRGraph,
  symbolId,
} from "../ir/index.js";
import type { PerformanceTracker } from "./performance.js";

// ---------------------------------------------------------------------------
// Result shapes
// ---------------------------------------------------------------------------

/** How a node was first reached — the seed for a why-path. */
export type Predecessor =
  | {
      readonly via: "entrypoint";
      readonly entrypointId: string;
      readonly file: string;
      readonly reason: string;
      readonly entryKind: EntrypointKind;
      readonly targetSymbol?: string;
    }
  | { readonly via: "edge"; readonly edge: IREdge };

export interface Reachability {
  /** Reachable file node ids. */
  readonly reachableFiles: ReadonlySet<string>;
  /** File node ids whose **whole** export surface is live (entrypoint / `*` / dynamic). */
  readonly surfaceLiveFiles: ReadonlySet<string>;
  /** Reachable symbol node ids. */
  readonly reachableSymbols: ReadonlySet<string>;
  /** File node ids that are roots of ANY kind (production, config, or test) — never claimed. */
  readonly entrypointFiles: ReadonlySet<string>;
  /**
   * File node ids that are **production** roots specifically. When empty, no
   * subject can be proven dead (nothing anchors liveness) — `claims.ts` emits
   * nothing (architecture.md §3 partition rule; the entrypoint-detection
   * docstring's "no confident root" contract).
   */
  readonly productionEntrypointFiles: ReadonlySet<string>;
  /** node id → the predecessor that first reached it (why-path provenance). */
  readonly predecessor: ReadonlyMap<string, Predecessor>;
  /** Present only for a predicate-bounded walk that terminated early. */
  readonly stoppedAt?: string;
}

/**
 * Options for {@link computeReachability}. The default (no options) seeds every
 * production, config, AND test root — the historical single-partition behaviour.
 * A `seedFilter` restricts seeding to the entrypoints it accepts, which is how
 * {@link computePartitionedReachability} builds the three per-partition walks
 * (T5.1) and how zombie-test detection (T5.2) walks from one test root in
 * isolation.
 */
export interface ComputeReachabilityOptions {
  /**
   * When present, only entrypoints for which this returns `true` are seeded.
   * Absent ⇒ seed all production/config/test roots (the pre-M5 behaviour).
   */
  readonly seedFilter?: (entry: EntrypointNode) => boolean;
  /**
   * Effective edge world for this walk. `shared` excludes references that exist
   * only in a language's test compilation; `test` includes shared + test edges.
   * Omitted preserves the historical union-walk behaviour (`test`).
   */
  readonly edgeWorld?: "shared" | "test";
  /** Optional run-local work counter/timer collector. */
  readonly performance?: PerformanceTracker;
  /** Stop after first reaching a matching node (used by bounded existence queries). */
  readonly stopWhen?: (nodeId: string) => boolean;
}

// ---------------------------------------------------------------------------
// Reachability
// ---------------------------------------------------------------------------

/**
 * Compute forward reachability from the seeded entrypoints. With no options the
 * seeds are every production, config, and test root (the union walk used by
 * `why_alive` and the pre-M5 claim path); pass `options.seedFilter` to restrict
 * the seed set (the M5 partition walks and per-test zombie walks).
 */
export function computeReachability(
  graph: IRGraph,
  options?: ComputeReachabilityOptions,
): Reachability {
  options?.performance?.increment("graphWalks");
  const reachableFiles = new Set<string>();
  const surfaceLiveFiles = new Set<string>();
  const reachableSymbols = new Set<string>();
  const entrypointFiles = new Set<string>();
  const productionEntrypointFiles = new Set<string>();
  const predecessor = new Map<string, Predecessor>();
  const queue: string[] = [];
  let stoppedAt: string | undefined;
  const seedFilter = options?.seedFilter;
  const edgeWorld = options?.edgeWorld ?? "test";
  const edgeActive = (edge: IREdge): boolean =>
    edge.partitions === undefined || (edgeWorld === "test" && edge.partitions.includes("test"));

  const setPredIfAbsent = (id: string, pred: Predecessor): void => {
    if (!predecessor.has(id)) predecessor.set(id, pred);
  };

  const markFile = (fileRel: string, pred: Predecessor): void => {
    const id = fileId(fileRel);
    if (!reachableFiles.has(id)) {
      reachableFiles.add(id);
      setPredIfAbsent(id, pred);
      queue.push(id);
      if (stoppedAt === undefined && options?.stopWhen?.(id) === true) stoppedAt = id;
    }
  };

  const markSurfaceLive = (fileRel: string, pred: Predecessor): void => {
    markFile(fileRel, pred);
    const id = fileId(fileRel);
    if (!surfaceLiveFiles.has(id)) {
      surfaceLiveFiles.add(id);
      // Re-enqueue so the file is re-processed in surface-live mode (its
      // `exports` edges only propagate once the whole surface is live).
      queue.push(id);
    }
  };

  const markSymbol = (symId: string, pred: Predecessor): void => {
    if (!reachableSymbols.has(symId)) {
      reachableSymbols.add(symId);
      setPredIfAbsent(symId, pred);
      queue.push(symId);
      if (stoppedAt === undefined && options?.stopWhen?.(symId) === true) stoppedAt = symId;
    }
    const node = graph.getNode(symId);
    if (node?.kind === "symbol") markFile(node.file, pred);
  };

  // The file-rel of an edge's target (file node → its path; symbol node → its
  // file). `null` for a dependency/endpoint/absent target.
  const targetFileRel = (edge: IREdge): string | null => {
    const node = graph.getNode(edge.to);
    if (node === undefined) return null;
    if (node.kind === "file") return node.path;
    if (node.kind === "symbol") return node.file;
    return null;
  };

  /**
   * Resolve `name` from `fileRel` through its recursive `re-export "*"` chain
   * (rule 1). Marks every file walked reachable (a barrel on the live chain).
   * Exactly one origin ⇒ only that symbol lives; zero or many ⇒ keep the whole
   * surface(s) alive (a name is never dropped).
   */
  const resolveNamed = (fileRel: string, name: string, pred: Predecessor): void => {
    const results = new Set<string>();
    const visited = new Set<string>();
    const collect = (fr: string): void => {
      if (visited.has(fr)) return;
      visited.add(fr);
      markFile(fr, pred);
      const direct = graph.getNode(symbolId(fr, name));
      if (direct?.kind === "symbol") results.add(direct.id);
      for (const edge of graph.outEdges(fileId(fr))) {
        if (edge.kind !== "references" || edge.referenceKind !== "re-export" || !edgeActive(edge))
          continue;
        if (edge.name !== "*") continue;
        const next = graph.getNode(edge.to);
        if (next?.kind === "file") collect(next.path);
      }
    };
    collect(fileRel);

    if (results.size === 1) {
      const [only] = results;
      if (only !== undefined) markSymbol(only, pred);
    } else if (results.size === 0) {
      markSurfaceLive(fileRel, pred); // unresolved ⇒ keep whole surface alive
    } else {
      for (const fr of visited) markSurfaceLive(fr, pred); // ambiguous ⇒ keep surfaces alive
    }
  };

  const handleRef = (edge: IREdge, sourceIsSurface: boolean): void => {
    if (!edgeActive(edge)) return;
    const target = graph.getNode(edge.to);
    if (target === undefined || target.kind === "dependency" || target.kind === "endpoint") return;
    const fileRel = targetFileRel(edge);
    if (fileRel === null) return;
    const pred: Predecessor = { via: "edge", edge };

    switch (edge.referenceKind) {
      case "side-effect":
      case "hazard":
        // File is kept alive; its exports stay individually flaggable (rule 2).
        markFile(fileRel, pred);
        return;
      case "dynamic-resolved":
        // A whole-module require/import — the whole surface is consumed (rule 2).
        markSurfaceLive(fileRel, pred);
        return;
      case "runtime-resolved":
      case "safety-root":
      case "static": {
        if (edge.name === undefined || edge.name === "*") {
          markSurfaceLive(fileRel, pred); // namespace / bare type-import
        } else if (target.kind === "symbol") {
          markSymbol(target.id, pred);
        } else {
          resolveNamed(fileRel, edge.name, pred); // name forwarded via a star chain
        }
        return;
      }
      case "re-export": {
        const name = edge.name;
        if (name === undefined || name === "*") {
          // A file-level star re-export forwards the whole surface only when the
          // consuming source is itself surface-live; otherwise a *named* import
          // through it is handled by resolveNamed at the consumption site.
          if (sourceIsSurface) markSurfaceLive(fileRel, pred);
        } else if (target.kind === "symbol") {
          markSymbol(target.id, pred);
        } else {
          resolveNamed(fileRel, name, pred);
        }
        return;
      }
      default:
        return;
    }
  };

  const processFile = (id: string): void => {
    const surface = surfaceLiveFiles.has(id);
    for (const edge of graph.outEdges(id)) {
      if (edge.kind === "exports") {
        if (surface) {
          const sym = graph.getNode(edge.to);
          if (sym?.kind === "symbol") markSymbol(sym.id, { via: "edge", edge });
        }
        continue;
      }
      if (edge.kind === "references") handleRef(edge, surface);
      // `contains` / `consumes` are structural / reserved — not reachability.
    }
  };

  const processSymbol = (id: string): void => {
    // A reachable symbol forwards through:
    //  - its own `re-export` out-edges (a barrel entry that was actually
    //    consumed), and
    //  - its intra-file `static` out-edges to sibling export symbols (emitIR's
    //    flattened intra-file reachability: an alive symbol's body uses a
    //    sibling export, directly or via private module-scope bindings).
    for (const edge of graph.outEdges(id)) {
      if (edge.kind !== "references") continue;
      if (!edgeActive(edge)) continue;
      const target = graph.getNode(edge.to);
      const pred: Predecessor = { via: "edge", edge };
      if (
        edge.referenceKind === "static" ||
        edge.referenceKind === "runtime-resolved" ||
        edge.referenceKind === "safety-root"
      ) {
        // A statically proven or literal-runtime symbol edge keeps that exact
        // target alive (including cross-file Elixir runtime conventions).
        if (target?.kind === "symbol") markSymbol(target.id, pred);
        continue;
      }
      if (edge.referenceKind !== "re-export") continue;
      const name = edge.name;
      if (name === undefined || name === "*") {
        // `import * as ns …; export { ns }` forwards the whole target surface.
        if (target?.kind === "file") markSurfaceLive(target.path, pred);
        else if (target?.kind === "symbol") markSurfaceLive(target.file, pred);
      } else if (target?.kind === "symbol") {
        markSymbol(target.id, pred);
      } else if (target?.kind === "file") {
        resolveNamed(target.path, name, pred);
      }
    }
  };

  // --- seed the (optionally filtered) roots, surface-live --------------------
  // Production roots anchor liveness; config roots (architecture.md §3) keep
  // their reachable code alive and are never flagged; test roots seed the test
  // partition (T5.1). Which of the three are seeded here is governed by
  // `options.seedFilter` — the union of all three (no filter) is the historical
  // walk `why_alive` uses; the single-partition walks are how M5 tells
  // production-alive apart from test-only apart from dead.
  for (const entry of graph.entrypoints()) {
    if (
      entry.entryKind !== "production" &&
      entry.entryKind !== "config" &&
      entry.entryKind !== "test"
    )
      continue;
    if (seedFilter !== undefined && !seedFilter(entry)) continue;
    entrypointFiles.add(fileId(entry.file));
    if (entry.entryKind === "production") productionEntrypointFiles.add(fileId(entry.file));
    const predecessor: Predecessor = {
      via: "entrypoint",
      entrypointId: entry.id,
      file: entry.file,
      reason: entry.reason,
      entryKind: entry.entryKind,
      ...(entry.targetSymbol === undefined ? {} : { targetSymbol: entry.targetSymbol }),
    };
    if (entry.targetSymbol === undefined) {
      markSurfaceLive(entry.file, predecessor);
      continue;
    }
    const target = graph.nodeOfKind("symbol", entry.targetSymbol);
    if (target === undefined || target.file !== entry.file) {
      throw new Error(`entrypoint ${entry.id} targets an absent or foreign symbol`);
    }
    markFile(entry.file, predecessor);
    markSymbol(target.id, predecessor);
  }

  // --- drain -----------------------------------------------------------------
  let queueIndex = 0;
  while (queueIndex < queue.length && stoppedAt === undefined) {
    const id = queue[queueIndex] as string;
    queueIndex += 1;
    const node = graph.getNode(id);
    if (node === undefined) continue;
    if (node.kind === "file") processFile(id);
    else if (node.kind === "symbol") processSymbol(id);
  }

  return {
    reachableFiles,
    surfaceLiveFiles,
    reachableSymbols,
    entrypointFiles,
    productionEntrypointFiles,
    predecessor,
    ...(stoppedAt === undefined ? {} : { stoppedAt }),
  };
}

// ---------------------------------------------------------------------------
// Partitioned reachability (T5.1 — the tier-2 partition rule, architecture §3)
// ---------------------------------------------------------------------------

/**
 * Reachability computed independently from each root partition, so the claim
 * engine can tell three states apart (T5.1):
 *  - **production ∪ config reachable** ⇒ alive, never flagged (config-reachable
 *    is alive by the architecture §3 partition rule and never a claim);
 *  - **test-reachable but NOT production/config-reachable** ⇒ `test-only`;
 *  - **reachable from nothing** ⇒ `unused` (the existing verdict).
 *
 * Each partition is a separate {@link computeReachability} walk seeded by a
 * kind filter. A shared symbol imported from BOTH production and a test is in
 * the production walk, so it is production-alive and never test-only — the
 * classic false-positive trap the partition rule exists to avoid.
 */
export interface PartitionedReachability {
  /** Reachability seeded from production roots only (anchors dead-code claims). */
  readonly production: Reachability;
  /** Reachability seeded from config roots only (alive, never flagged). */
  readonly config: Reachability;
  /**
   * Effective test-world reachability: production/config/test roots over shared
   * plus test-scoped edges. Classification subtracts the two authoritative
   * non-test walks, leaving only test-environment-exclusive subjects.
   */
  readonly test: Reachability;
}

/** Compute the three per-partition reachability walks (T5.1). */
export function computePartitionedReachability(
  graph: IRGraph,
  performance?: PerformanceTracker,
): PartitionedReachability {
  const started = performance?.now();
  const result = {
    production: computeReachability(graph, {
      seedFilter: (e) => e.entryKind === "production",
      edgeWorld: "shared",
      ...(performance === undefined ? {} : { performance }),
    }),
    config: computeReachability(graph, {
      seedFilter: (e) => e.entryKind === "config",
      edgeWorld: "shared",
      ...(performance === undefined ? {} : { performance }),
    }),
    test: computeReachability(graph, {
      // The effective test world includes the production/config baseline plus
      // test roots, then enables test-scoped edges. Classification still checks
      // the independent production/config walks first, so baseline subjects do
      // not become `test-only` merely because this superset reaches them.
      seedFilter: () => true,
      edgeWorld: "test",
      ...(performance === undefined ? {} : { performance }),
    }),
  };
  if (started !== undefined && performance !== undefined) {
    performance.finish("reachability-partitioning", started);
  }
  return result;
}

// ---------------------------------------------------------------------------
// why-path query
// ---------------------------------------------------------------------------

export interface WhyReachable {
  readonly reachable: boolean;
  /** The entrypoint the path terminates at (present iff reachable). */
  readonly entrypoint?: {
    readonly id: string;
    readonly file: string;
    readonly reason: string;
    readonly entryKind: EntrypointKind;
    readonly targetSymbol?: string;
  };
  /**
   * Edges from the entrypoint side down to the queried node, in order. Empty
   * when the node *is* an entrypoint file (it is a root, reached with no edge).
   */
  readonly edges: readonly IREdge[];
}

/**
 * Explain why `nodeId` is reachable: the chain of edges from a production
 * entrypoint down to it, built entirely from the stored predecessor map (no
 * re-analysis). Cycle-guarded. Returns `{ reachable: false }` for a node the
 * walk never reached.
 */
export function whyReachable(
  reach: Reachability,
  nodeId: string,
  performance?: PerformanceTracker,
): WhyReachable {
  const started = performance?.now();
  const first = reach.predecessor.get(nodeId);
  if (first === undefined) {
    if (started !== undefined && performance !== undefined) {
      performance.addDuration("shortest-path-evidence", performance.elapsedSince(started));
    }
    return { reachable: false, edges: [] };
  }

  const edges: IREdge[] = [];
  const guard = new Set<string>([nodeId]);
  let pred: Predecessor | undefined = first;

  while (pred !== undefined) {
    if (pred.via === "entrypoint") {
      const result: WhyReachable = {
        reachable: true,
        entrypoint: {
          id: pred.entrypointId,
          file: pred.file,
          reason: pred.reason,
          entryKind: pred.entryKind,
          ...(pred.targetSymbol === undefined ? {} : { targetSymbol: pred.targetSymbol }),
        },
        edges,
      };
      if (started !== undefined && performance !== undefined) {
        performance.addDuration("shortest-path-evidence", performance.elapsedSince(started));
      }
      return result;
    }
    edges.unshift(pred.edge);
    const from = pred.edge.from;
    if (guard.has(from)) break; // cycle — stop, return what we have
    guard.add(from);
    pred = reach.predecessor.get(from);
  }

  // Reached a node with a predecessor edge but no entrypoint terminal (should
  // not happen for a well-formed seed, but degrade gracefully rather than lie).
  if (started !== undefined && performance !== undefined) {
    performance.addDuration("shortest-path-evidence", performance.elapsedSince(started));
  }
  return { reachable: true, edges };
}
