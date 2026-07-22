/**
 * `unused why <symbol|file>` rendering (T8.2, docs/phasing.md M8;
 * docs/design/cli-ux.md §4). Pure text projection of the why-path answer the
 * core `whyAlive` query computes — one hop per path line, entrypoint kind
 * labelled, the tier-2 note for test-only subjects, and the verdict / evidence
 * / hazards-checked block for dead ones (cli-ux §4).
 *
 * Boundary (dependency-cruiser): reporters render only from the claim schema —
 * so the dead-subject block imports `Evidence`/`Verdict`/`Confidence` from
 * `core/claims`, but the path/hop shapes are re-declared here as reporter-local
 * view types rather than imported from `core/analysis` (which reporters must
 * not reach into). The CLI passes the structurally-compatible `whyAlive` result
 * straight through — no translation, no boundary crossing.
 *
 * The hop/path string renderers ({@link renderHop}, {@link renderWhyPath}) are
 * exported so the MCP server projects `why_alive.paths` through the identical
 * formatter the terminal uses — the two surfaces can never render a path
 * differently.
 */
import type { Confidence, Evidence, Verdict } from "../core/claims/index.js";

export type WhyEntrypointKind = "production" | "config" | "test";

/** One node on a why-path (view mirror of core `WhyHop`). */
export interface WhyHopView {
  readonly file: string;
  readonly line?: number;
  readonly symbol?: string;
  readonly entrypoint?: { readonly kind: WhyEntrypointKind; readonly reason: string };
}

/** A shortest path from an entrypoint to the subject (view mirror of core `WhyPath`). */
export interface WhyPathView {
  readonly entrypointKind: WhyEntrypointKind;
  readonly entrypointReason: string;
  readonly hops: readonly WhyHopView[];
}

export interface WhyCandidateView {
  readonly kind: "export" | "file" | "dependency";
  readonly label: string;
  readonly file: string;
  readonly name?: string;
}

export interface WhySubjectView {
  readonly kind: "export" | "file" | "dependency";
  readonly file: string;
  readonly name?: string;
  readonly line?: number;
}

export interface WhyHazardView {
  readonly hazardClass: string;
  readonly detail: string;
  readonly site: string;
  readonly worlds: readonly WhyEntrypointKind[];
}

/** The renderable why-answer — structurally the core `WhyAliveResult`. */
export type WhyReportInput =
  | { readonly outcome: "not-found"; readonly query: string }
  | {
      readonly outcome: "ambiguous";
      readonly query: string;
      readonly candidates: readonly WhyCandidateView[];
    }
  | {
      readonly outcome: "alive";
      readonly query: string;
      readonly subject: WhySubjectView;
      readonly entrypointKind: WhyEntrypointKind;
      readonly testOnly: boolean;
      readonly paths: readonly WhyPathView[];
    }
  | {
      readonly outcome: "dead";
      readonly query: string;
      readonly subject: WhySubjectView;
      readonly verdict?: Verdict;
      readonly confidence?: Confidence;
      readonly claimId?: string;
      readonly evidence: readonly Evidence[];
      readonly hazards: readonly WhyHazardView[];
    };

const KIND_LABEL: Readonly<Record<WhyEntrypointKind, string>> = {
  production: "production",
  config: "config",
  test: "test",
};

/** Render one hop: `src/foo.ts:12 bar` for a symbol, `src/foo.ts` for a file, plus the entrypoint label on the root hop. */
export function renderHop(hop: WhyHopView): string {
  const base = hop.symbol !== undefined ? `${hop.file}:${hop.line} ${hop.symbol}` : hop.file;
  return hop.entrypoint !== undefined
    ? `${base} (${KIND_LABEL[hop.entrypoint.kind]} entrypoint)`
    : base;
}

/** Render a whole path as `entrypoint → … → subject` (cli-ux §4). `ascii` swaps the arrow for `->`. */
export function renderWhyPath(path: WhyPathView, ascii: boolean): string {
  const arrow = ascii ? " -> " : " → ";
  return path.hops.map(renderHop).join(arrow);
}

/** `src/foo.ts:12 bar` (export) or `src/foo.ts` (file) — the subject headline. */
export function subjectLabel(subject: WhySubjectView): string {
  if (subject.kind === "file") return subject.file;
  if (subject.kind === "dependency") return `${subject.name} (${subject.file})`;
  return subject.line !== undefined
    ? `${subject.file}:${subject.line} ${subject.name}`
    : `${subject.name} (${subject.file})`;
}

/** Render the full `unused why` report for one query (cli-ux §4). */
export function renderWhy(input: WhyReportInput, ascii: boolean): string {
  const dash = ascii ? "--" : "—";
  switch (input.outcome) {
    case "not-found":
      return (
        `unused why: no symbol, file, or dependency matching "${input.query}" found in this project.\n` +
        "  Try an export or dependency name, a file path, or file.ts:exportName.\n"
      );

    case "ambiguous": {
      const lines = [
        `unused why: "${input.query}" is ambiguous ${dash} ${input.candidates.length} candidates. Re-ask with one of:`,
        ...input.candidates.map((c) => `  unused why ${c.label}`),
      ];
      return `${lines.join("\n")}\n`;
    }

    case "alive": {
      const head = subjectLabel(input.subject);
      const lines: string[] = [];
      if (input.testOnly) {
        lines.push(`${head} ${dash} test-only (reachable only in the test environment)`, "");
        lines.push("  reachable only in the test environment from:");
        for (const p of input.paths) lines.push(`    ${renderWhyPath(p, ascii)}`);
        lines.push(
          "",
          "  tier-2: the production and config worlds do not reach this. Its path above",
          "  preserves the real root; use `unused why --delete` before removal.",
        );
      } else {
        lines.push(`${head} ${dash} alive`, "");
        for (const p of input.paths) {
          lines.push(`  reachable from a ${KIND_LABEL[p.entrypointKind]} entrypoint:`);
          lines.push(`    ${renderWhyPath(p, ascii)}`);
        }
        if (input.paths.length === 0) {
          lines.push(`  reachable from a ${KIND_LABEL[input.entrypointKind]} entrypoint.`);
        }
      }
      return `${lines.join("\n")}\n`;
    }

    case "dead": {
      const head = subjectLabel(input.subject);
      const verdict = input.verdict ?? "unused";
      const confidence = input.confidence !== undefined ? ` (confidence: ${input.confidence})` : "";
      const lines: string[] = [`${head} ${dash} ${verdict}${confidence}`, "", "  evidence:"];
      for (const e of input.evidence) lines.push(`    - ${e.detail}`);
      lines.push("");
      if (input.hazards.length === 0) {
        lines.push(
          `  hazards checked near this subject: none ${dash} no dynamic-reference hazard was`,
          "  found nearby, so the static verdict stands.",
        );
      } else {
        lines.push("  hazards checked near this subject:");
        for (const h of input.hazards)
          lines.push(
            `    - ${h.hazardClass}: ${h.detail} (${h.site}; worlds: ${h.worlds.join("/")})`,
          );
      }
      return `${lines.join("\n")}\n`;
    }
  }
}
