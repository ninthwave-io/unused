import { relative, sep } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fileId, IRGraph } from "../../core/ir/index.js";
import { analyzeRustProjectFragment } from "../rust/index.js";
import { EMPTY_CONFIG } from "../ts/config.js";
import { selectProjectBoundaries } from "./boundaries.js";
import { rustLanguagePlugin } from "./builtins.js";
import {
  partitionRustSourceCandidates,
  rustSourceCandidatesForBoundary,
} from "./rust-boundaries.js";
import type { FrontendLocalGraph, RepositoryAnalysisContext } from "./types.js";

vi.mock("../rust/index.js", () => ({
  analyzeRustProjectFragment: vi.fn(),
}));

afterEach(() => {
  vi.clearAllMocks();
});

describe("Rust language boundary inventory", () => {
  it("passes and owns every source candidate only in its sibling Cargo boundary", async () => {
    vi.mocked(analyzeRustProjectFragment).mockImplementation(async (root, _options, internal) =>
      localRustFragment(root, internal?.sourceFiles ?? []),
    );
    const root = "/neutral/repository";
    const alpha = `${root}/native/alpha`;
    const alphabet = `${root}/native/alphabet`;
    const alphabetSource = `${alphabet}/src/lib.rs`;
    const candidates = [
      `${alpha}/src/lib.rs`,
      `${alpha}/src/nested/worker.rs`,
      `${alpha}/tests/contract.rs`,
      alphabetSource,
      `${root}/other/detached.rs`,
    ];
    const context: RepositoryAnalysisContext = {
      rootDir: root,
      gitignore: true,
      manifests: {
        packageJsonDirs: [],
        mixExsDirs: [],
        cargoTomlDirs: [alphabet, alpha],
        elixirSourceFiles: [],
        rustSourceFiles: candidates,
      },
      now: new Date(0),
      toolVersion: "0.1.0",
      repositoryConfig: EMPTY_CONFIG,
    };

    const boundaries = await rustLanguagePlugin.discover(context);
    const fragments = [];
    for (const boundary of boundaries) {
      fragments.push(await rustLanguagePlugin.analyze(context, boundary));
    }

    expect(
      vi.mocked(analyzeRustProjectFragment).mock.calls.map(([boundaryRoot, , internal]) => ({
        boundaryRoot,
        sources: internal?.sourceFiles,
      })),
    ).toEqual([
      { boundaryRoot: alpha, sources: candidates.slice(0, 3) },
      { boundaryRoot: alphabet, sources: [alphabetSource] },
    ]);
    expect(
      fragments.map((fragment) => ({
        boundary: fragment.boundary.id,
        files: [...fragment.claimInputs.analysisFiles],
      })),
    ).toEqual([
      {
        boundary: "rs:native/alpha",
        files: [
          "native/alpha/src/lib.rs",
          "native/alpha/src/nested/worker.rs",
          "native/alpha/tests/contract.rs",
        ],
      },
      {
        boundary: "rs:native/alphabet",
        files: ["native/alphabet/src/lib.rs"],
      },
    ]);
  });

  it("inspects a large shared inventory once and retains every owned candidate", () => {
    const root = "/neutral/scale";
    const boundaryCount = 256;
    const filesPerBoundary = 8;
    const manifestDirs = Array.from(
      { length: boundaryCount },
      (_, index) => `${root}/native/unit-${String(index).padStart(3, "0")}`,
    );
    const boundaries = selectProjectBoundaries(root, manifestDirs, {
      language: "rs",
      manifestName: "Cargo.toml",
      projectKind: "cargo-workspace",
    });
    const expected = new Map<string, string[]>();
    const candidates: string[] = [];
    for (const boundaryRoot of manifestDirs) {
      const sources = Array.from(
        { length: filesPerBoundary },
        (_, index) => `${boundaryRoot}/src/part-${index}.rs`,
      );
      expected.set(boundaryRoot, sources);
      candidates.push(...sources);
    }
    const prefixCollision = `${root}/native/unit-000-extra/src/detached.rs`;
    candidates.splice(17, 0, prefixCollision);

    const partition = partitionRustSourceCandidates(root, boundaries, candidates);

    expect(partition.candidateInspections).toBe(candidates.length);
    expect(partition.candidateInspections).toBe(boundaryCount * filesPerBoundary + 1);
    expect(partition.ancestorProbes).toBeLessThanOrEqual(candidates.length * 5);
    expect(
      partition.boundaries.reduce(
        (total, boundary) => total + rustSourceCandidatesForBoundary(boundary).length,
        0,
      ),
    ).toBe(boundaryCount * filesPerBoundary);
    for (const boundary of partition.boundaries) {
      expect(rustSourceCandidatesForBoundary(boundary)).toEqual(expected.get(boundary.rootDir));
      expect(JSON.stringify(boundary)).not.toContain(".rs");
    }
    expect(
      partition.boundaries.some((boundary) =>
        rustSourceCandidatesForBoundary(boundary).includes(prefixCollision),
      ),
    ).toBe(false);
  });
});

function localRustFragment(root: string, sourceFiles: readonly string[]): FrontendLocalGraph {
  const files = sourceFiles.map((file) => relative(root, file).split(sep).join("/"));
  const graph = new IRGraph();
  for (const file of files) graph.addNode({ kind: "file", id: fileId(file), path: file });
  return {
    graph,
    provenance: {
      analyzer: "rust-reference-graph",
      version: "0.1.0",
      generatedAt: new Date(0).toISOString(),
    },
    metadata: {
      projectName: "neutral",
      fileCount: files.length,
      workspaceCount: 1,
      configHash: "neutral",
      gateThreshold: "high",
      completeness: { production: "complete", config: "complete", test: "complete" },
    },
    claimInputs: {
      fileLineCounts: new Map(files.map((file) => [fileId(file), 1])),
      units: [{ rootRelDir: "", name: "neutral" }],
      analysisFiles: new Set(files),
      claimableFiles: new Set(files),
    },
    claimAnnotations: new Map(),
    diagnostics: [],
  };
}
