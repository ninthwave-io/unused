import { describe, expect, it } from "vitest";
import { entrypointId, fileId, IRGraph, type Site, symbolId } from "../ir/index.js";
import { computeDeletionPlan } from "./deletion-plan.js";
import { computePartitionedReachability } from "./reachability.js";

const span = (line = 1): Site["span"] => ({
  start: line * 10,
  end: line * 10 + 5,
  startLine: line,
  endLine: line,
});
const site = (file: string, line = 1): Site => ({ file, span: span(line) });

function addFile(graph: IRGraph, file: string): void {
  graph.addNode({ kind: "file", id: fileId(file), path: file });
}

function addEntry(graph: IRGraph, file: string): void {
  addFile(graph, file);
  graph.addNode({
    kind: "entrypoint",
    id: entrypointId("production", file),
    entryKind: "production",
    file,
    reason: "main",
  });
}

function addSymbol(
  graph: IRGraph,
  file: string,
  name: string,
  options: {
    readonly local?: boolean;
    readonly localName?: string;
    readonly localNameKind?: "Name" | "Default" | "None";
    readonly line?: number;
  } = {},
): void {
  addFile(graph, file);
  const local = options.local ?? true;
  const declarationSpan = span(options.line ?? 1);
  graph.addNode({
    kind: "symbol",
    id: symbolId(file, name),
    file,
    exportedName: name,
    ...(options.localName === undefined ? {} : { localName: options.localName }),
    ...(options.localNameKind === undefined ? {} : { localNameKind: options.localNameKind }),
    isDefault: false,
    typeOnly: false,
    local,
    span: declarationSpan,
  });
  graph.addEdge({
    kind: "exports",
    from: fileId(file),
    to: symbolId(file, name),
    name,
    site: { file, span: declarationSpan },
  });
  if (local) {
    graph.addEdge({
      kind: "contains",
      from: fileId(file),
      to: symbolId(file, name),
      name,
      site: { file, span: declarationSpan },
    });
  }
}

function reference(
  graph: IRGraph,
  from: string,
  to: string,
  line = 1,
  referenceKind: "static" | "runtime-resolved" | "re-export" | "side-effect" = "static",
  name?: string,
): void {
  graph.addEdge({
    kind: "references",
    referenceKind,
    from,
    to,
    site: site(subjectFile(from), line),
    ...(name === undefined ? {} : { name }),
  });
}

function subjectFile(id: string): string {
  return id.slice(id.indexOf(":") + 1).split("#", 1)[0] as string;
}

describe("computeDeletionPlan", () => {
  it("refuses a subject selected by a reachable literal runtime convention", () => {
    const graph = new IRGraph();
    addEntry(graph, "lib/application.ex");
    addSymbol(graph, "lib/application.ex", "Application.start/2");
    addSymbol(graph, "lib/config.ex", "Config.callback/1");
    addSymbol(graph, "lib/callback.ex", "Callback.handle/0");
    reference(
      graph,
      symbolId("lib/application.ex", "Application.start/2"),
      symbolId("lib/config.ex", "Config.callback/1"),
    );
    reference(
      graph,
      symbolId("lib/config.ex", "Config.callback/1"),
      symbolId("lib/callback.ex", "Callback.handle/0"),
      7,
      "runtime-resolved",
      "Callback.handle/0",
    );

    const plan = computeDeletionPlan({
      graph,
      reachability: computePartitionedReachability(graph),
      subject: { kind: "export", file: "lib/callback.ex", name: "Callback.handle/0" },
    });

    expect(plan).toEqual({
      schemaVersion: "1.2.0",
      selected: { kind: "export", file: "lib/callback.ex", name: "Callback.handle/0" },
      supported: false,
      unsupportedReason: "selected subject has a live runtime reference at lib/config.ex:7",
      reExportEdits: [],
      stages: [],
    });
  });

  it("groups a newly-dead reference chain into deterministic causal stages", () => {
    const graph = new IRGraph();
    addEntry(graph, "src/index.ts");
    addSymbol(graph, "src/index.ts", "start");
    addSymbol(graph, "src/helper.ts", "helper");
    addSymbol(graph, "src/leaf.ts", "leaf");
    reference(graph, symbolId("src/index.ts", "start"), symbolId("src/helper.ts", "helper"));
    reference(graph, symbolId("src/helper.ts", "helper"), symbolId("src/leaf.ts", "leaf"));

    const plan = computeDeletionPlan({
      graph,
      reachability: computePartitionedReachability(graph),
      subject: { kind: "export", file: "src/index.ts", name: "start", line: 1 },
    });

    expect(plan).toMatchObject({
      supported: true,
      reExportEdits: [],
      stages: [
        { stage: 1, newlyDead: [{ kind: "file", file: "src/helper.ts" }] },
        { stage: 2, newlyDead: [{ kind: "file", file: "src/leaf.ts" }] },
      ],
    });
  });

  it("puts file-level descendants after the selected export's newly-dead owning file", () => {
    const graph = new IRGraph();
    addEntry(graph, "src/index.ts");
    addSymbol(graph, "src/feature.ts", "run");
    addSymbol(graph, "src/direct.ts", "direct");
    addFile(graph, "src/side-effect.ts");
    reference(graph, fileId("src/index.ts"), symbolId("src/feature.ts", "run"));
    reference(graph, symbolId("src/feature.ts", "run"), symbolId("src/direct.ts", "direct"));
    reference(graph, fileId("src/feature.ts"), fileId("src/side-effect.ts"));

    const plan = computeDeletionPlan({
      graph,
      reachability: computePartitionedReachability(graph),
      subject: { kind: "export", file: "src/feature.ts", name: "run", line: 1 },
    });

    expect(plan.stages).toEqual([
      {
        stage: 1,
        newlyDead: [
          { kind: "file", file: "src/direct.ts" },
          { kind: "file", file: "src/feature.ts" },
        ],
      },
      { stage: 2, newlyDead: [{ kind: "file", file: "src/side-effect.ts" }] },
    ]);
  });

  it("returns every required edit in a named re-export chain from stored provenance", () => {
    const graph = new IRGraph();
    addEntry(graph, "src/index.ts");
    addSymbol(graph, "src/origin.ts", "thing", { line: 2 });
    addSymbol(graph, "src/mid.ts", "thing", { local: false, line: 5 });
    addSymbol(graph, "src/api.ts", "thing", { local: false, line: 7 });
    addFile(graph, "src/api-support.ts");
    reference(
      graph,
      symbolId("src/mid.ts", "thing"),
      symbolId("src/origin.ts", "thing"),
      5,
      "re-export",
    );
    reference(
      graph,
      symbolId("src/api.ts", "thing"),
      symbolId("src/mid.ts", "thing"),
      7,
      "re-export",
    );
    reference(graph, fileId("src/index.ts"), symbolId("src/api.ts", "thing"));
    reference(graph, fileId("src/api.ts"), fileId("src/api-support.ts"), 8, "side-effect");

    const plan = computeDeletionPlan({
      graph,
      reachability: computePartitionedReachability(graph),
      subject: { kind: "export", file: "src/origin.ts", name: "thing", line: 2 },
    });

    expect(plan.reExportEdits).toEqual([
      {
        kind: "remove-re-export",
        file: "src/api.ts",
        line: 7,
        exportedName: "thing",
        targetFile: "src/mid.ts",
        targetName: "thing",
        site: site("src/api.ts", 7),
      },
      {
        kind: "remove-re-export",
        file: "src/mid.ts",
        line: 5,
        exportedName: "thing",
        targetFile: "src/origin.ts",
        targetName: "thing",
        site: site("src/mid.ts", 5),
      },
    ]);
    expect(plan.stages).toEqual([
      {
        stage: 1,
        newlyDead: [
          { kind: "file", file: "src/api.ts" },
          { kind: "file", file: "src/mid.ts" },
          { kind: "file", file: "src/origin.ts" },
        ],
      },
      {
        stage: 2,
        newlyDead: [{ kind: "file", file: "src/api-support.ts" }],
      },
    ]);
  });

  it("removes a downstream aliased named re-export across a multihop star chain", () => {
    const graph = new IRGraph();
    addEntry(graph, "src/index.ts");
    addSymbol(graph, "src/origin.ts", "dead", { line: 2 });
    addSymbol(graph, "src/origin.ts", "retained", { line: 3 });
    addFile(graph, "src/inner.ts");
    addFile(graph, "src/mid.ts");
    addSymbol(graph, "src/api.ts", "legacy", { local: false, line: 9 });
    addSymbol(graph, "src/api.ts", "other", { local: false, line: 10 });
    reference(graph, fileId("src/inner.ts"), fileId("src/origin.ts"), 4, "re-export", "*");
    reference(graph, fileId("src/mid.ts"), fileId("src/inner.ts"), 6, "re-export", "*");
    reference(
      graph,
      symbolId("src/api.ts", "legacy"),
      fileId("src/mid.ts"),
      9,
      "re-export",
      "dead",
    );
    reference(
      graph,
      symbolId("src/api.ts", "other"),
      fileId("src/mid.ts"),
      10,
      "re-export",
      "retained",
    );

    const plan = computeDeletionPlan({
      graph,
      reachability: computePartitionedReachability(graph),
      subject: { kind: "export", file: "src/origin.ts", name: "dead", line: 2 },
    });

    expect(plan.reExportEdits).toEqual([
      {
        kind: "remove-re-export",
        file: "src/api.ts",
        line: 9,
        exportedName: "legacy",
        targetFile: "src/mid.ts",
        site: site("src/api.ts", 9),
      },
    ]);
  });

  it("keeps a downstream named re-export when another star source still supplies the name", () => {
    const graph = new IRGraph();
    addSymbol(graph, "src/selected.ts", "shared", { line: 2 });
    addSymbol(graph, "src/alternate.ts", "shared", { line: 3 });
    addFile(graph, "src/barrel.ts");
    addSymbol(graph, "src/api.ts", "shared", { local: false, line: 8 });
    reference(graph, fileId("src/barrel.ts"), fileId("src/selected.ts"), 4, "re-export", "*");
    reference(graph, fileId("src/barrel.ts"), fileId("src/alternate.ts"), 5, "re-export", "*");
    reference(
      graph,
      symbolId("src/api.ts", "shared"),
      fileId("src/barrel.ts"),
      8,
      "re-export",
      "shared",
    );

    const plan = computeDeletionPlan({
      graph,
      reachability: computePartitionedReachability(graph),
      subject: { kind: "export", file: "src/selected.ts", name: "shared", line: 2 },
    });

    expect(plan.reExportEdits).toEqual([]);
  });

  it("keeps exact consumers and re-exports when the selected file has a star fallback", () => {
    const graph = new IRGraph();
    addEntry(graph, "src/index.ts");
    addSymbol(graph, "src/selected.ts", "shared", { line: 2 });
    addSymbol(graph, "src/alternate.ts", "shared", { line: 3 });
    addSymbol(graph, "src/api.ts", "forwarded", { local: false, line: 8 });
    reference(graph, fileId("src/selected.ts"), fileId("src/alternate.ts"), 4, "re-export", "*");
    reference(
      graph,
      symbolId("src/api.ts", "forwarded"),
      symbolId("src/selected.ts", "shared"),
      8,
      "re-export",
      "shared",
    );
    reference(
      graph,
      fileId("src/index.ts"),
      symbolId("src/api.ts", "forwarded"),
      1,
      "static",
      "forwarded",
    );

    const plan = computeDeletionPlan({
      graph,
      reachability: computePartitionedReachability(graph),
      subject: { kind: "export", file: "src/selected.ts", name: "shared", line: 2 },
    });

    expect(plan.reExportEdits).toEqual([]);
    expect(plan.stages).toEqual([]);
  });

  it("keeps fallback when multiple star paths converge on one surviving origin", () => {
    const graph = new IRGraph();
    addEntry(graph, "src/index.ts");
    addSymbol(graph, "src/selected.ts", "shared", { line: 2 });
    addFile(graph, "src/left.ts");
    addFile(graph, "src/right.ts");
    addSymbol(graph, "src/origin.ts", "shared", { line: 3 });
    addSymbol(graph, "src/api.ts", "forwarded", { local: false, line: 8 });
    reference(graph, fileId("src/selected.ts"), fileId("src/left.ts"), 4, "re-export", "*");
    reference(graph, fileId("src/selected.ts"), fileId("src/right.ts"), 5, "re-export", "*");
    reference(graph, fileId("src/left.ts"), fileId("src/origin.ts"), 6, "re-export", "*");
    reference(graph, fileId("src/right.ts"), fileId("src/origin.ts"), 7, "re-export", "*");
    reference(
      graph,
      symbolId("src/api.ts", "forwarded"),
      symbolId("src/selected.ts", "shared"),
      8,
      "re-export",
      "shared",
    );
    reference(
      graph,
      fileId("src/index.ts"),
      symbolId("src/api.ts", "forwarded"),
      1,
      "static",
      "forwarded",
    );

    const plan = computeDeletionPlan({
      graph,
      reachability: computePartitionedReachability(graph),
      subject: { kind: "export", file: "src/selected.ts", name: "shared", line: 2 },
    });

    expect(plan.reExportEdits).toEqual([]);
    expect(plan.stages).toEqual([]);
  });

  it("collapses exported aliases of one local binding into one fallback origin", () => {
    const graph = new IRGraph();
    addEntry(graph, "src/index.ts");
    addSymbol(graph, "src/selected.ts", "shared", { line: 2 });
    addSymbol(graph, "src/origin.ts", "first", {
      localName: "binding",
      localNameKind: "Name",
      line: 3,
    });
    addSymbol(graph, "src/origin.ts", "second", {
      localName: "binding",
      localNameKind: "Name",
      line: 3,
    });
    addSymbol(graph, "src/left.ts", "shared", { local: false, line: 4 });
    addSymbol(graph, "src/right.ts", "shared", { local: false, line: 5 });
    addSymbol(graph, "src/api.ts", "forwarded", { local: false, line: 8 });
    reference(
      graph,
      symbolId("src/left.ts", "shared"),
      symbolId("src/origin.ts", "first"),
      4,
      "re-export",
      "first",
    );
    reference(
      graph,
      symbolId("src/right.ts", "shared"),
      symbolId("src/origin.ts", "second"),
      5,
      "re-export",
      "second",
    );
    reference(graph, fileId("src/selected.ts"), fileId("src/left.ts"), 6, "re-export", "*");
    reference(graph, fileId("src/selected.ts"), fileId("src/right.ts"), 7, "re-export", "*");
    reference(
      graph,
      symbolId("src/api.ts", "forwarded"),
      symbolId("src/selected.ts", "shared"),
      8,
      "re-export",
      "shared",
    );
    reference(
      graph,
      fileId("src/index.ts"),
      symbolId("src/api.ts", "forwarded"),
      1,
      "static",
      "forwarded",
    );

    const plan = computeDeletionPlan({
      graph,
      reachability: computePartitionedReachability(graph),
      subject: { kind: "export", file: "src/selected.ts", name: "shared", line: 2 },
    });

    expect(plan.reExportEdits).toEqual([]);
    expect(plan.stages).toEqual([]);
  });

  it("keeps a default assignment distinct from an alias of its expression binding", () => {
    const graph = new IRGraph();
    addEntry(graph, "src/index.ts");
    addSymbol(graph, "src/selected.ts", "shared", { line: 2 });
    addSymbol(graph, "src/origin.ts", "default", {
      localName: "binding",
      localNameKind: "Default",
      line: 3,
    });
    addSymbol(graph, "src/origin.ts", "named", {
      localName: "binding",
      localNameKind: "Name",
      line: 3,
    });
    addSymbol(graph, "src/left.ts", "shared", { local: false, line: 4 });
    addSymbol(graph, "src/right.ts", "shared", { local: false, line: 5 });
    addSymbol(graph, "src/api.ts", "forwarded", { local: false, line: 8 });
    reference(
      graph,
      symbolId("src/left.ts", "shared"),
      symbolId("src/origin.ts", "default"),
      4,
      "re-export",
      "default",
    );
    reference(
      graph,
      symbolId("src/right.ts", "shared"),
      symbolId("src/origin.ts", "named"),
      5,
      "re-export",
      "named",
    );
    reference(graph, fileId("src/selected.ts"), fileId("src/left.ts"), 6, "re-export", "*");
    reference(graph, fileId("src/selected.ts"), fileId("src/right.ts"), 7, "re-export", "*");
    reference(
      graph,
      symbolId("src/api.ts", "forwarded"),
      symbolId("src/selected.ts", "shared"),
      8,
      "re-export",
      "shared",
    );
    reference(
      graph,
      fileId("src/index.ts"),
      symbolId("src/api.ts", "forwarded"),
      1,
      "static",
      "forwarded",
    );

    const plan = computeDeletionPlan({
      graph,
      reachability: computePartitionedReachability(graph),
      subject: { kind: "export", file: "src/selected.ts", name: "shared", line: 2 },
    });

    expect(plan.reExportEdits).toEqual([
      {
        kind: "remove-re-export",
        file: "src/api.ts",
        line: 8,
        exportedName: "forwarded",
        targetFile: "src/selected.ts",
        targetName: "shared",
        site: site("src/api.ts", 8),
      },
    ]);
  });

  it("collapses namespace wrappers of one target module into one fallback origin", () => {
    const graph = new IRGraph();
    addEntry(graph, "src/index.ts");
    addSymbol(graph, "src/selected.ts", "api", { line: 2 });
    addFile(graph, "src/target.ts");
    addSymbol(graph, "src/left.ts", "api", { local: false, line: 4 });
    addSymbol(graph, "src/right.ts", "api", { local: false, line: 5 });
    addSymbol(graph, "src/public.ts", "api", { local: false, line: 8 });
    reference(graph, symbolId("src/left.ts", "api"), fileId("src/target.ts"), 4, "re-export", "*");
    reference(graph, symbolId("src/right.ts", "api"), fileId("src/target.ts"), 5, "re-export", "*");
    reference(graph, fileId("src/selected.ts"), fileId("src/left.ts"), 6, "re-export", "*");
    reference(graph, fileId("src/selected.ts"), fileId("src/right.ts"), 7, "re-export", "*");
    reference(
      graph,
      symbolId("src/public.ts", "api"),
      symbolId("src/selected.ts", "api"),
      8,
      "re-export",
      "api",
    );
    reference(graph, fileId("src/index.ts"), symbolId("src/public.ts", "api"), 1, "static", "api");

    const plan = computeDeletionPlan({
      graph,
      reachability: computePartitionedReachability(graph),
      subject: { kind: "export", file: "src/selected.ts", name: "api", line: 2 },
    });

    expect(plan.reExportEdits).toEqual([]);
    expect(plan.stages).toEqual([]);
  });

  it("removes a downstream re-export when same-file star fallback is ambiguous", () => {
    const graph = new IRGraph();
    addEntry(graph, "src/index.ts");
    addSymbol(graph, "src/selected.ts", "shared", { line: 2 });
    addSymbol(graph, "src/alternate-a.ts", "shared", { line: 3 });
    addSymbol(graph, "src/alternate-b.ts", "shared", { line: 4 });
    addSymbol(graph, "src/api.ts", "forwarded", { local: false, line: 8 });
    addFile(graph, "src/api-support.ts");
    reference(graph, fileId("src/selected.ts"), fileId("src/alternate-a.ts"), 5, "re-export", "*");
    reference(graph, fileId("src/selected.ts"), fileId("src/alternate-b.ts"), 6, "re-export", "*");
    reference(
      graph,
      symbolId("src/api.ts", "forwarded"),
      symbolId("src/selected.ts", "shared"),
      8,
      "re-export",
      "shared",
    );
    reference(
      graph,
      fileId("src/index.ts"),
      symbolId("src/api.ts", "forwarded"),
      1,
      "static",
      "forwarded",
    );
    reference(graph, fileId("src/api.ts"), fileId("src/api-support.ts"), 9, "side-effect");

    const plan = computeDeletionPlan({
      graph,
      reachability: computePartitionedReachability(graph),
      subject: { kind: "export", file: "src/selected.ts", name: "shared", line: 2 },
    });

    expect(plan.reExportEdits).toEqual([
      {
        kind: "remove-re-export",
        file: "src/api.ts",
        line: 8,
        exportedName: "forwarded",
        targetFile: "src/selected.ts",
        targetName: "shared",
        site: site("src/api.ts", 8),
      },
    ]);
    expect(plan.stages).toEqual([
      {
        stage: 1,
        newlyDead: [
          { kind: "file", file: "src/api.ts" },
          { kind: "file", file: "src/selected.ts" },
        ],
      },
      { stage: 2, newlyDead: [{ kind: "file", file: "src/api-support.ts" }] },
    ]);
  });

  it("removing a file removes its exports and reports its newly orphaned target", () => {
    const graph = new IRGraph();
    addEntry(graph, "src/index.ts");
    addSymbol(graph, "src/index.ts", "run");
    addSymbol(graph, "src/feature.ts", "feature");
    addSymbol(graph, "src/support.ts", "support");
    reference(graph, symbolId("src/index.ts", "run"), symbolId("src/feature.ts", "feature"));
    reference(graph, symbolId("src/feature.ts", "feature"), symbolId("src/support.ts", "support"));

    const plan = computeDeletionPlan({
      graph,
      reachability: computePartitionedReachability(graph),
      subject: { kind: "file", file: "src/feature.ts" },
    });
    expect(plan.stages).toEqual([
      { stage: 1, newlyDead: [{ kind: "file", file: "src/support.ts" }] },
    ]);
  });

  it("returns a conservative empty cascade for unsupported dependencies", () => {
    const graph = new IRGraph();
    const plan = computeDeletionPlan({
      graph,
      reachability: computePartitionedReachability(graph),
      subject: { kind: "dependency", file: "package.json", name: "some-package" },
    });
    expect(plan).toEqual({
      schemaVersion: "1.2.0",
      selected: { kind: "dependency", file: "package.json", name: "some-package" },
      supported: false,
      unsupportedReason: "dependency deletion has no graph cascade model",
      reExportEdits: [],
      stages: [],
    });
  });
});
