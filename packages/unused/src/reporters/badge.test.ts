/**
 * `unused badge` tests (T9.3, docs/design/report-and-badge.md §2). Exercises
 * the exact states the spec calls out by name: `clean` at zero high, a
 * 0-high/5-medium repo still `clean`, and `N claims` at N high — plus the
 * suppression judgment call documented in `badge.ts`'s module docstring.
 */
import { describe, expect, it } from "vitest";
import type { Claim, ClaimRun } from "../core/claims/index.js";
import { type BadgeJson, computeBadge, renderBadgeConfirmation, renderBadgeJson } from "./badge.js";

function claim(overrides: Partial<Claim> & Pick<Claim, "subject" | "verdict">): Claim {
  return {
    id: `id_${overrides.subject.name}`,
    confidence: "high",
    evidence: [
      { type: "static-reachability", detail: "no inbound refs", source: "reference-graph" },
    ],
    provenance: {
      analyzer: "ts-reference-graph",
      version: "0.1.0",
      generatedAt: "2026-07-18T00:00:00.000Z",
    },
    ...overrides,
  } as Claim;
}

function makeRun(claims: readonly Claim[]): ClaimRun {
  return {
    schemaVersion: "1.1.0",
    tool: { name: "unused", version: "0.1.0" },
    run: {
      root: "/repo",
      configHash: "abc",
      startedAt: "2026-07-18T09:12:03.000Z",
      durationMs: 100,
    },
    claims,
    summary: {
      byKind: { export: 0, file: 0, dependency: 0, endpoint: 0, test: 0 },
      byConfidence: { high: 0, medium: 0, low: 0 },
      estDeletableLoc: 0,
    },
  };
}

function exportClaim(
  name: string,
  confidence: Claim["confidence"],
  extra: Partial<Omit<Claim, "subject" | "verdict">> = {},
): Claim {
  return claim({
    subject: { kind: "export", name, loc: { file: `src/${name}.ts`, span: [1, 2] } },
    verdict: "unused",
    confidence,
    ...extra,
  });
}

describe("computeBadge", () => {
  it("never analysed / zero claims -> clean, green", () => {
    const badge = computeBadge(makeRun([]));
    expect(badge).toEqual<BadgeJson>({
      schemaVersion: 1,
      label: "unused",
      message: "clean",
      color: "green",
    });
  });

  it("0-high/5-medium repo shows clean (report-and-badge.md §2's explicit example)", () => {
    const claims = Array.from({ length: 5 }, (_, i) => exportClaim(`m${i}`, "medium"));
    const badge = computeBadge(makeRun(claims));
    expect(badge.message).toBe("clean");
    expect(badge.color).toBe("green");
  });

  it("low-confidence claims never count toward the badge either", () => {
    const claims = [exportClaim("a", "low"), exportClaim("b", "low"), exportClaim("c", "medium")];
    const badge = computeBadge(makeRun(claims));
    expect(badge.message).toBe("clean");
  });

  it("N high-confidence claims -> 'N claims', blue", () => {
    const claims = [exportClaim("a", "high"), exportClaim("b", "high"), exportClaim("c", "medium")];
    const badge = computeBadge(makeRun(claims));
    expect(badge.message).toBe("2 claims");
    expect(badge.color).toBe("blue");
  });

  it("singular: exactly 1 high-confidence claim -> '1 claim', not '1 claims'", () => {
    const badge = computeBadge(makeRun([exportClaim("a", "high")]));
    expect(badge.message).toBe("1 claim");
  });

  it("counts a suppressed high-confidence claim too — not silently dropped (PRD §4/§6, badge.ts docstring)", () => {
    const claims = [exportClaim("a", "high", { suppression: { reason: "accepted debt" } })];
    const badge = computeBadge(makeRun(claims));
    expect(badge.message).toBe("1 claim");
    expect(badge.color).toBe("blue");
  });

  it("counts every subject kind and verdict at high confidence, not just unused exports", () => {
    const claims = [
      claim({
        subject: { kind: "file", name: "src/dead.ts", loc: { file: "src/dead.ts", span: [1, 5] } },
        verdict: "unused",
        confidence: "high",
      }),
      claim({
        subject: { kind: "test", name: "t.spec.ts", loc: { file: "t.spec.ts", span: [1, 1] } },
        verdict: "test-only",
        confidence: "high",
      }),
    ];
    const badge = computeBadge(makeRun(claims));
    expect(badge.message).toBe("2 claims");
  });
});

describe("renderBadgeJson", () => {
  it("emits the shields.io endpoint schema (schemaVersion 1, label unused)", () => {
    const parsed = JSON.parse(renderBadgeJson(makeRun([])));
    expect(parsed).toEqual({ schemaVersion: 1, label: "unused", message: "clean", color: "green" });
  });

  it("is pretty-printed with a trailing newline (legible git diff)", () => {
    const text = renderBadgeJson(makeRun([]));
    expect(text.endsWith("\n")).toBe(true);
    expect(text).toContain("\n  ");
  });
});

describe("renderBadgeConfirmation", () => {
  it("reports the path and the badge message", () => {
    const text = renderBadgeConfirmation(
      { schemaVersion: 1, label: "unused", message: "3 claims", color: "blue" },
      ".unused/badge.json",
    );
    expect(text).toBe("unused badge: wrote .unused/badge.json (3 claims).\n");
  });
});
