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
import { analyzeProject, analyzeProjectWithGraph } from "./analyze.js";

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

/** A medium-confidence shape: a subject a modelled hazard's scope caps (T3.1). */
const M = (kind: "export" | "file", name: string, file: string): Shape => ({
  kind,
  name,
  file,
  confidence: "medium",
  verdict: "unused",
});

/** case → the exact claims the analyzer emits (hand-verified, corpus-scored). */
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
  "ambient-dts": [],
  "basic-alive-export": [],
  // T3.1 scoped-hazard cases: dead subjects a modelled hazard reaches are now
  // CLAIMED at the registry cap (medium) instead of blanket-suppressed.
  "config-referenced-file": [M("file", "src/test-setup.ts", "src/test-setup.ts")],
  "computed-cjs-exports": [M("export", "dynamicHandler", "src/handlers.ts")],
  "require-expression": [
    // `require(resolvePluginPath())` has no static prefix ⇒ whole-package scope,
    // so both orphan plugins are capped medium (unused.ts's label ceiling is
    // high; medium is tolerated under-confidence, not a violation).
    M("file", "src/plugins/core.ts", "src/plugins/core.ts"),
    M("file", "src/plugins/unused.ts", "src/plugins/unused.ts"),
  ],
  "string-computed-import": [
    // `import(`./mods/${x}.js`)` ⇒ subtree src/mods/ capped medium; a file
    // outside the subtree stays a plain high-confidence dead claim.
    M("file", "src/mods/alpha.ts", "src/mods/alpha.ts"),
    M("file", "src/mods/beta.ts", "src/mods/beta.ts"),
    H("file", "src/unrelated.ts", "src/unrelated.ts"),
  ],
  // import-equals remains recall debt. Complete root reachability now exposes
  // the unconsumed re-export origin as a whole-file claim (ADR 0012).
  "import-equals": [],
  "re-export-chain": [H("file", "src/lib/unusedThing.ts", "src/lib/unusedThing.ts")],
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
      expect(run.summary.byConfidence.high).toBe(
        expected.filter((s) => s.confidence === "high").length,
      );
      expect(run.summary.byConfidence.medium).toBe(
        expected.filter((s) => s.confidence === "medium").length,
      );
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

describe("config-reference hazard provenance", () => {
  it("attributes the cap and evidence to the config source, not the referenced target", async () => {
    const run = await analyzeProjectWithGraph(corpus("config-referenced-file"), {
      now: FIXED_CLOCK,
    });
    const hazard = run.graph
      .hazards()
      .find((candidate) => candidate.hazardClass === "config-referenced-file");
    expect(hazard?.file).toBe("file:src/test-setup.ts");
    expect(hazard?.site.file).toBe("jest.config.json");
    expect(hazard?.site.span).toMatchObject({ startLine: 2, endLine: 2 });

    const claim = run.result.claims.find(
      (candidate) => candidate.subject.name === "src/test-setup.ts",
    );
    expect(claim?.evidence[0]?.detail).toContain("jest.config.json:2");
    expect(claim?.evidence[0]?.detail).not.toContain("src/test-setup.ts:1");
  });
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

  it("P5/P3: config ROOTS + real-edge deps stay alive; a config-referenced file is capped medium; a real orphan flags high", async () => {
    // vite.config.ts (config root) seeds build.ts via a real import edge (stays
    // alive); jest.config.js's setupFiles STRING makes test-setup a
    // config-referenced-file hazard — now a medium claim, not blanket-alive
    // (T3.1); src/dead.ts is a genuine orphan flagged high.
    const run = await analyzeProject(testfx("config-root"), { now: FIXED_CLOCK });
    expect(shapes(run.claims)).toEqual([
      H("file", "src/dead.ts", "src/dead.ts"),
      M("file", "src/test-setup.ts", "src/test-setup.ts"),
    ]);
    // Config roots and code reachable through real edges from them are never claimed.
    const names = shapes(run.claims).map((c) => `${c.kind}:${c.name}`);
    for (const forbidden of ["vite.config.ts", "jest.config.js", "src/build.ts", "src/app.ts"]) {
      expect(names.some((n) => n.endsWith(forbidden))).toBe(false);
    }
  });
});

describe("analyzeProject — workspace-member tsconfig `paths` (T4.6, M4 smoke 'worst finding')", () => {
  it("a member's own `@/*` alias keeps its aliased file alive; root files still use the root tsconfig; a real orphan still flags high", async () => {
    // packages/app declares its own tsconfig `paths: {"@/*": ["./*"]}` (the
    // near-universal Next.js convention). widget.ts is reachable ONLY through
    // that member alias; before T4.6 the single root-bound resolver never saw
    // the member's tsconfig and flagged it as a false positive. The repo root
    // separately declares `@root/*` -> `./shared/*`; root-widget.ts is reachable
    // ONLY through that root alias. Both must be alive, and only the genuine
    // orphan claimed.
    const run = await analyzeProject(testfx("workspace-member-paths"), { now: FIXED_CLOCK });
    expect(shapes(run.claims)).toEqual([
      H("file", "packages/app/components/orphan.ts", "packages/app/components/orphan.ts"),
    ]);
    const claimedFiles = run.claims.map((c) => c.subject.loc.file);
    // widget.ts alive ⇒ member files use the member tsconfig.
    expect(claimedFiles).not.toContain("packages/app/components/widget.ts");
    // root-widget.ts alive ⇒ root files use the root tsconfig.
    expect(claimedFiles).not.toContain("shared/root-widget.ts");
  });
});

describe("analyzeProject — computed-import root resolution (reviewer, FP-critical)", () => {
  it("`import(`./${x}.js`)` in a ROOT file caps the whole package (medium), not zero files", async () => {
    // Without the root-resolution fix the prefix would be `./` (matches nothing)
    // and mod.ts would leak as a HIGH-confidence claim.
    const run = await analyzeProject(testfx("computed-import-root"), { now: FIXED_CLOCK });
    expect(shapes(run.claims)).toEqual([M("file", "mod.ts", "mod.ts")]);
  });

  it("`import(`../${x}.js`)` in src/ resolves to root ⇒ whole-package cap (medium)", async () => {
    const run = await analyzeProject(testfx("computed-import-parent"), { now: FIXED_CLOCK });
    expect(shapes(run.claims)).toEqual([M("file", "sibling.ts", "sibling.ts")]);
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
