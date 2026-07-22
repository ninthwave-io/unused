/**
 * The default terminal report (T6.1, docs/phasing.md M6) — "the product's
 * face" (docs/design/cli-ux.md, header). Implements cli-ux.md §2 (layout),
 * §5 (degradation), §6 (empty/clean states) as closely as the spec's prose
 * mockup allows; genuine judgment calls made where the mockup under-
 * specifies are called out inline and in the T6.1 delegation report.
 *
 * Three render layouts, selected by the caller (the CLI owns terminal
 * detection — `process.stdout` access has no place in a pure renderer):
 *  - `"wide"`   — full color table, confidence badges, a right-aligned
 *    "confidence" column header (cli-ux §2's mockup, ≥80 cols, a TTY, color
 *    enabled).
 *  - `"narrow"` — same color/badges, but the why column drops to an
 *    indented second line (cli-ux §5, <80 cols).
 *  - `"plain"`  — non-TTY stdout, `NO_COLOR`, or `--no-color` (cli-ux §5):
 *    no ANSI, no glyphs — confidence badges become the word itself
 *    (`high`/`medium`/`low`, still "shape", i.e. legible without color, per
 *    cli-ux §2's "never color alone") — one claim per line, the stable
 *    grep-able grammar cli-ux §5 asks for, carrying the *same information*
 *    as the color report (why text included, not summarised away).
 *
 * Sections render in cli-ux §2's fixed order: exports, files, dependencies,
 * test-only, endpoints (present only once tier-3 extraction ships, post-v1
 * — PRD §2 T3 — so this section is always empty and always skipped in v1,
 * kept here so the rule-id/schema-level plumbing needs no rework later).
 *
 * Low-confidence claims are summarised, not listed, by default (cli-ux §2)
 * — UNLESS the caller passed an explicit `--min-confidence` (in which case
 * the caller already filtered `run.claims` down to that floor, via
 * `reporters/filter.ts`, and this module must not hide anything further:
 * `--min-confidence low` is cli-ux §2's own stated affordance for making low
 * confidence visible, so a second hide pass here would make that flag a
 * no-op). `explicitMinConfidence` on {@link TtyRenderOptions} carries this.
 *
 * Imports only `core/claims` (dependency-cruiser reporters boundary).
 */
import type { Claim, ClaimRun, Confidence, SubjectKind } from "../core/claims/index.js";

export type TtyLayout = "wide" | "narrow" | "plain";

/** Header/context fields the claim schema itself has no field for (`analyze.ts`'s out-of-band `AnalyzeResult` extras). */
export interface TtyReportContext {
  readonly run: ClaimRun;
  readonly repoName: string;
  readonly fileCount: number;
  readonly workspaceCount: number;
}

export interface TtyRenderOptions {
  readonly layout: TtyLayout;
  /** Real terminal width when `layout !== "plain"`; ignored (but required) otherwise. */
  readonly columns: number;
  /** `--show-suppressed` (cli-ux §2 "suppressed count line + --show-suppressed"). */
  readonly showSuppressed: boolean;
  /** `--all` — defeats the top-10-per-section truncation (cli-ux §2 "Scale rule"). Does NOT reveal low-confidence rows; that is `--min-confidence low`'s job. */
  readonly all: boolean;
  /** The `--min-confidence` value, when the user passed it explicitly; `undefined` ⇒ default report behaviour. */
  readonly explicitMinConfidence: Confidence | undefined;
  /** True when `--filter`/`--min-confidence` narrowed `run.claims` to empty — an empty run under an active filter is not "clean" (cli-ux §6). */
  readonly filtersActive: boolean;
  /**
   * True when the analysed project has zero production entrypoints
   * (`AnalyzeResult.productionEntrypointCount === 0`) — nothing anchors
   * liveness, so an empty `claims` array here means "nothing was provably
   * checked", not "checked and found clean". Reviewer finding: stdout must
   * never look like an all-clear in this state; the CLI already warns on
   * stderr (`NO_ENTRYPOINTS_WARNING`), but the TTY report was printing the
   * identical "clean" celebration on stdout regardless, which reads as a
   * false all-clear to anyone who only looks at stdout (e.g. a CI log
   * viewer, a piped digest). Takes priority over the "clean" state but not
   * over `filtersActive` (an explicit `--filter` is the user's own doing).
   */
  readonly noProductionEntrypoints: boolean;
}

const BADGE_GLYPH: Readonly<Record<Confidence, string>> = { high: "●", medium: "◐", low: "○" };
const ANSI = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  gray: "\x1b[90m",
} as const;
const BADGE_COLOR: Readonly<Record<Confidence, string>> = {
  high: ANSI.green,
  medium: ANSI.yellow,
  low: ANSI.gray,
};

interface SectionNoun {
  readonly singular: string;
  readonly plural: string;
}

interface SectionDef {
  readonly title: string;
  readonly match: (claim: Claim) => boolean;
  /** `--filter` value to suggest in the truncation affordance; `undefined` when the section spans more than one kind (test-only). */
  readonly filterHint: SubjectKind | undefined;
  readonly noun: SectionNoun;
  /** Extra lines appended after the rows/affordance (test-only's zombie-test CI-seconds line, T5.3). */
  readonly extraFooterLines?: (run: ClaimRun, ascii: boolean) => string[];
}

function isUnusedKind(claim: Claim, kind: SubjectKind): boolean {
  return claim.subject.kind === kind && claim.verdict === "unused";
}

/** cli-ux §2 order: exports, files, dependencies, test-only, endpoints. */
const SECTIONS: readonly SectionDef[] = [
  {
    title: "UNUSED EXPORTS",
    match: (c) => isUnusedKind(c, "export"),
    filterHint: "export",
    noun: { singular: "export", plural: "exports" },
  },
  {
    title: "UNUSED FILES",
    match: (c) => isUnusedKind(c, "file"),
    filterHint: "file",
    noun: { singular: "file", plural: "files" },
  },
  {
    title: "UNUSED DEPENDENCIES",
    match: (c) => isUnusedKind(c, "dependency"),
    filterHint: "dependency",
    noun: { singular: "dependency", plural: "dependencies" },
  },
  {
    title: "TEST-ONLY (reachable only in test environment)",
    match: (c) => c.verdict === "test-only",
    filterHint: undefined,
    noun: { singular: "test-only claim", plural: "test-only claims" },
    extraFooterLines: (run, ascii) => {
      const z = run.summary.zombieTests;
      const actionableCount = countMatching(
        run.claims,
        (claim) => claim.subject.kind === "test" && claim.suppression === undefined,
      );
      if (z === undefined || actionableCount === 0) return [];
      const dash = ascii ? "--" : "—";
      const estCiSecondsPerRun = actionableCount * z.avgSecondsPerTestFile;
      return [
        `  ${formatCount(actionableCount)} zombie test${actionableCount === 1 ? "" : "s"} ${dash} ~${formatCount(estCiSecondsPerRun)}s CI per run (estimated).`,
      ];
    },
  },
  {
    title: "UNCONSUMED ENDPOINTS",
    match: (c) => c.verdict === "unconsumed-endpoint",
    filterHint: "endpoint",
    noun: { singular: "endpoint", plural: "endpoints" },
  },
];

// ---------------------------------------------------------------------------
// Small formatting helpers
// ---------------------------------------------------------------------------

/**
 * Manual thousands separator — deterministic, no ICU/locale dependency
 * (non-negative integers only). Exported for reuse by
 * `reporters/check.ts`/`reporters/baseline.ts` (T7.1/T7.2).
 */
export function formatCount(n: number): string {
  return Math.trunc(n)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function formatDuration(ms: number): string {
  return `${Math.max(0, ms / 1000).toFixed(1)}s`;
}

function plural(n: number): string {
  return n === 1 ? "" : "s";
}

/** Exported for reuse by `reporters/check.ts` (T7.2) — the same "file:line" location label `unused check`'s NEW-claim rows use. */
export function locLabel(claim: Claim): string {
  return `${claim.subject.loc.file}:${claim.subject.loc.span[0]}`;
}

/** Line count of a claim's subject span — exported for reuse by `reporters/report.ts` (T9.3: "top-10 deletions by LOC"). */
export function spanLines(claim: Claim): number {
  const [start, end] = claim.subject.loc.span;
  return end - start + 1;
}

/** Word-boundary-aware truncation — "never wrap mid-token" (cli-ux §5). */
function truncateWhy(text: string, maxLen: number): string {
  if (text.length <= maxLen || maxLen <= 1) return text;
  const slice = text.slice(0, maxLen - 1);
  const lastSpace = slice.lastIndexOf(" ");
  const cut = lastSpace > 0 ? slice.slice(0, lastSpace) : slice;
  return `${cut}…`;
}

function fit(text: string, width: number): string {
  if (text.length > width)
    return width <= 1 ? text.slice(0, width) : `${text.slice(0, width - 1)}…`;
  return text.padEnd(width);
}

function wrap(text: string, code: string, color: boolean): string {
  return color ? `${code}${text}${ANSI.reset}` : text;
}

/**
 * The claim's one-line why (PRD §8: rendered from data already captured at
 * analysis time — `evidence[0].detail`, never re-derived). Under
 * `--show-suppressed`, a suppressed claim's reason is prefixed — the
 * mandatory `/* unused:ignore <reason> *\/` text PRD §4/§6 says must travel
 * into every report, not just `--json`/SARIF.
 * Exported for reuse by `reporters/check.ts` (T7.2) — `unused check`'s NEW-
 * claim rows render the identical one-line why (cli-ux §3: "each with the
 * same one-line why").
 */
export function whyText(claim: Claim, showSuppressed: boolean): string {
  const base = claim.evidence[0]?.detail ?? "";
  if (showSuppressed && claim.suppression !== undefined) {
    return `[suppressed: ${claim.suppression.reason}] ${base}`;
  }
  return base;
}

function badgeStr(confidence: Confidence, color: boolean): string {
  return color
    ? wrap(BADGE_GLYPH[confidence], BADGE_COLOR[confidence], true)
    : BADGE_GLYPH[confidence];
}

// ---------------------------------------------------------------------------
// Header + summary strip
// ---------------------------------------------------------------------------

function renderHeader(ctx: TtyReportContext, ascii: boolean): string {
  const dash = ascii ? "--" : "—";
  const fileWord = ctx.fileCount === 1 ? "file" : "files";
  const workspaceClause =
    ctx.workspaceCount > 1 ? `, ${formatCount(ctx.workspaceCount)} workspaces` : "";
  return (
    `unused v${ctx.run.tool.version} ${dash} ${ctx.repoName} ` +
    `(${formatCount(ctx.fileCount)} ${fileWord}${workspaceClause}) ${dash} ` +
    formatDuration(ctx.run.run.durationMs)
  );
}

function countMatching(claims: readonly Claim[], predicate: (c: Claim) => boolean): number {
  let n = 0;
  for (const c of claims) if (predicate(c)) n += 1;
  return n;
}

function renderSummaryStrip(run: ClaimRun, ascii: boolean): string[] {
  const sep = ascii ? ", " : " · ";
  const unusedExports = countMatching(
    run.claims,
    (c) => c.suppression === undefined && isUnusedKind(c, "export"),
  );
  const unusedFiles = countMatching(
    run.claims,
    (c) => c.suppression === undefined && isUnusedKind(c, "file"),
  );
  const unusedDeps = countMatching(
    run.claims,
    (c) => c.suppression === undefined && isUnusedKind(c, "dependency"),
  );
  const testOnlySymbols = countMatching(
    run.claims,
    (c) => c.suppression === undefined && c.verdict === "test-only" && c.subject.kind !== "test",
  );
  const suppressedTotal = countMatching(run.claims, (c) => c.suppression !== undefined);

  const line1 = [
    `${formatCount(unusedExports)} unused export${plural(unusedExports)}`,
    `${formatCount(unusedFiles)} unused file${plural(unusedFiles)}`,
    `${formatCount(unusedDeps)} unused dependenc${unusedDeps === 1 ? "y" : "ies"}`,
  ].join(sep);

  const line2Parts = [
    `~${formatCount(run.summary.estDeletableLoc)} deletable LOC`,
    `${formatCount(testOnlySymbols)} test-only symbol${plural(testOnlySymbols)}`,
  ];
  if (suppressedTotal > 0) line2Parts.push(`${formatCount(suppressedTotal)} suppressed`);

  return [`  ${line1}`, `  ${line2Parts.join(sep)}`];
}

// ---------------------------------------------------------------------------
// Section rows
// ---------------------------------------------------------------------------

function visibleRows(matched: readonly Claim[], options: TtyRenderOptions): Claim[] {
  return matched
    .filter((c) => {
      if (!options.showSuppressed && c.suppression !== undefined) return false;
      if (options.explicitMinConfidence === undefined && c.confidence === "low") return false;
      return true;
    })
    .sort((a, b) => {
      const diff = spanLines(b) - spanLines(a); // top-10 ranked by deletable LOC (cli-ux §2)
      if (diff !== 0) return diff;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0; // deterministic tiebreak
    });
}

function renderSectionHeader(
  title: string,
  layout: TtyLayout,
  columns: number,
  color: boolean,
): string {
  if (layout !== "wide") return wrap(title, ANSI.bold, color);
  const width = Math.min(Math.max(columns, 80), 110);
  const label = "confidence";
  const pad = Math.max(1, width - title.length - label.length);
  return `${wrap(title, ANSI.bold, color)}${" ".repeat(pad)}${wrap(label, ANSI.dim, color)}`;
}

function renderRowWide(
  claim: Claim,
  options: TtyRenderOptions,
  color: boolean,
  nameWidth: number,
  locWidth: number,
): string {
  const badge = badgeStr(claim.confidence, color);
  const name = fit(claim.subject.name, nameWidth);
  const loc = fit(locLabel(claim), locWidth);
  const used = 2 + 1 + 1 + nameWidth + 2 + locWidth + 2; // indent, badge, space, name, gap, loc, gap
  const width = Math.min(Math.max(options.columns, 80), 110);
  const avail = Math.max(20, width - used);
  const why = truncateWhy(whyText(claim, options.showSuppressed), avail);
  return `  ${badge} ${name}  ${loc}  ${why}`;
}

function renderRowNarrow(claim: Claim, options: TtyRenderOptions, color: boolean): string[] {
  const badge = badgeStr(claim.confidence, color);
  const line1 = `  ${badge} ${claim.subject.name}   ${locLabel(claim)}`;
  const avail = Math.max(20, options.columns - 6);
  const why = truncateWhy(whyText(claim, options.showSuppressed), avail);
  return [line1, `      ${why}`];
}

/** Plain mode: one claim per line, ASCII, grep-able (cli-ux §5) — carries every field, including why, in full (no truncation: no real screen width applies to a pipe). */
function renderRowPlain(claim: Claim, options: TtyRenderOptions): string {
  const why = whyText(claim, options.showSuppressed);
  return `${claim.verdict}  ${claim.subject.kind}  ${claim.subject.name}  ${locLabel(claim)}  ${claim.confidence}  ${why}`;
}

interface RenderedSection {
  readonly lines: string[];
  readonly firstShownName: string | undefined;
}

function renderSection(
  def: SectionDef,
  run: ClaimRun,
  options: TtyRenderOptions,
  color: boolean,
): RenderedSection | undefined {
  const ascii = options.layout === "plain";
  const matched = run.claims.filter(def.match);
  const visible = visibleRows(matched, options);
  const shown = options.all ? visible : visible.slice(0, 10);
  const hidden = visible.length - shown.length;
  const extra = def.extraFooterLines?.(run, ascii) ?? [];
  if (shown.length === 0 && extra.length === 0) return undefined;

  const lines: string[] = [renderSectionHeader(def.title, options.layout, options.columns, color)];

  if (options.layout === "wide") {
    const nameWidth =
      shown.length > 0 ? Math.min(Math.max(...shown.map((c) => c.subject.name.length)), 32) : 0;
    const locWidth =
      shown.length > 0 ? Math.min(Math.max(...shown.map((c) => locLabel(c).length)), 40) : 0;
    for (const claim of shown)
      lines.push(renderRowWide(claim, options, color, nameWidth, locWidth));
  } else if (options.layout === "narrow") {
    for (const claim of shown) lines.push(...renderRowNarrow(claim, options, color));
  } else {
    for (const claim of shown) lines.push(renderRowPlain(claim, options));
  }

  if (hidden > 0) {
    const dash = ascii ? "--" : "—";
    const ellipsis = ascii ? "..." : "…";
    const affordance =
      def.filterHint !== undefined
        ? `unused --filter ${def.filterHint} --all, or --json`
        : "unused --all, or --json";
    lines.push(
      `  ${ellipsis} ${formatCount(hidden)} more ${def.noun.plural} ${dash} ${affordance}`,
    );
  }

  lines.push(...extra);
  return { lines, firstShownName: shown[0]?.subject.name };
}

// ---------------------------------------------------------------------------
// Footer counts + next steps
// ---------------------------------------------------------------------------

function renderFooterCounts(run: ClaimRun, options: TtyRenderOptions, ascii: boolean): string[] {
  const lines: string[] = [];
  const dash = ascii ? "--" : "—";

  if (options.explicitMinConfidence === undefined) {
    const lowCount = countMatching(run.claims, (c) => c.confidence === "low");
    if (lowCount > 0) {
      const glyph = ascii ? "" : `${BADGE_GLYPH.low} `;
      lines.push(
        `  ${glyph}${formatCount(lowCount)} low-confidence candidate${plural(lowCount)} hidden ${dash} \`unused --min-confidence low\` to show`,
      );
    }
  }

  const suppressedCount = countMatching(run.claims, (c) => c.suppression !== undefined);
  if (suppressedCount > 0) {
    lines.push(
      options.showSuppressed
        ? `  ${formatCount(suppressedCount)} suppressed (shown above)`
        : `  ${formatCount(suppressedCount)} suppressed ${dash} \`unused --show-suppressed\``,
    );
  }

  return lines;
}

function renderNextSteps(topClaimName: string | undefined, ascii: boolean): string {
  const bar = ascii ? " | " : " · ";
  const why = topClaimName !== undefined ? `\`unused why ${topClaimName}\`${bar}` : "";
  return `next: ${why}\`unused --json\`${bar}docs: unused.dev`;
}

function renderEmptyReport(
  ctx: TtyReportContext,
  options: TtyRenderOptions,
  ascii: boolean,
): string {
  const dash = ascii ? "--" : "—";
  const bar = ascii ? " | " : " · ";
  const lines: string[] = [renderHeader(ctx, ascii), ""];
  if (options.filtersActive) {
    lines.push(
      `  no claims match this filter ${dash} try \`unused\` without --filter/--min-confidence, or \`unused --json\` to inspect the full run.`,
      "",
      `next: \`unused --json\`${bar}docs: unused.dev`,
    );
  } else if (options.noProductionEntrypoints) {
    // Reviewer finding: an empty `claims` array here means "nothing was
    // provably checked" (no entrypoint anchors liveness), NOT "checked and
    // found clean" — stdout must not read as an all-clear. Distinct from
    // both the filtered-empty and genuinely-clean states below.
    lines.push(
      `  no production entrypoints detected ${dash} nothing was analysed for liveness; see stderr.`,
      "",
      `next: declare an entrypoint (package.json \`main\`/\`exports\`/\`bin\`, or config \`entry\`)${bar}docs: unused.dev`,
    );
  } else {
    // cli-ux §6: "Clean repo: celebrate briefly, suggest the badge and `unused check` adoption."
    lines.push(
      `  clean ${dash} no unused exports, files, or dependencies found.`,
      "",
      `next: \`unused badge\` to show it off${bar}\`unused check\` to gate future PRs${bar}docs: unused.dev`,
    );
  }
  return `${lines.join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function renderTtyReport(ctx: TtyReportContext, options: TtyRenderOptions): string {
  const ascii = options.layout === "plain";
  const color = options.layout !== "plain";

  if (ctx.run.claims.length === 0) return renderEmptyReport(ctx, options, ascii);

  const lines: string[] = [renderHeader(ctx, ascii), "", ...renderSummaryStrip(ctx.run, ascii), ""];

  let topClaimName: string | undefined;
  for (const def of SECTIONS) {
    const rendered = renderSection(def, ctx.run, options, color);
    if (rendered === undefined) continue;
    lines.push(...rendered.lines, "");
    topClaimName ??= rendered.firstShownName;
  }

  const footerCounts = renderFooterCounts(ctx.run, options, ascii);
  if (footerCounts.length > 0) lines.push(...footerCounts, "");

  lines.push(renderNextSteps(topClaimName, ascii));
  return `${lines.join("\n")}\n`;
}
