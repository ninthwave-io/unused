import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { computePartitionedReachability } from "../../core/analysis/index.js";
import { entrypointId, fileId, IRGraph, symbolId } from "../../core/ir/index.js";
import { EMPTY_CONFIG } from "../ts/config.js";
import {
  rustlerBridgePlugin,
  rustlerElixirConventionPlugin,
  rustlerRustConventionPlugin,
} from "./rustler.js";
import type {
  FrontendGraphFragment,
  GraphContribution,
  RepositoryAnalysisContext,
} from "./types.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("Rustler plugins", () => {
  it("joins an exact Elixir stub to its Rust NIF before reachability", async () => {
    const root = await fixtureRoot();
    const exFile = "beam/lib/neutral/native.ex";
    const rsFile = "native/src/lib.rs";
    await write(root, exFile, elixirSource());
    await write(root, rsFile, rustSource());
    const context = repository(root, [rsFile]);
    const ex = fragment("ex", exFile, exGraph(exFile));
    const rs = fragment("rs", rsFile, rustGraph(rsFile));
    const graph = merge(ex.graph, rs.graph);
    add(graph, await rustlerElixirConventionPlugin.analyze({ repository: context, fragment: ex }));
    add(graph, await rustlerRustConventionPlugin.analyze({ repository: context, fragment: rs }));
    const contribution = await rustlerBridgePlugin.analyze({
      repository: context,
      fragments: [ex, rs],
      graph,
    });
    add(graph, contribution);

    expect(contribution.edges).toMatchObject([
      {
        kind: "references",
        referenceKind: "runtime-resolved",
        from: symbolId(exFile, "Neutral.Native.combine/2"),
        to: symbolId(rsFile, "combine"),
        site: { file: exFile, span: { startLine: 6 } },
      },
    ]);
    expect(
      computePartitionedReachability(graph).production.reachableSymbols.has(
        symbolId(rsFile, "combine"),
      ),
    ).toBe(true);
  });

  it("keeps an unmatched exact NIF alive for an external BEAM consumer", async () => {
    const root = await fixtureRoot();
    const rsFile = "native/src/lib.rs";
    await write(root, rsFile, rustSource());
    const context = repository(root, [rsFile]);
    const rs = fragment("rs", rsFile, rustGraph(rsFile));
    const graph = merge(rs.graph);
    add(graph, await rustlerRustConventionPlugin.analyze({ repository: context, fragment: rs }));
    const contribution = await rustlerBridgePlugin.analyze({
      repository: context,
      fragments: [rs],
      graph,
    });
    add(graph, contribution);

    expect(contribution.edges).toMatchObject([
      {
        referenceKind: "runtime-resolved",
        from: fileId(rsFile),
        to: symbolId(rsFile, "combine"),
      },
    ]);
    expect(
      computePartitionedReachability(graph).production.reachableSymbols.has(
        symbolId(rsFile, "combine"),
      ),
    ).toBe(true);
  });

  it("adds a scoped refusal hazard for computed registration", async () => {
    const root = await fixtureRoot();
    const rsFile = "native/src/lib.rs";
    await write(
      root,
      rsFile,
      `#[rustler::nif]\nfn combine(left: i64, right: i64) -> i64 { left + right }\nrustler::init!(module_name());\n`,
    );
    const context = repository(root, [rsFile]);
    const rs = fragment("rs", rsFile, rustGraph(rsFile));

    const contribution = await rustlerRustConventionPlugin.analyze({
      repository: context,
      fragment: rs,
    });
    expect(contribution.hazards).toMatchObject([
      { file: fileId(rsFile), hazardClass: "rustler-ambiguous-registration" },
      { file: fileId(rsFile), hazardClass: "rustler-ambiguous-registration" },
    ]);
  });
});

async function fixtureRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "unused-rustler-plugin-"));
  temporaryRoots.push(root);
  return root;
}

async function write(root: string, file: string, content: string): Promise<void> {
  const full = join(root, file);
  await mkdir(join(full, ".."), { recursive: true });
  await writeFile(full, content);
}

function repository(
  rootDir: string,
  rustSourceFiles: readonly string[],
): RepositoryAnalysisContext {
  return {
    rootDir,
    gitignore: true,
    manifests: {
      packageJsonDirs: [],
      mixExsDirs: [],
      cargoTomlDirs: [],
      elixirSourceFiles: [],
      rustSourceFiles: rustSourceFiles.map((file) => join(rootDir, file)),
    },
    now: new Date(0),
    toolVersion: "0.1.0",
    repositoryConfig: EMPTY_CONFIG,
  };
}

function fragment(language: "ex" | "rs", file: string, graph: IRGraph): FrontendGraphFragment {
  return {
    pluginId: `language:${language}`,
    language,
    boundary: {
      id: `${language}:fixture`,
      language,
      rootDir: "",
      rootRelDir: language === "ex" ? "beam" : "native",
      manifest: language === "ex" ? "beam/mix.exs" : "native/Cargo.toml",
      projectKind: language === "ex" ? "mix" : "cargo-workspace",
    },
    graph,
    provenance: {
      analyzer: `${language}-test`,
      version: "0.1.0",
      generatedAt: new Date(0).toISOString(),
    },
    metadata: {
      projectName: "neutral",
      fileCount: 1,
      workspaceCount: 1,
      configHash: "test",
      gateThreshold: "high",
      completeness: { production: "complete", config: "complete", test: "complete" },
    },
    claimInputs: {
      fileLineCounts: new Map(),
      units: [{ rootRelDir: language === "ex" ? "beam" : "native", name: "neutral" }],
      analysisFiles: new Set([file]),
      claimableFiles: new Set([file]),
    },
    claimAnnotations: new Map(),
    diagnostics: [],
  };
}

function exGraph(file: string): IRGraph {
  const graph = new IRGraph();
  const entry = "beam/lib/neutral/application.ex";
  graph.addNode({ kind: "file", id: fileId(entry), path: entry });
  graph.addNode({ kind: "file", id: fileId(file), path: file });
  graph.addNode({
    kind: "entrypoint",
    id: entrypointId("production", entry),
    entryKind: "production",
    file: entry,
    reason: "neutral-test",
  });
  const stub = symbolId(file, "Neutral.Native.combine/2");
  graph.addNode({
    kind: "symbol",
    id: stub,
    file,
    exportedName: "Neutral.Native.combine/2",
    isDefault: false,
    typeOnly: false,
    local: true,
    span: span(6),
  });
  graph.addEdge({
    kind: "contains",
    from: fileId(file),
    to: stub,
    site: { file, span: span(6) },
    name: "Neutral.Native.combine/2",
  });
  graph.addEdge({
    kind: "references",
    referenceKind: "static",
    from: fileId(entry),
    to: stub,
    site: { file: entry, span: span(4) },
    name: "Neutral.Native.combine/2",
  });
  return graph;
}

function rustGraph(file: string): IRGraph {
  const graph = new IRGraph();
  graph.addNode({ kind: "file", id: fileId(file), path: file });
  graph.addNode({
    kind: "entrypoint",
    id: entrypointId("production", file),
    entryKind: "production",
    file,
    reason: "cargo-target:cdylib",
  });
  return graph;
}

function merge(...graphs: readonly IRGraph[]): IRGraph {
  const merged = new IRGraph();
  for (const graph of graphs)
    add(merged, { nodes: graph.nodes(), edges: graph.edges(), hazards: graph.hazards() });
  return merged;
}

function add(graph: IRGraph, contribution: GraphContribution): void {
  for (const node of contribution.nodes ?? []) graph.addNode(node);
  for (const edge of contribution.edges ?? []) graph.addEdge(edge);
  for (const hazard of contribution.hazards ?? []) graph.addHazard(hazard);
}

function span(line: number): { start: number; end: number; startLine: number; endLine: number } {
  return { start: 0, end: 0, startLine: line, endLine: line };
}

function elixirSource(): string {
  return `defmodule Neutral.Native do
  use Rustler,
    otp_app: :neutral,
    crate: :neutral_native

  def combine(left, right), do: :erlang.nif_error(:nif_not_loaded)
end
`;
}

function rustSource(): string {
  return `#[rustler::nif]
fn combine(left: i64, right: i64) -> i64 { left + right }

rustler::init!("Elixir.Neutral.Native");
`;
}
