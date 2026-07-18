/**
 * Claim emission from reachability (T2.4 for the base walk; T3.1 for the hazard
 * registry). Language-agnostic: IR + {@link Reachability} in, {@link Claim}s
 * out. Imports only `core/ir`, `core/claims`, the hazard registry, and its
 * sibling `reachability.ts` — never a frontend.
 *
 * ## Base emission
 * `unused` verdicts for `export` and `file` subjects. Absent any hazard a
 * subject is claimed at `high`; a hazard whose registry scope covers it caps its
 * confidence (`medium`/`low`) or suppresses it (`no-claim`). Real per-subject
 * confidence *assignment* (below the cap) is T3.3; here the base confidence is
 * `high` and the cap is the only thing that can lower it.
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
  Evidence,
  ExportClaim,
  ExportSubject,
  FileClaim,
  FileSubject,
  Provenance,
  Span,
  Suppression,
} from "../claims/types.js";
import { fileId, type HazardAnnotation, type IRGraph } from "../ir/index.js";
import { type ConfidenceCap, capIsStrongerOrEqual, lookupHazard } from "./hazard-registry.js";
import type { Reachability } from "./reachability.js";

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

export interface EmitClaimsInput {
  readonly graph: IRGraph;
  readonly reachability: Reachability;
  /** Provenance stamped on every claim (analyzer / version / generatedAt). */
  readonly provenance: Provenance;
  /**
   * file node id → total line count, for `file`-claim spans. Supplied by the
   * frontend (core does no file I/O). Missing ⇒ a `[1, 1]` placeholder.
   */
  readonly fileLineCounts?: ReadonlyMap<string, number>;
  /** Claim-id language slot (empty/absent ⇒ `ts`, ADR 0006). */
  readonly language?: string;
}

/**
 * Emit the M2 claim set for one project: deterministic, sorted by claim id.
 * Returns `[]` when an unscoped hazard forces whole-project keep-alive.
 */
export function emitClaims(input: EmitClaimsInput): Claim[] {
  const { graph, reachability } = input;

  // --- no production entrypoint ⇒ nothing anchors liveness -------------------
  // With zero production roots the reference graph has no basis to prove ANY
  // subject dead (a library with no `main`/`exports`/`bin` and no fallback
  // entry, or a project the frontend could not root). Claiming here would flag
  // the whole codebase — the entrypoint-detection contract's "no confident
  // root" case. Emit nothing; the caller surfaces "no entrypoints detected".
  if (reachability.productionEntrypointFiles.size === 0) return [];

  // --- registry-driven hazard caps ------------------------------------------
  // `fileCap[F]`   caps F's file claim AND F's export claims (directory-subtree,
  //                file scopes). `exportCap[F]` caps only F's export claims
  //                (symbol-set scope). An unregistered class ⇒ project no-claim.
  const caps = buildHazardCaps(graph);
  if (caps.projectNoClaim) return [];
  const { fileCap, exportCap } = caps;

  // Files reached by any reference edge (to the file node or any symbol it
  // exposes) — the "has an inbound edge" test for file claims.
  const referencedFiles = new Set<string>();
  for (const edge of graph.edges()) {
    if (edge.kind !== "references") continue;
    const target = graph.getNode(edge.to);
    if (target === undefined) continue;
    if (target.kind === "file") referencedFiles.add(target.id);
    else if (target.kind === "symbol") referencedFiles.add(fileId(target.file));
  }

  const claims: Claim[] = [];

  for (const node of graph.nodes()) {
    if (node.kind === "file") {
      if (isDeclarationFile(node.path)) continue; // ambient/declaration — never claimed
      if (reachability.entrypointFiles.has(node.id)) continue; // public API root
      if (referencedFiles.has(node.id)) continue; // has an inbound edge ⇒ not a bare orphan
      // Not referenced and not an entrypoint ⇒ unreachable: a dead file. A
      // symbol-set (export-only) cap never applies to a file claim (file
      // liveness is unaffected by a computed-CJS-export hazard).
      const applied = fileCap.get(node.id);
      if (applied?.cap === "no-claim") continue; // e.g. an unparseable file
      const confidence = confidenceForCap(applied);
      claims.push(
        buildFileClaim(
          node.path,
          spanForFile(node.id, input.fileLineCounts),
          input,
          confidence,
          noteForCap(applied),
        ),
      );
    } else if (node.kind === "symbol") {
      if (!node.local) continue; // forwarded (re-export) symbols are not declarations
      if (isDeclarationFile(node.file)) continue;
      if (reachability.reachableSymbols.has(node.id)) continue; // used
      const fileNodeId = fileId(node.file);
      if (!reachability.reachableFiles.has(fileNodeId)) continue; // subsumed by the file claim
      // An export claim is capped by the stronger of the file-scoped and the
      // export-only (symbol-set) hazard covering its file.
      const applied = strongerCap(fileCap.get(fileNodeId), exportCap.get(fileNodeId));
      if (applied?.cap === "no-claim") continue;
      const confidence = confidenceForCap(applied);
      const span: Span = [node.span.startLine, node.span.endLine];
      const suppression = suppressionOf(node.suppression);
      claims.push(
        buildExportClaim(
          node.exportedName,
          node.file,
          span,
          input,
          suppression,
          confidence,
          noteForCap(applied),
        ),
      );
    }
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
        // exactly like a directory-subtree hazard with an empty prefix.
        if (entry.cap === "no-claim") {
          projectNoClaim = true;
        } else {
          for (const f of fileNodes) mergeCap(fileCap, f.id, applied);
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
        break;
      }
    }
  }

  return { projectNoClaim, fileCap, exportCap };
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
// Claim builders
// ---------------------------------------------------------------------------

function buildExportClaim(
  name: string,
  file: string,
  span: Span,
  input: EmitClaimsInput,
  suppression: Suppression | undefined,
  confidence: Confidence,
  capNote: string | undefined,
): ExportClaim {
  const subject: ExportSubject = { kind: "export", name, loc: { file, span } };
  const evidence: Evidence = {
    type: "static-reachability",
    detail: `0 inbound references to \`${name}\` from any production entrypoint in the reference graph.${capNote ?? ""}`,
    source: EVIDENCE_SOURCE,
  };
  const id = computeClaimId(subject, langOpt(input));
  return {
    id,
    subject,
    verdict: "unused",
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
): FileClaim {
  const subject: FileSubject = { kind: "file", name: file, loc: { file, span } };
  const evidence: Evidence = {
    type: "static-reachability",
    detail: `0 inbound references to \`${file}\` from any production entrypoint in the reference graph.${capNote ?? ""}`,
    source: EVIDENCE_SOURCE,
  };
  const id = computeClaimId(subject, langOpt(input));
  return {
    id,
    subject,
    verdict: "unused",
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
