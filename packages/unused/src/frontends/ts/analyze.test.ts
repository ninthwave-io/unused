/**
 * `analyzeProject` integration tests (T2.4 acceptance). Runs the full pipeline
 * (discover → parse → resolve → emit → reachability → claims) over the read-only
 * golden corpus and asserts the **exact** claim set per case, then cross-checks
 * every claim against that case's `labels.yaml` ground truth (a claim must join a
 * `dead` label within its confidence ceiling — never an `alive` one).
 *
 * The eight-plus asserted cases below span the M2-claimable mechanisms (dead
 * export, dead file, exports-map entrypoints, star-chain, type-only re-export,
 * side-effect surface, alias resolution) and the hazard/keep-alive cases that
 * must yield **no** claim (computed import, config-referenced file, ambient
 * `.d.ts`, import-equals whole-surface, barrel dead-branch origin).
 */
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Claim, Confidence } from "../../core/claims/types.js";
import { loadLabelCase } from "../../testing/corpus/labels.js";
import { analyzeProject } from "./analyze.js";

const repoRoot = fileURLToPath(new URL("../../../../../", import.meta.url));
const corpus = (c: string): string => join(repoRoot, "fixtures/ts", c);
const testfx = (c: string): string =>
  fileURLToPath(new URL(`./__testfixtures__/${c}`, import.meta.url));
const FIXED_CLOCK = new Date(0);
const CONFIDENCE_RANK: Readonly<Record<Confidence, number>> = { low: 1, medium: 2, high: 3 };

interface Shape {
  kind: string;
  name: string;
  file: string;
  confidence: string;
  verdict: string;
}

function shapes(claims: readonly Claim[]): Shape[] {
  return claims
    .map((c) => ({
      kind: c.subject.kind,
      name: c.subject.name,
      file: c.subject.loc.file,
      confidence: c.confidence,
      verdict: c.verdict,
    }))
    .sort((a, b) => `${a.kind} ${a.name} ${a.file}`.localeCompare(`${b.kind} ${b.name} ${b.file}`));
}

const H = (kind: "export" | "file", name: string, file: string): Shape => ({
  kind,
  name,
  file,
  confidence: "high",
  verdict: "unused",
});

/** case → the exact claims M2 emits (hand-verified, corpus-scored). */
const EXPECTED: Record<string, Shape[]> = {
  "basic-dead-export": [H("export", "subtract", "src/math.ts")],
  "broken-paths-alias": [H("export", "neverUsed", "src/app/util.ts")],
  "dead-file": [H("file", "src/orphan.ts", "src/orphan.ts")],
  "entrypoint-exports-map": [H("export", "helperC", "src/shared.ts")],
  "export-star-chain": [H("export", "widgetB", "src/internal/widgets.ts")],
  "import-type-reexport": [H("export", "Address", "src/model.ts")],
  "side-effect-import": [H("export", "unusedHelper", "src/polyfill.ts")],
  "tsconfig-paths-alias": [
    H("export", "siblingUnused", "src/app/util.ts"),
    H("file", "src/app/orphan.ts", "src/app/orphan.ts"),
  ],
  "type-position-inverse": [H("export", "UnusedShape", "src/types.ts")],
  // keep-alive / recall-debt cases: no claim in M2 (documented misses).
  "ambient-dts": [],
  "basic-alive-export": [],
  "config-referenced-file": [],
  "import-equals": [],
  "re-export-chain": [],
  "require-expression": [],
  "string-computed-import": [],
};

describe("analyzeProject — exact claims over the corpus", () => {
  for (const [caseName, expected] of Object.entries(EXPECTED)) {
    it(`${caseName}`, async () => {
      const run = await analyzeProject(corpus(caseName), { now: FIXED_CLOCK });
      expect(shapes(run.claims)).toEqual(
        [...expected].sort((a, b) =>
          `${a.kind} ${a.name} ${a.file}`.localeCompare(`${b.kind} ${b.name} ${b.file}`),
        ),
      );
      // Wire format sanity: schema version, tool, provenance, evidence.
      expect(run.summary.byConfidence.high).toBe(expected.length);
      for (const claim of run.claims) {
        expect(claim.id).toMatch(/^(exp|fil)_[0-9a-f]{16}$/);
        expect(claim.evidence).toHaveLength(1);
        expect(claim.evidence[0]?.type).toBe("static-reachability");
        expect(claim.evidence[0]?.source).toBe("reference-graph");
        expect(claim.provenance.analyzer).toBe("ts-reference-graph");
      }
    });
  }
});

describe("analyzeProject — every claim joins a dead label, never an alive one", () => {
  for (const caseName of Object.keys(EXPECTED)) {
    it(`${caseName}`, async () => {
      const [run, labelCase] = await Promise.all([
        analyzeProject(corpus(caseName), { now: FIXED_CLOCK }),
        loadLabelCase(corpus(caseName)),
      ]);
      for (const claim of run.claims) {
        const label = labelCase.subjects.find(
          (s) =>
            s.kind === claim.subject.kind &&
            s.name === claim.subject.name &&
            s.file === claim.subject.loc.file,
        );
        // A claim need not be labelled (labels are partial), but if it joins a
        // label that label must be `dead`, and within its confidence ceiling —
        // never `alive` (that would be a Gate A false positive).
        if (label !== undefined) {
          expect(label.expected, `${caseName}: ${claim.subject.name}`).toBe("dead");
          const ceiling = label.minConfidence ?? "high";
          expect(CONFIDENCE_RANK[claim.confidence]).toBeLessThanOrEqual(CONFIDENCE_RANK[ceiling]);
        }
      }
    });
  }
});

describe("analyzeProject — entrypoint/keep-alive FP regressions (T2.4 review)", () => {
  it("P1: wildcard subpath exports keep the whole subtree alive; a real orphan still flags", async () => {
    // exports: {"./*": "./src/*.js"} → every src file is public. helper.ts is
    // reachable ONLY via the wildcard; lib/dead.ts is outside it and truly dead.
    const run = await analyzeProject(testfx("wildcard-exports"), { now: FIXED_CLOCK });
    expect(shapes(run.claims)).toEqual([H("file", "lib/dead.ts", "lib/dead.ts")]);
  });

  it("P2: zero production entrypoints ⇒ no claims at all (nothing anchors liveness)", async () => {
    // No main/module/exports/bin and no index.* fallback → zero prod roots.
    const run = await analyzeProject(testfx("no-entrypoints"), { now: FIXED_CLOCK });
    expect(run.claims).toEqual([]);
  });

  it("P5/P3: config roots + their string-path references stay alive; a real orphan still flags", async () => {
    // vite.config.ts (config root) seeds build.ts; jest.config.js's setupFiles
    // string keeps test-setup.ts alive; src/dead.ts is a genuine orphan.
    const run = await analyzeProject(testfx("config-root"), { now: FIXED_CLOCK });
    const names = shapes(run.claims).map((c) => `${c.kind}:${c.name}`);
    expect(names).toEqual(["file:src/dead.ts"]);
    // None of the config machinery is ever claimed.
    for (const forbidden of [
      "vite.config.ts",
      "jest.config.js",
      "src/build.ts",
      "src/test-setup.ts",
      "src/app.ts",
    ]) {
      expect(names.some((n) => n.endsWith(forbidden))).toBe(false);
    }
  });
});

describe("analyzeProject — cycle termination (end-to-end)", () => {
  it("terminates on the circular `export *` chain fixture and flags nothing (both surfaces live)", async () => {
    // a.ts (entrypoint) `export * from ./b` + fromA; b.ts `export * from ./a` + fromB.
    const run = await analyzeProject(testfx("circular-reexport"), { now: FIXED_CLOCK });
    expect(run.claims).toEqual([]);
  });
});

describe("analyzeProject — determinism", () => {
  it("two runs of the same project produce byte-identical claims", async () => {
    const a = await analyzeProject(corpus("tsconfig-paths-alias"), { now: FIXED_CLOCK });
    const b = await analyzeProject(corpus("tsconfig-paths-alias"), { now: FIXED_CLOCK });
    expect(JSON.stringify(a.claims)).toEqual(JSON.stringify(b.claims));
  });

  it("claims are emitted id-sorted", async () => {
    const run = await analyzeProject(corpus("tsconfig-paths-alias"), { now: FIXED_CLOCK });
    const ids = run.claims.map((c) => c.id);
    expect([...ids].sort()).toEqual(ids);
  });
});
