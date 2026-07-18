/**
 * Claim emission from reachability (T2.4, phasing.md M2). Language-agnostic:
 * IR + {@link Reachability} in, {@link Claim}s out. Imports only `core/ir`,
 * `core/claims`, and its sibling `reachability.ts` — never a frontend.
 *
 * ## What M2 claims (and, deliberately, what it does not)
 * Only `unused` verdicts for `export` and `file` subjects, only at `high`
 * confidence, and only where **no hazard interaction** exists (the confidence
 * machinery that would emit `medium`/`low` is M3/T3.3). Everything a hazard
 * touches yields **no claim** — a recall miss, which is not gated, rather than a
 * false positive or a confidence-ceiling violation, which are (ADR 0009 Gates
 * A/B). This is the deliberate M1→M2 asymmetry: under-report, never over-report.
 *
 * ## The keep-alive rules (rule 3 of the T2.3 review), per hazard class
 *  - **Unknown-/unreliable-target hazards** — a computed `import()`/`require()`
 *    (`computed-dynamic-import` / `computed-require`) or a `parse-error`: the
 *    frontend records no resolvable target (the template prefix / expression is
 *    not captured in M2), so the plausible-target set is *the whole project*.
 *    Conservatively, a project carrying any such hazard emits **no claims at
 *    all**. (M3's hazard registry records a scope — e.g. the `./mods/` directory
 *    pattern — and narrows this to just the plausible targets.)
 *  - **`config-referenced-file`** (injected by the frontend when a discovered
 *    source file's path appears as a string in a config file): keep-alive for
 *    *that file* — no file or export claim on it.
 *  - **`unresolvable-import` / `outside-project`**: the target is unknown or
 *    un-analyzed, not a real project file, so it affects nothing else — no
 *    suppression (the importing file's unrelated dead siblings stay claimable).
 *  - **`internal-declaration` / `declaration-companion`** hazard *edges* already
 *    keep their `.d.ts` targets reachable in the graph; declaration files are
 *    additionally never claimed (they have no runtime body — the ambient/global
 *    `.d.ts` class).
 *  - **Suppressed symbols** (`/* unused:ignore *\/`): still claimed, but the
 *    claim carries its `suppression` object and is counted (PRD §4/§6).
 *
 * ## File vs export granularity
 * A file with no inbound reference edge (to the file or any symbol it exposes),
 * that is not an entrypoint, not a declaration file, and not kept alive ⇒ a
 * `file` claim; its exports are then subsumed (not separately claimed), and the
 * file span is counted once toward `estDeletableLoc`. A dead export in an
 * otherwise-reachable file ⇒ an `export` claim.
 */

import { computeClaimId } from "../claims/id.js";
import type {
  Claim,
  Evidence,
  ExportClaim,
  ExportSubject,
  FileClaim,
  FileSubject,
  Provenance,
  Span,
  Suppression,
} from "../claims/types.js";
import { fileId, type IRGraph } from "../ir/index.js";
import type { Reachability } from "./reachability.js";

/** Hazard classes whose target the frontend cannot pin down in M2 ⇒ suppress the whole project. */
const UNSCOPED_HAZARDS: ReadonlySet<string> = new Set([
  "computed-dynamic-import",
  "computed-require",
  "parse-error",
]);

/** Hazard class the frontend injects to keep a config-referenced source file alive. */
const CONFIG_REFERENCED = "config-referenced-file";

const EVIDENCE_SOURCE = "reference-graph";

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

  // --- hazard-derived keep-alive state --------------------------------------
  const configReferencedFiles = new Set<string>();
  let projectFullySuppressed = false;
  for (const hazard of graph.hazards()) {
    if (UNSCOPED_HAZARDS.has(hazard.hazardClass)) projectFullySuppressed = true;
    else if (hazard.hazardClass === CONFIG_REFERENCED) configReferencedFiles.add(hazard.file);
  }
  if (projectFullySuppressed) return [];

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
      if (configReferencedFiles.has(node.id)) continue; // kept alive by config
      if (referencedFiles.has(node.id)) continue; // has an inbound edge ⇒ not a bare orphan
      // Not referenced and not an entrypoint ⇒ unreachable: a dead file.
      claims.push(buildFileClaim(node.path, spanForFile(node.id, input.fileLineCounts), input));
    } else if (node.kind === "symbol") {
      if (!node.local) continue; // forwarded (re-export) symbols are not declarations
      if (isDeclarationFile(node.file)) continue;
      if (reachability.reachableSymbols.has(node.id)) continue; // used
      const fileNodeId = fileId(node.file);
      if (!reachability.reachableFiles.has(fileNodeId)) continue; // subsumed by the file claim
      if (configReferencedFiles.has(fileNodeId)) continue; // whole file kept alive
      const span: Span = [node.span.startLine, node.span.endLine];
      const suppression = suppressionOf(node.suppression);
      claims.push(buildExportClaim(node.exportedName, node.file, span, input, suppression));
    }
  }

  claims.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return claims;
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
): ExportClaim {
  const subject: ExportSubject = { kind: "export", name, loc: { file, span } };
  const evidence: Evidence = {
    type: "static-reachability",
    detail: `0 inbound references to \`${name}\` from any production entrypoint in the reference graph.`,
    source: EVIDENCE_SOURCE,
  };
  const id = computeClaimId(subject, langOpt(input));
  return {
    id,
    subject,
    verdict: "unused",
    confidence: "high",
    evidence: [evidence],
    provenance: input.provenance,
    ...(suppression !== undefined ? { suppression } : {}),
  };
}

function buildFileClaim(file: string, span: Span, input: EmitClaimsInput): FileClaim {
  const subject: FileSubject = { kind: "file", name: file, loc: { file, span } };
  const evidence: Evidence = {
    type: "static-reachability",
    detail: `0 inbound references to \`${file}\` from any production entrypoint in the reference graph.`,
    source: EVIDENCE_SOURCE,
  };
  const id = computeClaimId(subject, langOpt(input));
  return {
    id,
    subject,
    verdict: "unused",
    confidence: "high",
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
