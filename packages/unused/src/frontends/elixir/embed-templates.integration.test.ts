import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  computeDeletionPlan,
  type HazardEvaluation,
  type PartitionedReachability,
  whyAlive,
} from "../../core/analysis/index.js";
import type { IRGraph } from "../../core/ir/index.js";
import { isMixAvailable } from "../../testing/corpus/elixir-corpus.js";
import { analyzeProjectAutoWithGraph } from "../dispatch.js";
import type { AnalyzeResult } from "../ts/analyze.js";
import { analyzeElixirProjectWithGraph } from "./analyze.js";
import { runTracer } from "./runner.js";

const fixture = fileURLToPath(
  new URL("../../../../../fixtures/elixir/heex-experiment", import.meta.url),
);
const temporaryProjects: string[] = [];
const MIX_AVAILABLE = isMixAvailable();

interface PrecisionAnalysis {
  readonly result: AnalyzeResult;
  readonly graph: IRGraph;
  readonly reachability: PartitionedReachability;
}

afterEach(async () => {
  await Promise.all(
    temporaryProjects.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe.skipIf(!MIX_AVAILABLE)("Phoenix embedded-template precision", () => {
  it("keeps generated provenance without treating atom-name production as dispatch", async () => {
    const runtimeAtomRoot = await createRuntimeAtomProject();
    const runtimeTrace = runTracer(runtimeAtomRoot);
    expect(
      runtimeTrace.events
        .filter(
          (event) =>
            event.from_mod === "RuntimeAtom.Dispatch" &&
            event.to_mod === "String" &&
            (event.name === "to_atom" || event.name === "to_existing_atom"),
        )
        .map((event) => ({ fromFun: event.from_fun, name: event.name, dyn: event.dyn }))
        .sort((left, right) => String(left.name).localeCompare(String(right.name))),
    ).toEqual([
      { fromFun: "via_atom/1", name: "to_atom", dyn: true },
      { fromFun: "via_existing_atom/1", name: "to_existing_atom", dyn: true },
    ]);
    expect(
      runtimeTrace.events.some(
        (event) => event.from_mod === "RuntimeAtom.Dispatch" && event.name === "run",
      ),
    ).toBe(false);
    const runtimeAnalysis = await analyzeElixirProjectWithGraph(runtimeAtomRoot, {
      now: new Date(0),
    });
    expect(
      runtimeAnalysis.graph
        .hazards()
        .some((hazard) => hazard.hazardClass === "elixir-dynamic-dispatch"),
    ).toBe(true);
    expect(
      runtimeAnalysis.result.claims.find(
        (claim) => claim.subject.loc.file === "lib/runtime_atom/unrelated.ex",
      ),
    ).toMatchObject({ confidence: "medium" });

    const trace = runTracer(fixture);
    expect(
      trace.events.filter(
        (event) =>
          event.from_mod === "HeexExp.TemplatePage" &&
          event.to_mod === "String" &&
          event.name === "to_atom" &&
          event.arity === 1,
      ),
    ).toEqual([
      expect.objectContaining({
        file: "lib/heex_exp/template_page.ex",
        line: 4,
        dyn: false,
        partition: "prod",
      }),
    ]);
    expect(trace.events).toContainEqual(
      expect.objectContaining({
        file: "lib/heex_exp/template_page/index.html.heex",
        line: 1,
        from_mod: "HeexExp.TemplatePage",
        from_fun: "index/1",
        to_mod: "HeexExp.Components",
        name: "template_greeting",
        arity: 1,
        dyn: false,
        partition: "prod",
      }),
    );
    expect(
      trace.functions.some(
        (fn) =>
          fn.mod === "HeexExp.TemplatePage" && fn.name === "__mix_recompile__?" && fn.arity === 0,
      ),
    ).toBe(false);

    const analysis = await analyzeElixirProjectWithGraph(fixture, { now: new Date(0) });
    assertEmbeddedTemplatePrecision(analysis, [analysis.hazardEvaluation]);
  }, 60_000);

  it("preserves the same claims and deletion evidence after mixed-plugin composition", async () => {
    const root = await mkdtemp(join(tmpdir(), "unused-embed-mixed-"));
    temporaryProjects.push(root);
    await cp(fixture, root, { recursive: true });
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({
        name: "neutral-embed-mixed",
        private: true,
        type: "module",
        main: "src/index.ts",
      }),
    );
    await writeFile(join(root, "src", "index.ts"), "export const neutralValue = 1;\n");

    const analysis = await analyzeProjectAutoWithGraph(root, { now: new Date(0) });
    expect(analysis.boundaries).toMatchObject([
      { pluginId: "language:elixir", boundaryId: "ex:.", language: "ex" },
      { pluginId: "language:typescript", boundaryId: "ts:.", language: "ts" },
    ]);
    assertEmbeddedTemplatePrecision(analysis, analysis.hazardEvaluations);
  }, 60_000);
});

async function createRuntimeAtomProject(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "unused-runtime-atom-"));
  temporaryProjects.push(root);
  await mkdir(join(root, "lib", "runtime_atom"), { recursive: true });
  await writeFile(
    join(root, "mix.exs"),
    `defmodule RuntimeAtom.MixProject do
  use Mix.Project
  def project, do: [app: :runtime_atom, version: "0.1.0", elixir: "~> 1.17"]
  def application, do: [mod: {RuntimeAtom.Application, []}]
end
`,
  );
  await writeFile(
    join(root, "lib", "runtime_atom", "application.ex"),
    `defmodule RuntimeAtom.Application do
  use Application
  def start(_type, _args) do
    _ = RuntimeAtom.Dispatch.via_atom("Elixir.RuntimeAtom.Target")
    _ = RuntimeAtom.Dispatch.via_existing_atom("Elixir.RuntimeAtom.Target")
    {:ok, self()}
  end
end
`,
  );
  await writeFile(
    join(root, "lib", "runtime_atom", "dispatch.ex"),
    `defmodule RuntimeAtom.Dispatch do
  def via_atom(name), do: String.to_atom(name).run()
  def via_existing_atom(name), do: String.to_existing_atom(name).run()
end
`,
  );
  await writeFile(
    join(root, "lib", "runtime_atom", "unrelated.ex"),
    `defmodule RuntimeAtom.Unrelated do
  def dead, do: :dead
end
`,
  );
  return root;
}

function assertEmbeddedTemplatePrecision(
  analysis: PrecisionAnalysis,
  hazardEvaluations: readonly HazardEvaluation[],
): void {
  expect(
    analysis.graph.hazards().some((hazard) => hazard.hazardClass === "elixir-dynamic-dispatch"),
  ).toBe(false);
  expect(
    analysis.graph
      .edges()
      .some(
        (edge) =>
          edge.kind === "references" &&
          edge.site.file === "lib/heex_exp/template_page/index.html.heex" &&
          edge.site.span.startLine === 1 &&
          edge.name === "HeexExp.Components.template_greeting/1",
      ),
  ).toBe(true);

  for (const name of [
    "HeexExp.Components.unused_component/1",
    "HeexExp.TemplatePage.unrelated_dead/1",
  ]) {
    expect(
      analysis.result.claims.find(
        (claim) => claim.subject.kind === "export" && claim.subject.name === name,
      ),
    ).toMatchObject({ verdict: "unused", confidence: "high" });
  }

  const generatedWhy = whyAlive({
    graph: analysis.graph,
    reachability: analysis.reachability,
    claims: analysis.result.claims,
    query: "HeexExp.TemplatePage.index/1",
    hazardEvaluations,
  });
  expect(generatedWhy).toMatchObject({ outcome: "alive", entrypointKind: "production" });
  if (generatedWhy.outcome !== "alive") throw new Error("expected generated template to be alive");
  expect(generatedWhy.paths[0]?.hops.map((hop) => hop.file)).toEqual([
    "lib/heex_exp/application.ex",
    "lib/heex_exp/template_page.ex",
  ]);
  expect(
    computeDeletionPlan({
      graph: analysis.graph,
      reachability: analysis.reachability,
      subject: generatedWhy.subject,
      hazardEvaluations,
    }),
  ).toMatchObject({
    supported: false,
    unsupportedReason: expect.stringContaining(
      "non-re-export inbound reference remains at lib/heex_exp/application.ex",
    ),
  });

  const componentWhy = whyAlive({
    graph: analysis.graph,
    reachability: analysis.reachability,
    claims: analysis.result.claims,
    query: "HeexExp.Components.template_greeting/1",
    hazardEvaluations,
  });
  expect(componentWhy).toMatchObject({ outcome: "alive", entrypointKind: "production" });
  if (componentWhy.outcome !== "alive") throw new Error("expected embedded component to be alive");
  expect(componentWhy.paths[0]?.hops.map((hop) => hop.file)).toEqual([
    "lib/heex_exp/application.ex",
    "lib/heex_exp/template_page.ex",
    "lib/heex_exp/components.ex",
  ]);
  expect(
    computeDeletionPlan({
      graph: analysis.graph,
      reachability: analysis.reachability,
      subject: componentWhy.subject,
      hazardEvaluations,
    }),
  ).toMatchObject({
    supported: false,
    unsupportedReason:
      "non-re-export inbound reference remains at lib/heex_exp/template_page/index.html.heex:1; coordinated caller edits or deletion cohort are not modeled",
  });

  const deadWhy = whyAlive({
    graph: analysis.graph,
    reachability: analysis.reachability,
    claims: analysis.result.claims,
    query: "HeexExp.TemplatePage.unrelated_dead/1",
    hazardEvaluations,
  });
  expect(deadWhy).toMatchObject({ outcome: "dead", verdict: "unused", confidence: "high" });
  if (deadWhy.outcome !== "dead") throw new Error("expected unrelated export to be unused");
  const deadPlan = computeDeletionPlan({
    graph: analysis.graph,
    reachability: analysis.reachability,
    subject: deadWhy.subject,
    hazardEvaluations,
  });
  expect(deadPlan).toMatchObject({ supported: true });
  expect("unsupportedReason" in deadPlan).toBe(false);
}
