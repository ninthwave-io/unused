/**
 * `unused report` tests (T9.3, docs/design/report-and-badge.md §1). Snapshot
 * both formats against a fixed, hand-built `ClaimRun` — deterministic
 * because `renderReportMarkdown`/`renderReportHtml` are pure functions of
 * their input (no internal clock), matching `reporters/tty.test.ts`'s
 * pattern (a fixed `run.startedAt` stands in for "clock injection").
 */
import { describe, expect, it } from "vitest";
import type { Claim, ClaimRun } from "../core/claims/index.js";
import {
  type ReportContext,
  renderReportConfirmation,
  renderReportHtml,
  renderReportMarkdown,
  reportDeletionPlanClaimIds,
} from "./report.js";

function claim(overrides: Partial<Claim> & Pick<Claim, "subject" | "verdict">): Claim {
  return {
    id: `id_${overrides.subject.name}`,
    language: "ts",
    confidence: "high",
    evidence: [
      { type: "static-reachability", detail: "no inbound refs", source: "reference-graph" },
    ],
    provenance: {
      analyzer: "ts-reference-graph",
      version: "0.1.0",
      generatedAt: "2026-07-18T09:12:07.210Z",
    },
    ...overrides,
  } as Claim;
}

function makeRun(claims: readonly Claim[], overrides: Partial<ClaimRun["summary"]> = {}): ClaimRun {
  return {
    schemaVersion: "1.1.0",
    tool: { name: "unused", version: "0.1.0" },
    run: {
      root: "/repo/acme-web",
      configHash: "abc",
      startedAt: "2026-07-18T09:12:03.000Z",
      durationMs: 4200,
      boundaries: [
        {
          status: "complete",
          pluginId: "language:typescript",
          boundaryId: "ts:.",
          language: "ts",
          fileCount: 1,
          workspaceCount: 1,
        },
      ],
    },
    claims,
    summary: {
      byKind: { export: 0, file: 0, dependency: 0, endpoint: 0, test: 0 },
      byConfidence: { high: 0, medium: 0, low: 0 },
      estDeletableLoc: 0,
      ...overrides,
    },
  };
}

const CTX_BASE = { repoName: "acme-web", fileCount: 1284, workspaceCount: 3 };

const formatCurrency = claim({
  id: "exp_1",
  subject: {
    kind: "export",
    name: "formatCurrency",
    loc: { file: "src/utils/currency.ts", span: [12, 24] },
  },
  verdict: "unused",
  confidence: "high",
});
const parseLegacyId = claim({
  id: "exp_2",
  subject: {
    kind: "export",
    name: "parseLegacyId",
    loc: { file: "src/utils/ids.ts", span: [44, 50] },
  },
  verdict: "unused",
  confidence: "high",
});
const getFlags = claim({
  id: "exp_3",
  subject: { kind: "export", name: "getFlags", loc: { file: "src/flags.ts", span: [9, 9] } },
  verdict: "unused",
  confidence: "medium",
});
const lowCandidate = claim({
  id: "exp_4",
  subject: {
    kind: "export",
    name: "oldHelper",
    loc: { file: "src/legacy/helper.ts", span: [1, 1] },
  },
  verdict: "unused",
  confidence: "low",
});
const orderMapper = claim({
  id: "exp_5",
  subject: {
    kind: "export",
    name: "OrderMapper",
    loc: { file: "src/orders/mapper.ts", span: [30, 40] },
  },
  verdict: "test-only",
  confidence: "high",
});
const zombieTest = claim({
  id: "tst_1",
  subject: { kind: "test", name: "orders.spec.ts", loc: { file: "orders.spec.ts", span: [1, 1] } },
  verdict: "test-only",
  confidence: "high",
});
const suppressedExport = claim({
  id: "exp_6",
  subject: { kind: "export", name: "keepForNow", loc: { file: "src/keep.ts", span: [1, 100] } },
  verdict: "unused",
  confidence: "high",
  suppression: { reason: "migration pending" },
});

describe("renderReportMarkdown", () => {
  const run = makeRun(
    [formatCurrency, parseLegacyId, getFlags, lowCandidate, orderMapper, zombieTest],
    {
      estDeletableLoc: 1840,
      byConfidence: { high: 4, medium: 1, low: 1 },
      zombieTests: { count: 1, estCiSecondsPerRun: 14, estimated: true, avgSecondsPerTestFile: 14 },
    },
  );
  const ctx: ReportContext = { run, ...CTX_BASE };

  it("matches the snapshot", () => {
    expect(renderReportMarkdown(ctx)).toMatchSnapshot();
  });

  it("includes the privacy note", () => {
    expect(renderReportMarkdown(ctx)).toContain("reveals file paths and symbol names");
  });

  it("top deletions excludes low confidence, test-only, and suppressed claims", () => {
    const withExtras = makeRun([formatCurrency, lowCandidate, orderMapper, suppressedExport], {
      estDeletableLoc: 13,
    });
    const text = renderReportMarkdown({ run: withExtras, ...CTX_BASE });
    expect(text).toContain("formatCurrency");
    expect(text).not.toContain("oldHelper"); // low confidence
    expect(text).not.toContain("OrderMapper"); // test-only, not an immediate deletion
    expect(text).not.toContain("keepForNow"); // suppressed
    expect(text).toContain("2 unused exports");
    expect(text).toContain("1 suppressed (excluded from totals above)");
  });

  it("ranks top deletions by LOC descending", () => {
    const text = renderReportMarkdown(ctx);
    const idxCurrency = text.indexOf("formatCurrency"); // span 12-24 = 13 lines
    const idxIds = text.indexOf("parseLegacyId"); // span 44-50 = 7 lines
    expect(idxCurrency).toBeGreaterThan(-1);
    expect(idxIds).toBeGreaterThan(-1);
    expect(idxCurrency).toBeLessThan(idxIds);
  });

  it("truncates to the top 10 deletions", () => {
    const many: Claim[] = Array.from({ length: 15 }, (_, i) =>
      claim({
        id: `exp_many_${i}`,
        subject: {
          kind: "export",
          name: `sym${i}`,
          loc: { file: `src/f${i}.ts`, span: [1, i + 1] },
        },
        verdict: "unused",
        confidence: "high",
      }),
    );
    const text = renderReportMarkdown({
      run: makeRun(many, { estDeletableLoc: 999 }),
      ...CTX_BASE,
    });
    const rows = text.split("\n").filter((l) => l.startsWith("| high |"));
    expect(rows).toHaveLength(10);
    expect(reportDeletionPlanClaimIds(makeRun(many)).size).toBe(10);
  });

  it("omits the zombie-tests headline line on a run with none", () => {
    const text = renderReportMarkdown({
      run: makeRun([formatCurrency], { estDeletableLoc: 13 }),
      ...CTX_BASE,
    });
    expect(text).not.toContain("zombie test");
  });

  it("renders a graceful empty state on a clean run", () => {
    const text = renderReportMarkdown({ run: makeRun([]), ...CTX_BASE });
    expect(text).toContain("Nothing to show");
    expect(text).toContain("~0 deletable LOC");
  });

  it("references the generated assumption-set doc", () => {
    expect(renderReportMarkdown(ctx)).toContain("docs/generated/assumption-set.md");
  });

  it("surfaces staged deletion consequences when plans are supplied", () => {
    const text = renderReportMarkdown({
      run: makeRun([formatCurrency]),
      ...CTX_BASE,
      deletionPlans: {
        [formatCurrency.id]: {
          schemaVersion: "1.3.0",
          selected: {
            kind: "export",
            file: formatCurrency.subject.loc.file,
            name: formatCurrency.subject.name,
          },
          supported: true,
          reExportEdits: [],
          stages: [{ stage: 1, newlyDead: [{ kind: "file", file: "src/legacy/currency.ts" }] }],
        },
      },
    });
    expect(text).toContain("## Deletion consequences");
    expect(text).toContain("1 newly dead subject across 1 stage");
  });
});

describe("renderReportHtml", () => {
  const run = makeRun([formatCurrency, parseLegacyId, getFlags, orderMapper, zombieTest], {
    estDeletableLoc: 1840,
    byConfidence: { high: 3, medium: 1, low: 0 },
    zombieTests: { count: 1, estCiSecondsPerRun: 14, estimated: true, avgSecondsPerTestFile: 14 },
  });
  const ctx: ReportContext = { run, ...CTX_BASE };

  it("matches the snapshot", () => {
    expect(renderReportHtml(ctx)).toMatchSnapshot();
  });

  it("is self-contained: no external stylesheet/script/font references", () => {
    const html = renderReportHtml(ctx);
    expect(html).not.toMatch(/<link\b/);
    expect(html).not.toMatch(/<script\b/);
    expect(html).not.toMatch(/https?:\/\/(?!unused\.dev)/); // only the unused.dev footer link
    expect(html).toContain("<style>");
  });

  it("escapes HTML-significant characters in subject names", () => {
    const dangerous = claim({
      id: "exp_x",
      subject: {
        kind: "export",
        name: "<script>evil()</script>",
        loc: { file: "src/x.ts", span: [1, 2] },
      },
      verdict: "unused",
      confidence: "high",
    });
    const html = renderReportHtml({
      run: makeRun([dangerous], { estDeletableLoc: 2 }),
      ...CTX_BASE,
    });
    expect(html).not.toContain("<script>evil()</script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("is valid enough to parse as a single well-formed document (doctype + closing tags)", () => {
    const html = renderReportHtml(ctx);
    expect(html.trimStart().startsWith("<!doctype html>")).toBe(true);
    expect(html.trim().endsWith("</html>")).toBe(true);
  });
});

describe("renderReportConfirmation", () => {
  it("summarises claim count, deletable LOC, and zombie tests, plus the privacy reminder", () => {
    const run = makeRun([formatCurrency], {
      estDeletableLoc: 13,
      zombieTests: { count: 2, estCiSecondsPerRun: 10, estimated: true, avgSecondsPerTestFile: 5 },
    });
    const text = renderReportConfirmation(run, ".unused/report.md", true);
    expect(text).toContain("wrote .unused/report.md");
    expect(text).toContain("1 claim");
    expect(text).toContain("~13 deletable LOC");
    expect(text).toContain("2 zombie tests");
    expect(text).toContain("review before sharing");
  });

  it("ascii mode never emits the unicode em dash", () => {
    const text = renderReportConfirmation(makeRun([]), ".unused/report.md", true);
    expect(text).not.toContain("—");
  });
});
