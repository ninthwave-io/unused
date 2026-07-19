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
 * Reachability arrives split into production/config/test partitions. A subject
 * reachable from production or config is alive (never flagged). A subject
 * reachable ONLY from tests is `test-only` (export/file/dependency); a test file
 * exercising only test-only/dead code is a zombie `test` claim. A subject
 * reachable from nothing stays `unused`. The `test-only` verdict runs through
 * the identical hazard-cap machinery (`high` when clean); its evidence names the
 * test entrypoint keeping it alive, read from the test partition's stored
 * predecessor map.
 *
 * ## Hazard scoping (T3.1 — replaces M2's blanket whole-project suppression)
 * Each hazard annotation is looked up in the registry (`hazard-registry.ts`),
 * which fixes its **scope** and **confidence cap**. The whole-project suppression
 * M2 applied to any computed `import()`/`require()` is gone: those are now
 * `directory-subtree`-scoped, so only the plausibly-reachable subtree is capped
 * (at `medium`) and everything outside it stays claimable at `high`.
 *
 *  - **`computed-dynamic-import` / `computed-require`** (`directory-subtree`,
 *    cap `medium`) — every file whose path starts with the annotation's
 *    `subtreePrefix` (the template's static prefix; the importer's whole package
 *    when there is none) is capped; the file claim AND any dead-export claim of
 *    an in-scope file.
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
import { fileId, type HazardAnnotation, type IRGraph } from "../ir/index.js";
import { type ConfidenceCap, capIsStrongerOrEqual, lookupHazard } from "./hazard-registry.js";
import {
  computeReachability,
  type PartitionedReachability,
  type Reachability,
  whyReachable,
} from "./reachability.js";

/** The claim verdicts M5 emits for export/file/dependency subjects. */
type LivenessVerdict = "unused" | "test-only";

const EVIDENCE_SOURCE = "reference-graph";

/** A confidence cap plus the hazard site that produced it, for the evidence note. */
interface AppliedCap {
  readonly cap: ConfidenceCap;
  /** The hazard's one-line detail (registry-independent, frontend-authored). */
  readonly detail: string;
  /** Provenance of the downgrade — the hazard site, rendered `file:line`. */
  readonly siteFile: string;
  readonly siteLine: number;
}

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
   * The three per-partition reachability walks (T5.1). Production ∪ config
   * reachable is alive; test-reachable-only is `test-only`; reachable-from-
   * nothing is `unused`. Built by `computePartitionedReachability`.
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
   * Declared dependencies the frontend judged unused (T4.1). Each becomes a
   * `dependency`/`unused` claim, at `high` unless a **project-scope** hazard
   * caps the workspace project-wide (the existing cap plumbing —
   * `unresolvable-entrypoint-target`, a whole-package `project-references`, or a
   * repo-root computed import — applies to dependency claims exactly as to file
   * claims). Absent/empty ⇒ no dependency claims (byte-identical to pre-M4).
   */
  readonly dependencies?: readonly DependencyClaimInput[];
}

/**
 * How each non-entrypoint, non-declaration file sits relative to the three root
 * partitions (T5.1):
 *  - `alive`     — production ∪ config reachable ⇒ never a file claim; its dead
 *                  exports are still individually claimable in the symbol pass.
 *  - `test-only` — test-reachable but NOT production/config-reachable ⇒ one
 *                  whole-file `test-only` claim, subsuming its exports.
 *  - `unused`    — reachable from nothing AND no inbound reference edge (a bare
 *                  orphan) ⇒ a whole-file `unused` claim, subsuming its exports.
 *  - `none`      — reachable from nothing but referenced by (dead) code, so not a
 *                  bare orphan ⇒ no file claim; its symbols are not claimed
 *                  either (the pre-M5 "subsumed by the file claim" behaviour).
 */
type FileClass = "alive" | "test-only" | "unused" | "none";

/**
 * Emit the claim set for one project: deterministic, sorted by claim id. Returns
 * `[]` when there is no production root or an unscoped hazard forces whole-
 * project keep-alive.
 *
 * M5 partitions liveness: a subject reachable only from tests is `test-only`
 * (export/file/dependency), a test file exercising only test-only/dead code is a
 * zombie `test` claim, and code reachable from production or config is alive as
 * before. The hazard-cap machinery is applied identically to every verdict.
 */
export function emitClaims(input: EmitClaimsInput): Claim[] {
  const { graph, reachability } = input;
  const { production, config, test } = reachability;

  // --- no production entrypoint ⇒ nothing anchors liveness -------------------
  // With zero production roots the reference graph has no basis to prove ANY
  // subject dead (a library with no `main`/`exports`/`bin` and no fallback
  // entry, or a project the frontend could not root). Claiming here would flag
  // the whole codebase — the entrypoint-detection contract's "no confident
  // root" case. This also gates `test-only`: without a production baseline we
  // cannot tell "reachable only from tests" from "the whole project". Emit
  // nothing; the caller surfaces "no entrypoints detected".
  if (production.productionEntrypointFiles.size === 0) return [];

  // --- registry-driven hazard caps ------------------------------------------
  // `fileCap[F]`   caps F's file claim AND F's export claims (directory-subtree,
  //                file scopes). `exportCap[F]` caps only F's export claims
  //                (symbol-set scope). An unregistered class ⇒ project no-claim.
  const caps = buildHazardCaps(graph);
  if (caps.projectNoClaim) return [];
  const { fileCap, exportCap, projectCap } = caps;

  // Every root file (production, config, or test) — never itself flagged as a
  // file or export; a test root can only surface as a zombie `test` claim.
  const entrypointFiles = new Set<string>();
  for (const entry of graph.entrypoints()) entrypointFiles.add(fileId(entry.file));

  // Files reached by any reference edge (to the file node or any symbol it
  // exposes) — the "has an inbound edge" test that distinguishes a bare orphan
  // (`unused`) from a file referenced only by other dead code (`none`).
  const referencedFiles = new Set<string>();
  for (const edge of graph.edges()) {
    if (edge.kind !== "references") continue;
    const target = graph.getNode(edge.to);
    if (target === undefined) continue;
    if (target.kind === "file") referencedFiles.add(target.id);
    else if (target.kind === "symbol") referencedFiles.add(fileId(target.file));
  }

  const aliveFile = (id: string): boolean =>
    production.reachableFiles.has(id) || config.reachableFiles.has(id);
  const aliveSymbol = (id: string): boolean =>
    production.reachableSymbols.has(id) || config.reachableSymbols.has(id);

  // Per-file classification, precomputed so the symbol pass can subsume exports
  // by their file's class regardless of node iteration order.
  const fileClass = new Map<string, FileClass>();
  for (const node of graph.nodes()) {
    if (node.kind !== "file") continue;
    if (isDeclarationFile(node.path)) continue; // ambient/declaration — never classified/claimed
    if (entrypointFiles.has(node.id)) continue; // a root — never a file/export claim
    if (aliveFile(node.id)) fileClass.set(node.id, "alive");
    else if (test.reachableFiles.has(node.id)) fileClass.set(node.id, "test-only");
    else if (referencedFiles.has(node.id)) fileClass.set(node.id, "none");
    else fileClass.set(node.id, "unused");
  }

  const claims: Claim[] = [];

  for (const node of graph.nodes()) {
    if (node.kind === "file") {
      const cls = fileClass.get(node.id);
      if (cls === undefined || cls === "alive" || cls === "none") continue;
      // A symbol-set (export-only) cap never applies to a file claim (file
      // liveness is unaffected by a computed-CJS-export hazard).
      const applied = fileCap.get(node.id);
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
            testEntrypointFor(test, node.id),
          ),
        );
      } else {
        claims.push(
          buildFileClaim(node.path, span, input, confidence, noteForCap(applied), "unused"),
        );
      }
    } else if (node.kind === "symbol") {
      if (!node.local) continue; // forwarded (re-export) symbols are not declarations
      if (isDeclarationFile(node.file)) continue;
      const fileNodeId = fileId(node.file);
      // Only a symbol in an alive file is individually claimable: a test-only /
      // unused file already emitted one whole-file claim that subsumes it; a
      // `none` / entrypoint / declaration file yields no export claim (pre-M5).
      if (fileClass.get(fileNodeId) !== "alive") continue;
      if (aliveSymbol(node.id)) continue; // used from production or config
      // An export claim is capped by the stronger of the file-scoped and the
      // export-only (symbol-set) hazard covering its file.
      const applied = strongerCap(fileCap.get(fileNodeId), exportCap.get(fileNodeId));
      if (applied?.cap === "no-claim") continue;
      const confidence = confidenceForCap(applied);
      const span: Span = [node.span.startLine, node.span.endLine];
      const suppression = suppressionOf(node.suppression);
      // A dead export in an alive file: `test-only` when a test still reaches it,
      // otherwise plainly `unused`.
      if (test.reachableSymbols.has(node.id)) {
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
            testEntrypointFor(test, node.id),
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
  claims.push(...emitZombieTestClaims(graph, reachability, fileCap, input));

  // --- dependency claims (T4.1, T5.2 point 4) -------------------------------
  // The frontend already excluded referenced / kept-alive dependencies and
  // tagged each leftover `unused` or `test-only` (referenced only from tests).
  // Confidence is `high` unless a project-wide hazard caps the whole workspace
  // (the same `projectCap` a file claim in this project would carry) — deps are
  // a project-level subject, unaffected by per-file/symbol-set hazards. The
  // entrypoint / no-claim guards above also gate these.
  for (const dep of input.dependencies ?? []) {
    const confidence = confidenceForCap(projectCap);
    claims.push(buildDependencyClaim(dep, input, confidence, noteForCap(projectCap)));
  }

  claims.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return claims;
}

// ---------------------------------------------------------------------------
// Hazard caps (registry lookup + scope resolution)
// ---------------------------------------------------------------------------

interface HazardCaps {
  /** Set ⇒ an unregistered hazard class forced whole-project no-claim. */
  readonly projectNoClaim: boolean;
  /** fileId → strongest cap on the file claim and its export claims. */
  readonly fileCap: ReadonlyMap<string, AppliedCap>;
  /** fileId → strongest cap on the file's export claims only (symbol-set). */
  readonly exportCap: ReadonlyMap<string, AppliedCap>;
  /**
   * The strongest cap that applies **project-wide** — a `project`-scoped hazard
   * (`unresolvable-entrypoint-target`), or a whole-package `directory-subtree`
   * hazard whose prefix is `""` (a `project-references` cap, a repo-root
   * computed import). This is the ceiling a dependency claim (T4.1), which has
   * no file to attach a per-file cap to, is emitted at. `undefined` ⇒ no
   * project-wide hazard ⇒ dependency claims stay `high`.
   */
  readonly projectCap: AppliedCap | undefined;
}

/**
 * Resolve every hazard annotation through the registry into per-subject caps.
 * An unregistered class degrades the whole project to no-claim (never silent —
 * a loud internal warning fires, once per distinct unknown class).
 */
function buildHazardCaps(graph: IRGraph): HazardCaps {
  const fileCap = new Map<string, AppliedCap>();
  const exportCap = new Map<string, AppliedCap>();
  let projectNoClaim = false;
  let projectCap: AppliedCap | undefined;
  const raiseProjectCap = (applied: AppliedCap): void => {
    if (projectCap === undefined || capIsStrongerOrEqual(applied.cap, projectCap.cap))
      projectCap = applied;
  };
  const warned = new Set<string>();

  // Precompute the file-node (id, path) list ONCE: every directory-subtree
  // hazard scans it, keeping the whole pass O(hazards + files) rather than
  // O(hazards × files) with a `getNode` per file per hazard.
  const fileNodes: Array<{ readonly id: string; readonly path: string }> = [];
  for (const node of graph.nodes()) {
    if (node.kind === "file") fileNodes.push({ id: node.id, path: node.path });
  }

  for (const hazard of graph.hazards()) {
    const entry = lookupHazard(hazard.hazardClass);
    if (entry === undefined) {
      projectNoClaim = true;
      if (!warned.has(hazard.hazardClass)) {
        warned.add(hazard.hazardClass);
        // The CLAUDE.md degrade-toward-alive invariant: never a silent pass.
        console.warn(
          `[unused] unregistered hazard class "${hazard.hazardClass}" at ` +
            `${hazard.site.file}:${hazard.site.span.startLine} — treating the whole project ` +
            "as no-claim (conservative). Add it to core/analysis/hazard-registry.ts.",
        );
      }
      continue;
    }
    const applied = appliedCap(hazard, entry.cap);
    switch (entry.scope) {
      case "none":
        break; // provenance only
      case "project":
        // `no-claim` suppresses the whole project; a `medium`/`low` project cap
        // instead lowers every file's ceiling (file claim AND its export claims),
        // exactly like a directory-subtree hazard with an empty prefix, and caps
        // dependency claims project-wide (they have no per-file cap).
        if (entry.cap === "no-claim") {
          projectNoClaim = true;
        } else {
          for (const f of fileNodes) mergeCap(fileCap, f.id, applied);
          raiseProjectCap(applied);
        }
        break;
      case "file":
        mergeCap(fileCap, hazard.file, applied);
        break;
      case "symbol-set":
        mergeCap(exportCap, hazard.file, applied);
        break;
      case "directory-subtree": {
        const prefix = hazard.subtreePrefix ?? ""; // absent ⇒ whole package
        for (const f of fileNodes) {
          if (f.path.startsWith(prefix)) mergeCap(fileCap, f.id, applied);
        }
        // A whole-package (empty-prefix) subtree cap covers every file, so it is
        // also a project-wide cap for the (file-less) dependency claims.
        if (prefix === "") raiseProjectCap(applied);
        break;
      }
    }
  }

  return { projectNoClaim, fileCap, exportCap, projectCap };
}

function appliedCap(hazard: HazardAnnotation, cap: ConfidenceCap): AppliedCap {
  return {
    cap,
    detail: hazard.detail,
    siteFile: hazard.site.file,
    siteLine: hazard.site.span.startLine,
  };
}

/** Keep the stronger (more restrictive) cap when a subject is in several scopes. */
function mergeCap(map: Map<string, AppliedCap>, key: string, applied: AppliedCap): void {
  const current = map.get(key);
  if (current === undefined || capIsStrongerOrEqual(applied.cap, current.cap))
    map.set(key, applied);
}

function strongerCap(a: AppliedCap | undefined, b: AppliedCap | undefined): AppliedCap | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return capIsStrongerOrEqual(a.cap, b.cap) ? a : b;
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
 * The test entrypoint keeping `nodeId` alive, for a `test-only` claim's evidence
 * detail — read from the test partition's stored predecessor map (no re-
 * analysis, PRD §8). `undefined` if the node is not test-reachable (should not
 * happen for a `test-only` subject, but degrade gracefully rather than lie).
 */
function testEntrypointFor(test: Reachability, nodeId: string): string | undefined {
  return whyReachable(test, nodeId).entrypoint?.file;
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
  fileCap: ReadonlyMap<string, AppliedCap>,
  input: EmitClaimsInput,
): TestClaim[] {
  const { production, config } = reachability;
  // The production ∪ config alive surface (files + symbols): reaching any of
  // these disqualifies a test from being a zombie.
  const aliveNodes = new Set<string>([
    ...production.reachableFiles,
    ...production.reachableSymbols,
    ...config.reachableFiles,
    ...config.reachableSymbols,
  ]);

  const claims: TestClaim[] = [];
  for (const entry of graph.entrypoints()) {
    if (entry.entryKind !== "test") continue;
    const testFileId = fileId(entry.file);
    if (graph.outEdges(testFileId).length === 0) continue; // imports nothing ⇒ not a zombie

    // Walk from this one test root; a zombie reaches ≥1 subject beyond itself,
    // none of them alive.
    const reach = computeReachability(graph, { seedFilter: (e) => e.id === entry.id });
    let reachedOther = false;
    let reachesAlive = false;
    for (const fid of reach.reachableFiles) {
      if (fid === testFileId) continue; // its own file is the seed, not "exercised"
      reachedOther = true;
      if (aliveNodes.has(fid)) {
        reachesAlive = true;
        break;
      }
    }
    if (!reachesAlive) {
      for (const sid of reach.reachableSymbols) {
        const sym = graph.getNode(sid);
        if (sym?.kind === "symbol" && sym.file === entry.file) continue; // its own export
        reachedOther = true;
        if (aliveNodes.has(sid)) {
          reachesAlive = true;
          break;
        }
      }
    }
    if (!reachedOther || reachesAlive) continue;

    const applied = fileCap.get(testFileId);
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
      ? `${subjectRef} is reachable only from test entrypoint ${testEntry !== undefined ? `\`${testEntry}\`` : "(s)"}; no production or config entrypoint references it.${capNote ?? ""}`
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
  return { id, subject, verdict, confidence, evidence: [evidence], provenance: input.provenance };
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
  return { id, subject, verdict, confidence, evidence: [evidence], provenance: input.provenance };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function langOpt(input: EmitClaimsInput): { language?: string } {
  return input.language !== undefined ? { language: input.language } : {};
}

/** A suppressed symbol still yields a claim; the reason travels in the object (PRD §6). */
function suppressionOf(
  suppression: { reason: string | null; valid: boolean } | undefined,
): Suppression | undefined {
  if (suppression === undefined) return undefined;
  return { reason: suppression.reason ?? "" };
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
