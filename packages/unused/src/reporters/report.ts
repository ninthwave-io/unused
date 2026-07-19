/**
 * `unused report` — the shareable deletion report (T9.3, docs/phasing.md M9;
 * docs/design/report-and-badge.md §1: "the growth artifact"). Renders a
 * self-contained Markdown or HTML document from the last analysis: headline
 * totals, the top-10 deletions by LOC, a confidence breakdown, the
 * assumption-set footnote, tool version + date, and a privacy note.
 *
 * Pure functions of the claim schema plus the same out-of-band header
 * context the TTY report uses (`repoName`/`fileCount`/`workspaceCount`) — no
 * frontend/CLI I/O here (reporters boundary — dependency-cruiser: reporters
 * may depend on `core/claims` only, never `core/analysis` or `frontends`,
 * so the assumption-set footnote below is a static pointer to the generated
 * doc, not a live read of it).
 *
 * HTML output is fully self-contained: inline `<style>`, no external
 * scripts/fonts/images/CDN — open the file straight from disk or paste its
 * rendered contents into a PR/Slack (report-and-badge.md §1: "designed to be
 * screenshotted or pasted ... one screen, big numbers").
 *
 * Determinism (T9.3 acceptance: "snapshots — deterministic, inject clock"):
 * both renderers are pure functions of {@link ReportContext}, whose `run`
 * already carries a fixed `run.startedAt`/`tool.version` (set by
 * `analyzeProject`'s injectable `now`/`toolVersion` options) — no separate
 * clock plumbing is needed here, matching `reporters/tty.ts`'s test pattern
 * (a hand-built `ClaimRun` with a fixed `startedAt`).
 */
import type { Claim, ClaimRun } from "../core/claims/index.js";
import { formatCount, locLabel, spanLines, whyText } from "./tty.js";

export type ReportFormat = "md" | "html";

/** Same header/context shape as `reporters/tty.ts`'s `TtyReportContext` — the claim schema itself has no field for repo identity/scale (`analyze.ts`'s out-of-band `AnalyzeResult` extras). */
export interface ReportContext {
  readonly run: ClaimRun;
  readonly repoName: string;
  readonly fileCount: number;
  readonly workspaceCount: number;
}

function plural(n: number): string {
  return n === 1 ? "" : "s";
}

function isUnusedKind(claim: Claim, kind: Claim["subject"]["kind"]): boolean {
  return claim.subject.kind === kind && claim.verdict === "unused";
}

function countMatching(claims: readonly Claim[], predicate: (c: Claim) => boolean): number {
  let n = 0;
  for (const c of claims) if (predicate(c)) n += 1;
  return n;
}

interface Headline {
  readonly unusedExports: number;
  readonly unusedFiles: number;
  readonly unusedDeps: number;
  readonly testOnlySymbols: number;
}

function computeHeadline(run: ClaimRun): Headline {
  return {
    unusedExports: countMatching(run.claims, (c) => isUnusedKind(c, "export")),
    unusedFiles: countMatching(run.claims, (c) => isUnusedKind(c, "file")),
    unusedDeps: countMatching(run.claims, (c) => isUnusedKind(c, "dependency")),
    testOnlySymbols: countMatching(
      run.claims,
      (c) => c.verdict === "test-only" && c.subject.kind !== "test",
    ),
  };
}

/**
 * The top-10 deletions ranked by LOC (report-and-badge.md §1). Scoped to
 * `verdict: "unused"`, non-suppressed, confidence `high`/`medium` claims —
 * deliberately the exact same claim set `core/claims/summary.ts`'s
 * `estimateDeletableLoc` counts, so the headline "~N deletable LOC" figure
 * and the list beneath it never disagree about what's included. `test-only`
 * claims are excluded (a code+test cascade decision, not a straight
 * deletion — same rationale as `estDeletableLoc`); `low`-confidence
 * candidates are excluded because a shareable growth artifact should not
 * present unproven candidates as "top deletions" (the same
 * ranked-by-actionability principle the TTY report's default view uses,
 * cli-ux §1/§2).
 */
function topDeletions(run: ClaimRun, limit = 10): Claim[] {
  return run.claims
    .filter((c) => c.verdict === "unused" && c.suppression === undefined && c.confidence !== "low")
    .sort((a, b) => {
      const diff = spanLines(b) - spanLines(a);
      if (diff !== 0) return diff;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0; // deterministic tiebreak
    })
    .slice(0, limit);
}

function formatDate(iso: string): string {
  return iso.slice(0, 10);
}

const PRIVACY_NOTE =
  "Generated locally from this repository's source. It reveals file paths and symbol names — " +
  "review before sharing outside your team. Nothing is uploaded; unused never phones home.";

const ASSUMPTION_SET_NOTE =
  "High-confidence claims hold under a published, enumerated assumption set, generated from the " +
  "analyzer's own code so it cannot drift from what it actually does: docs/generated/assumption-set.md " +
  "(https://unused.dev/assumptions).";

// ---------------------------------------------------------------------------
// Markdown
// ---------------------------------------------------------------------------

/** Escapes the one Markdown metacharacter a claim's why-text or subject name could plausibly contain and still land inside a `|`-delimited table cell. */
function escapeMdCell(text: string): string {
  return text.replace(/\|/g, "\\|");
}

function headerLine(ctx: ReportContext): string {
  const fileWord = ctx.fileCount === 1 ? "file" : "files";
  const workspaceClause =
    ctx.workspaceCount > 1 ? `, ${formatCount(ctx.workspaceCount)} workspaces` : "";
  return (
    `Generated ${formatDate(ctx.run.run.startedAt)} by \`unused\` v${ctx.run.tool.version} — ` +
    `${formatCount(ctx.fileCount)} ${fileWord}${workspaceClause}.`
  );
}

export function renderReportMarkdown(ctx: ReportContext): string {
  const { run, repoName } = ctx;
  const h = computeHeadline(run);
  const top = topDeletions(run);
  const z = run.summary.zombieTests;

  const lines: string[] = [
    `# unused deletion report — ${repoName}`,
    "",
    headerLine(ctx),
    "",
    `> **Privacy:** ${PRIVACY_NOTE}`,
    "",
    "## Headline",
    "",
    `- **~${formatCount(run.summary.estDeletableLoc)} deletable LOC**`,
    `- ${formatCount(h.unusedExports)} unused export${plural(h.unusedExports)}, ` +
      `${formatCount(h.unusedFiles)} unused file${plural(h.unusedFiles)}, ` +
      `${formatCount(h.unusedDeps)} unused dependenc${h.unusedDeps === 1 ? "y" : "ies"}`,
    `- ${formatCount(h.testOnlySymbols)} test-only symbol${plural(h.testOnlySymbols)}`,
  ];
  if (z !== undefined) {
    lines.push(
      `- ${formatCount(z.count)} zombie test${plural(z.count)} — ~${formatCount(z.estCiSecondsPerRun)}s CI per run (estimated)`,
    );
  }

  lines.push("", "## Top deletions by LOC", "");
  if (top.length === 0) {
    lines.push("_Nothing to show — no high/medium-confidence deletable claims in this run._");
  } else {
    lines.push(
      "| Confidence | Subject | Location | LOC | Why |",
      "|---|---|---|---|---|",
      ...top.map(
        (c) =>
          `| ${c.confidence} | \`${escapeMdCell(c.subject.name)}\` (${c.subject.kind}) | ` +
          `\`${locLabel(c)}\` | ${spanLines(c)} | ${escapeMdCell(whyText(c, false))} |`,
      ),
    );
  }

  lines.push(
    "",
    "## Confidence breakdown",
    "",
    `- high: ${formatCount(run.summary.byConfidence.high)}`,
    `- medium: ${formatCount(run.summary.byConfidence.medium)}`,
    `- low: ${formatCount(run.summary.byConfidence.low)}`,
    "",
    "---",
    "",
    ASSUMPTION_SET_NOTE,
    "",
    `Generated by \`unused\` v${run.tool.version} on ${formatDate(run.run.startedAt)}. docs: unused.dev`,
  );

  return `${lines.join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// HTML (self-contained: inline CSS, no external assets)
// ---------------------------------------------------------------------------

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const HTML_STYLE = `
  :root { color-scheme: light; }
  body {
    margin: 0; padding: 2.5rem 1.5rem; display: flex; justify-content: center;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
    background: #faf8f5; color: #2b2621;
  }
  main { width: 100%; max-width: 860px; }
  h1 { font-size: 1.5rem; margin: 0 0 0.25rem; }
  .meta { color: #6b6259; font-size: 0.9rem; margin: 0 0 1.5rem; }
  .privacy {
    background: #fbf3e0; border: 1px solid #e8d7a8; border-radius: 8px;
    padding: 0.75rem 1rem; font-size: 0.88rem; margin: 0 0 2rem;
  }
  .headline {
    display: flex; flex-wrap: wrap; gap: 1.25rem; margin: 0 0 2rem;
    padding: 1.25rem; background: #ffffff; border: 1px solid #e7e0d6; border-radius: 10px;
  }
  .stat .n { font-size: 1.6rem; font-weight: 700; display: block; }
  .stat .l { font-size: 0.82rem; color: #6b6259; }
  h2 { font-size: 1.05rem; margin: 2rem 0 0.75rem; border-bottom: 1px solid #e7e0d6; padding-bottom: 0.4rem; }
  table { width: 100%; border-collapse: collapse; font-size: 0.88rem; }
  th, td { text-align: left; padding: 0.4rem 0.6rem; border-bottom: 1px solid #eee5d8; }
  th { color: #6b6259; font-weight: 600; }
  code { background: #f1ece2; padding: 0.1rem 0.3rem; border-radius: 4px; font-size: 0.85em; }
  .badge { display: inline-block; width: 0.7em; text-align: center; }
  .high { color: #3f7d4a; } .medium { color: #a97a1f; } .low { color: #8a8074; }
  .breakdown span { display: inline-block; margin-right: 1.5rem; }
  footer { margin-top: 2.5rem; font-size: 0.82rem; color: #8a8074; }
  footer a { color: #6b5a3f; }
`;

function confidenceBadge(confidence: Claim["confidence"]): string {
  const glyph = confidence === "high" ? "●" : confidence === "medium" ? "◐" : "○";
  return `<span class="badge ${confidence}" title="${confidence} confidence">${glyph}</span> ${confidence}`;
}

export function renderReportHtml(ctx: ReportContext): string {
  const { run, repoName } = ctx;
  const h = computeHeadline(run);
  const top = topDeletions(run);
  const z = run.summary.zombieTests;
  const date = formatDate(run.run.startedAt);

  const statsHtml = [
    { n: `~${formatCount(run.summary.estDeletableLoc)}`, l: "deletable LOC" },
    { n: formatCount(h.unusedExports), l: `unused export${plural(h.unusedExports)}` },
    { n: formatCount(h.unusedFiles), l: `unused file${plural(h.unusedFiles)}` },
    { n: formatCount(h.unusedDeps), l: `unused dependenc${h.unusedDeps === 1 ? "y" : "ies"}` },
    { n: formatCount(h.testOnlySymbols), l: `test-only symbol${plural(h.testOnlySymbols)}` },
    ...(z !== undefined
      ? [
          {
            n: formatCount(z.count),
            l: `zombie test${plural(z.count)} (~${formatCount(z.estCiSecondsPerRun)}s CI/run, est.)`,
          },
        ]
      : []),
  ]
    .map(
      (s) =>
        `<div class="stat"><span class="n">${s.n}</span><span class="l">${escapeHtml(s.l)}</span></div>`,
    )
    .join("\n      ");

  const tableRows =
    top.length === 0
      ? `<tr><td colspan="5"><em>Nothing to show — no high/medium-confidence deletable claims in this run.</em></td></tr>`
      : top
          .map(
            (c) =>
              `<tr><td>${confidenceBadge(c.confidence)}</td>` +
              `<td><code>${escapeHtml(c.subject.name)}</code> (${escapeHtml(c.subject.kind)})</td>` +
              `<td><code>${escapeHtml(locLabel(c))}</code></td>` +
              `<td>${spanLines(c)}</td>` +
              `<td>${escapeHtml(whyText(c, false))}</td></tr>`,
          )
          .join("\n          ");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>unused deletion report — ${escapeHtml(repoName)}</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>${HTML_STYLE}</style>
</head>
<body>
<main>
  <h1>unused deletion report — ${escapeHtml(repoName)}</h1>
  <p class="meta">${escapeHtml(headerLine(ctx))}</p>
  <p class="privacy"><strong>Privacy:</strong> ${escapeHtml(PRIVACY_NOTE)}</p>

  <div class="headline">
      ${statsHtml}
  </div>

  <h2>Top deletions by LOC</h2>
  <table>
    <thead><tr><th>Confidence</th><th>Subject</th><th>Location</th><th>LOC</th><th>Why</th></tr></thead>
    <tbody>
          ${tableRows}
    </tbody>
  </table>

  <h2>Confidence breakdown</h2>
  <p class="breakdown">
    <span class="high">● high: ${formatCount(run.summary.byConfidence.high)}</span>
    <span class="medium">◐ medium: ${formatCount(run.summary.byConfidence.medium)}</span>
    <span class="low">○ low: ${formatCount(run.summary.byConfidence.low)}</span>
  </p>

  <footer>
    <p>${escapeHtml(ASSUMPTION_SET_NOTE)}</p>
    <p>Generated by unused v${escapeHtml(run.tool.version)} on ${date}. docs: <a href="https://unused.dev">unused.dev</a></p>
  </footer>
</main>
</body>
</html>
`;
}

// ---------------------------------------------------------------------------
// CLI confirmation line (`unused report`'s stdout, after the file is written)
// ---------------------------------------------------------------------------

/** The one-line stdout confirmation `unused report` prints after writing the artifact — reiterates the privacy note (report-and-badge.md §1: "warns before anyone shares it") so it's visible even without opening the file. */
export function renderReportConfirmation(run: ClaimRun, path: string, ascii: boolean): string {
  const dash = ascii ? "--" : "—";
  const bar = ascii ? " | " : " · ";
  const z = run.summary.zombieTests;
  const parts = [
    `${formatCount(run.claims.length)} claim${plural(run.claims.length)}`,
    `~${formatCount(run.summary.estDeletableLoc)} deletable LOC`,
  ];
  if (z !== undefined) parts.push(`${formatCount(z.count)} zombie test${plural(z.count)}`);
  return (
    `unused report: wrote ${path} (${parts.join(", ")}).\n` +
    `Contains file paths and symbol names from this repo ${dash} review before sharing outside your team.\n` +
    `next: \`unused badge\`${bar}docs: unused.dev\n`
  );
}
