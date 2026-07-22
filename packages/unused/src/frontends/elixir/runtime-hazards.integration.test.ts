import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { computeDeletionPlan, whyAlive } from "../../core/analysis/index.js";
import { isMixAvailable } from "../../testing/corpus/elixir-corpus.js";
import { analyzeProjectAutoWithGraph } from "../dispatch.js";
import { analyzeElixirProjectWithGraph } from "./analyze.js";
import { runTracer } from "./runner.js";

const fixture = (name: string): string =>
  fileURLToPath(new URL(`../../../../../fixtures/elixir/${name}`, import.meta.url));
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe.skipIf(!isMixAvailable())("real Elixir dynamic-hazard roles", () => {
  it("accounts for every literal guarded use-helper invocation without an opaque cap", async () => {
    const analysis = await analyzeElixirProjectWithGraph(fixture("dynamic-use-helpers"), {
      now: new Date(0),
    });
    expect(
      analysis.graph.hazards().filter((hazard) => hazard.hazardClass === "elixir-dynamic-dispatch"),
    ).toEqual([]);

    const selected = whyAlive({
      graph: analysis.graph,
      reachability: analysis.reachability,
      claims: analysis.result.claims,
      query: "NeutralUse.Web.controller/0",
      hazardEvaluations: [analysis.hazardEvaluation],
    });
    expect(selected).toMatchObject({ outcome: "alive", entrypointKind: "production" });

    const dead = whyAlive({
      graph: analysis.graph,
      reachability: analysis.reachability,
      claims: analysis.result.claims,
      query: "NeutralUse.Web.genuinely_unused/0",
      hazardEvaluations: [analysis.hazardEvaluation],
    });
    expect(dead).toMatchObject({ outcome: "dead", confidence: "high" });
    if (dead.outcome !== "dead") throw new Error("expected unused helper");
    expect(
      computeDeletionPlan({
        graph: analysis.graph,
        reachability: analysis.reachability,
        subject: dead.subject,
        hazardEvaluations: [analysis.hazardEvaluation],
      }),
    ).toMatchObject({ supported: true });
  }, 60_000);

  it("treats direct Map-key atom production as data and masks inert text", async () => {
    const root = fixture("atom-map-key-safe");
    const trace = runTracer(root);
    expect(trace.events.filter((event) => event.dyn)).toHaveLength(2);
    const analysis = await analyzeElixirProjectWithGraph(root, { now: new Date(0) });
    expect(
      analysis.graph.hazards().filter((hazard) => hazard.hazardClass === "elixir-dynamic-dispatch"),
    ).toEqual([]);
    const dead = whyAlive({
      graph: analysis.graph,
      reachability: analysis.reachability,
      claims: analysis.result.claims,
      query: "NeutralAtomKey.Lookup.genuinely_unused/0",
      hazardEvaluations: [analysis.hazardEvaluation],
    });
    expect(dead).toMatchObject({ outcome: "dead", confidence: "high" });
    if (dead.outcome !== "dead") throw new Error("expected dead Map-key sibling");
    expect(
      computeDeletionPlan({
        graph: analysis.graph,
        reachability: analysis.reachability,
        subject: dead.subject,
        hazardEvaluations: [analysis.hazardEvaluation],
      }),
    ).toMatchObject({ supported: true });
  }, 60_000);

  it("keeps immediate, assigned, and mixed same-line atom flows opaque", async () => {
    const analysis = await analyzeElixirProjectWithGraph(fixture("atom-dynamic-receiver"), {
      now: new Date(0),
    });
    const hazards = analysis.graph
      .hazards()
      .filter((hazard) => hazard.hazardClass === "elixir-dynamic-dispatch");
    expect(hazards.map((hazard) => hazard.carrierSymbol).sort()).toEqual([
      expect.stringContaining("assigned/1"),
      expect.stringContaining("immediate/1"),
      expect.stringContaining("mixed/2"),
    ]);
    const dead = whyAlive({
      graph: analysis.graph,
      reachability: analysis.reachability,
      claims: analysis.result.claims,
      query: "lib/neutral_atom_flow/target.ex",
      hazardEvaluations: [analysis.hazardEvaluation],
    });
    expect(dead).toMatchObject({ outcome: "dead", confidence: "medium" });
    if (dead.outcome !== "dead") throw new Error("expected conservatively dead target");
    expect(
      computeDeletionPlan({
        graph: analysis.graph,
        reachability: analysis.reachability,
        subject: dead.subject,
        hazardEvaluations: [analysis.hazardEvaluation],
      }),
    ).toMatchObject({ supported: false });
  }, 60_000);

  it.each(["dynamic-use-helpers", "atom-map-key-safe", "atom-dynamic-receiver"])(
    "preserves Elixir claims after mixed-plugin composition: %s",
    async (name) => {
      const direct = await analyzeElixirProjectWithGraph(fixture(name), { now: new Date(0) });
      const mixedRoot = await mixedFixture(name);
      const mixed = await analyzeProjectAutoWithGraph(mixedRoot, { now: new Date(0) });
      const projectPrefix = "apps/beam/";
      const directClaims = direct.result.claims.map((claim) => ({
        kind: claim.subject.kind,
        name: claim.subject.name,
        file: claim.subject.loc.file,
        confidence: claim.confidence,
      }));
      const mixedClaims = mixed.result.claims
        .filter((claim) => claim.language === "ex")
        .map((claim) => ({
          kind: claim.subject.kind,
          name: claim.subject.name?.startsWith(projectPrefix)
            ? claim.subject.name.slice(projectPrefix.length)
            : claim.subject.name,
          file: claim.subject.loc.file.slice(projectPrefix.length),
          confidence: claim.confidence,
        }));
      expect(mixedClaims).toEqual(directClaims);
    },
    120_000,
  );
});

async function mixedFixture(name: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "unused-elixir-hazard-mixed-"));
  temporaryRoots.push(root);
  const beam = join(root, "apps", "beam");
  await mkdir(beam, { recursive: true });
  await cp(fixture(name), beam, {
    recursive: true,
    filter: (path) => !["_build", "deps", ".elixir_ls"].includes(basename(path)),
  });
  await mkdir(join(root, "src"));
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({ name: "neutral-mixed", private: true, type: "module", main: "src/index.ts" }),
  );
  await writeFile(join(root, "src", "index.ts"), "export const neutral = true;\n");
  return root;
}
