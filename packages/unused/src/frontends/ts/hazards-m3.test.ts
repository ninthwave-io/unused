/**
 * T3.1b detection tests: the remaining hazard classes must FIRE from real source
 * (not merely exist in the registry). Each is a fooling-input case — the subject
 * a naive syntactic analyzer would claim dead, proven capped/alive because the
 * detection fired:
 *
 *  - `checker-only-type-relationship` — a `declare module` / `declare global`
 *    augmentation keeps the merge participant's exports alive.
 *  - `emit-decorator-metadata` — a decorated class under `emitDecoratorMetadata`
 *    is capped to medium (would be high without the tsconfig flag).
 *  - `conditional-exports-divergence` — a file reached only via a `browser`
 *    remap is kept alive (a genuine orphan beside it still flags).
 *  - `project-references` — a tsconfig with `references` caps the whole package.
 */
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { computeReachability, emitClaims } from "../../core/analysis/index.js";
import type { Provenance } from "../../core/claims/types.js";
import type { IRGraph } from "../../core/ir/index.js";
import { analyzeProject } from "./analyze.js";
import { discover } from "./discover.js";
import { emitIR } from "./emit.js";
import { parseFile } from "./parse.js";
import { Resolver } from "./resolve.js";

const repoRoot = fileURLToPath(new URL("../../../../../", import.meta.url));
const corpus = (c: string): string => join(repoRoot, "fixtures/ts", c);
const testfx = (c: string): string =>
  fileURLToPath(new URL(`./__testfixtures__/${c}`, import.meta.url));
const FIXED_CLOCK = new Date(0);
const PROVENANCE: Provenance = {
  analyzer: "ts-reference-graph",
  version: "0.1.0",
  generatedAt: "1970-01-01T00:00:00.000Z",
};

/** discover → parse → resolve → emit IR (optionally with emitDecoratorMetadata). */
async function buildIR(root: string, emitDecoratorMetadata = false): Promise<IRGraph> {
  const files = await discover(root);
  const records = await Promise.all(files.map((f) => parseFile(f)));
  const resolver = new Resolver({ projectRoot: root, discoveredFiles: new Set(files) });
  return emitIR({ projectRoot: root, records, resolver, emitDecoratorMetadata });
}

function claimShapes(graph: IRGraph): Array<{ kind: string; name: string; confidence: string }> {
  const claims = emitClaims({
    graph,
    reachability: computeReachability(graph),
    provenance: PROVENANCE,
  });
  return claims
    .map((c) => ({ kind: c.subject.kind, name: c.subject.name, confidence: c.confidence }))
    .sort((a, b) => `${a.kind}:${a.name}`.localeCompare(`${b.kind}:${b.name}`));
}

// ---------------------------------------------------------------------------
// checker-only-type-relationship (declaration merging)
// ---------------------------------------------------------------------------

describe("checker-only-type-relationship detection", () => {
  it("fires on the declaration-merging corpus fixture's `declare module` augmentation", async () => {
    const graph = await buildIR(corpus("declaration-merging"));
    const hz = graph.hazards().filter((h) => h.hazardClass === "checker-only-type-relationship");
    // The augmenting file (config-augment.ts) carries the hazard; the base file
    // (config.ts) does not — so config.ts#neverUsed stays a claimable dead export.
    expect(hz.map((h) => h.file)).toEqual(["file:src/config-augment.ts"]);
  });

  it("keeps a `declare global` merge participant alive while a real dead export still flags", async () => {
    // Detection fires on globals.ts (the augmentation site).
    const graph = await buildIR(testfx("checker-only-augmentation"));
    expect(
      graph
        .hazards()
        .some(
          (h) =>
            h.hazardClass === "checker-only-type-relationship" && h.file === "file:src/globals.ts",
        ),
    ).toBe(true);

    // End-to-end: `Marker` (used only through the merge) is NOT claimed; the
    // genuine dead export in the non-augmented util.ts IS claimed at high.
    const run = await analyzeProject(testfx("checker-only-augmentation"), { now: FIXED_CLOCK });
    const names = run.claims.map((c) => `${c.subject.kind}:${c.subject.name}`);
    expect(names).not.toContain("export:Marker");
    const control = run.claims.find((c) => c.subject.name === "deadControl");
    expect(control?.confidence).toBe("high");
  });
});

// ---------------------------------------------------------------------------
// emit-decorator-metadata
// ---------------------------------------------------------------------------

describe("emit-decorator-metadata detection", () => {
  it("caps a decorated class to medium ONLY when emitDecoratorMetadata is on", async () => {
    const root = testfx("emit-decorator-metadata");

    // WITHOUT the flag: the decorated class is a confident (high) dead export.
    const withoutFlag = await buildIR(root, false);
    expect(withoutFlag.hazards().some((h) => h.hazardClass === "emit-decorator-metadata")).toBe(
      false,
    );
    expect(claimShapes(withoutFlag)).toEqual([
      { kind: "export", name: "Service", confidence: "high" },
    ]);

    // WITH the flag: the marker becomes a hazard and the class is capped medium.
    const withFlag = await buildIR(root, true);
    expect(
      withFlag
        .hazards()
        .some(
          (h) => h.hazardClass === "emit-decorator-metadata" && h.file === "file:src/service.ts",
        ),
    ).toBe(true);
    expect(claimShapes(withFlag)).toEqual([
      { kind: "export", name: "Service", confidence: "medium" },
    ]);
  });

  it("end-to-end (reads the flag from the fixture's tsconfig): Service is capped medium", async () => {
    const run = await analyzeProject(testfx("emit-decorator-metadata"), { now: FIXED_CLOCK });
    const service = run.claims.find((c) => c.subject.name === "Service");
    expect(service?.confidence).toBe("medium");
  });
});

// ---------------------------------------------------------------------------
// conditional-exports-divergence (browser field remap)
// ---------------------------------------------------------------------------

describe("conditional-exports-divergence detection", () => {
  it("keeps a browser-only remap target alive while a genuine orphan still flags high", async () => {
    const run = await analyzeProject(testfx("conditional-exports-browser"), { now: FIXED_CLOCK });
    const shapes = run.claims.map((c) => ({
      name: c.subject.name,
      confidence: c.confidence,
    }));
    // impl.browser.ts is reached only via the browser remap ⇒ kept alive (no claim).
    expect(shapes.some((s) => s.name === "src/impl.browser.ts")).toBe(false);
    // dead.ts is a real orphan ⇒ still flagged high.
    expect(shapes).toContainEqual({ name: "src/dead.ts", confidence: "high" });
  });

  it("keeps a non-selected `imports` (#subpath) condition target alive (imports-map divergence)", async () => {
    // `#impl` resolves via `default` ⇒ impl.ts; the `browser` branch's
    // impl.browser.ts is a live module reached by no selected edge. Folding
    // `imports` into the divergence scan keeps it alive instead of flagging it high.
    const run = await analyzeProject(testfx("conditional-exports-imports"), { now: FIXED_CLOCK });
    const names = run.claims.map((c) => c.subject.name);
    expect(names).not.toContain("src/impl.browser.ts");
    // sanity: nothing else is spuriously claimed (impl.ts is the selected, live branch).
    expect(run.claims).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// project-references
// ---------------------------------------------------------------------------

describe("project-references detection", () => {
  it("caps the whole package to medium when tsconfig has `references`", async () => {
    const run = await analyzeProject(testfx("project-references"), { now: FIXED_CLOCK });
    const dead = run.claims.find((c) => c.subject.name === "deadButMaybeConsumed");
    // Would be `high` in a stand-alone project; the whole-package cap makes it medium.
    expect(dead?.confidence).toBe("medium");
    // The cap is blunt-but-scoped: nothing escapes to high in a referenced package.
    expect(run.claims.every((c) => c.confidence !== "high")).toBe(true);
  });
});
