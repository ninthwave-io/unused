import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { computeDeletionPlan, PerformanceTracker, whyAlive } from "../../core/analysis/index.js";
import { symbolId } from "../../core/ir/index.js";
import { isPolyglotToolchainAvailable } from "../../testing/corpus/polyglot-corpus.js";
import { analyzeProjectAutoWithGraph } from "../dispatch.js";

const fixture = fileURLToPath(
  new URL("../../../../../fixtures/polyglot/rustler-literal", import.meta.url),
);
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe.skipIf(!isPolyglotToolchainAvailable())("literal Rustler bridge integration", () => {
  it("drives claims, why evidence, and deletion refusal across languages", {
    timeout: 120_000,
  }, async () => {
    const performance = new PerformanceTracker();
    const analysis = await analyzeProjectAutoWithGraph(fixture, {
      now: new Date(0),
      performance,
    });
    const measured = performance.snapshot();
    for (const phase of [
      "discovery-gitignore",
      "workspace-config-detection",
      "parsing",
      "convention-config-roots",
      "graph-construction",
      "reachability-partitioning",
      "hazard-activation",
      "claim-generation",
    ] as const) {
      expect(measured.phasesMs[phase], phase).toBeGreaterThan(0);
    }
    expect(measured.counters).toMatchObject({
      files: 5,
      claims: 2,
      workspaces: 3,
      deletionPlanSimulations: 0,
    });
    const deadSubjects = analysis.result.claims.map(
      (claim) => `${claim.subject.loc.file}:${claim.subject.name}`,
    );
    expect(deadSubjects).toHaveLength(2);
    expect(deadSubjects).toEqual(
      expect.arrayContaining([
        "native/src/lib.rs:dead_nif",
        "beam/lib/neutral_bridge/native.ex:NeutralBridge.Native.dead_nif/1",
      ]),
    );

    const rustWhy = whyAlive({
      graph: analysis.graph,
      reachability: analysis.reachability,
      claims: analysis.result.claims,
      query: "native/src/lib.rs:live_nif",
    });
    expect(rustWhy).toMatchObject({
      outcome: "alive",
      paths: [
        {
          entrypointKind: "production",
          hops: [
            { file: "beam/lib/neutral_bridge/application.ex" },
            {
              file: "beam/lib/neutral_bridge/native.ex",
              line: 7,
              symbol: "NeutralBridge.Native.live_nif/2",
            },
            { file: "native/src/lib.rs", line: 1, symbol: "live_nif" },
          ],
        },
      ],
    });
    if (rustWhy.outcome !== "alive") throw new Error("expected live Rust NIF");
    expect(
      computeDeletionPlan({
        graph: analysis.graph,
        reachability: analysis.reachability,
        subject: rustWhy.subject,
      }),
    ).toMatchObject({
      supported: false,
      unsupportedReason:
        "selected subject has a live runtime reference at beam/lib/neutral_bridge/native.ex:7",
      stages: [],
    });

    const elixirWhy = whyAlive({
      graph: analysis.graph,
      reachability: analysis.reachability,
      claims: analysis.result.claims,
      query: "NeutralBridge.Native.live_nif/2",
    });
    if (elixirWhy.outcome !== "alive") throw new Error("expected live Elixir NIF stub");
    expect(
      computeDeletionPlan({
        graph: analysis.graph,
        reachability: analysis.reachability,
        subject: elixirWhy.subject,
      }),
    ).toMatchObject({
      supported: false,
      unsupportedReason:
        "selected subject has a live static reference at beam/lib/neutral_bridge/application.ex:7",
      stages: [],
    });
  });

  it("makes both exact functions dead when the planted caller edge is removed", {
    timeout: 120_000,
  }, async () => {
    const root = await mkdtemp(join(tmpdir(), "unused-rustler-bridge-"));
    temporaryRoots.push(root);
    await cp(fixture, root, {
      recursive: true,
      filter: (source) => !["_build", "target"].includes(basename(source)),
    });
    const application = join(root, "beam/lib/neutral_bridge/application.ex");
    const source = await readFile(application, "utf8");
    if (!source.includes("    NeutralBridge.Native.live_nif(20, 22)\n")) {
      throw new Error("neutral fixture caller was not found");
    }
    await writeFile(application, source.replace("    NeutralBridge.Native.live_nif(20, 22)\n", ""));

    const analysis = await analyzeProjectAutoWithGraph(root, { now: new Date(0) });
    expect(
      analysis.result.claims.map((claim) => `${claim.subject.loc.file}:${claim.subject.name}`),
    ).toEqual(
      expect.arrayContaining([
        "beam/lib/neutral_bridge/native.ex:NeutralBridge.Native.live_nif/2",
        "native/src/lib.rs:live_nif",
      ]),
    );
    expect(
      analysis.reachability.production.reachableSymbols.has(
        symbolId("native/src/lib.rs", "live_nif"),
      ),
    ).toBe(false);
  });

  it("protects bridge descendants from incomplete Elixir tests without hiding complete boundaries", {
    timeout: 120_000,
  }, async () => {
    const root = await mkdtemp(join(tmpdir(), "unused-rustler-incomplete-test-"));
    temporaryRoots.push(root);
    await cp(fixture, root, {
      recursive: true,
      filter: (source) => !["_build", "target"].includes(basename(source)),
    });

    await mkdir(join(root, "src"));
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ name: "neutral-polyglot-root", type: "module", main: "src/index.ts" }),
    );
    await writeFile(join(root, "src/index.ts"), "export const live = true;\n");
    await writeFile(join(root, "src/dead.ts"), "export const deadValue = true;\n");

    const application = join(root, "beam/lib/neutral_bridge/application.ex");
    const applicationSource = await readFile(application, "utf8");
    await writeFile(
      application,
      applicationSource.replace(
        "  def start(_type, _args) do\n",
        "  def start(_type, _args) do\n    Application.put_env(:neutral_bridge, :runtime_marker, :started)\n",
      ),
    );
    await mkdir(join(root, "beam/test"));
    await writeFile(join(root, "beam/test/test_helper.exs"), "ExUnit.start()\n");
    await writeFile(
      join(root, "beam/test/native_test.exs"),
      `defmodule NeutralBridge.NativeTest do
  use ExUnit.Case
  @runtime_marker Application.fetch_env!(:neutral_bridge, :runtime_marker)
  test "runtime-selected NIF" do
    assert @runtime_marker == :started
    assert NeutralBridge.Native.dead_nif(1) == 1
  end
end
`,
    );

    const analysis = await analyzeProjectAutoWithGraph(root, { now: new Date(0) });
    expect(analysis.result.run.boundaries).toMatchObject([
      {
        boundaryId: "ex:beam",
        status: "partial",
        partitions: { production: "complete", config: "complete", test: "incomplete" },
      },
      {
        boundaryId: "rs:native",
        status: "complete",
        partitions: { production: "complete", config: "complete", test: "complete" },
      },
      {
        boundaryId: "ts:.",
        status: "complete",
        partitions: { production: "complete", config: "complete", test: "complete" },
      },
    ]);
    expect(analysis.result.claims.length).toBeGreaterThan(0);
    expect(new Set(analysis.result.claims.map((claim) => claim.language))).toEqual(new Set(["ts"]));
    expect(analysis.result.claims.some((claim) => claim.subject.loc.file === "src/dead.ts")).toBe(
      true,
    );
    expect(
      analysis.result.claims.some(
        (claim) =>
          claim.subject.name === "NeutralBridge.Native.dead_nif/1" ||
          claim.subject.name === "dead_nif",
      ),
    ).toBe(false);
  });
});
