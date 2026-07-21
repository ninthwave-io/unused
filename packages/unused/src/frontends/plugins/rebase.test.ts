import { describe, expect, it } from "vitest";
import { dependencyId, entrypointId, fileId, IRGraph, symbolId } from "../../core/ir/index.js";
import { prefixRepositoryPath, rebaseClaimInputs, rebaseGraph } from "./rebase.js";

const SITE = { file: "lib/callback.ex", span: { start: 0, end: 1, startLine: 2, endLine: 2 } };

describe("rebaseGraph", () => {
  it("rebases node identities, edges, hazards, prefixes, and provenance", () => {
    const graph = new IRGraph();
    graph.addNode({ kind: "file", id: fileId("lib/callback.ex"), path: "lib/callback.ex" });
    graph.addNode({
      kind: "symbol",
      id: symbolId("lib/callback.ex", "App.callback/1"),
      file: "lib/callback.ex",
      exportedName: "App.callback/1",
      isDefault: false,
      typeOnly: false,
      local: true,
      span: SITE.span,
    });
    graph.addNode({
      kind: "entrypoint",
      id: entrypointId("production", "lib/callback.ex"),
      entryKind: "production",
      file: "lib/callback.ex",
      reason: "application-callback",
    });
    graph.addNode({
      kind: "dependency",
      id: dependencyId("neutral"),
      packageName: "neutral",
    });
    graph.addEdge({
      kind: "references",
      referenceKind: "static",
      from: symbolId("lib/callback.ex", "App.callback/1"),
      to: dependencyId("neutral"),
      site: SITE,
      name: "neutral",
    });
    graph.addHazard({
      file: fileId("lib/callback.ex"),
      hazardClass: "elixir-dynamic-dispatch",
      detail: "neutral dynamic dispatch",
      site: SITE,
      subtreePrefix: "lib/plugins/",
    });

    const rebased = rebaseGraph(graph, "apps/backend");
    expect(rebased.nodes()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: fileId("apps/backend/lib/callback.ex"),
          path: "apps/backend/lib/callback.ex",
        }),
        expect.objectContaining({
          id: symbolId("apps/backend/lib/callback.ex", "App.callback/1"),
          file: "apps/backend/lib/callback.ex",
        }),
        expect.objectContaining({
          id: entrypointId("production", "apps/backend/lib/callback.ex"),
          file: "apps/backend/lib/callback.ex",
        }),
        expect.objectContaining({ id: dependencyId("neutral") }),
      ]),
    );
    expect(rebased.edges()[0]).toMatchObject({
      from: symbolId("apps/backend/lib/callback.ex", "App.callback/1"),
      to: dependencyId("neutral"),
      site: { file: "apps/backend/lib/callback.ex" },
    });
    expect(rebased.hazards()[0]).toMatchObject({
      file: fileId("apps/backend/lib/callback.ex"),
      site: { file: "apps/backend/lib/callback.ex" },
      subtreePrefix: "apps/backend/lib/plugins/",
    });
  });

  it("returns the original graph at the repository root and rejects escaping paths", () => {
    const graph = new IRGraph();
    expect(rebaseGraph(graph, "")).toBe(graph);
    expect(prefixRepositoryPath("apps/backend", "lib/a.ex")).toBe("apps/backend/lib/a.ex");
    expect(() => prefixRepositoryPath("../outside", "lib/a.ex")).toThrow(
      "path must be repository-relative",
    );
  });

  it("rebases line counts, dependency sites, units, and file scopes", () => {
    const rebased = rebaseClaimInputs(
      {
        fileLineCounts: new Map([[fileId("lib/callback.ex"), 12]]),
        dependencies: [{ packageName: "neutral", loc: { file: "mix.exs", span: [4, 4] } }],
        units: [{ rootRelDir: "", name: "neutral" }],
        analysisFiles: new Set(["lib/callback.ex", "lib/generated.ex"]),
        claimableFiles: new Set(["lib/callback.ex"]),
      },
      "apps/backend",
    );

    expect([...rebased.fileLineCounts]).toEqual([[fileId("apps/backend/lib/callback.ex"), 12]]);
    expect(rebased.dependencies?.[0]?.loc.file).toBe("apps/backend/mix.exs");
    expect(rebased.units).toEqual([{ rootRelDir: "apps/backend", name: "neutral" }]);
    expect([...rebased.analysisFiles]).toEqual([
      "apps/backend/lib/callback.ex",
      "apps/backend/lib/generated.ex",
    ]);
    expect([...rebased.claimableFiles]).toEqual(["apps/backend/lib/callback.ex"]);
  });
});
