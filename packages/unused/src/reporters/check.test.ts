/**
 * `unused check` output tests (T7.2, docs/design/cli-ux.md §3): the pass/
 * fail verdict lines, NEW-claim rows, the mismatch warning, the resolved-
 * count feel-good line, and the suppressed-new-claim carve-out.
 */
import { describe, expect, it } from "vitest";
import type { BaselineDiff, Claim } from "../core/claims/index.js";
import { type CheckVersionMismatch, renderCheckReport } from "./check.js";

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

const NO_MISMATCH: CheckVersionMismatch = {
  analyzer: undefined,
  idVersion: undefined,
  schema: undefined,
  configHash: false,
};

const BASELINE_META = {
  generatedAt: "2026-07-01T09:00:00.000Z",
  analyzerVersion: "0.1.0",
  claimCount: 41,
};

function emptyDiff(overrides: Partial<BaselineDiff> = {}): BaselineDiff {
  return { newClaims: [], newSuppressedClaims: [], resolvedCount: 0, ...overrides };
}

describe("renderCheckReport — pass/fail verdict lines (cli-ux §3 literal wording)", () => {
  it("passes: exact cli-ux §3 wording, exit 0", () => {
    const text = renderCheckReport({
      kind: "evaluated",
      ascii: false,
      threshold: "high",
      baseline: BASELINE_META,
      diff: emptyDiff(),
      mismatch: NO_MISMATCH,
    });
    expect(text).toContain("✓ no new dead weight since baseline — exit 0");
  });

  it("fails: exact cli-ux §3 literal example wording for the default (high) threshold", () => {
    const a = claim({
      subject: { kind: "export", name: "a", loc: { file: "src/a.ts", span: [1, 2] } },
      verdict: "unused",
    });
    const b = claim({
      subject: { kind: "export", name: "b", loc: { file: "src/b.ts", span: [1, 2] } },
      verdict: "unused",
    });
    const text = renderCheckReport({
      kind: "evaluated",
      ascii: false,
      threshold: "high",
      baseline: BASELINE_META,
      diff: emptyDiff({ newClaims: [a, b] }),
      mismatch: NO_MISMATCH,
    });
    expect(text).toContain(
      "✗ 2 new high-confidence claims since baseline (2026-07-01, 41 claims) — exit 1",
    );
  });

  it("singular new claim uses singular wording", () => {
    const a = claim({
      subject: { kind: "export", name: "a", loc: { file: "src/a.ts", span: [1, 2] } },
      verdict: "unused",
    });
    const text = renderCheckReport({
      kind: "evaluated",
      ascii: false,
      threshold: "high",
      baseline: BASELINE_META,
      diff: emptyDiff({ newClaims: [a] }),
      mismatch: NO_MISMATCH,
    });
    expect(text).toContain("✗ 1 new high-confidence claim since baseline");
  });

  it("ascii mode uses plain ASCII markers and dashes, never unicode", () => {
    const text = renderCheckReport({
      kind: "evaluated",
      ascii: true,
      threshold: "high",
      baseline: BASELINE_META,
      diff: emptyDiff(),
      mismatch: NO_MISMATCH,
    });
    expect(text).toContain("PASS no new dead weight since baseline -- exit 0");
    expect(text).not.toMatch(/[✓✗—]/);
  });

  it("prints every NEW claim, one line per claim, same one-line-why grammar as the default report", () => {
    const a = claim({
      subject: { kind: "export", name: "leaked", loc: { file: "src/a.ts", span: [3, 5] } },
      verdict: "unused",
      evidence: [
        { type: "static-reachability", detail: "0 inbound refs", source: "reference-graph" },
      ],
    });
    const text = renderCheckReport({
      kind: "evaluated",
      ascii: true,
      threshold: "high",
      baseline: BASELINE_META,
      diff: emptyDiff({ newClaims: [a] }),
      mismatch: NO_MISMATCH,
    });
    expect(text).toContain("unused  export  leaked  src/a.ts:3  high  0 inbound refs");
  });

  it("always shows baseline metadata (date, claim count, analyzer version)", () => {
    const text = renderCheckReport({
      kind: "evaluated",
      ascii: true,
      threshold: "high",
      baseline: BASELINE_META,
      diff: emptyDiff(),
      mismatch: NO_MISMATCH,
    });
    expect(text).toContain("baseline: 2026-07-01 (41 claims, analyzer 0.1.0)");
  });
});

describe("renderCheckReport — threshold wording", () => {
  it("a medium threshold gets 'medium-confidence-or-above' wording, not 'high-confidence'", () => {
    const a = claim({
      subject: {
        kind: "file",
        name: "src/mods/gamma.ts",
        loc: { file: "src/mods/gamma.ts", span: [1, 3] },
      },
      verdict: "unused",
      confidence: "medium",
    });
    const text = renderCheckReport({
      kind: "evaluated",
      ascii: true,
      threshold: "medium",
      baseline: BASELINE_META,
      diff: emptyDiff({ newClaims: [a] }),
      mismatch: NO_MISMATCH,
    });
    expect(text).toContain("1 new medium-confidence-or-above claim since baseline");
  });
});

describe("renderCheckReport — resolved claims (feel-good, non-gating)", () => {
  it("shows the resolved count when > 0", () => {
    const text = renderCheckReport({
      kind: "evaluated",
      ascii: true,
      threshold: "high",
      baseline: BASELINE_META,
      diff: emptyDiff({ resolvedCount: 3 }),
      mismatch: NO_MISMATCH,
    });
    expect(text).toContain("3 claims resolved since baseline.");
    expect(text).toContain("PASS no new dead weight"); // resolved claims never affect the verdict
  });

  it("omits the resolved line entirely when 0", () => {
    const text = renderCheckReport({
      kind: "evaluated",
      ascii: true,
      threshold: "high",
      baseline: BASELINE_META,
      diff: emptyDiff(),
      mismatch: NO_MISMATCH,
    });
    expect(text).not.toContain("resolved since baseline");
  });
});

describe("renderCheckReport — suppressed new claims (escape hatch, never gates)", () => {
  it("lists a new suppressed claim separately and still passes", () => {
    const suppressed = claim({
      subject: { kind: "export", name: "withReason", loc: { file: "src/legacy.ts", span: [1, 2] } },
      verdict: "unused",
      suppression: { reason: "migration pending" },
    });
    const text = renderCheckReport({
      kind: "evaluated",
      ascii: true,
      threshold: "high",
      baseline: BASELINE_META,
      diff: emptyDiff({ newSuppressedClaims: [suppressed] }),
      mismatch: NO_MISMATCH,
    });
    expect(text).toContain("suppressed, not gated");
    expect(text).toContain("withReason");
    expect(text).toContain("PASS no new dead weight since baseline -- exit 0");
  });
});

describe("renderCheckReport — version-stamp mismatch warning (PRD §4 graceful degrade)", () => {
  it("warns on an analyzer-version mismatch but still passes on a clean diff", () => {
    const text = renderCheckReport({
      kind: "evaluated",
      ascii: true,
      threshold: "high",
      baseline: BASELINE_META,
      diff: emptyDiff(),
      mismatch: { ...NO_MISMATCH, analyzer: { baseline: "0.1.0", current: "0.2.0" } },
    });
    expect(text).toContain("analyzer version: baseline 0.1.0, current 0.2.0");
    expect(text).toContain("re-baseline");
    expect(text).toContain("PASS no new dead weight since baseline -- exit 0");
  });

  it("warns on an idVersion mismatch", () => {
    const text = renderCheckReport({
      kind: "evaluated",
      ascii: true,
      threshold: "high",
      baseline: BASELINE_META,
      diff: emptyDiff(),
      mismatch: { ...NO_MISMATCH, idVersion: { baseline: 1, current: 2 } },
    });
    expect(text).toContain("claim id recipe (idVersion): baseline 1, current 2");
  });

  it("warns on a schemaVersion mismatch", () => {
    const text = renderCheckReport({
      kind: "evaluated",
      ascii: true,
      threshold: "high",
      baseline: BASELINE_META,
      diff: emptyDiff(),
      mismatch: { ...NO_MISMATCH, schema: { baseline: "1.0.0", current: "1.1.0" } },
    });
    expect(text).toContain("schema version: baseline 1.0.0, current 1.1.0");
  });

  it("warns on a configHash mismatch (config changed underneath the baseline)", () => {
    const text = renderCheckReport({
      kind: "evaluated",
      ascii: true,
      threshold: "high",
      baseline: BASELINE_META,
      diff: emptyDiff(),
      mismatch: { ...NO_MISMATCH, configHash: true },
    });
    expect(text).toContain("config: changed since baseline (configHash differs)");
  });

  it("no warning block at all when nothing mismatches", () => {
    const text = renderCheckReport({
      kind: "evaluated",
      ascii: true,
      threshold: "high",
      baseline: BASELINE_META,
      diff: emptyDiff(),
      mismatch: NO_MISMATCH,
    });
    expect(text).not.toMatch(/different conditions/);
  });
});

describe("renderCheckReport — remediation (failure always teaches a next step)", () => {
  it("shows remediation guidance only when there is a gating new claim", () => {
    const a = claim({
      subject: { kind: "export", name: "a", loc: { file: "src/a.ts", span: [1, 2] } },
      verdict: "unused",
    });
    const failing = renderCheckReport({
      kind: "evaluated",
      ascii: true,
      threshold: "high",
      baseline: BASELINE_META,
      diff: emptyDiff({ newClaims: [a] }),
      mismatch: NO_MISMATCH,
    });
    expect(failing).toContain("remediation:");
    expect(failing).toContain("unused:ignore <reason>");
    expect(failing).toContain("re-baseline on main");

    const passing = renderCheckReport({
      kind: "evaluated",
      ascii: true,
      threshold: "high",
      baseline: BASELINE_META,
      diff: emptyDiff(),
      mismatch: NO_MISMATCH,
    });
    expect(passing).not.toContain("remediation:");
  });
});

describe("renderCheckReport — kind: 'gate-not-evaluated' (reviewer fix: idVersion/schemaVersion-MAJOR mismatch)", () => {
  it("prints the mismatch warning and an explicit 'gate not evaluated' line, never the pass/fail verdict, exit 0", () => {
    const text = renderCheckReport({
      kind: "gate-not-evaluated",
      ascii: true,
      baseline: BASELINE_META,
      mismatch: { ...NO_MISMATCH, idVersion: { baseline: 1, current: 2 } },
    });
    expect(text).toContain("claim id recipe (idVersion): baseline 1, current 2");
    expect(text).toContain("gate not evaluated -- claim ids are not comparable");
    expect(text).toContain("re-baseline required");
    expect(text).toMatch(/exit 0$/m);
    expect(text).not.toContain("PASS no new dead weight");
    expect(text).not.toContain("FAIL");
    expect(text).not.toContain("no new dead weight");
  });

  it("never renders NEW-claim rows, remediation, or a resolved-count line — there is no meaningful diff in this state", () => {
    const text = renderCheckReport({
      kind: "gate-not-evaluated",
      ascii: true,
      baseline: BASELINE_META,
      mismatch: { ...NO_MISMATCH, idVersion: { baseline: 1, current: 2 } },
    });
    expect(text).not.toContain("remediation:");
    expect(text).not.toContain("resolved since baseline");
  });

  it("unicode mode uses the warning glyph and em dash, not the pass/fail checkmarks", () => {
    const text = renderCheckReport({
      kind: "gate-not-evaluated",
      ascii: false,
      baseline: BASELINE_META,
      mismatch: { ...NO_MISMATCH, idVersion: { baseline: 1, current: 2 } },
    });
    expect(text).toContain("⚠ gate not evaluated");
    expect(text).not.toMatch(/[✓✗]/);
  });
});
