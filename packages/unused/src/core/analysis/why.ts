/**
 * `whyAlive` — the why-path query (T8.1, docs/phasing.md M8; PRD §5
 * `why_alive`, cli-ux §4). Language-agnostic: it reads the reference-graph
 * {@link IRGraph}, the per-partition {@link PartitionedReachability} predecessor
 * maps, and the already-emitted {@link Claim}s — never a frontend (ADR 0003,
 * dependency-cruiser). It renders nothing; it returns structured data the CLI
 * (`unused why`) and the MCP server (`why_alive`) both project.
 *
 * ## It answers for ANY symbol (PRD §5)
 * The agent workflow is "I'm about to touch this — is it safe?", not "show me
 * only what you already flagged". So `whyAlive` resolves a user-named subject
 * (a bare export name, a `file:name` qualifier, or a file path) and answers
 * whether it is alive and how, for alive AND dead subjects alike:
 *
 *  - **alive** — a shortest path root → … → subject, one per authoritative
 *    world (production first, then config, then effective test — labelled), capped at
 *    three (cli-ux §4, "shortest path(s)"). Every path is rebuilt from the
 *    partition's stored predecessor map — no re-analysis (PRD §8). The primary
 *    `entrypointKind` is the highest-priority partition that reaches it.
 *  - **test-only** — reachable only in the effective test world: still `alive`,
 *    but `testOnly: true` and `entrypointKind: "test"`. Its path preserves the
 *    actual root kind/reason, including production/config roots whose outgoing
 *    edge exists only in the test environment.
 *  - **dead** — reachable from nothing: the verdict, confidence, and evidence of
 *    its claim (when one exists), plus the hazard classes found near the subject
 *    (what the analyzer weighed before calling it dead — cli-ux §4).
 *  - **ambiguous** — a bare name that resolves to several declarations: the
 *    candidate list, so the caller can re-ask qualified.
 *  - **not-found** — nothing in the graph matches the query.
 *
 * Partition priority (production ▸ config ▸ test) mirrors the claim engine's
 * liveness rule (`claims.ts`): production ∪ config reachable is alive and never
 * flagged; effective-test-world-only is `test-only`; unreachable is dead.
 */

import type { Claim, Confidence, DeletionPlanSubject, Evidence, Verdict } from "../claims/types.js";
import { type EntrypointKind, fileId, type IRGraph, symbolId } from "../ir/index.js";
import type { PerformanceTracker } from "./performance.js";
import { type PartitionedReachability, type Reachability, whyReachable } from "./reachability.js";

// ---------------------------------------------------------------------------
// Result shapes (plain, serialisable — no IR node/edge leaks)
// ---------------------------------------------------------------------------

/** One node on a why-path. A symbol hop carries `symbol` + `line`; a file hop neither; the root hop carries `entrypoint`. */
export interface WhyHop {
  /** POSIX, repo-relative path of the file this hop is in. */
  readonly file: string;
  /** 1-based declaration line — present iff this hop is an export symbol. */
  readonly line?: number;
  /** Export name — present iff this hop is an export symbol. */
  readonly symbol?: string;
  /** Present iff this hop is the entrypoint root the path terminates at. */
  readonly entrypoint?: { readonly kind: EntrypointKind; readonly reason: string };
}

/** A shortest reference path from one partition's entrypoint down to the subject. */
export interface WhyPath {
  readonly entrypointKind: EntrypointKind;
  /** The entrypoint's `reason` (which package.json field / convention rooted it). */
  readonly entrypointReason: string;
  /** Root hop first, subject hop last. */
  readonly hops: readonly WhyHop[];
}

/** One disambiguation candidate for a bare name that resolves to several subjects. */
export interface WhyCandidate {
  readonly kind: "export" | "file" | "dependency";
  /** How the caller can re-ask unambiguously: `src/foo.ts:bar` (export) or `src/foo.ts` (file). */
  readonly label: string;
  readonly file: string;
  readonly name?: string;
}

/** The resolved subject a why-answer is about. */
export type WhySubjectRef = DeletionPlanSubject;

/** A hazard class found near a dead subject — what the analyzer weighed before the verdict. */
export interface WhyHazard {
  readonly hazardClass: string;
  readonly detail: string;
  /** `file:line` of the hazard site. */
  readonly site: string;
}

export type WhyAliveResult =
  | { readonly outcome: "not-found"; readonly query: string }
  | {
      readonly outcome: "ambiguous";
      readonly query: string;
      readonly candidates: readonly WhyCandidate[];
    }
  | {
      readonly outcome: "alive";
      readonly query: string;
      readonly subject: WhySubjectRef;
      /** The primary (highest-priority) partition that reaches the subject. */
      readonly entrypointKind: EntrypointKind;
      /** `true` ⇒ reachable only in the effective test world (production/config-dead). */
      readonly testOnly: boolean;
      /** Shortest path per reaching partition, production ▸ config ▸ test, max 3. */
      readonly paths: readonly WhyPath[];
    }
  | {
      readonly outcome: "dead";
      readonly query: string;
      readonly subject: WhySubjectRef;
      /** From the subject's claim, when one exists (a subsumed subject has none). */
      readonly verdict?: Verdict;
      readonly confidence?: Confidence;
      readonly claimId?: string;
      /** The claim's evidence, or a synthesised "unreachable" entry when subsumed. */
      readonly evidence: readonly Evidence[];
      /** Hazard classes found near the subject (empty ⇒ none weighed against it). */
      readonly hazards: readonly WhyHazard[];
    };

export interface WhyAliveInput {
  readonly graph: IRGraph;
  readonly reachability: PartitionedReachability;
  /** The run's emitted claims — the verdict/confidence/evidence source for dead subjects. */
  readonly claims: readonly Claim[];
  /** The user-named subject: a bare export name, `file:name`, or a file path. */
  readonly query: string;
  readonly performance?: PerformanceTracker;
}

/** Partition scan order — mirrors the claim engine's liveness priority. */
const PARTITION_ORDER: readonly (keyof PartitionedReachability)[] = [
  "production",
  "config",
  "test",
];
const PARTITION_KIND: Readonly<Record<keyof PartitionedReachability, EntrypointKind>> = {
  production: "production",
  config: "config",
  test: "test",
};
const MAX_PATHS = 3;
const EVIDENCE_SOURCE = "reference-graph";

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Resolve `input.query` to a subject and explain its liveness (see the module
 * docstring). Pure over its inputs; deterministic.
 */
export function whyAlive(input: WhyAliveInput): WhyAliveResult {
  const { graph, reachability, claims, query } = input;
  const resolution = resolveSubject(graph, claims, query);

  if (resolution.kind === "not-found") return { outcome: "not-found", query };
  if (resolution.kind === "ambiguous") {
    return { outcome: "ambiguous", query, candidates: resolution.candidates };
  }

  const { subject, nodeId } = resolution;
  // Dependency claims come from manifest declarations and import evidence,
  // rather than graph reachability. Return their captured evidence directly.
  if (subject.kind === "dependency") return deadResult(query, subject, graph, claims);
  const isFile = subject.kind === "file";

  // Liveness by partition priority (production ▸ config ▸ test).
  const reaches: Partial<Record<keyof PartitionedReachability, boolean>> = {};
  for (const p of PARTITION_ORDER) reaches[p] = reachableIn(reachability[p], nodeId, isFile);

  const everyAlivePartition = PARTITION_ORDER.filter((p) => reaches[p]);
  if (everyAlivePartition.length === 0) {
    return deadResult(query, subject, graph, claims);
  }

  const productionOrConfig = reaches.production === true || reaches.config === true;
  // The test walk is an effective-world superset seeded with production/config
  // baselines. When an authoritative non-test partition already owns liveness,
  // omit the projected duplicate test path; only test-exclusive subjects cite
  // the test-environment provenance.
  const alivePartitions = productionOrConfig
    ? everyAlivePartition.filter((partition) => partition !== "test")
    : everyAlivePartition;
  const primary = alivePartitions[0] as keyof PartitionedReachability;

  const paths: WhyPath[] = [];
  for (const p of alivePartitions) {
    if (paths.length >= MAX_PATHS) break;
    const path = buildPath(reachability[p], nodeId, graph, PARTITION_KIND[p], input.performance);
    if (path !== undefined) paths.push(path);
  }

  return {
    outcome: "alive",
    query,
    subject,
    entrypointKind: PARTITION_KIND[primary],
    testOnly: !productionOrConfig,
    paths,
  };
}

// ---------------------------------------------------------------------------
// Subject resolution
// ---------------------------------------------------------------------------

type Resolution =
  | { readonly kind: "resolved"; readonly subject: WhySubjectRef; readonly nodeId: string }
  | { readonly kind: "ambiguous"; readonly candidates: readonly WhyCandidate[] }
  | { readonly kind: "not-found" };

/**
 * Resolve a user query to a graph node. Precedence:
 *  1. `file:name` — an explicit qualifier (the file must be a known node).
 *  2. an exact file path.
 *  3. a bare export name — preferring the LOCAL declaration(s) over barrel
 *     re-export entries of the same name; several declarations ⇒ ambiguous.
 *  4. a file path suffix (`currency.ts` → `src/utils/currency.ts`).
 */
function resolveSubject(graph: IRGraph, claims: readonly Claim[], query: string): Resolution {
  const trimmed = query.trim();
  if (trimmed === "") return { kind: "not-found" };

  // Resolve dependency claims before the `file:export` grammar. In a monorepo,
  // candidate labels qualify the package with its workspace or manifest.
  const dependencyCandidates = claims
    .filter((claim) => claim.subject.kind === "dependency")
    .map((claim) => {
      const qualifier = claim.subject.loc.package ?? claim.subject.loc.file;
      return {
        kind: "dependency" as const,
        label: `${qualifier}:${claim.subject.name}`,
        file: claim.subject.loc.file,
        name: claim.subject.name,
      };
    });
  const qualifiedDependency = dependencyCandidates.find((candidate) => candidate.label === trimmed);
  if (qualifiedDependency !== undefined) {
    return {
      kind: "resolved",
      subject: {
        kind: "dependency",
        file: qualifiedDependency.file,
        name: qualifiedDependency.name,
      },
      nodeId: `dependency:${qualifiedDependency.name}`,
    };
  }
  const matchingDependencies = dependencyCandidates.filter(
    (candidate) => candidate.name === trimmed,
  );
  if (matchingDependencies.length === 1) {
    const only = matchingDependencies[0] as (typeof matchingDependencies)[number];
    return {
      kind: "resolved",
      subject: { kind: "dependency", file: only.file, name: only.name },
      nodeId: `dependency:${only.name}`,
    };
  }
  if (matchingDependencies.length > 1) {
    return { kind: "ambiguous", candidates: sortCandidates(matchingDependencies) };
  }

  // (1) qualified `file:name`
  const colon = trimmed.lastIndexOf(":");
  if (colon > 0) {
    const pathPart = normalizePath(trimmed.slice(0, colon));
    const namePart = trimmed.slice(colon + 1);
    if (namePart !== "" && !namePart.includes("/")) {
      const fileNode = graph.getNode(fileId(pathPart));
      if (fileNode?.kind === "file") {
        const symId = symbolId(pathPart, namePart);
        const sym = graph.getNode(symId);
        if (sym?.kind === "symbol") {
          return {
            kind: "resolved",
            subject: {
              kind: "export",
              file: sym.file,
              name: sym.exportedName,
              line: sym.span.startLine,
            },
            nodeId: symId,
          };
        }
        // The file exists but exposes no such export — a nonexistent subject.
        return { kind: "not-found" };
      }
    }
  }

  // (2) exact file path
  const norm = normalizePath(trimmed);
  const fileNode = graph.getNode(fileId(norm));
  if (fileNode?.kind === "file") {
    return { kind: "resolved", subject: { kind: "file", file: norm }, nodeId: fileId(norm) };
  }

  // (3) bare export name
  const local: WhyCandidate[] = [];
  const forwarded: WhyCandidate[] = [];
  const localIds = new Map<string, string>();
  const forwardedIds = new Map<string, string>();
  for (const node of graph.nodes()) {
    if (node.kind !== "symbol" || node.exportedName !== trimmed) continue;
    const cand: WhyCandidate = {
      kind: "export",
      label: `${node.file}:${node.exportedName}`,
      file: node.file,
      name: node.exportedName,
    };
    if (node.local) {
      local.push(cand);
      localIds.set(cand.label, node.id);
    } else {
      forwarded.push(cand);
      forwardedIds.set(cand.label, node.id);
    }
  }
  const nameMatches = local.length > 0 ? local : forwarded;
  const nameIds = local.length > 0 ? localIds : forwardedIds;
  if (nameMatches.length === 1) {
    const only = nameMatches[0] as WhyCandidate;
    if (only.name === undefined) return { kind: "not-found" };
    return {
      kind: "resolved",
      subject: {
        kind: "export",
        file: only.file,
        name: only.name,
        ...symbolLine(graph, nameIds.get(only.label)),
      },
      nodeId: nameIds.get(only.label) as string,
    };
  }
  if (nameMatches.length > 1) {
    return { kind: "ambiguous", candidates: sortCandidates(nameMatches) };
  }

  // (4) file-path suffix
  const suffix: WhyCandidate[] = [];
  const suffixIds = new Map<string, string>();
  for (const node of graph.nodes()) {
    if (node.kind !== "file") continue;
    if (node.path === norm || node.path.endsWith(`/${norm}`)) {
      const cand: WhyCandidate = { kind: "file", label: node.path, file: node.path };
      suffix.push(cand);
      suffixIds.set(cand.label, node.id);
    }
  }
  if (suffix.length === 1) {
    const only = suffix[0] as WhyCandidate;
    return {
      kind: "resolved",
      subject: { kind: "file", file: only.file },
      nodeId: suffixIds.get(only.label) as string,
    };
  }
  if (suffix.length > 1) return { kind: "ambiguous", candidates: sortCandidates(suffix) };

  return { kind: "not-found" };
}

function symbolLine(graph: IRGraph, nodeId: string | undefined): { line?: number } {
  if (nodeId === undefined) return {};
  const node = graph.getNode(nodeId);
  return node?.kind === "symbol" ? { line: node.span.startLine } : {};
}

function sortCandidates(candidates: readonly WhyCandidate[]): WhyCandidate[] {
  return [...candidates].sort((a, b) => (a.label < b.label ? -1 : a.label > b.label ? 1 : 0));
}

// ---------------------------------------------------------------------------
// Path building (from the stored predecessor map — no re-analysis)
// ---------------------------------------------------------------------------

function reachableIn(reach: Reachability, nodeId: string, isFile: boolean): boolean {
  return isFile ? reach.reachableFiles.has(nodeId) : reach.reachableSymbols.has(nodeId);
}

/**
 * Rebuild the shortest path to `nodeId` in one partition. BFS first-reach means
 * the stored predecessor chain IS a shortest (fewest-edge) path. `undefined`
 * when the partition never reached the node, or reached it without an
 * entrypoint terminal (a degrade case — we would rather show no path than lie).
 */
function buildPath(
  reach: Reachability,
  nodeId: string,
  graph: IRGraph,
  _kind: EntrypointKind,
  performance?: PerformanceTracker,
): WhyPath | undefined {
  const wr = whyReachable(reach, nodeId, performance);
  if (!wr.reachable || wr.entrypoint === undefined) return undefined;
  const ep = wr.entrypoint;

  const hops: WhyHop[] = [{ file: ep.file, entrypoint: { kind: ep.entryKind, reason: ep.reason } }];
  for (const edge of wr.edges) {
    if (edge.referenceKind === "runtime-resolved") {
      const previous = hops.at(-1);
      if (previous?.file === edge.site.file) {
        hops[hops.length - 1] = {
          ...previous,
          line: edge.site.span.startLine,
        };
      }
    }
    const to = graph.getNode(edge.to);
    if (to === undefined) continue;
    if (to.kind === "file") hops.push({ file: to.path });
    else if (to.kind === "symbol") {
      hops.push({ file: to.file, line: to.span.startLine, symbol: to.exportedName });
    }
    // dependency / endpoint / entrypoint nodes are not hops on a live path.
  }

  return { entrypointKind: ep.entryKind, entrypointReason: ep.reason, hops: collapseHops(hops) };
}

/**
 * Collapse consecutive hops in the same file into one — a file hop immediately
 * followed by an export hop of that same file (the common entry → its-own-export
 * shape) reads as one line, keeping the more specific symbol/line and the
 * earliest entrypoint annotation.
 */
function collapseHops(hops: readonly WhyHop[]): WhyHop[] {
  const out: WhyHop[] = [];
  for (const hop of hops) {
    const prev = out[out.length - 1];
    if (prev !== undefined && prev.file === hop.file) {
      const symbol = hop.symbol ?? prev.symbol;
      const line = hop.line ?? prev.line;
      const entrypoint = prev.entrypoint ?? hop.entrypoint;
      out[out.length - 1] = {
        file: prev.file,
        ...(symbol !== undefined ? { symbol } : {}),
        ...(line !== undefined ? { line } : {}),
        ...(entrypoint !== undefined ? { entrypoint } : {}),
      };
    } else {
      out.push(hop);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Dead subjects
// ---------------------------------------------------------------------------

function deadResult(
  query: string,
  subject: WhySubjectRef,
  graph: IRGraph,
  claims: readonly Claim[],
): WhyAliveResult {
  const claim = findClaim(claims, subject);
  const fileNodeId = fileId(subject.file);
  // "the hazard classes checked" (cli-ux §4): the hazards that could have kept
  // this subject alive or capped it. Two ways a hazard covers the subject:
  //  - it is attached directly to the subject's file (a `file`/`symbol-set`/
  //    `config-referenced-file` annotation), or
  //  - it is a `directory-subtree` hazard whose static prefix contains the
  //    subject (a computed `import()`/`require()` elsewhere reaching into this
  //    file's directory — the one that capped `src/mods/alpha.ts` to medium
  //    even though its site is the importer, not the subject).
  const hazards: WhyHazard[] = graph
    .hazards()
    .filter(
      (h) =>
        h.file === fileNodeId ||
        (h.subtreePrefix !== undefined && subject.file.startsWith(h.subtreePrefix)),
    )
    .map((h) => ({
      hazardClass: h.hazardClass,
      detail: h.detail,
      site: `${h.site.file}:${h.site.span.startLine}`,
    }));

  const evidence: readonly Evidence[] =
    claim !== undefined
      ? claim.evidence
      : [
          {
            type: "static-reachability",
            detail: `${subjectLabel(subject)} is unreachable from any production, config, or test entrypoint; it carries no standalone claim (subsumed by a file-level claim, or referenced only by other dead code).`,
            source: EVIDENCE_SOURCE,
          },
        ];

  return {
    outcome: "dead",
    query,
    subject,
    ...(claim !== undefined
      ? { verdict: claim.verdict, confidence: claim.confidence, claimId: claim.id }
      : {}),
    evidence,
    hazards,
  };
}

function findClaim(claims: readonly Claim[], subject: WhySubjectRef): Claim | undefined {
  return claims.find((c) => {
    if (subject.kind === "file")
      return c.subject.kind === "file" && c.subject.loc.file === subject.file;
    if (subject.kind === "dependency") {
      return (
        c.subject.kind === "dependency" &&
        c.subject.name === subject.name &&
        c.subject.loc.file === subject.file
      );
    }
    return (
      c.subject.kind === "export" &&
      c.subject.name === subject.name &&
      c.subject.loc.file === subject.file
    );
  });
}

/** A terse subject label for synthesised evidence text. */
function subjectLabel(subject: WhySubjectRef): string {
  if (subject.kind === "file") return `\`${subject.file}\``;
  return `\`${subject.name}\``;
}

function normalizePath(p: string): string {
  let s = p.trim().replace(/\\/g, "/");
  while (s.startsWith("./")) s = s.slice(2);
  return s;
}
