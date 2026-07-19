/**
 * `renderWhy` snapshot tests (T8.2, cli-ux §4). Crafted view inputs so the
 * exact terminal format is locked independently of the analysis pipeline — the
 * fixture-driven end-to-end path lives in the CLI integration test.
 */
import { describe, expect, it } from "vitest";
import { renderHop, renderWhy, renderWhyPath, type WhyReportInput } from "./why.js";

const ALIVE_PROD: WhyReportInput = {
  outcome: "alive",
  query: "OrderMapper",
  subject: { kind: "export", file: "src/orders/mapper.ts", name: "OrderMapper", line: 30 },
  entrypointKind: "production",
  testOnly: false,
  paths: [
    {
      entrypointKind: "production",
      entrypointReason: "main",
      hops: [
        { file: "src/index.ts", entrypoint: { kind: "production", reason: "main" } },
        { file: "src/app.ts" },
        { file: "src/orders/mapper.ts", line: 30, symbol: "OrderMapper" },
      ],
    },
  ],
};

const TEST_ONLY: WhyReportInput = {
  outcome: "alive",
  query: "helper",
  subject: { kind: "export", file: "src/helper.ts", name: "helper", line: 3 },
  entrypointKind: "test",
  testOnly: true,
  paths: [
    {
      entrypointKind: "test",
      entrypointReason: "test-file",
      hops: [
        { file: "src/helper.spec.ts", entrypoint: { kind: "test", reason: "test-file" } },
        { file: "src/helper.ts", line: 3, symbol: "helper" },
      ],
    },
  ],
};

const DEAD_CLEAN: WhyReportInput = {
  outcome: "dead",
  query: "subtract",
  subject: { kind: "export", file: "src/math.ts", name: "subtract", line: 6 },
  verdict: "unused",
  confidence: "high",
  evidence: [
    {
      type: "static-reachability",
      detail:
        "0 inbound references to `subtract` from any production entrypoint in the reference graph.",
      source: "reference-graph",
    },
  ],
  hazards: [],
};

const DEAD_HAZARD: WhyReportInput = {
  outcome: "dead",
  query: "src/mods/alpha.ts",
  subject: { kind: "file", file: "src/mods/alpha.ts" },
  verdict: "unused",
  confidence: "medium",
  evidence: [
    {
      type: "static-reachability",
      detail: "0 inbound references to `src/mods/alpha.ts` ...; capped medium.",
      source: "reference-graph",
    },
  ],
  hazards: [
    {
      hazardClass: "computed-dynamic-import",
      detail: "dynamic import() with a computed (non-string-literal) specifier",
      site: "src/index.ts:4",
    },
  ],
};

const AMBIGUOUS: WhyReportInput = {
  outcome: "ambiguous",
  query: "dup",
  candidates: [
    { kind: "export", label: "src/a.ts:dup", file: "src/a.ts", name: "dup" },
    { kind: "export", label: "src/b.ts:dup", file: "src/b.ts", name: "dup" },
  ],
};

const NOT_FOUND: WhyReportInput = { outcome: "not-found", query: "ghost" };

describe("renderHop / renderWhyPath", () => {
  it("renders a symbol hop, a file hop, and an entrypoint hop", () => {
    expect(renderHop({ file: "src/a.ts", line: 3, symbol: "x" })).toBe("src/a.ts:3 x");
    expect(renderHop({ file: "src/a.ts" })).toBe("src/a.ts");
    expect(
      renderHop({ file: "src/a.ts", entrypoint: { kind: "production", reason: "main" } }),
    ).toBe("src/a.ts (production entrypoint)");
  });

  it("joins hops with the unicode arrow (or -> in ascii)", () => {
    const path = ALIVE_PROD.outcome === "alive" ? ALIVE_PROD.paths[0] : undefined;
    if (path === undefined) throw new Error("unreachable");
    expect(renderWhyPath(path, false)).toBe(
      "src/index.ts (production entrypoint) → src/app.ts → src/orders/mapper.ts:30 OrderMapper",
    );
    expect(renderWhyPath(path, true)).toBe(
      "src/index.ts (production entrypoint) -> src/app.ts -> src/orders/mapper.ts:30 OrderMapper",
    );
  });
});

describe("renderWhy", () => {
  it("alive (production)", () => {
    expect(renderWhy(ALIVE_PROD, false)).toMatchInlineSnapshot(`
      "src/orders/mapper.ts:30 OrderMapper — alive

        reachable from a production entrypoint:
          src/index.ts (production entrypoint) → src/app.ts → src/orders/mapper.ts:30 OrderMapper
      "
    `);
  });

  it("test-only (tier-2 note)", () => {
    expect(renderWhy(TEST_ONLY, false)).toMatchInlineSnapshot(`
      "src/helper.ts:3 helper — test-only (production-dead, kept alive by tests)

        reachable only from a test entrypoint:
          src/helper.spec.ts (test entrypoint) → src/helper.ts:3 helper

        tier-2: no production or config entrypoint reaches this. It is alive only
        because a test imports it — deleting it (and its zombie test) removes dead weight.
      "
    `);
  });

  it("dead (clean, high confidence, no hazards)", () => {
    expect(renderWhy(DEAD_CLEAN, false)).toMatchInlineSnapshot(`
      "src/math.ts:6 subtract — unused (confidence: high)

        evidence:
          - 0 inbound references to \`subtract\` from any production entrypoint in the reference graph.

        hazards checked near this subject: none — no dynamic-reference hazard was
        found nearby, so the static verdict stands.
      "
    `);
  });

  it("dead (medium, with a hazard class listed)", () => {
    expect(renderWhy(DEAD_HAZARD, false)).toMatchInlineSnapshot(`
      "src/mods/alpha.ts — unused (confidence: medium)

        evidence:
          - 0 inbound references to \`src/mods/alpha.ts\` ...; capped medium.

        hazards checked near this subject:
          - computed-dynamic-import: dynamic import() with a computed (non-string-literal) specifier (src/index.ts:4)
      "
    `);
  });

  it("ambiguous (candidate list)", () => {
    expect(renderWhy(AMBIGUOUS, false)).toMatchInlineSnapshot(`
      "unused why: "dup" is ambiguous — 2 candidates. Re-ask with one of:
        unused why src/a.ts:dup
        unused why src/b.ts:dup
      "
    `);
  });

  it("not-found", () => {
    expect(renderWhy(NOT_FOUND, false)).toMatchInlineSnapshot(`
      "unused why: no symbol or file matching "ghost" found in this project.
        Try a bare export name, a file path, or file.ts:exportName.
      "
    `);
  });
});
