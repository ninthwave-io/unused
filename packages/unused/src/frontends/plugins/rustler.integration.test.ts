import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
});
