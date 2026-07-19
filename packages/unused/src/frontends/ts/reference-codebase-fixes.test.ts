/**
 * End-to-end regression tests for the reference-codebase real-customer smoke round
 * (docs/smoke/reference-codebase-ts-sanitized.md): the storybook + cdk presets, the
 * capacitor dependency keep-alive, and the per-workspace-unit hazard-cap scoping
 * fix. Each asserts the exact false-positive class the round closed, on a fresh
 * placeholder fixture (no customer identifiers).
 */
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Claim } from "../../core/claims/types.js";
import { analyzeProject } from "./analyze.js";

const FIXED_CLOCK = new Date(0);
/** A corpus fixture under `fixtures/ts/` (same depth as `labels.ts`'s fixtures root). */
const corpusFx = (c: string): string =>
  fileURLToPath(new URL(`../../../../../fixtures/ts/${c}`, import.meta.url));
/** A local `__testfixtures__/` fixture. */
const testFx = (c: string): string =>
  fileURLToPath(new URL(`./__testfixtures__/${c}`, import.meta.url));

const claimFor = (claims: readonly Claim[], file: string): Claim | undefined =>
  claims.find((c) => c.subject.loc.file === file);
const files = (claims: readonly Claim[]): string[] => claims.map((c) => c.subject.loc.file);

describe("storybook preset — `.storybook/main.ts` stories glob (FP class 1)", () => {
  it("seeds every matched story file as an entrypoint; a story-only component is alive; a true orphan is dead/high", async () => {
    const run = await analyzeProject(corpusFx("preset-storybook"), { now: FIXED_CLOCK });
    // The single largest real-customer FP class: an auto-discovered story file
    // must never be flagged.
    expect(files(run.claims)).not.toContain("src/Widget.stories.tsx");
    // The component rendered only by that story is kept alive through it.
    expect(files(run.claims)).not.toContain("src/Widget.tsx");
    // But the preset must not over-keep-alive: a component with no story is dead.
    expect(claimFor(run.claims, "src/Orphan.tsx")).toMatchObject({
      subject: { kind: "file" },
      verdict: "unused",
      confidence: "high",
    });
    expect(run.claims).toHaveLength(1);
  });
});

describe("cdk preset — `cdk.json#app` + the bin/ entry convention (FP class 2)", () => {
  it("keeps the CDK app entry and its stacks alive; an unimported lib helper is dead/high", async () => {
    const run = await analyzeProject(corpusFx("preset-cdk"), { now: FIXED_CLOCK });
    expect(files(run.claims)).not.toContain("bin/app.ts"); // cdk.json#app / bin convention
    expect(files(run.claims)).not.toContain("lib/my-stack.ts"); // instantiated by the entry
    expect(claimFor(run.claims, "lib/orphan.ts")).toMatchObject({
      verdict: "unused",
      confidence: "high",
    });
    expect(run.claims).toHaveLength(1);
  });
});

describe("capacitor keep-alive — platform/CLI packages in a Capacitor app (FP class 3)", () => {
  it("keeps @capacitor/ios|android|cli alive via the config marker; a plugin (@capacitor/camera) stays claimable", async () => {
    const run = await analyzeProject(testFx("capacitor-platform-deps"), { now: FIXED_CLOCK });
    const deps = run.claims
      .filter((c) => c.subject.kind === "dependency")
      .map((c) => c.subject.name);
    expect(deps).not.toContain("@capacitor/ios");
    expect(deps).not.toContain("@capacitor/android");
    expect(deps).not.toContain("@capacitor/cli");
    expect(deps).not.toContain("@capacitor/core"); // imported by src ⇒ alive via reference
    // A plugin exposes a JS API, so an unimported one is a genuine claim.
    expect(deps).toContain("@capacitor/camera");
  });
});

describe("storybook aggregator — a host package's `stories` glob reaching into siblings (reviewer fix)", () => {
  it("seeds a sibling package's story cross-unit; the sibling's true orphan stays dead/high", async () => {
    const run = await analyzeProject(corpusFx("preset-storybook-aggregator"), { now: FIXED_CLOCK });
    // The escaping `../../packages/*/**` glob must keep the sibling's story (and
    // its component) alive even though the sibling has no Storybook marker.
    expect(files(run.claims)).not.toContain("packages/ui/src/Button.stories.tsx");
    expect(files(run.claims)).not.toContain("packages/ui/src/Button.tsx");
    expect(claimFor(run.claims, "packages/ui/src/Orphan.tsx")).toMatchObject({
      verdict: "unused",
      confidence: "high",
    });
    expect(run.claims).toHaveLength(1);
  });
});

describe("project-references — the cap covers the referenced leaf, not only the referencer (reviewer fix)", () => {
  it("caps a composite referenced leaf's dead export to medium (would be high without the referenced-unit half)", async () => {
    const run = await analyzeProject(corpusFx("project-references-workspace"), {
      now: FIXED_CLOCK,
    });
    const deadLib = run.claims.find(
      (c) => c.subject.kind === "export" && c.subject.name === "deadLib",
    );
    expect(deadLib).toMatchObject({ verdict: "unused", confidence: "medium" });
    // usedLib is consumed across the boundary ⇒ no claim.
    expect(run.claims.some((c) => c.subject.name === "usedLib")).toBe(false);
  });
});

describe("per-unit hazard activation — an unreachable carrier can't cap any workspace (§4.3)", () => {
  it("leaves both the carrier's package and its sibling at high confidence", async () => {
    const run = await analyzeProject(testFx("hazard-scope-per-unit"), { now: FIXED_CLOCK });
    // pkg-a contains an opaque require, but its carrier is unreachable and
    // cannot execute. It therefore cannot dynamically load pkg-a's dead code.
    expect(claimFor(run.claims, "packages/pkg-a/src/dead-a.ts")).toMatchObject({
      verdict: "unused",
      confidence: "high",
    });
    // pkg-b has no hazard and no relationship to pkg-a.
    expect(claimFor(run.claims, "packages/pkg-b/src/dead-b.ts")).toMatchObject({
      verdict: "unused",
      confidence: "high",
    });
  });
});
