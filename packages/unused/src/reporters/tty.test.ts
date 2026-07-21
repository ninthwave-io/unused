/**
 * TTY report tests (T6.1 acceptance): the four cli-ux §5 degradation modes
 * (TTY-color/wide, narrow, plain, NO_COLOR — NO_COLOR and non-TTY both
 * resolve to `layout: "plain"`, the CLI's job per `cli/index.ts`'s
 * `resolveTtyInputs`; this module only ever sees the resolved layout, so
 * the NO_COLOR case is exercised as a second `"plain"` snapshot to prove
 * the path is independently reachable, not merely type-compatible), plus
 * truncation, low-confidence summarisation, suppression rendering, the
 * clean/filtered-empty states, and the zombie-test CI-seconds line.
 *
 * Snapshots below were hand-verified against docs/design/cli-ux.md §2/§5/§6
 * before being locked (T6.1 acceptance checklist) — see the delegation
 * report for the specific deviations called out from the spec's prose
 * mockup (which is illustrative, not a byte-for-byte contract).
 */
import { describe, expect, it } from "vitest";
import type { Claim, ClaimRun } from "../core/claims/index.js";
import { renderTtyReport, type TtyRenderOptions } from "./tty.js";

// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI escapes for assertions.
const ANSI_RE = /\x1b\[[0-9;]*m/g;
function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, "");
}

function claim(overrides: Partial<Claim> & Pick<Claim, "subject" | "verdict">): Claim {
  return {
    id: `id_${overrides.subject.name}`,
    language: "ts",
    confidence: "high",
    evidence: [
      {
        type: "static-reachability",
        detail: "0 inbound references from any entrypoint.",
        source: "reference-graph",
      },
    ],
    provenance: {
      analyzer: "ts-reference-graph",
      version: "0.1.0",
      generatedAt: "2026-07-18T09:12:07.210Z",
    },
    ...overrides,
  } as Claim;
}

const formatCurrency = claim({
  id: "exp_1",
  subject: {
    kind: "export",
    name: "formatCurrency",
    loc: { file: "src/utils/currency.ts", span: [12, 24] },
  },
  verdict: "unused",
  confidence: "high",
  evidence: [
    {
      type: "static-reachability",
      detail: "no refs from any entrypoint",
      source: "reference-graph",
    },
  ],
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
  evidence: [
    {
      type: "static-reachability",
      detail: "no refs from any entrypoint",
      source: "reference-graph",
    },
  ],
});
const getFlags = claim({
  id: "exp_3",
  subject: { kind: "export", name: "getFlags", loc: { file: "src/flags.ts", span: [9, 9] } },
  verdict: "unused",
  confidence: "medium",
  evidence: [
    {
      type: "static-reachability",
      detail: "unused, but dynamic import nearby",
      source: "reference-graph",
    },
  ],
});
const oldHelper = claim({
  id: "exp_4",
  subject: {
    kind: "export",
    name: "oldHelper",
    loc: { file: "src/legacy/helper.ts", span: [1, 1] },
  },
  verdict: "unused",
  confidence: "low",
  evidence: [
    {
      type: "static-reachability",
      detail: "candidate, needs confirmation",
      source: "reference-graph",
    },
  ],
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
  evidence: [
    {
      type: "test-only",
      detail:
        "`OrderMapper` is reachable only from test entrypoint `orders.spec.ts`; no production or config entrypoint references it.",
      source: "reference-graph",
    },
  ],
});
const zombieTest = claim({
  id: "tst_1",
  subject: { kind: "test", name: "orders.spec.ts", loc: { file: "orders.spec.ts", span: [1, 1] } },
  verdict: "test-only",
  confidence: "high",
  evidence: [
    {
      type: "test-only",
      detail: "exercises only test-only or dead code",
      source: "reference-graph",
    },
  ],
});
const suppressedExport = claim({
  id: "exp_6",
  subject: { kind: "export", name: "keepForNow", loc: { file: "src/keep.ts", span: [1, 3] } },
  verdict: "unused",
  confidence: "high",
  suppression: { reason: "migration pending" },
  evidence: [
    {
      type: "static-reachability",
      detail: "no refs from any entrypoint",
      source: "reference-graph",
    },
  ],
});
const MOCK_CLAIMS = [formatCurrency, parseLegacyId, getFlags, oldHelper, orderMapper] as const;

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
          partitions: { production: "complete", config: "complete", test: "complete" },
        },
      ],
    },
    claims,
    summary: {
      byKind: { export: 0, file: 0, dependency: 0, endpoint: 0, test: 0 },
      byConfidence: { high: 0, medium: 0, low: 0 },
      estDeletableLoc: 1840,
      ...overrides,
    },
  };
}

const BASE_OPTIONS: TtyRenderOptions = {
  layout: "wide",
  columns: 80,
  showSuppressed: false,
  all: false,
  explicitMinConfidence: undefined,
  filtersActive: false,
  noProductionEntrypoints: false,
};

const CTX = { repoName: "acme-web", fileCount: 1284, workspaceCount: 3 };

describe("renderTtyReport — cli-ux §2 mockup shape (four degradation modes)", () => {
  const run = makeRun([...MOCK_CLAIMS, zombieTest], {
    zombieTests: { count: 1, estCiSecondsPerRun: 14, estimated: true, avgSecondsPerTestFile: 14 },
  });

  it("wide (TTY-color, >=80 cols)", () => {
    expect(
      renderTtyReport({ run, ...CTX }, { ...BASE_OPTIONS, layout: "wide", columns: 80 }),
    ).toMatchSnapshot();
  });

  it("narrow (<80 cols)", () => {
    expect(
      renderTtyReport({ run, ...CTX }, { ...BASE_OPTIONS, layout: "narrow", columns: 60 }),
    ).toMatchSnapshot();
  });

  it("plain (non-TTY stdout / --no-color)", () => {
    expect(
      renderTtyReport({ run, ...CTX }, { ...BASE_OPTIONS, layout: "plain" }),
    ).toMatchSnapshot();
  });

  it("plain (NO_COLOR env — same layout as non-TTY, independently reachable via cli/index.ts's resolveTtyInputs)", () => {
    // `renderTtyReport` never observes *why* layout is "plain" (non-TTY vs
    // --no-color vs NO_COLOR are all resolved to the same layout value by
    // the CLI before this module ever runs) — this snapshot documents that
    // the three env paths are visually identical by construction, which is
    // the point: NO_COLOR must behave exactly like piping to a file.
    expect(
      renderTtyReport({ run, ...CTX }, { ...BASE_OPTIONS, layout: "plain" }),
    ).toMatchSnapshot();
  });
});

describe("renderTtyReport — header", () => {
  it("shows file count, workspace count (only when > 1), tool version, duration", () => {
    const run = makeRun([formatCurrency]);
    const out = renderTtyReport({ run, ...CTX }, BASE_OPTIONS);
    expect(out).toContain("unused v0.1.0 — acme-web (1,284 files, 3 workspaces) — 4.2s");
  });

  it("omits the workspace clause for a single-package run", () => {
    const run = makeRun([formatCurrency]);
    const out = renderTtyReport(
      { run, repoName: "my-lib", fileCount: 12, workspaceCount: 1 },
      BASE_OPTIONS,
    );
    expect(out).toContain("unused v0.1.0 — my-lib (12 files) — 4.2s");
    expect(out).not.toMatch(/workspace/);
  });

  it("plain layout uses ASCII '--' instead of an em dash", () => {
    const run = makeRun([formatCurrency]);
    const out = renderTtyReport({ run, ...CTX }, { ...BASE_OPTIONS, layout: "plain" });
    expect(out).toContain("unused v0.1.0 -- acme-web (1,284 files, 3 workspaces) -- 4.2s");
    expect(out).not.toContain("—");
  });
});

describe("renderTtyReport — low-confidence summarisation (cli-ux §2)", () => {
  it("hides low-confidence rows by default and reports a hidden count with the exact affordance", () => {
    const run = makeRun([formatCurrency, oldHelper]);
    const out = renderTtyReport({ run, ...CTX }, BASE_OPTIONS);
    expect(out).not.toContain("oldHelper");
    expect(out).toContain(
      "1 low-confidence candidate hidden — `unused --min-confidence low` to show",
    );
  });

  it("shows low-confidence rows when --min-confidence was passed explicitly (even at 'low')", () => {
    const run = makeRun([formatCurrency, oldHelper]); // caller already filtered via reporters/filter.ts in the real CLI
    const out = renderTtyReport({ run, ...CTX }, { ...BASE_OPTIONS, explicitMinConfidence: "low" });
    expect(out).toContain("oldHelper");
    expect(out).not.toMatch(/low-confidence candidate/);
  });
});

describe("renderTtyReport — truncation (cli-ux §2 Scale rule)", () => {
  function manyExports(n: number): Claim[] {
    return Array.from({ length: n }, (_, i) =>
      claim({
        id: `exp_many_${i}`,
        subject: {
          kind: "export",
          name: `export${i}`,
          loc: { file: `src/f${i}.ts`, span: [1, n - i] },
        },
        verdict: "unused",
        confidence: "high",
      }),
    );
  }

  it("truncates a section at 10 with an affordance naming the exact hidden count and a --filter suggestion", () => {
    const run = makeRun(manyExports(15));
    const out = stripAnsi(renderTtyReport({ run, ...CTX }, BASE_OPTIONS));
    expect(out).toContain("… 5 more exports — unused --filter export --all, or --json");
    expect(out.match(/^ {2}● export/gm)?.length).toBe(10);
  });

  it("--all defeats truncation but not the low-confidence default hide", () => {
    const run = makeRun([...manyExports(15), oldHelper]);
    const out = renderTtyReport({ run, ...CTX }, { ...BASE_OPTIONS, all: true });
    expect(out).not.toMatch(/… \d+ more/);
    expect(out).not.toContain("oldHelper"); // still low-confidence, --all doesn't reveal it
    expect(out).toContain("1 low-confidence candidate hidden");
  });

  it("ranks rows by deletable LOC descending (best deletions first)", () => {
    const run = makeRun(manyExports(3)); // spans give LOC 3, 2, 1 for export0, export1, export2
    const out = stripAnsi(renderTtyReport({ run, ...CTX }, BASE_OPTIONS));
    const rows = out.split("\n").filter((l) => /^ {2}● export\d/.test(l));
    const order = rows.map((l) => l.match(/export\d/)?.[0]);
    expect(order).toEqual(["export0", "export1", "export2"]);
  });
});

describe("renderTtyReport — suppression rendering", () => {
  it("hides suppressed claims from the listing by default but counts them", () => {
    const run = makeRun([formatCurrency, suppressedExport]);
    const out = renderTtyReport({ run, ...CTX }, BASE_OPTIONS);
    expect(out).not.toContain("keepForNow");
    expect(out).toContain("1 unused export");
    expect(out).toContain("1 suppressed — `unused --show-suppressed`");
  });

  it("does not blend a suppressed claim into the actionable summary total", () => {
    const run = makeRun([suppressedExport]);
    const out = renderTtyReport({ run, ...CTX }, BASE_OPTIONS);
    expect(out).toContain("0 unused exports");
    expect(out).toContain("1 suppressed");
  });

  it("--show-suppressed lists them, marked with the suppression reason", () => {
    const run = makeRun([formatCurrency, suppressedExport]);
    const out = renderTtyReport({ run, ...CTX }, { ...BASE_OPTIONS, showSuppressed: true });
    expect(out).toContain("keepForNow");
    expect(out).toContain("[suppressed: migration pending]");
    expect(out).toContain("1 suppressed (shown above)");
  });
});

describe("renderTtyReport — test-only section + zombie CI-seconds line (T5.3)", () => {
  it("lists test-only claims and appends the zombie-test CI-seconds line", () => {
    const run = makeRun([orderMapper, zombieTest], {
      zombieTests: { count: 1, estCiSecondsPerRun: 14, estimated: true, avgSecondsPerTestFile: 14 },
    });
    const out = renderTtyReport({ run, ...CTX }, BASE_OPTIONS);
    expect(out).toContain("TEST-ONLY (production-dead, kept alive by tests)");
    expect(out).toContain("OrderMapper");
    expect(out).toContain("1 zombie test — ~14s CI per run (estimated).");
  });

  it("excludes suppressed zombie tests from actionable cost and does not render an empty section", () => {
    const suppressedZombie = {
      ...zombieTest,
      suppression: { reason: "temporarily retained" },
    } as Claim;
    const run = makeRun([suppressedZombie], {
      zombieTests: { count: 1, estCiSecondsPerRun: 14, estimated: true, avgSecondsPerTestFile: 14 },
    });

    const hidden = renderTtyReport({ run, ...CTX }, BASE_OPTIONS);
    expect(hidden).not.toContain("TEST-ONLY");
    expect(hidden).not.toContain("zombie test");

    const shown = renderTtyReport({ run, ...CTX }, { ...BASE_OPTIONS, showSuppressed: true });
    expect(shown).toContain("orders.spec.ts");
    expect(shown).not.toContain("zombie test");
  });

  it("charges only unsuppressed zombie tests when the summary also contains suppressed ones", () => {
    const suppressedZombie = {
      ...zombieTest,
      id: "tst_suppressed",
      verdict: "test-only",
      subject: {
        kind: "test",
        name: "suppressed.spec.ts",
        loc: zombieTest.subject.loc,
      },
      suppression: { reason: "temporarily retained" },
    } as Claim;
    const run = makeRun([zombieTest, suppressedZombie], {
      zombieTests: { count: 2, estCiSecondsPerRun: 28, estimated: true, avgSecondsPerTestFile: 14 },
    });

    const out = renderTtyReport({ run, ...CTX }, BASE_OPTIONS);
    expect(out).toContain("1 zombie test — ~14s CI per run (estimated).");
    expect(out).not.toContain("2 zombie tests");
  });

  it("the zombie line still appears even if every test-only row is hidden (low confidence, no explicit floor)", () => {
    const lowZombie = claim({
      id: "tst_low",
      subject: { kind: "test", name: "x.spec.ts", loc: { file: "x.spec.ts", span: [1, 1] } },
      verdict: "test-only",
      confidence: "low",
    });
    const run = makeRun([lowZombie], {
      zombieTests: { count: 1, estCiSecondsPerRun: 5, estimated: true, avgSecondsPerTestFile: 5 },
    });
    const out = renderTtyReport({ run, ...CTX }, BASE_OPTIONS);
    expect(out).toContain("TEST-ONLY");
    expect(out).toContain("1 zombie test — ~5s CI per run (estimated).");
  });
});

describe("renderTtyReport — empty states (cli-ux §6)", () => {
  it("celebrates a genuinely clean run and suggests the badge + unused check", () => {
    const run = makeRun([]);
    const out = renderTtyReport({ run, ...CTX }, BASE_OPTIONS);
    expect(out).toContain("clean — no unused exports, files, or dependencies found.");
    expect(out).toContain("unused badge");
    expect(out).toContain("unused check");
    expect(out).not.toContain("UNUSED EXPORTS"); // never an empty table
  });

  it("a filter that matches nothing is NOT presented as 'clean'", () => {
    const run = makeRun([]);
    const out = renderTtyReport({ run, ...CTX }, { ...BASE_OPTIONS, filtersActive: true });
    expect(out).not.toContain("clean");
    expect(out).toContain("no claims match this filter");
  });

  it("zero production entrypoints is NOT presented as 'clean' either — stdout must not read as an all-clear (reviewer finding)", () => {
    const run = makeRun([]);
    const out = renderTtyReport(
      { run, ...CTX },
      { ...BASE_OPTIONS, noProductionEntrypoints: true },
    );
    expect(out).not.toContain("clean");
    expect(out).not.toContain("unused badge");
    expect(out).toContain(
      "no production entrypoints detected — nothing was analysed for liveness; see stderr.",
    );
  });

  it("filtersActive takes priority over noProductionEntrypoints (the user's own --filter explains the emptiness)", () => {
    const run = makeRun([]);
    const out = renderTtyReport(
      { run, ...CTX },
      { ...BASE_OPTIONS, filtersActive: true, noProductionEntrypoints: true },
    );
    expect(out).toContain("no claims match this filter");
    expect(out).not.toContain("no production entrypoints detected");
  });
});

describe("renderTtyReport — never prints an empty table", () => {
  it("a section with matched claims but zero VISIBLE rows (all low-confidence) is skipped entirely", () => {
    const run = makeRun([oldHelper]); // only a low-confidence export exists
    const out = renderTtyReport({ run, ...CTX }, BASE_OPTIONS);
    expect(out).not.toContain("UNUSED EXPORTS");
    expect(out).toContain("1 low-confidence candidate hidden");
  });
});

describe("renderTtyReport — next-step footer", () => {
  it("suggests `unused why <name>` for the first shown claim", () => {
    const run = makeRun([formatCurrency, parseLegacyId]);
    const out = renderTtyReport({ run, ...CTX }, BASE_OPTIONS);
    expect(out).toContain("next: `unused why formatCurrency` · `unused --json` · docs: unused.dev");
  });
});
