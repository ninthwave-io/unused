/**
 * Claim emission from reachability (T2.4 for the base walk; T3.1 for the hazard
 * registry; T5.1/T5.2 for the tier-2 partition). Language-agnostic: IR +
 * {@link PartitionedReachability} in, {@link Claim}s out. Imports only
 * `core/ir`, `core/claims`, the hazard registry, and its sibling
 * `reachability.ts` — never a frontend.
 *
 * ## Base emission
 * `unused` verdicts for `export` and `file` subjects. Absent any hazard a
 * subject is claimed at `high`; a hazard whose registry scope covers it caps its
 * confidence (`medium`/`low`) or suppresses it (`no-claim`). Real per-subject
 * confidence *assignment* (below the cap) is T3.3; here the base confidence is
 * `high` and the cap is the only thing that can lower it.
 *
 * ## Tier-2 partition (T5.1/T5.2)
 * Reachability arrives as authoritative production/config worlds plus an
 * effective test world. A subject reached by production/config is alive (never
 * flagged). A subject reached only in the test world is `test-only`
 * (export/file/dependency); a test file exercising only test-only/dead code is a
 * zombie `test` claim. A subject reachable from nothing stays `unused`. The
 * `test-only` verdict runs through the shared hazard-cap machinery using only
 * production/config effects (`high` when clean); a test-only hazard cannot
 * undermine that verdict. Its evidence names the actual effective-world root,
 * which may be production/config when a test-scoped edge leaves that root.
 *
 * ## Hazard scoping (T3.1 — replaces M2's blanket whole-project suppression)
 * Each hazard annotation is looked up in the registry (`hazard-registry.ts`),
 * which fixes its **activation**, **scope**, and **confidence cap**. The
 * whole-project suppression M2 applied to any computed `import()`/`require()`
 * is gone: those annotations activate only when their carrier is reachable,
 * then cap only the plausibly-reachable subtree (at `medium`); everything
 * outside it stays claimable at `high`.
 *
 *  - **`computed-dynamic-import` / `computed-require`** (`directory-subtree`,
 *    cap `medium`, carrier-reachable) — while the importer is reachable from a
 *    production/config/test root or an explicitly propagated dynamic target, every file
 *    whose path starts with the annotation's `subtreePrefix` (the template's
 *    static prefix; the importer's whole package when there is none) is capped;
 *    the file claim AND any dead-export claim of an in-scope file. An indexed
 *    carrier queue closes activation to a fixed point; an unreachable importer
 *    outside that closure cannot run, so its outgoing hazard caps nothing.
 *  - **`config-referenced-file`** (`file`, cap `medium`) — the referenced file
 *    (and its exports) is capped, not suppressed: a config-loaded file is
 *    probably-dead, not proven-dead.
 *  - **`computed-cjs-exports`** (`symbol-set`, cap `medium`) — only the file's
 *    **export** claims are capped; its own file liveness is unaffected.
 *  - **`parse-error`** (`file`, cap `no-claim`) — the unparseable file is never
 *    claimed (its references cannot be seen); importers' unresolved names are
 *    already kept alive by reachability.
 *  - **`unresolvable-import` / `outside-project` / `internal-declaration` /
 *    `declaration-companion` / `import-equals` / `export-assignment`** (`none`)
 *    — provenance only; they scope no claim (keep-alive edges are handled by
 *    reachability; the importing file's unrelated dead siblings stay claimable).
 *  - **An unregistered class** — project-scope no-claim + a loud internal
 *    warning (the CLAUDE.md degrade-toward-alive invariant); never silent.
 *  - Declaration files (`.d.ts`) are never claimed (no runtime body).
 *  - **Suppressed symbols** (`/* unused:ignore *\/`) are still claimed, carrying
 *    their `suppression` object, and counted (PRD §4/§6).
 *
 * A capped claim's evidence `detail` gains a note citing the hazard class and
 * its site (`…; capped medium: <why> (src/loader.ts:12)`), so the report can
 * explain the downgrade from stored provenance (PRD §8).
 *
 * ## File vs export granularity
 * A file with no inbound reference edge (to the file or any symbol it exposes),
 * that is not an entrypoint, not a declaration file, and not suppressed ⇒ a
 * `file` claim; its exports are then subsumed (not separately claimed), and the
 * file span is counted once toward `estDeletableLoc`. A dead export in an
 * otherwise-reachable file ⇒ an `export` claim.
 */

import { computeClaimId } from "../claims/id.js";
import type {
  Claim,
  Confidence,
  DependencyClaim,
  DependencySubject,
  Evidence,
  EvidenceType,
  ExportClaim,
  ExportSubject,
  FileClaim,
  FileSubject,
  Loc,
  Provenance,
  Span,
  Suppression,
  TestClaim,
  TestSubject,
} from "../claims/types.js";
import { fileId, type HazardWorld, type IRGraph, type IRNode } from "../ir/index.js";
import {
  type AppliedHazardCap,
  evaluateHazards,
  type HazardEvaluation,
} from "./hazard-evaluation.js";
import type { ConfidenceCap } from "./hazard-registry.js";
import type { PerformanceTracker } from "./performance.js";
import {
  computeReachability,
  type PartitionedReachability,
  type Reachability,
  whyReachable,
} from "./reachability.js";

/** The claim verdicts M5 emits for export/file/dependency subjects. */
type LivenessVerdict = "unused" | "test-only";

const UNUSED_CLAIM_WORLDS = ["production", "config", "test"] as const;
const TEST_ONLY_CLAIM_WORLDS = ["production", "config"] as const;
const ZOMBIE_TEST_CLAIM_WORLDS = ["test"] as const;

const EVIDENCE_SOURCE = "reference-graph";

/** Shared empty set for the optional self-dependency exemption (avoids per-call allocation). */
const EMPTY_ID_SET: ReadonlySet<string> = new Set<string>();

/** A confidence cap plus the hazard site that produced it, for the evidence note. */
type AppliedCap = AppliedHazardCap;

/** Non-suppressing caps map to their claim confidence; `no-claim` handled separately. */
const CAP_CONFIDENCE: Readonly<Record<Exclude<ConfidenceCap, "no-claim">, Confidence>> = {
  medium: "medium",
  low: "low",
};

/**
 * One declared dependency the frontend has already judged **claimable unused**
 * (T4.1, phasing.md M4). Dependency liveness — declared vs. referenced package
 * names, `@types` pairing, bin-only tools, the JSX runtime, `workspace:`
 * siblings, config/scripts-named packages — is ecosystem-specific, so the
 * TS/JS frontend (`frontends/ts/dependencies.ts`) resolves it and passes core
 * only the leftover unused declarations. Core owns just the claim construction:
 * the stable id, the subject, and the project-scope confidence cap (below), so
 * dependency claims read identically to export/file claims and respect the same
 * hazard plumbing.
 */
export interface DependencyClaimInput {
  /** The declared package name (`lodash`, `@scope/pkg`). */
  readonly packageName: string;
  /** The declaring `package.json` location (file + span + owning workspace). */
  readonly loc: Loc;
  /**
   * `unused` (referenced by nothing) or `test-only` (referenced only from
   * test-partition files — T5.2 point 4). The frontend classifies this, since
   * dependency liveness is ecosystem-specific; absent ⇒ `unused` (pre-M5).
   */
  readonly verdict?: LivenessVerdict;
}

export interface EmitClaimsInput {
  readonly graph: IRGraph;
  /**
   * Authoritative production/config walks plus the effective test world (T5.1).
   * Production or config reachability is alive; effective-test-world-only is
   * `test-only`; unreachable in all three is `unused`. Built by
   * `computePartitionedReachability`.
   */
  readonly reachability: PartitionedReachability;
  /** Provenance stamped on every claim (analyzer / version / generatedAt). */
  readonly provenance: Provenance;
  /**
   * file node id → total line count, for `file`-claim spans. Supplied by the
   * frontend (core does no file I/O). Missing ⇒ a `[1, 1]` placeholder.
   */
  readonly fileLineCounts?: ReadonlyMap<string, number>;
  /** Claim-id language slot (empty/absent ⇒ `ts`, ADR 0006). */
  readonly language?: string;
  /**
   * Repository-relative files analyzed by this frontend fragment. When set,
   * claim emission and hazard activation are isolated to this scope while
   * liveness still comes from the shared repository reachability result.
   * Absent preserves the historical single-graph behaviour.
   */
  readonly analysisFiles?: ReadonlySet<string>;
  /**
   * Subset of `analysisFiles` eligible to receive file, export, and test
   * claims. Frontends use this for generated/vendor/config exclusions without
   * removing those files from the graph or weakening reachability precision.
   */
  readonly claimableFiles?: ReadonlySet<string>;
  /**
   * Declared dependencies the frontend judged unused (T4.1). Each becomes a
   * `dependency`/`unused` claim, at `high` unless a **project-scope** hazard
   * caps the workspace project-wide (the existing cap plumbing —
   * `unresolvable-entrypoint-target`, a whole-package `project-references`, or a
   * repo-root computed import — applies to dependency claims exactly as to file
   * claims). Absent/empty ⇒ no dependency claims (byte-identical to pre-M4).
   */
  readonly dependencies?: readonly DependencyClaimInput[];
  /**
   * Dependency node ids of the analyzed project's OWN package name(s) (T5 zombie
   * hardening). A test that imports the package by its own name (`require('fastify')`
   * inside fastify) resolves **external** — a resolver limitation — so its edge to
   * its own production code is severed and it would look like it exercises nothing.
   * A test whose reach references any of these is exempt from zombie classification
   * (degrade toward alive): we cannot see what production code it really runs.
   * Absent/empty ⇒ no self-name exemption (byte-identical to pre-T5.5).
   */
  readonly selfDependencyIds?: ReadonlySet<string>;
  /**
   * The run's workspace-unit boundaries (root-relative POSIX directories; `""`
   * is the root package), so a WHOLE-PACKAGE hazard cap — a `project`-scope
   * hazard, or a `directory-subtree` hazard with no static prefix (a computed
   * `require`/`import()` with an opaque argument) — scopes to the OWNING
   * workspace unit of the hazard site, never the whole monorepo (reference-codebase
   * smoke: a single computed `require` in a vendored top-level file was capping
   * every claim across all 18 packages). A file is owned by the deepest unit
   * whose directory contains it; a file under no member (a vendored top-level
   * file) is owned by the root unit. Absent/empty ⇒ a single root unit
   * (`[{ rootRelDir: "" }]`) — every whole-package cap covers the whole run,
   * byte-identical to the pre-fix single-graph behaviour (and to single-package
   * analysis, where there is only ever one unit).
   */
  readonly units?: readonly { readonly rootRelDir: string }[];
  /** Optional run-local phase/counter collector. */
  readonly performance?: PerformanceTracker;
  /** Precomputed once for this graph/fragment and reusable by why/deletion planning. */
  readonly hazardEvaluation?: HazardEvaluation;
  /** Graph-wide immutable indexes shared by repository fragment emissions. */
  readonly context?: ClaimEmissionContext;
}

export interface ClaimEmissionContext {
  readonly graph: IRGraph;
  readonly claimNodes: readonly IRNode[];
  readonly claimNodesByFile: ReadonlyMap<string, readonly IRNode[]>;
  readonly entrypoints: ReturnType<IRGraph["entrypoints"]>;
  readonly testEntrypointsByFile: ReadonlyMap<
    string,
    readonly ReturnType<IRGraph["entrypoints"]>[number][]
  >;
  readonly entrypointFiles: ReadonlySet<string>;
  readonly surfaceEntrypointFiles: ReadonlySet<string>;
  readonly exportedSymbolIds: ReadonlySet<string>;
  readonly hazardsBySiteFile: ReadonlyMap<
    string,
    readonly ReturnType<IRGraph["hazards"]>[number][]
  >;
}

/** Build immutable graph indexes once for one or many claim scopes. */
export function createClaimEmissionContext(graph: IRGraph): ClaimEmissionContext {
  const claimNodes: IRNode[] = [];
  const claimNodesByFile = new Map<string, IRNode[]>();
  for (const node of graph.nodes()) {
    if (node.kind !== "file" && node.kind !== "symbol") continue;
    claimNodes.push(node);
    addToList(claimNodesByFile, node.kind === "file" ? node.path : node.file, node);
  }
  const entrypoints = graph.entrypoints();
  const testEntrypointsByFile = new Map<string, ReturnType<IRGraph["entrypoints"]>[number][]>();
  const entrypointFiles = new Set<string>();
  const surfaceEntrypointFiles = new Set<string>();
  for (const entry of entrypoints) {
    entrypointFiles.add(fileId(entry.file));
    if (entry.targetSymbol === undefined) surfaceEntrypointFiles.add(fileId(entry.file));
    if (entry.entryKind === "test") addToList(testEntrypointsByFile, entry.file, entry);
  }
  const exportedSymbolIds = new Set<string>();
  for (const edge of graph.edges()) {
    if (edge.kind === "exports") exportedSymbolIds.add(edge.to);
  }
  const hazardsBySiteFile = new Map<string, ReturnType<IRGraph["hazards"]>[number][]>();
  for (const hazard of graph.hazards()) addToList(hazardsBySiteFile, hazard.site.file, hazard);
  return {
    graph,
    claimNodes,
    claimNodesByFile,
    entrypoints,
    testEntrypointsByFile,
    entrypointFiles,
    surfaceEntrypointFiles,
    exportedSymbolIds,
    hazardsBySiteFile,
  };
}

/**
 * How each non-entrypoint, non-declaration file sits relative to the three root
 * partitions (T5.1):
 *  - `alive`     — production ∪ config reachable ⇒ never a file claim; its dead
 *                  exports are still individually claimable in the symbol pass.
 *  - `test-only` — effective-test-world reachable but NOT production/config
 *                  reachable ⇒ one whole-file claim, subsuming its exports.
 *  - `unused`    — reachable from nothing, including a file referenced only by
 *                  other unreachable code ⇒ a whole-file `unused` claim,
 *                  subsuming its exports (ADR 0012 complete reachability).
 */
type FileClass = "alive" | "test-only" | "unused";

/**
 * Emit the claim set for one project: deterministic, sorted by claim id. Returns
 * `[]` when there is no production root or an unscoped hazard forces whole-
 * project keep-alive.
 *
 * M5 partitions liveness: a subject reachable only in the effective test world
 * is `test-only` (export/file/dependency), a test file exercising only
 * test-only/dead code is a zombie `test` claim, and code reachable in production
 * or config is alive as before. The hazard-cap machinery is applied identically
 * to every verdict.
 */
export function emitClaims(input: EmitClaimsInput): Claim[] {
  const claimStarted = input.performance?.now();
  const hazardBefore = input.performance?.phaseTotal("hazard-activation") ?? 0;
  const evidenceBefore = input.performance?.phaseTotal("shortest-path-evidence") ?? 0;
  const { graph, reachability } = input;
  const { production, config, test } = reachability;
  const context =
    input.context?.graph === graph ? input.context : createClaimEmissionContext(graph);
  const scopedClaimNodes = claimNodesForScope(context, input.analysisFiles);

  // --- no production entrypoint ⇒ nothing anchors liveness -------------------
  // With zero production roots the reference graph has no basis to prove ANY
  // subject dead (a library with no `main`/`exports`/`bin` and no fallback
  // entry, or a project the frontend could not root). Claiming here would flag
  // the whole codebase — the entrypoint-detection contract's "no confident
  // root" case. This also gates `test-only`: without a production baseline we
  // cannot tell "reachable only in the test world" from "the whole project". Emit
  // nothing; the caller surfaces "no entrypoints detected".
  if (!hasProductionAnchor(production, input.analysisFiles)) return [];

  // --- registry-driven hazard caps ------------------------------------------
  // Caps are indexed by subject and world. Claim verdicts select only the
  // worlds that could invalidate that verdict; deletion planning deliberately
  // asks the same evaluation for every world.
  const caps =
    input.hazardEvaluation?.graph === graph
      ? input.hazardEvaluation
      : evaluateHazards({
          graph,
          reachability,
          ...(input.units === undefined ? {} : { units: input.units }),
          ...(input.analysisFiles === undefined ? {} : { analysisFiles: input.analysisFiles }),
          ...(input.dependencies === undefined ? {} : { dependencies: input.dependencies }),
          ...(input.performance === undefined ? {} : { performance: input.performance }),
        });
  if (caps.projectNoClaim) {
    input.performance?.set("claims", 0);
    finishClaimPerformance(input.performance, claimStarted, hazardBefore, evidenceBefore);
    return [];
  }

  // Every root file (production, config, or test) — never itself flagged as a
  // file or export; a test root can only surface as a zombie `test` claim.
  const { entrypointFiles, surfaceEntrypointFiles, exportedSymbolIds } = context;

  const aliveFile = (id: string): boolean =>
    production.reachableFiles.has(id) || config.reachableFiles.has(id);
  const aliveSymbol = (id: string): boolean =>
    production.reachableSymbols.has(id) || config.reachableSymbols.has(id);

  // Per-file classification, precomputed so the symbol pass can subsume exports
  // by their file's class regardless of node iteration order.
  const fileClass = new Map<string, FileClass>();
  for (const node of scopedClaimNodes) {
    if (node.kind !== "file") continue;
    if (!isInScope(node.path, input.analysisFiles)) continue;
    if (isDeclarationFile(node.path)) continue; // ambient/declaration — never classified/claimed
    if (entrypointFiles.has(node.id)) continue; // a root — never a file/export claim
    if (aliveFile(node.id)) fileClass.set(node.id, "alive");
    else if (test.reachableFiles.has(node.id)) fileClass.set(node.id, "test-only");
    else fileClass.set(node.id, "unused");
  }

  const claims: Claim[] = [];

  for (const node of scopedClaimNodes) {
    if (node.kind === "file") {
      if (!isInScope(node.path, input.claimableFiles)) continue;
      const cls = fileClass.get(node.id);
      if (cls === undefined || cls === "alive") continue;
      const applied = caps.capForSubject({ kind: "file", file: node.path }, claimWorlds(cls));
      if (applied?.cap === "no-claim") continue; // e.g. an unparseable file
      const confidence = confidenceForCap(applied);
      const span = spanForFile(node.id, input.fileLineCounts);
      if (cls === "test-only") {
        claims.push(
          buildFileClaim(
            node.path,
            span,
            input,
            confidence,
            noteForCap(applied),
            "test-only",
            testWorldRootFor(test, node.id, input.performance),
          ),
        );
      } else {
        claims.push(
          buildFileClaim(node.path, span, input, confidence, noteForCap(applied), "unused"),
        );
      }
    } else if (node.kind === "symbol") {
      if (!isInScope(node.file, input.claimableFiles)) continue;
      if (!node.local) continue; // forwarded (re-export) symbols are not declarations
      if (isDeclarationFile(node.file)) continue;
      const fileNodeId = fileId(node.file);
      // Only a symbol in an alive file is individually claimable: a test-only /
      // unused file already emitted one whole-file claim that subsumes it; a
      // entrypoint / declaration files yield no export claim.
      // Entrypoint files may contain private, contains-only symbols (Rust crate
      // roots). Public/exported entrypoint symbols are already surface-live;
      // an unreachable private symbol remains claimable.
      if (fileClass.get(fileNodeId) !== "alive" && !entrypointFiles.has(fileNodeId)) continue;
      if (surfaceEntrypointFiles.has(fileNodeId) && exportedSymbolIds.has(node.id)) continue;
      if (aliveSymbol(node.id)) continue; // used from production or config
      const verdict = test.reachableSymbols.has(node.id) ? "test-only" : "unused";
      const applied = caps.capForSubject(
        { kind: "export", file: node.file, name: node.exportedName },
        claimWorlds(verdict),
      );
      if (applied?.cap === "no-claim") continue;
      const confidence = confidenceForCap(applied);
      const span: Span = [node.span.startLine, node.span.endLine];
      const suppression = suppressionOf(node.suppression, node.file, node.span.startLine);
      // A dead export in an alive file: `test-only` when a test still reaches it,
      // otherwise plainly `unused`.
      if (verdict === "test-only") {
        claims.push(
          buildExportClaim(
            node.exportedName,
            node.file,
            span,
            input,
            suppression,
            confidence,
            noteForCap(applied),
            "test-only",
            testWorldRootFor(test, node.id, input.performance),
          ),
        );
      } else {
        claims.push(
          buildExportClaim(
            node.exportedName,
            node.file,
            span,
            input,
            suppression,
            confidence,
            noteForCap(applied),
            "unused",
          ),
        );
      }
    }
  }

  // --- zombie tests (T5.2 point 3) ------------------------------------------
  // A test file that exercises nothing production-alive is a zombie: everything
  // it reaches is itself test-only or dead. Conservative — if it reaches ANY
  // production/config-reachable subject it is kept (not a zombie).
  claims.push(...emitZombieTestClaims(graph, reachability, caps, input, context));

  // --- dependency claims (T4.1, T5.2 point 4) -------------------------------
  // The frontend already excluded referenced / kept-alive dependencies and
  // tagged each leftover `unused` or `test-only` (referenced only from tests).
  // Confidence is `high` unless a project-wide hazard caps the whole workspace
  // (the same `projectCap` a file claim in this project would carry) — deps are
  // a project-level subject, unaffected by per-file/symbol-set hazards. The
  // entrypoint / no-claim guards above also gate these.
  for (const dep of input.dependencies ?? []) {
    // A dependency claim carries its OWNING workspace unit's whole-package cap
    // (its declaring package.json's unit) — not a run-wide cap: a computed
    // require in one package must not downgrade a sibling package's dependency
    // claims. `dep.loc.file` is the declaring package.json's path.
    const depCap = caps.capForSubject(
      { kind: "dependency", file: dep.loc.file, name: dep.packageName },
      claimWorlds(dep.verdict ?? "unused"),
    );
    const confidence = confidenceForCap(depCap);
    claims.push(buildDependencyClaim(dep, input, confidence, noteForCap(depCap)));
  }

  claims.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  input.performance?.set("claims", claims.length);
  finishClaimPerformance(input.performance, claimStarted, hazardBefore, evidenceBefore);
  return claims;
}

function isInScope(file: string, scope: ReadonlySet<string> | undefined): boolean {
  return scope === undefined || scope.has(file);
}

/**
 * A scoped fragment needs evidence that production can enter it. Its own
 * production root is sufficient; so is any file made production-reachable by
 * an inbound cross-language bridge. An unrelated root elsewhere in the merged
 * graph is deliberately insufficient.
 */
function hasProductionAnchor(
  production: Reachability,
  analysisFiles: ReadonlySet<string> | undefined,
): boolean {
  if (analysisFiles === undefined) return production.productionEntrypointFiles.size > 0;
  for (const file of analysisFiles) {
    const id = fileId(file);
    if (production.productionEntrypointFiles.has(id) || production.reachableFiles.has(id)) {
      return true;
    }
  }
  return false;
}

function claimNodesForScope(
  context: ClaimEmissionContext,
  analysisFiles: ReadonlySet<string> | undefined,
): readonly IRNode[] {
  if (analysisFiles === undefined) return context.claimNodes;
  return [...analysisFiles].flatMap((file) => context.claimNodesByFile.get(file) ?? []);
}

function addToList<T>(map: Map<string, T[]>, key: string, value: T): void {
  const values = map.get(key);
  if (values === undefined) map.set(key, [value]);
  else values.push(value);
}

function finishClaimPerformance(
  performance: PerformanceTracker | undefined,
  started: number | undefined,
  hazardBefore: number,
  evidenceBefore: number,
): void {
  if (started !== undefined && performance !== undefined) {
    const total = performance.elapsedSince(started);
    const nestedHazard = performance.phaseTotal("hazard-activation") - hazardBefore;
    const nestedEvidence = performance.phaseTotal("shortest-path-evidence") - evidenceBefore;
    performance.addDuration(
      "claim-generation",
      Math.max(0, total - nestedHazard - nestedEvidence),
      true,
    );
    if (nestedEvidence > 0) {
      performance.emitAccumulated("shortest-path-evidence", nestedEvidence);
    }
  }
}

function claimWorlds(verdict: LivenessVerdict): readonly HazardWorld[] {
  return verdict === "test-only" ? TEST_ONLY_CLAIM_WORLDS : UNUSED_CLAIM_WORLDS;
}

/** Base confidence is `high`; a cap can only lower it (T3.3 assigns below the cap). */
function confidenceForCap(applied: AppliedCap | undefined): Confidence {
  if (applied === undefined || applied.cap === "no-claim") return "high";
  return CAP_CONFIDENCE[applied.cap];
}

/** The evidence-detail suffix explaining a downgrade, from the hazard site. */
function noteForCap(applied: AppliedCap | undefined): string | undefined {
  if (applied === undefined || applied.cap === "no-claim") return undefined;
  return `; capped ${applied.cap}: ${applied.detail} (${applied.siteFile}:${applied.siteLine})`;
}

// ---------------------------------------------------------------------------
// Zombie tests + test-partition provenance (T5.2)
// ---------------------------------------------------------------------------

/**
 * The effective test-world root keeping `nodeId` alive, for a `test-only`
 * claim's evidence detail — read from the test world's stored predecessor map
 * (no re-analysis, PRD §8). This may be a real production/config root whose
 * outgoing test-scoped edge exists only under test compilation. `undefined` if
 * the node is not test-reachable (degrade gracefully rather than lie).
 */
function testWorldRootFor(
  test: Reachability,
  nodeId: string,
  performance?: PerformanceTracker,
): string | undefined {
  return whyReachable(test, nodeId, performance).entrypoint?.file;
}

/**
 * Emit a `test`/`test-only` claim for every zombie test: a test file whose
 * forward reach (walked from that root alone) contains no production- or config-
 * reachable subject — i.e. it exercises only test-only or dead code (T5.2 point
 * 3). Reaching ANY alive subject makes it a real test, never a zombie
 * (conservative). Confidence flows through the same file-scoped hazard cap a
 * file claim on that path would carry (`high` when clean).
 */
function emitZombieTestClaims(
  graph: IRGraph,
  reachability: PartitionedReachability,
  hazards: HazardEvaluation,
  input: EmitClaimsInput,
  context: ClaimEmissionContext,
): TestClaim[] {
  const { production, config } = reachability;
  // The production ∪ config alive surface (files + symbols): reaching any of
  // these disqualifies a test from being a zombie.
  const isAliveNode = (id: string): boolean =>
    production.reachableFiles.has(id) ||
    production.reachableSymbols.has(id) ||
    config.reachableFiles.has(id) ||
    config.reachableSymbols.has(id);

  // --- zombie hardening (T5.5): exempt tests whose visible reach can't be
  // trusted complete (degrade toward alive) ----------------------------------
  // (a) an `unresolvable-import` hazard hides what a file really pulls in; and
  // (b) a self-name import of the analyzed package resolves *external* (resolver
  //     limitation), severing the test's edge to its own production code. Either
  //     way we cannot prove the test exercises nothing production-alive, so it is
  //     NOT a confident zombie — no wrong zombie survives these shapes.
  const filesWithUnresolvableImport = new Set<string>();
  const scopedHazards =
    input.analysisFiles === undefined
      ? [...context.hazardsBySiteFile.values()].flat()
      : [...input.analysisFiles].flatMap((file) => context.hazardsBySiteFile.get(file) ?? []);
  for (const hazard of scopedHazards) {
    if (hazard.hazardClass === "unresolvable-import") {
      filesWithUnresolvableImport.add(hazard.file);
    }
  }
  const selfDeps = input.selfDependencyIds ?? EMPTY_ID_SET;
  const referencesSelfPackage = (fileNodeId: string): boolean => {
    if (selfDeps.size === 0) return false;
    for (const edge of graph.outEdges(fileNodeId)) {
      if (edge.kind === "references" && selfDeps.has(edge.to)) return true;
    }
    return false;
  };
  const reachIsUncertain = (testFileId: string, reachableFiles: ReadonlySet<string>): boolean => {
    if (filesWithUnresolvableImport.has(testFileId) || referencesSelfPackage(testFileId))
      return true;
    for (const fid of reachableFiles) {
      if (filesWithUnresolvableImport.has(fid) || referencesSelfPackage(fid)) return true;
    }
    return false;
  };

  const claims: TestClaim[] = [];
  const testEntrypoints =
    input.analysisFiles === undefined
      ? context.entrypoints.filter((entry) => entry.entryKind === "test")
      : [...input.analysisFiles].flatMap((file) => context.testEntrypointsByFile.get(file) ?? []);
  for (const entry of testEntrypoints) {
    if (!isInScope(entry.file, input.claimableFiles)) continue;
    const testFileId = fileId(entry.file);
    if (graph.outEdges(testFileId).length === 0) continue; // imports nothing ⇒ not a zombie
    if (filesWithUnresolvableImport.has(testFileId) || referencesSelfPackage(testFileId)) continue;

    // Walk only until this test proves non-zombie or uncertain. The previous
    // implementation completed a whole-graph walk for every test root, making
    // claim generation O(test roots × graph) even though a normal test usually
    // reaches production-alive code in its first few hops.
    const reach = computeReachability(graph, {
      seedFilter: (e) => e.id === entry.id,
      edgeWorld: "test",
      ...(input.performance === undefined ? {} : { performance: input.performance }),
      stopWhen: (nodeId) => {
        if (nodeId === testFileId) return false;
        if (isAliveNode(nodeId)) return true;
        const node = graph.getNode(nodeId);
        return (
          node?.kind === "file" &&
          (filesWithUnresolvableImport.has(nodeId) || referencesSelfPackage(nodeId))
        );
      },
    });
    if (reach.stoppedAt !== undefined) continue;
    if (reachIsUncertain(testFileId, reach.reachableFiles)) continue; // can't see the real reach
    let reachedOther = false;
    let reachesAlive = false;
    for (const fid of reach.reachableFiles) {
      if (fid === testFileId) continue; // its own file is the seed, not "exercised"
      reachedOther = true;
      if (isAliveNode(fid)) {
        reachesAlive = true;
        break;
      }
    }
    if (!reachesAlive) {
      for (const sid of reach.reachableSymbols) {
        const sym = graph.getNode(sid);
        if (sym?.kind === "symbol" && sym.file === entry.file) continue; // its own export
        reachedOther = true;
        if (isAliveNode(sid)) {
          reachesAlive = true;
          break;
        }
      }
    }
    if (!reachedOther || reachesAlive) continue;

    const applied = hazards.capForSubject(
      { kind: "file", file: entry.file },
      ZOMBIE_TEST_CLAIM_WORLDS,
    );
    if (applied?.cap === "no-claim") continue; // e.g. an unparseable test file
    claims.push(
      buildTestClaim(
        entry.file,
        spanForFile(testFileId, input.fileLineCounts),
        input,
        confidenceForCap(applied),
        noteForCap(applied),
      ),
    );
  }
  return claims;
}

// ---------------------------------------------------------------------------
// Claim builders
// ---------------------------------------------------------------------------

/** Evidence for a `unused` vs `test-only` claim on a `subjectRef` (a name or path). */
function buildLivenessEvidence(
  verdict: LivenessVerdict,
  subjectRef: string,
  capNote: string | undefined,
  testEntry: string | undefined,
): Evidence {
  const type: EvidenceType = verdict === "test-only" ? "test-only" : "static-reachability";
  const detail =
    verdict === "test-only"
      ? `${subjectRef} is reachable only in the test environment from root ${testEntry !== undefined ? `\`${testEntry}\`` : "(s)"}; the production and config worlds do not reach it.${capNote ?? ""}`
      : `0 inbound references to ${subjectRef} from any production entrypoint in the reference graph.${capNote ?? ""}`;
  return { type, detail, source: EVIDENCE_SOURCE };
}

function buildExportClaim(
  name: string,
  file: string,
  span: Span,
  input: EmitClaimsInput,
  suppression: Suppression | undefined,
  confidence: Confidence,
  capNote: string | undefined,
  verdict: LivenessVerdict,
  testEntry?: string,
): ExportClaim {
  const subject: ExportSubject = { kind: "export", name, loc: { file, span } };
  const evidence = buildLivenessEvidence(verdict, `\`${name}\``, capNote, testEntry);
  const id = computeClaimId(subject, langOpt(input));
  return {
    id,
    language: claimLanguage(input),
    subject,
    verdict,
    confidence,
    evidence: [evidence],
    provenance: input.provenance,
    ...(suppression !== undefined ? { suppression } : {}),
  };
}

function buildFileClaim(
  file: string,
  span: Span,
  input: EmitClaimsInput,
  confidence: Confidence,
  capNote: string | undefined,
  verdict: LivenessVerdict,
  testEntry?: string,
): FileClaim {
  const subject: FileSubject = { kind: "file", name: file, loc: { file, span } };
  const evidence = buildLivenessEvidence(verdict, `\`${file}\``, capNote, testEntry);
  const id = computeClaimId(subject, langOpt(input));
  return {
    id,
    language: claimLanguage(input),
    subject,
    verdict,
    confidence,
    evidence: [evidence],
    provenance: input.provenance,
  };
}

function buildTestClaim(
  file: string,
  span: Span,
  input: EmitClaimsInput,
  confidence: Confidence,
  capNote: string | undefined,
): TestClaim {
  const subject: TestSubject = { kind: "test", name: file, loc: { file, span } };
  const evidence: Evidence = {
    type: "test-only",
    detail: `\`${file}\` is a test file that exercises no production-alive code — every file and symbol it reaches is itself test-only or unused (a zombie test).${capNote ?? ""}`,
    source: EVIDENCE_SOURCE,
  };
  const id = computeClaimId(subject, langOpt(input));
  return {
    id,
    language: claimLanguage(input),
    subject,
    verdict: "test-only",
    confidence,
    evidence: [evidence],
    provenance: input.provenance,
  };
}

function buildDependencyClaim(
  dep: DependencyClaimInput,
  input: EmitClaimsInput,
  confidence: Confidence,
  capNote: string | undefined,
): DependencyClaim {
  const subject: DependencySubject = { kind: "dependency", name: dep.packageName, loc: dep.loc };
  const where = dep.loc.package !== undefined ? `workspace \`${dep.loc.package}\`` : "the project";
  const verdict: LivenessVerdict = dep.verdict ?? "unused";
  const detail =
    verdict === "test-only"
      ? `Declared dependency \`${dep.packageName}\` is imported only from test files in ${where} (no production or config reference) and matches no dependency keep-alive rule.${capNote ?? ""}`
      : `Declared dependency \`${dep.packageName}\` is imported by no file in ${where} and matches no dependency keep-alive rule (\`@types\` pairing, a \`bin\` tool, the JSX runtime, a \`workspace:\` sibling, or a config/scripts reference).${capNote ?? ""}`;
  const evidence: Evidence = {
    type: verdict === "test-only" ? "test-only" : "static-reachability",
    detail,
    source: EVIDENCE_SOURCE,
  };
  const id = computeClaimId(subject, langOpt(input));
  return {
    id,
    language: claimLanguage(input),
    subject,
    verdict,
    confidence,
    evidence: [evidence],
    provenance: input.provenance,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function langOpt(input: EmitClaimsInput): { language?: string } {
  return input.language !== undefined ? { language: input.language } : {};
}

/** TypeScript's historical empty identity slot still renders explicitly as `ts`. */
function claimLanguage(input: EmitClaimsInput): string {
  return input.language ?? "ts";
}

/** A suppressed symbol still yields a claim; the reason travels in the object (PRD §6). */
function suppressionOf(
  suppression: { reason: string | null; valid: boolean } | undefined,
  file: string,
  line: number,
): Suppression | undefined {
  if (suppression === undefined) return undefined;
  if (!suppression.valid || suppression.reason === null || suppression.reason.trim() === "") {
    console.warn(
      `[unused] ${file}:${line}: unused:ignore requires a non-empty reason; claim remains unsuppressed.`,
    );
    return undefined;
  }
  return { reason: suppression.reason };
}

function spanForFile(
  fileNodeId: string,
  lineCounts: ReadonlyMap<string, number> | undefined,
): Span {
  const lines = lineCounts?.get(fileNodeId);
  return [1, lines !== undefined && lines >= 1 ? lines : 1];
}

/** A TypeScript declaration file (`.d.ts` / `.d.mts` / `.d.cts`) — never claimed. */
function isDeclarationFile(path: string): boolean {
  const lower = path.toLowerCase();
  return lower.endsWith(".d.ts") || lower.endsWith(".d.mts") || lower.endsWith(".d.cts");
}
