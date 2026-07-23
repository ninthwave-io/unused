import { describe, expect, it, vi } from "vitest";
import {
  dependencyId,
  entrypointId,
  fileId,
  IRGraph,
  type Site,
  symbolId,
} from "../../core/ir/index.js";
import {
  createRebaseContext,
  prefixRepositoryPath,
  prepareOwnedGraphRebase,
  rebaseClaimInputs,
  rebaseDiagnostic,
  rebaseGraph,
  rebaseGraphContribution,
} from "./rebase.js";

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
      id: entrypointId(
        "production",
        "lib/callback.ex",
        symbolId("lib/callback.ex", "App.callback/1"),
      ),
      entryKind: "production",
      file: "lib/callback.ex",
      targetSymbol: symbolId("lib/callback.ex", "App.callback/1"),
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
      partitions: ["test"],
    });
    graph.addHazard({
      file: fileId("lib/callback.ex"),
      carrierSymbol: symbolId("lib/callback.ex", "App.callback/1"),
      hazardClass: "elixir-dynamic-dispatch",
      detail: "neutral dynamic dispatch",
      site: SITE,
      subtreePrefix: "lib/plugins/",
      effect: {
        scope: { kind: "symbols", ids: [symbolId("lib/callback.ex", "App.callback/1")] },
        worlds: ["test"],
      },
    });

    const context = createRebaseContext("apps/backend");
    const rebased = rebaseGraph(graph, "apps/backend", context);
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
          id: entrypointId(
            "production",
            "apps/backend/lib/callback.ex",
            symbolId("apps/backend/lib/callback.ex", "App.callback/1"),
          ),
          file: "apps/backend/lib/callback.ex",
          targetSymbol: symbolId("apps/backend/lib/callback.ex", "App.callback/1"),
        }),
        expect.objectContaining({ id: dependencyId("neutral") }),
      ]),
    );
    expect(rebased.edges()[0]).toMatchObject({
      from: symbolId("apps/backend/lib/callback.ex", "App.callback/1"),
      to: dependencyId("neutral"),
      site: { file: "apps/backend/lib/callback.ex" },
      partitions: ["test"],
    });
    expect(rebased.hazards()[0]).toMatchObject({
      file: fileId("apps/backend/lib/callback.ex"),
      carrierSymbol: symbolId("apps/backend/lib/callback.ex", "App.callback/1"),
      site: { file: "apps/backend/lib/callback.ex" },
      subtreePrefix: "apps/backend/lib/plugins/",
      effect: {
        scope: {
          kind: "symbols",
          ids: [symbolId("apps/backend/lib/callback.ex", "App.callback/1")],
        },
        worlds: ["test"],
      },
    });
    expect(rebased.edges()[0]?.site).toBe(rebased.hazards()[0]?.site);
    expect(context.paths.size).toBeLessThanOrEqual(2);
  });

  it("returns the original graph at the repository root and rejects escaping paths", () => {
    const graph = new IRGraph();
    expect(rebaseGraph(graph, "")).toBe(graph);
    expect(prefixRepositoryPath("apps/backend", "lib/a.ex")).toBe("apps/backend/lib/a.ex");
    expect(() => prefixRepositoryPath("../outside", "lib/a.ex")).toThrow(
      "path must be repository-relative",
    );
    expect(() => prefixRepositoryPath("apps/backend", "inside/../../outside.ts")).toThrow(
      "path must be repository-relative",
    );
    expect(() => prefixRepositoryPath("apps/backend", "C:\\outside.ts")).toThrow(
      "path must be repository-relative",
    );
  });

  it("canonicalizes internal dot segments consistently across every fragment surface", () => {
    const graph = new IRGraph();
    graph.addNode({ kind: "file", id: fileId("src/../lib/a.ex"), path: "src/../lib/a.ex" });
    graph.addNode({ kind: "dependency", id: dependencyId("neutral"), packageName: "neutral" });
    graph.addEdge({
      kind: "references",
      referenceKind: "static",
      from: fileId("src/../lib/a.ex"),
      to: dependencyId("neutral"),
      site: { ...SITE, file: "./lib/a.ex" },
      name: "neutral",
    });
    const context = createRebaseContext("apps/./backend");
    const rebased = rebaseGraph(graph, "apps/./backend", context);
    const inputs = rebaseClaimInputs(
      {
        fileLineCounts: new Map([[fileId("src/../lib/a.ex"), 3]]),
        units: [{ rootRelDir: "nested/..", name: "neutral" }],
        analysisFiles: new Set(["src/../lib/a.ex", "lib/./a.ex"]),
        claimableFiles: new Set(["lib/a.ex"]),
      },
      "apps/./backend",
      context,
    );
    const contribution = rebaseGraphContribution(
      {
        diagnostics: [
          {
            pluginId: "neutral",
            severity: "warning",
            code: "neutral-path",
            message: "neutral",
            site: { ...SITE, file: "lib/./a.ex" },
          },
        ],
      },
      graph,
      "apps/./backend",
      context,
    );

    expect(rebased.nodes()[0]).toMatchObject({
      id: fileId("apps/backend/lib/a.ex"),
      path: "apps/backend/lib/a.ex",
    });
    expect(rebased.edges()[0]?.site.file).toBe("apps/backend/lib/a.ex");
    expect([...inputs.analysisFiles]).toEqual(["apps/backend/lib/a.ex"]);
    expect([...inputs.fileLineCounts]).toEqual([[fileId("apps/backend/lib/a.ex"), 3]]);
    expect(inputs.units).toEqual([{ rootRelDir: "apps/backend", name: "neutral" }]);
    expect(contribution.diagnostics?.[0]?.site?.file).toBe("apps/backend/lib/a.ex");
    expect(
      rebaseDiagnostic(
        {
          pluginId: "neutral",
          severity: "warning",
          code: "neutral-path",
          message: "neutral",
          site: { ...SITE, file: "x/../lib/a.ex" },
        },
        "apps/./backend",
        context,
      ).site?.file,
    ).toBe("apps/backend/lib/a.ex");
    expect(context.paths.size).toBe(2);
  });

  it.each(["file", "unit"] as const)("preserves an explicit %s effect while rebasing", (kind) => {
    const graph = new IRGraph();
    graph.addNode({ kind: "file", id: fileId("lib/loader.ex"), path: "lib/loader.ex" });
    graph.addHazard({
      file: fileId("lib/loader.ex"),
      hazardClass: "elixir-dynamic-dispatch",
      detail: "neutral contextual effect",
      site: { ...SITE, file: "lib/loader.ex" },
      effect: { scope: { kind }, worlds: ["config"] },
    });

    expect(rebaseGraph(graph, "apps/backend").hazards()).toEqual([
      expect.objectContaining({
        file: fileId("apps/backend/lib/loader.ex"),
        site: expect.objectContaining({ file: "apps/backend/lib/loader.ex" }),
        effect: { scope: { kind }, worlds: ["config"] },
      }),
    ]);
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

  it("rebases deferred edges against nodes retained in the owning graph", () => {
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
    const wholeGraphWalk = vi.spyOn(graph, "nodes");
    const contribution = rebaseGraphContribution(
      {
        edges: [
          {
            kind: "references",
            referenceKind: "runtime-resolved",
            from: symbolId("lib/callback.ex", "App.callback/1"),
            to: symbolId("lib/callback.ex", "App.callback/1"),
            site: SITE,
            name: "App.callback/1",
          },
        ],
        hazards: [
          {
            file: fileId("lib/callback.ex"),
            carrierSymbol: symbolId("lib/callback.ex", "App.callback/1"),
            hazardClass: "elixir-dynamic-dispatch",
            detail: "neutral",
            site: SITE,
            effect: {
              scope: {
                kind: "symbols",
                ids: [symbolId("lib/callback.ex", "App.callback/1")],
              },
              worlds: ["production"],
            },
          },
        ],
      },
      graph,
      "apps/backend",
    );

    expect(contribution.edges?.[0]).toMatchObject({
      from: symbolId("apps/backend/lib/callback.ex", "App.callback/1"),
      to: symbolId("apps/backend/lib/callback.ex", "App.callback/1"),
      site: { file: "apps/backend/lib/callback.ex" },
    });
    expect(contribution.hazards?.[0]).toMatchObject({
      file: fileId("apps/backend/lib/callback.ex"),
      carrierSymbol: symbolId("apps/backend/lib/callback.ex", "App.callback/1"),
      site: { file: "apps/backend/lib/callback.ex" },
      effect: {
        scope: {
          kind: "symbols",
          ids: [symbolId("apps/backend/lib/callback.ex", "App.callback/1")],
        },
        worlds: ["production"],
      },
    });
    expect(wholeGraphWalk).not.toHaveBeenCalled();
  });

  it("transfers owned graph storage in place while preserving record and site identity", () => {
    const graph = new IRGraph();
    const file = { kind: "file" as const, id: fileId("lib/callback.ex"), path: "lib/callback.ex" };
    const callback = {
      kind: "symbol" as const,
      id: symbolId("lib/callback.ex", "App.callback/1"),
      file: "lib/callback.ex",
      exportedName: "App.callback/1",
      isDefault: false,
      typeOnly: false,
      local: true,
      span: SITE.span,
    };
    const edge = {
      kind: "references" as const,
      referenceKind: "static" as const,
      from: file.id,
      to: dependencyId("neutral"),
      site: { ...SITE },
      name: "neutral",
    };
    const hazard = {
      file: file.id,
      carrierSymbol: callback.id,
      hazardClass: "elixir-dynamic-dispatch" as const,
      detail: "neutral",
      site: edge.site,
      subtreePrefix: "lib/plugins",
      effect: Object.freeze({
        scope: Object.freeze({
          kind: "symbols" as const,
          ids: Object.freeze([callback.id]),
        }),
        worlds: Object.freeze(["test" as const]),
      }),
    };
    graph.addNode(file);
    graph.addNode(callback);
    graph.addNode({ kind: "dependency", id: dependencyId("neutral"), packageName: "neutral" });
    graph.addEdge(edge);
    graph.addHazard(hazard);
    graph.addHazard(hazard);

    const plan = prepareOwnedGraphRebase(graph, "apps/backend");
    const transferred = plan.commit();

    expect(transferred).toBe(graph);
    expect(transferred.getNode(fileId("apps/backend/lib/callback.ex"))).toBe(file);
    expect(transferred.edges()[0]).toBe(edge);
    expect(transferred.hazards()[0]).toBe(hazard);
    expect(transferred.hazards()[1]).toBe(hazard);
    expect(transferred.edges()[0]?.site).toBe(edge.site);
    expect(edge.site.file).toBe("apps/backend/lib/callback.ex");
    expect(hazard.file).toBe(fileId("apps/backend/lib/callback.ex"));
    expect(hazard.carrierSymbol).toBe(symbolId("apps/backend/lib/callback.ex", "App.callback/1"));
    expect(hazard.subtreePrefix).toBe("apps/backend/lib/plugins");
    expect(hazard.effect).toEqual({
      scope: {
        kind: "symbols",
        ids: [symbolId("apps/backend/lib/callback.ex", "App.callback/1")],
      },
      worlds: ["test"],
    });
    expect(transferred.outEdges(fileId("apps/backend/lib/callback.ex"))).toEqual([edge]);
    expect(() => plan.commit()).toThrow("already consumed");
  });

  it("transfers through frozen readonly edge and hazard views without rewriting array slots", () => {
    const graph = new IRGraph();
    const file = { kind: "file" as const, id: fileId("lib/frozen.ex"), path: "lib/frozen.ex" };
    const edge = {
      kind: "references" as const,
      referenceKind: "static" as const,
      from: file.id,
      to: file.id,
      site: { ...SITE, file: "lib/frozen.ex" },
    };
    const hazard = {
      file: file.id,
      hazardClass: "elixir-dynamic-dispatch" as const,
      detail: "neutral frozen view",
      site: { ...SITE, file: "lib/frozen.ex" },
    };
    graph.addNode(file);
    graph.addEdge(edge);
    graph.addHazard(hazard);
    const edges = graph.edges();
    const hazards = graph.hazards();
    Object.freeze(edges);
    Object.freeze(hazards);

    expect(() => prepareOwnedGraphRebase(graph, "apps/backend").commit()).not.toThrow();
    expect(graph.edges()).toBe(edges);
    expect(graph.hazards()).toBe(hazards);
    expect(graph.edges()[0]).toBe(edge);
    expect(graph.hazards()[0]).toBe(hazard);
    expect(edge).toMatchObject({
      from: fileId("apps/backend/lib/frozen.ex"),
      to: fileId("apps/backend/lib/frozen.ex"),
      site: { file: "apps/backend/lib/frozen.ex" },
    });
    expect(hazard).toMatchObject({
      file: fileId("apps/backend/lib/frozen.ex"),
      site: { file: "apps/backend/lib/frozen.ex" },
    });
    expect(graph.getNode(fileId("apps/backend/lib/frozen.ex"))).toBe(file);
    expect(graph.outEdges(fileId("apps/backend/lib/frozen.ex"))).toEqual([edge]);
  });

  it.each([
    {
      label: "file",
      scope: Object.freeze({ kind: "file" as const }),
      expectedScope: { kind: "file" },
    },
    {
      label: "unit",
      scope: Object.freeze({ kind: "unit" as const }),
      expectedScope: { kind: "unit" },
    },
    {
      label: "symbols",
      scope: Object.freeze({
        kind: "symbols" as const,
        ids: Object.freeze([symbolId("lib/effect.ex", "App.effect/0")]),
      }),
      expectedScope: {
        kind: "symbols",
        ids: [symbolId("apps/backend/lib/effect.ex", "App.effect/0")],
      },
    },
  ])("precomputes a frozen owned $label hazard effect without changing its meaning", (entry) => {
    const graph = new IRGraph();
    const file = { kind: "file" as const, id: fileId("lib/effect.ex"), path: "lib/effect.ex" };
    const symbol = {
      kind: "symbol" as const,
      id: symbolId("lib/effect.ex", "App.effect/0"),
      file: "lib/effect.ex",
      exportedName: "App.effect/0",
      isDefault: false,
      typeOnly: false,
      local: true,
      span: SITE.span,
    };
    const effect = Object.freeze({
      scope: entry.scope,
      worlds: Object.freeze(["production" as const, "test" as const]),
    });
    const hazard = {
      file: file.id,
      hazardClass: "elixir-dynamic-dispatch" as const,
      detail: "neutral frozen effect",
      site: { ...SITE, file: "lib/effect.ex" },
      effect,
    };
    graph.addNode(file);
    graph.addNode(symbol);
    graph.addHazard(hazard);

    prepareOwnedGraphRebase(graph, "apps/backend").commit();

    expect(hazard.effect).not.toBe(effect);
    expect(hazard.effect).toEqual({
      scope: entry.expectedScope,
      worlds: ["production", "test"],
    });
  });

  it("rejects a graph node reused as a provenance site before mutating any local identity", () => {
    const graph = new IRGraph();
    const file = { kind: "file" as const, id: fileId("lib/a.ex"), path: "lib/a.ex" };
    const symbol = {
      kind: "symbol" as const,
      id: symbolId("lib/a.ex", "App.a/0"),
      file: "lib/a.ex",
      exportedName: "App.a/0",
      isDefault: false,
      typeOnly: false,
      local: true,
      span: { ...SITE.span },
    };
    const edge = {
      kind: "references" as const,
      referenceKind: "static" as const,
      from: file.id,
      to: symbol.id,
      site: symbol,
    };
    graph.addNode(file);
    graph.addNode(symbol);
    graph.addEdge(edge);

    expect(() => prepareOwnedGraphRebase(graph, "apps/backend")).toThrow("incompatible");
    expect(file).toEqual({ kind: "file", id: fileId("lib/a.ex"), path: "lib/a.ex" });
    expect(symbol.file).toBe("lib/a.ex");
    expect(symbol.id).toBe(symbolId("lib/a.ex", "App.a/0"));
    expect(edge.from).toBe(fileId("lib/a.ex"));
    expect(graph.getNode(fileId("lib/a.ex"))).toBe(file);
    expect(graph.getNode(fileId("apps/backend/lib/a.ex"))).toBeUndefined();
  });

  it("rejects edge, hazard, and site records reused in incompatible roles atomically", () => {
    const selfEdgeGraph = new IRGraph();
    const edgeFile = {
      kind: "file" as const,
      id: fileId("lib/edge.ex"),
      path: "lib/edge.ex",
    };
    selfEdgeGraph.addNode(edgeFile);
    const selfEdge = {
      kind: "references" as const,
      referenceKind: "static" as const,
      from: edgeFile.id,
      to: edgeFile.id,
      site: undefined as unknown as Site,
    };
    selfEdge.site = selfEdge as unknown as Site;
    selfEdgeGraph.addEdge(selfEdge);
    expect(() => prepareOwnedGraphRebase(selfEdgeGraph, "apps/backend")).toThrow("incompatible");
    expect(edgeFile.path).toBe("lib/edge.ex");
    expect(selfEdge.from).toBe(fileId("lib/edge.ex"));
    expect(selfEdge.site).toBe(selfEdge);

    const selfHazardGraph = new IRGraph();
    const hazardFile = {
      kind: "file" as const,
      id: fileId("lib/hazard.ex"),
      path: "lib/hazard.ex",
    };
    selfHazardGraph.addNode(hazardFile);
    const selfHazard = {
      file: hazardFile.id,
      hazardClass: "elixir-dynamic-dispatch" as const,
      detail: "neutral",
      site: undefined as unknown as Site,
    };
    selfHazard.site = selfHazard as unknown as Site;
    selfHazardGraph.addHazard(selfHazard);
    expect(() => prepareOwnedGraphRebase(selfHazardGraph, "apps/backend")).toThrow("incompatible");
    expect(hazardFile.path).toBe("lib/hazard.ex");
    expect(selfHazard.file).toBe(fileId("lib/hazard.ex"));
    expect(selfHazard.site).toBe(selfHazard);

    const crossRoleGraph = new IRGraph();
    const crossFile = {
      kind: "file" as const,
      id: fileId("lib/cross.ex"),
      path: "lib/cross.ex",
    };
    crossRoleGraph.addNode(crossFile);
    const crossRole = {
      kind: "references" as const,
      referenceKind: "static" as const,
      from: crossFile.id,
      to: crossFile.id,
      file: crossFile.id,
      hazardClass: "elixir-dynamic-dispatch" as const,
      detail: "neutral",
      site: { ...SITE, file: "lib/cross.ex" },
    };
    crossRoleGraph.addEdge(crossRole);
    crossRoleGraph.addHazard(crossRole);
    expect(() => prepareOwnedGraphRebase(crossRoleGraph, "apps/backend")).toThrow("incompatible");
    expect(crossFile.path).toBe("lib/cross.ex");
    expect(crossRole.from).toBe(fileId("lib/cross.ex"));
    expect(crossRole.file).toBe(fileId("lib/cross.ex"));
    expect(crossRole.site.file).toBe("lib/cross.ex");
    expect(crossRoleGraph.getNode(fileId("apps/backend/lib/cross.ex"))).toBeUndefined();
  });

  it("preserves one valid site shared across graph, contribution, and diagnostic roles", () => {
    const graph = new IRGraph();
    const file = { kind: "file" as const, id: fileId("lib/shared.ex"), path: "lib/shared.ex" };
    const sharedSite = { ...SITE, file: "lib/shared.ex" };
    graph.addNode(file);
    graph.addEdge({
      kind: "references",
      referenceKind: "static",
      from: file.id,
      to: file.id,
      site: sharedSite,
    });
    graph.addHazard({
      file: file.id,
      hazardClass: "elixir-dynamic-dispatch",
      detail: "neutral graph hazard",
      site: sharedSite,
    });
    const diagnostic = {
      pluginId: "neutral",
      severity: "warning" as const,
      code: "neutral-shared-site",
      message: "neutral",
      site: sharedSite,
    };
    const contribution = {
      edges: [
        {
          kind: "references" as const,
          referenceKind: "runtime-resolved" as const,
          from: file.id,
          to: file.id,
          site: sharedSite,
        },
      ],
      hazards: [
        {
          file: file.id,
          hazardClass: "elixir-dynamic-dispatch" as const,
          detail: "neutral deferred hazard",
          site: sharedSite,
        },
      ],
      diagnostics: [diagnostic],
    };
    const plan = prepareOwnedGraphRebase(graph, "apps/backend");
    plan.prepareContribution(contribution);
    plan.prepareDiagnostic(diagnostic);
    const rebased = rebaseGraphContribution(contribution, graph, "apps/backend", plan.context);
    plan.commit();

    expect(sharedSite.file).toBe("apps/backend/lib/shared.ex");
    expect(graph.edges()[0]?.site).toBe(sharedSite);
    expect(graph.hazards()[0]?.site).toBe(sharedSite);
    expect(rebased.edges?.[0]?.site).toBe(sharedSite);
    expect(rebased.edges?.[0]).toMatchObject({
      from: fileId("apps/backend/lib/shared.ex"),
      to: fileId("apps/backend/lib/shared.ex"),
    });
    expect(rebased.hazards?.[0]?.site).toBe(sharedSite);
    expect(rebased.hazards?.[0]?.file).toBe(fileId("apps/backend/lib/shared.ex"));
    expect(rebased.diagnostics?.[0]?.site).toBe(sharedSite);
  });

  it("rejects a stateful nested hazard scope before mutating graph storage", () => {
    const graph = new IRGraph();
    const file = { kind: "file" as const, id: fileId("lib/effect.ex"), path: "lib/effect.ex" };
    const site = { ...SITE, file: "lib/effect.ex" };
    graph.addNode(file);
    const scope = Object.defineProperty({ kind: "symbols" as const }, "ids", {
      enumerable: true,
      configurable: true,
      get: () => [file.id],
    }) as { readonly kind: "symbols"; readonly ids: readonly string[] };
    graph.addHazard({
      file: file.id,
      hazardClass: "elixir-dynamic-dispatch",
      detail: "neutral stateful scope",
      site,
      effect: { scope, worlds: ["production"] },
    });

    expect(() => prepareOwnedGraphRebase(graph, "apps/backend")).toThrow("not stable data");
    expect(file).toEqual({ kind: "file", id: fileId("lib/effect.ex"), path: "lib/effect.ex" });
    expect(site.file).toBe("lib/effect.ex");
    expect(graph.hazards()[0]?.file).toBe(fileId("lib/effect.ex"));
    expect(graph.getNode(fileId("lib/effect.ex"))).toBe(file);
    expect(graph.getNode(fileId("apps/backend/lib/effect.ex"))).toBeUndefined();
  });

  it("validates escaping paths and identity collisions before mutating owned storage", () => {
    const escaping = new IRGraph();
    const file = { kind: "file" as const, id: fileId("lib/a.ex"), path: "lib/a.ex" };
    escaping.addNode(file);
    escaping.addHazard({
      file: file.id,
      hazardClass: "elixir-dynamic-dispatch",
      detail: "neutral",
      site: { ...SITE, file: "../../outside.ex" },
    });
    expect(() => prepareOwnedGraphRebase(escaping, "apps/backend")).toThrow(
      "path must be repository-relative",
    );
    expect(file).toEqual({ kind: "file", id: fileId("lib/a.ex"), path: "lib/a.ex" });

    const collision = new IRGraph();
    const first = { kind: "file" as const, id: fileId("src/../lib/a.ex"), path: "src/../lib/a.ex" };
    const second = { kind: "file" as const, id: fileId("lib/a.ex"), path: "lib/a.ex" };
    collision.addNode(first);
    collision.addNode(second);
    expect(() => prepareOwnedGraphRebase(collision, "apps/backend")).toThrow("duplicate node id");
    expect(first.path).toBe("src/../lib/a.ex");
    expect(second.path).toBe("lib/a.ex");

    const immutable = new IRGraph();
    const frozen = Object.freeze({
      kind: "file" as const,
      id: fileId("lib/frozen.ex"),
      path: "lib/frozen.ex",
    });
    immutable.addNode(frozen);
    expect(() => prepareOwnedGraphRebase(immutable, "apps/backend")).toThrow("not mutable");
    expect(frozen.path).toBe("lib/frozen.ex");

    const accessorGraph = new IRGraph();
    const accessor = Object.defineProperty(
      { kind: "file" as const, id: fileId("lib/accessor.ex") },
      "path",
      {
        enumerable: true,
        configurable: true,
        get: () => "lib/accessor.ex",
      },
    ) as { readonly kind: "file"; readonly id: string; readonly path: string };
    accessorGraph.addNode(accessor);
    expect(() => prepareOwnedGraphRebase(accessorGraph, "apps/backend")).toThrow(
      "not fully writable",
    );
    expect(accessor.id).toBe(fileId("lib/accessor.ex"));
    expect(accessorGraph.getNode(fileId("lib/accessor.ex"))).toBe(accessor);
    expect(accessorGraph.getNode(fileId("apps/backend/lib/accessor.ex"))).toBeUndefined();

    const inconsistent = new IRGraph();
    const aliased = {
      kind: "file" as const,
      id: fileId("lib/alias.ex"),
      path: "lib/actual.ex",
    };
    inconsistent.addNode(aliased);
    expect(() => prepareOwnedGraphRebase(inconsistent, "apps/backend")).toThrow(
      "does not match its identity fields",
    );
    expect(aliased).toEqual({
      kind: "file",
      id: fileId("lib/alias.ex"),
      path: "lib/actual.ex",
    });

    // Entrypoint ids use an unescaped `:target:` delimiter. Prefixing both the
    // file and target can therefore collapse two distinct local identities.
    const entrypoints = new IRGraph();
    const firstRoot = {
      kind: "entrypoint" as const,
      id: entrypointId("production", "x:target:symbol:p/y#z"),
      entryKind: "production" as const,
      file: "x:target:symbol:p/y#z",
      reason: "neutral-a",
    };
    const secondRoot = {
      kind: "entrypoint" as const,
      id: entrypointId("production", "x", symbolId("y", "z")),
      entryKind: "production" as const,
      file: "x",
      targetSymbol: symbolId("y", "z"),
      reason: "neutral-b",
    };
    entrypoints.addNode(firstRoot);
    entrypoints.addNode(secondRoot);
    expect(() => prepareOwnedGraphRebase(entrypoints, "p")).toThrow("duplicate entrypoint id");
    expect(firstRoot.file).toBe("x:target:symbol:p/y#z");
    expect(secondRoot.file).toBe("x");
    expect(entrypoints.getNode(firstRoot.id)).toBe(firstRoot);
    expect(entrypoints.getNode(secondRoot.id)).toBe(secondRoot);

    const staleIndex = new IRGraph();
    const reused = {
      kind: "file" as const,
      id: fileId("lib/a.ex"),
      path: "lib/a.ex",
    };
    staleIndex.addNode(reused);
    Object.assign(reused, { id: fileId("lib/b.ex"), path: "lib/b.ex" });
    staleIndex.addNode(reused);
    expect(() => prepareOwnedGraphRebase(staleIndex, "apps/backend")).toThrow(
      "source index is stale",
    );
    expect(reused.id).toBe(fileId("lib/b.ex"));
    expect(reused.path).toBe("lib/b.ex");
    expect(staleIndex.getNode(fileId("lib/a.ex"))).toBe(reused);
    expect(staleIndex.getNode(fileId("lib/b.ex"))).toBe(reused);
    expect(staleIndex.getNode(fileId("apps/backend/lib/b.ex"))).toBeUndefined();
  });
});
