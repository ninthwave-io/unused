import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PerformanceTracker } from "../../core/analysis/index.js";
import { dependencyId, fileId, IRGraph } from "../../core/ir/index.js";
import {
  BUILT_IN_LANGUAGE_PLUGINS,
  BUILT_IN_PLUGINS,
  consumeFrontendLocalGraph,
  createFrontendFragment,
  typescriptLanguagePlugin,
} from "./builtins.js";
import { claimAnnotationKey } from "./claim-annotations.js";
import { PluginRegistry } from "./registry.js";
import type { FrontendLocalGraph, ProjectBoundary, RepositoryAnalysisContext } from "./types.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("built-in language plugins", () => {
  it("registers the compiled-in language set deterministically", () => {
    const registry = new PluginRegistry(BUILT_IN_LANGUAGE_PLUGINS);
    expect(registry.languagePlugins().map((plugin) => plugin.id)).toEqual([
      "language:elixir",
      "language:rust",
      "language:typescript",
    ]);
  });

  it("registers conventions and bridges without orchestrator edits", () => {
    const registry = new PluginRegistry(BUILT_IN_PLUGINS);
    expect(registry.conventionPlugins().map((plugin) => plugin.id)).toEqual([
      "convention:ecto",
      "convention:elixir-runtime",
      "convention:elixir-scripts",
      "convention:ex-money",
      "convention:money",
      "convention:rustler-elixir",
      "convention:rustler-rust",
      "convention:typescript-config-carriers",
    ]);
    expect(registry.bridgePlugins().map((plugin) => plugin.id)).toEqual(["bridge:rustler"]);
  });

  it("discovers, analyzes, and rebases a nested TypeScript boundary", async () => {
    const root = await mkdtemp(join(tmpdir(), "unused-plugin-builtins-"));
    temporaryRoots.push(root);
    const project = join(root, "services", "web");
    await mkdir(join(project, "src"), { recursive: true });
    await writeFile(
      join(project, "package.json"),
      JSON.stringify({ name: "neutral-web", type: "module", main: "src/index.ts" }),
    );
    await writeFile(join(project, "src", "index.ts"), "export const live = true;\n");
    await writeFile(join(project, "src", "dead.ts"), "export const dead = true;\n");
    const performance = new PerformanceTracker();
    const context: RepositoryAnalysisContext = {
      rootDir: root,
      gitignore: true,
      manifests: {
        packageJsonDirs: [project],
        mixExsDirs: [],
        cargoTomlDirs: [],
        elixirSourceFiles: [],
        rustSourceFiles: [],
      },
      now: new Date(0),
      toolVersion: "0.1.0",
      performance,
    };

    const boundaries = await typescriptLanguagePlugin.discover(context);
    expect(boundaries).toMatchObject([
      { id: "ts:services/web", rootRelDir: "services/web", manifest: "services/web/package.json" },
    ]);
    const boundary = boundaries[0];
    if (boundary === undefined) throw new Error("expected TypeScript boundary");
    const fragment = await typescriptLanguagePlugin.analyze(context, boundary);

    expect(fragment.graph.getNode(fileId("services/web/src/index.ts"))).toBeDefined();
    expect(fragment.claimInputs.analysisFiles).toEqual(
      new Set(["services/web/src/dead.ts", "services/web/src/index.ts"]),
    );
    expect(fragment.claimInputs.units).toEqual([
      { rootRelDir: "services/web", name: "neutral-web" },
    ]);
    expect(fragment.metadata).toMatchObject({ projectName: "neutral-web", fileCount: 2 });
    expect(performance.snapshot()).toMatchObject({
      phasesMs: {
        "reachability-partitioning": 0,
        "hazard-activation": 0,
        "claim-generation": 0,
      },
      counters: { graphWalks: 0, claims: 0 },
    });
  });

  it("rebases site-bearing analyzer diagnostics with the fragment context", () => {
    const graph = new IRGraph();
    const fragment = createFrontendFragment(
      "language:typescript",
      "ts",
      {
        id: "ts:services/web",
        language: "ts",
        rootDir: "/neutral/services/web",
        rootRelDir: "services/web",
        manifest: "services/web/package.json",
        projectKind: "npm",
      },
      {
        graph,
        provenance: {
          analyzer: "neutral",
          version: "0.0.0",
          generatedAt: new Date(0).toISOString(),
        },
        metadata: {
          projectName: "neutral",
          fileCount: 0,
          workspaceCount: 1,
          configHash: "neutral",
          gateThreshold: "high",
          completeness: { production: "complete", config: "complete", test: "complete" },
        },
        claimInputs: {
          fileLineCounts: new Map(),
          units: [{ rootRelDir: "", name: "neutral" }],
          analysisFiles: new Set(),
          claimableFiles: new Set(),
        },
        claimAnnotations: new Map(),
        diagnostics: [
          {
            pluginId: "language:typescript",
            severity: "warning",
            code: "neutral-site",
            message: "neutral",
            site: {
              file: "src/./index.ts",
              span: { start: 0, end: 1, startLine: 1, endLine: 1 },
            },
          },
        ],
      },
    );

    expect(fragment.diagnostics).toEqual([
      expect.objectContaining({
        boundaryId: "ts:services/web",
        site: expect.objectContaining({ file: "services/web/src/index.ts" }),
      }),
    ]);
  });

  it("keeps copy rebasing immutable and makes owned transfer explicit across every surface", () => {
    const boundary: ProjectBoundary = {
      id: "ts:services/web",
      language: "ts",
      rootDir: "/neutral/services/web",
      rootRelDir: "services/web",
      manifest: "services/web/package.json",
      projectKind: "npm",
    };
    const copiedInput = localFragmentAnalysis();
    const copiedGraph = copiedInput.graph;
    const copiedSite = copiedGraph.edges()[0]?.site;
    const copied = createFrontendFragment("language:typescript", "ts", boundary, copiedInput);
    expect(copied.graph).not.toBe(copiedGraph);
    expect(copiedGraph.getNode(fileId("src/index.ts"))).toBeDefined();
    expect(copiedSite?.file).toBe("src/index.ts");

    const ownedInput = localFragmentAnalysis();
    const ownedGraph = ownedInput.graph;
    const ownedFile = ownedGraph.getNode(fileId("src/index.ts"));
    const ownedEdge = ownedGraph.edges()[0];
    const ownedSite = ownedEdge?.site;
    const owned = consumeFrontendLocalGraph("language:typescript", "ts", boundary, ownedInput);

    expect(owned.graph).toBe(ownedGraph);
    expect(owned.graph.getNode(fileId("services/web/src/index.ts"))).toBe(ownedFile);
    expect(owned.graph.edges()[0]).toBe(ownedEdge);
    expect(ownedSite?.file).toBe("services/web/src/index.ts");
    expect(owned.claimInputs.dependencies?.[0]?.loc.file).toBe("services/web/package.json");
    expect(
      owned.claimAnnotations.has(
        claimAnnotationKey("file", "services/web/src/index.ts", "services/web/src/index.ts"),
      ),
    ).toBe(true);
    expect(owned.deferredContributions?.get("neutral")?.edges?.[0]?.site).toBe(ownedSite);
    expect(owned.diagnostics[0]?.site).toBe(ownedSite);
  });

  it("leaves the owned graph local when a later metadata surface fails validation", () => {
    const boundary: ProjectBoundary = {
      id: "ts:services/web",
      language: "ts",
      rootDir: "/neutral/services/web",
      rootRelDir: "services/web",
      manifest: "services/web/package.json",
      projectKind: "npm",
    };
    const analysis = localFragmentAnalysis();
    const localFile = analysis.graph.getNode(fileId("src/index.ts"));
    const invalid: FrontendLocalGraph = {
      ...analysis,
      claimInputs: {
        ...analysis.claimInputs,
        fileLineCounts: new Map([["not-a-file-id", 1]]),
      },
    };

    expect(() => consumeFrontendLocalGraph("language:typescript", "ts", boundary, invalid)).toThrow(
      "expected file id",
    );
    expect(analysis.graph.getNode(fileId("src/index.ts"))).toBe(localFile);
    expect(analysis.graph.getNode(fileId("services/web/src/index.ts"))).toBeUndefined();
    expect(analysis.graph.edges()[0]?.site.file).toBe("src/index.ts");
  });
});

function localFragmentAnalysis(): FrontendLocalGraph {
  const graph = new IRGraph();
  const site = {
    file: "src/index.ts",
    span: { start: 0, end: 1, startLine: 1, endLine: 1 },
  };
  graph.addNode({ kind: "file", id: fileId("src/index.ts"), path: "src/index.ts" });
  graph.addNode({ kind: "dependency", id: dependencyId("neutral"), packageName: "neutral" });
  graph.addEdge({
    kind: "references",
    referenceKind: "static",
    from: fileId("src/index.ts"),
    to: dependencyId("neutral"),
    site,
    name: "neutral",
  });
  return {
    graph,
    provenance: {
      analyzer: "neutral",
      version: "0.0.0",
      generatedAt: new Date(0).toISOString(),
    },
    metadata: {
      projectName: "neutral",
      fileCount: 1,
      workspaceCount: 1,
      configHash: "neutral",
      gateThreshold: "high",
      completeness: { production: "complete", config: "complete", test: "complete" },
    },
    claimInputs: {
      fileLineCounts: new Map([[fileId("src/index.ts"), 1]]),
      dependencies: [{ packageName: "neutral", loc: { file: "package.json", span: [1, 1] } }],
      units: [{ rootRelDir: "", name: "neutral" }],
      analysisFiles: new Set(["src/index.ts"]),
      claimableFiles: new Set(["src/index.ts"]),
    },
    claimAnnotations: new Map([[claimAnnotationKey("file", "src/index.ts", "src/index.ts"), {}]]),
    deferredContributions: new Map([
      [
        "neutral",
        {
          edges: [
            {
              kind: "references",
              referenceKind: "runtime-resolved",
              from: fileId("src/index.ts"),
              to: dependencyId("neutral"),
              site,
              name: "neutral",
            },
          ],
        },
      ],
    ]),
    diagnostics: [
      {
        pluginId: "language:typescript",
        severity: "warning",
        code: "neutral-site",
        message: "neutral",
        site,
      },
    ],
  };
}
