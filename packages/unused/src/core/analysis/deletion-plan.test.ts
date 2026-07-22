import { describe, expect, it, vi } from "vitest";
import { entrypointId, fileId, IRGraph, type Site, symbolId } from "../ir/index.js";
import { computeDeletionPlan, createDeletionPlanningContext } from "./deletion-plan.js";
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

function addSymbolEntry(graph: IRGraph, file: string, name: string, reason: string): void {
  graph.addNode({
    kind: "entrypoint",
    id: entrypointId("production", file, symbolId(file, name)),
    entryKind: "production",
    file,
    targetSymbol: symbolId(file, name),
    reason,
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
  partitions?: readonly ["test"],
): void {
  graph.addEdge({
    kind: "references",
    referenceKind,
    from,
    to,
    site: site(subjectFile(from), line),
    ...(name === undefined ? {} : { name }),
    ...(partitions === undefined ? {} : { partitions }),
  });
}

function subjectFile(id: string): string {
  return id.slice(id.indexOf(":") + 1).split("#", 1)[0] as string;
}

describe("computeDeletionPlan", () => {
  it("refuses an exact configured root and its file while leaving siblings eligible", () => {
    const graph = new IRGraph();
    addSymbol(graph, "src/operations.ts", "run", { line: 3 });
    addSymbol(graph, "src/operations.ts", "unusedSibling", { line: 8 });
    addSymbolEntry(graph, "src/operations.ts", "run", "configured public operation");
    const reachability = computePartitionedReachability(graph);

    for (const subject of [
      { kind: "export", file: "src/operations.ts", name: "run" } as const,
      { kind: "file", file: "src/operations.ts" } as const,
    ]) {
      expect(computeDeletionPlan({ graph, reachability, subject })).toMatchObject({
        supported: false,
        unsupportedReason:
          "configured symbol entrypoint `run` in src/operations.ts (configured public operation) " +
          "prevents deletion; remove or change entrySymbols before deleting it",
        stages: [],
      });
    }

    expect(
      computeDeletionPlan({
        graph,
        reachability,
        subject: { kind: "export", file: "src/operations.ts", name: "unusedSibling" },
      }),
    ).toMatchObject({ supported: true });
  });

  it("refuses bounded dynamic targets and their containing file only while the exact carrier is active", () => {
    const build = (carrierReachable: boolean): IRGraph => {
      const graph = new IRGraph();
      addEntry(graph, "lib/application.ex");
      addSymbol(graph, "lib/router.ex", "Neutral.Router.dispatch/0");
      addSymbol(graph, "lib/target.ex", "Neutral.Target.possible/0");
      if (carrierReachable) {
        reference(
          graph,
          fileId("lib/application.ex"),
          symbolId("lib/router.ex", "Neutral.Router.dispatch/0"),
        );
      }
      graph.addHazard({
        file: fileId("lib/router.ex"),
        carrierSymbol: symbolId("lib/router.ex", "Neutral.Router.dispatch/0"),
        hazardClass: "elixir-dynamic-dispatch",
        detail: "bounded neutral dispatch",
        site: site("lib/router.ex", 8),
        effect: {
          scope: {
            kind: "symbols",
            ids: [symbolId("lib/target.ex", "Neutral.Target.possible/0")],
          },
          worlds: ["production"],
        },
      });
      return graph;
    };

    const active = build(true);
    const activeReachability = computePartitionedReachability(active);
    for (const subject of [
      { kind: "export", file: "lib/target.ex", name: "Neutral.Target.possible/0" } as const,
      { kind: "file", file: "lib/target.ex" } as const,
    ]) {
      expect(
        computeDeletionPlan({ graph: active, reachability: activeReachability, subject }),
      ).toMatchObject({
        supported: false,
        unsupportedReason:
          "active elixir-dynamic-dispatch hazard at lib/router.ex:8 in production " +
          "prevents proving deletion safe",
        stages: [],
      });
    }

    const inactive = build(false);
    expect(
      computeDeletionPlan({
        graph: inactive,
        reachability: computePartitionedReachability(inactive),
        subject: {
          kind: "export",
          file: "lib/target.ex",
          name: "Neutral.Target.possible/0",
        },
      }),
    ).toMatchObject({ supported: true });
  });

  it("refuses a descendant covered by overlapping bounded effects without losing world provenance", () => {
    const graph = new IRGraph();
    addEntry(graph, "lib/application.ex");
    addSymbol(graph, "lib/router.ex", "Neutral.Router.dispatch/0");
    addSymbol(graph, "lib/target.ex", "Neutral.Target.possible/0");
    addSymbol(graph, "lib/target.ex", "Neutral.Target.consequence/0");
    reference(
      graph,
      fileId("lib/application.ex"),
      symbolId("lib/router.ex", "Neutral.Router.dispatch/0"),
    );
    reference(
      graph,
      symbolId("lib/target.ex", "Neutral.Target.possible/0"),
      symbolId("lib/target.ex", "Neutral.Target.consequence/0"),
    );
    for (const [line, world] of [
      [8, "production"],
      [9, "test"],
    ] as const) {
      graph.addHazard({
        file: fileId("lib/router.ex"),
        carrierSymbol: symbolId("lib/router.ex", "Neutral.Router.dispatch/0"),
        hazardClass: "elixir-dynamic-dispatch",
        detail: `bounded neutral ${world} dispatch`,
        site: site("lib/router.ex", line),
        effect: {
          scope: {
            kind: "symbols",
            ids: [symbolId("lib/target.ex", "Neutral.Target.possible/0")],
          },
          worlds: [world],
        },
      });
    }

    const reachability = computePartitionedReachability(graph);
    expect(
      computeDeletionPlan({
        graph,
        reachability,
        subject: {
          kind: "export",
          file: "lib/target.ex",
          name: "Neutral.Target.consequence/0",
        },
      }),
    ).toMatchObject({
      supported: false,
      unsupportedReason:
        "active elixir-dynamic-dispatch hazard at lib/router.ex:8 in production " +
        "prevents proving deletion safe",
      stages: [],
    });
  });

  it("refuses a subject covered by a reachable opaque unit hazard", () => {
    const graph = new IRGraph();
    addEntry(graph, "lib/application.ex");
    addFile(graph, "lib/candidate.ex");
    graph.addHazard({
      file: fileId("lib/application.ex"),
      hazardClass: "elixir-dynamic-dispatch",
      detail: "opaque neutral dispatch",
      site: site("lib/application.ex", 12),
    });

    expect(
      computeDeletionPlan({
        graph,
        reachability: computePartitionedReachability(graph),
        subject: { kind: "file", file: "lib/candidate.ex" },
      }),
    ).toMatchObject({
      supported: false,
      unsupportedReason:
        "active elixir-dynamic-dispatch hazard at lib/application.ex:12 " +
        "in production/config/test prevents proving deletion safe",
      stages: [],
    });
  });

  it("refuses an unproved computed-atom escape with explicit unit/world evidence", () => {
    const graph = new IRGraph();
    addEntry(graph, "lib/application.ex");
    addFile(graph, "lib/candidate.ex");
    graph.addHazard({
      file: fileId("lib/application.ex"),
      hazardClass: "elixir-computed-atom-escape",
      detail: "computed atom escapes before its consumer can be classified",
      site: site("lib/application.ex", 14),
      effect: { scope: { kind: "unit" }, worlds: ["production"] },
    });

    expect(
      computeDeletionPlan({
        graph,
        reachability: computePartitionedReachability(graph),
        subject: { kind: "file", file: "lib/candidate.ex" },
      }),
    ).toMatchObject({
      supported: false,
      unsupportedReason:
        "computed atom escapes analysis at lib/application.ex:14 in production " +
        "and prevents proving deletion safe",
      stages: [],
    });
  });

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
      schemaVersion: "1.4.0",
      selected: { kind: "export", file: "lib/callback.ex", name: "Callback.handle/0" },
      supported: false,
      unsupportedReason:
        "non-re-export inbound reference remains at lib/config.ex:7; coordinated caller edits or deletion cohort are not modeled",
      reExportEdits: [],
      stages: [],
    });
  });

  it("refuses a subject with a reachable static caller that the plan cannot edit", () => {
    const graph = new IRGraph();
    addEntry(graph, "lib/application.ex");
    addSymbol(graph, "lib/application.ex", "Application.start/2");
    addSymbol(graph, "lib/native.ex", "Native.call/1");
    reference(
      graph,
      symbolId("lib/application.ex", "Application.start/2"),
      symbolId("lib/native.ex", "Native.call/1"),
      5,
      "static",
      "Native.call/1",
    );

    const plan = computeDeletionPlan({
      graph,
      reachability: computePartitionedReachability(graph),
      subject: { kind: "export", file: "lib/native.ex", name: "Native.call/1" },
    });

    expect(plan).toMatchObject({
      supported: false,
      unsupportedReason:
        "non-re-export inbound reference remains at lib/application.ex:5; coordinated caller edits or deletion cohort are not modeled",
      reExportEdits: [],
      stages: [],
    });
  });

  it("refuses deletion through a live test-environment-only reference", () => {
    const graph = new IRGraph();
    addEntry(graph, "lib/application.ex");
    addSymbol(graph, "lib/application.ex", "Application.start/2");
    addSymbol(graph, "lib/test_callback.ex", "TestCallback.perform/0");
    reference(
      graph,
      symbolId("lib/application.ex", "Application.start/2"),
      symbolId("lib/test_callback.ex", "TestCallback.perform/0"),
      9,
      "static",
      "TestCallback.perform/0",
      ["test"],
    );

    const reachability = computePartitionedReachability(graph);
    expect(
      reachability.production.reachableSymbols.has(
        symbolId("lib/test_callback.ex", "TestCallback.perform/0"),
      ),
    ).toBe(false);
    expect(
      reachability.test.reachableSymbols.has(
        symbolId("lib/test_callback.ex", "TestCallback.perform/0"),
      ),
    ).toBe(true);
    expect(
      computeDeletionPlan({
        graph,
        reachability,
        subject: {
          kind: "export",
          file: "lib/test_callback.ex",
          name: "TestCallback.perform/0",
        },
      }),
    ).toMatchObject({
      supported: false,
      unsupportedReason:
        "non-re-export inbound reference remains at lib/application.ex:9; coordinated caller edits or deletion cohort are not modeled",
      stages: [],
    });
  });

  it("refuses a file with an ordinary inbound reference from an already-dead file", () => {
    const graph = new IRGraph();
    addEntry(graph, "lib/application.ex");
    addSymbol(graph, "lib/dead_caller.ex", "DeadCaller.value/0");
    addSymbol(graph, "lib/dead_target.ex", "DeadTarget.value/0");
    reference(
      graph,
      symbolId("lib/dead_caller.ex", "DeadCaller.value/0"),
      symbolId("lib/dead_target.ex", "DeadTarget.value/0"),
      7,
    );
    const reachability = computePartitionedReachability(graph);
    expect(
      reachability.test.reachableSymbols.has(symbolId("lib/dead_caller.ex", "DeadCaller.value/0")),
    ).toBe(false);

    expect(
      computeDeletionPlan({
        graph,
        reachability,
        subject: { kind: "file", file: "lib/dead_target.ex" },
      }),
    ).toMatchObject({
      supported: false,
      unsupportedReason:
        "non-re-export inbound reference remains at lib/dead_caller.ex:7; coordinated caller edits or deletion cohort are not modeled",
      reExportEdits: [],
      stages: [],
    });
  });

  it("refuses a test-scoped inbound reference even when its source is unreachable", () => {
    const graph = new IRGraph();
    addSymbol(graph, "lib/dead_caller.ex", "DeadCaller.value/0");
    addSymbol(graph, "lib/dead_target.ex", "DeadTarget.value/0");
    reference(
      graph,
      symbolId("lib/dead_caller.ex", "DeadCaller.value/0"),
      symbolId("lib/dead_target.ex", "DeadTarget.value/0"),
      11,
      "static",
      "DeadTarget.value/0",
      ["test"],
    );

    expect(
      computeDeletionPlan({
        graph,
        reachability: computePartitionedReachability(graph),
        subject: { kind: "file", file: "lib/dead_target.ex" },
      }),
    ).toMatchObject({
      supported: false,
      unsupportedReason:
        "non-re-export inbound reference remains at lib/dead_caller.ex:11; coordinated caller edits or deletion cohort are not modeled",
    });
  });

  it("chooses the first blocking source site deterministically rather than by insertion order", () => {
    const graph = new IRGraph();
    addSymbol(graph, "lib/z_caller.ex", "ZCaller.value/0");
    addSymbol(graph, "lib/a_caller.ex", "ACaller.value/0");
    addSymbol(graph, "lib/dead_target.ex", "DeadTarget.value/0");
    reference(
      graph,
      symbolId("lib/z_caller.ex", "ZCaller.value/0"),
      symbolId("lib/dead_target.ex", "DeadTarget.value/0"),
      2,
    );
    reference(
      graph,
      symbolId("lib/a_caller.ex", "ACaller.value/0"),
      symbolId("lib/dead_target.ex", "DeadTarget.value/0"),
      9,
    );

    expect(
      computeDeletionPlan({
        graph,
        reachability: computePartitionedReachability(graph),
        subject: { kind: "file", file: "lib/dead_target.ex" },
      }),
    ).toMatchObject({
      unsupportedReason:
        "non-re-export inbound reference remains at lib/a_caller.ex:9; coordinated caller edits or deletion cohort are not modeled",
    });
  });

  it("reuses one inbound index without rescanning the graph for direct blockers", () => {
    const graph = new IRGraph();
    for (let index = 0; index < 20; index += 1) {
      addSymbol(graph, `src/caller_${index}.ts`, `caller_${index}`);
      addSymbol(graph, `src/target_${index}.ts`, `target_${index}`);
      reference(
        graph,
        symbolId(`src/caller_${index}.ts`, `caller_${index}`),
        symbolId(`src/target_${index}.ts`, `target_${index}`),
      );
    }
    const context = createDeletionPlanningContext(graph);
    const reachability = computePartitionedReachability(graph);
    const edges = vi.spyOn(graph, "edges");

    for (let index = 0; index < 20; index += 1) {
      expect(
        computeDeletionPlan({
          graph,
          reachability,
          context,
          subject: { kind: "file", file: `src/target_${index}.ts` },
        }).supported,
      ).toBe(false);
    }
    expect(edges).not.toHaveBeenCalled();
  });

  it("allows same-file local use when deleting only a public export", () => {
    const graph = new IRGraph();
    addSymbol(graph, "src/module.ts", "dead", { localNameKind: "Name" });
    addSymbol(graph, "src/module.ts", "localUser");
    reference(graph, symbolId("src/module.ts", "localUser"), symbolId("src/module.ts", "dead"), 4);

    expect(
      computeDeletionPlan({
        graph,
        reachability: computePartitionedReachability(graph),
        subject: { kind: "export", file: "src/module.ts", name: "dead" },
      }),
    ).toMatchObject({ supported: true, reExportEdits: [], stages: [] });
  });

  it("keeps a re-export-only plan supported with exact required edits", () => {
    const graph = new IRGraph();
    addSymbol(graph, "src/origin.ts", "thing", { line: 2 });
    addSymbol(graph, "src/mid.ts", "thing", { local: false, line: 5 });
    reference(
      graph,
      symbolId("src/mid.ts", "thing"),
      symbolId("src/origin.ts", "thing"),
      5,
      "re-export",
    );

    expect(
      computeDeletionPlan({
        graph,
        reachability: computePartitionedReachability(graph),
        subject: { kind: "export", file: "src/origin.ts", name: "thing", line: 2 },
      }),
    ).toMatchObject({
      supported: true,
      reExportEdits: [
        {
          kind: "remove-re-export",
          file: "src/mid.ts",
          line: 5,
          exportedName: "thing",
          targetFile: "src/origin.ts",
          targetName: "thing",
        },
      ],
    });
  });

  it("keeps a star re-export plan supported when the barrel has a side-effect consumer", () => {
    const graph = new IRGraph();
    addEntry(graph, "src/consumer.ts");
    addSymbol(graph, "src/target.ts", "thing", { line: 2 });
    addFile(graph, "src/barrel.ts");
    reference(graph, fileId("src/barrel.ts"), fileId("src/target.ts"), 4, "re-export", "*");
    reference(graph, fileId("src/consumer.ts"), fileId("src/barrel.ts"), 1, "side-effect");

    expect(
      computeDeletionPlan({
        graph,
        reachability: computePartitionedReachability(graph),
        subject: { kind: "file", file: "src/target.ts" },
      }),
    ).toMatchObject({
      supported: true,
      reExportEdits: [
        {
          kind: "remove-re-export",
          file: "src/barrel.ts",
          line: 4,
          targetFile: "src/target.ts",
        },
      ],
    });
  });

  it("conservatively blocks an unknown consumer of a star-only forwarding surface", () => {
    const graph = new IRGraph();
    addFile(graph, "src/target.ts");
    addFile(graph, "src/barrel.ts");
    addFile(graph, "src/consumer.ts");
    reference(graph, fileId("src/barrel.ts"), fileId("src/target.ts"), 4, "re-export", "*");
    reference(graph, fileId("src/consumer.ts"), fileId("src/barrel.ts"), 8, "static");

    expect(
      computeDeletionPlan({
        graph,
        reachability: computePartitionedReachability(graph),
        subject: { kind: "file", file: "src/target.ts" },
      }),
    ).toMatchObject({
      supported: false,
      unsupportedReason:
        "non-re-export inbound reference remains at src/consumer.ts:8; coordinated caller edits or deletion cohort are not modeled",
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

  it("ignores an inactive test-scoped shortcut when staging an active causal chain", () => {
    const graph = new IRGraph();
    addEntry(graph, "src/selected.ts");
    addSymbol(graph, "src/selected.ts", "start");
    graph.addNode({
      kind: "symbol",
      id: symbolId("src/selected.ts", "privateShortcut"),
      file: "src/selected.ts",
      exportedName: "privateShortcut",
      isDefault: false,
      typeOnly: false,
      local: true,
      span: span(2),
    });
    addSymbol(graph, "src/a.ts", "a");
    addSymbol(graph, "src/b.ts", "b");
    addSymbol(graph, "src/target.ts", "target");
    reference(graph, symbolId("src/selected.ts", "start"), symbolId("src/a.ts", "a"));
    reference(graph, symbolId("src/a.ts", "a"), symbolId("src/b.ts", "b"));
    reference(graph, symbolId("src/b.ts", "b"), symbolId("src/target.ts", "target"));
    reference(
      graph,
      symbolId("src/selected.ts", "privateShortcut"),
      symbolId("src/target.ts", "target"),
      2,
      "static",
      "target",
      ["test"],
    );

    const reachability = computePartitionedReachability(graph);
    expect(
      reachability.test.reachableSymbols.has(symbolId("src/selected.ts", "privateShortcut")),
    ).toBe(false);
    const plan = computeDeletionPlan({
      graph,
      reachability,
      subject: { kind: "file", file: "src/selected.ts" },
    });

    expect(plan.stages).toEqual([
      { stage: 1, newlyDead: [{ kind: "file", file: "src/a.ts" }] },
      { stage: 2, newlyDead: [{ kind: "file", file: "src/b.ts" }] },
      { stage: 3, newlyDead: [{ kind: "file", file: "src/target.ts" }] },
    ]);
  });

  it("ignores an inactive test-scoped reverse re-export when staging a causal chain", () => {
    const graph = new IRGraph();
    addEntry(graph, "src/selected.ts");
    addSymbol(graph, "src/selected.ts", "origin");
    addSymbol(graph, "src/a.ts", "a");
    addSymbol(graph, "src/b.ts", "b");
    addSymbol(graph, "src/target.ts", "target");
    addSymbol(graph, "src/inactive-barrel.ts", "forwarded", { local: false });
    reference(graph, symbolId("src/selected.ts", "origin"), symbolId("src/a.ts", "a"));
    reference(graph, symbolId("src/a.ts", "a"), symbolId("src/b.ts", "b"));
    reference(graph, symbolId("src/b.ts", "b"), symbolId("src/target.ts", "target"));
    reference(
      graph,
      symbolId("src/inactive-barrel.ts", "forwarded"),
      symbolId("src/selected.ts", "origin"),
      4,
      "re-export",
      "origin",
      ["test"],
    );
    reference(
      graph,
      fileId("src/inactive-barrel.ts"),
      symbolId("src/target.ts", "target"),
      5,
      "static",
      "target",
    );

    const reachability = computePartitionedReachability(graph);
    expect(
      reachability.test.reachableSymbols.has(symbolId("src/inactive-barrel.ts", "forwarded")),
    ).toBe(false);
    const plan = computeDeletionPlan({
      graph,
      reachability,
      subject: { kind: "export", file: "src/selected.ts", name: "origin", line: 1 },
    });

    expect(plan.stages).toEqual([
      { stage: 1, newlyDead: [{ kind: "file", file: "src/a.ts" }] },
      { stage: 2, newlyDead: [{ kind: "file", file: "src/b.ts" }] },
      { stage: 3, newlyDead: [{ kind: "file", file: "src/target.ts" }] },
    ]);
  });

  it("puts file-level descendants after the selected export's newly-dead owning file", () => {
    const graph = new IRGraph();
    addEntry(graph, "src/index.ts");
    addSymbol(graph, "src/index.ts", "run", { local: false });
    addSymbol(graph, "src/feature.ts", "run");
    addSymbol(graph, "src/direct.ts", "direct");
    addFile(graph, "src/side-effect.ts");
    reference(
      graph,
      symbolId("src/index.ts", "run"),
      symbolId("src/feature.ts", "run"),
      1,
      "re-export",
      "run",
    );
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

  it("refuses an ordinary consumer through a named re-export chain", () => {
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

    expect(plan).toMatchObject({
      supported: false,
      unsupportedReason:
        "non-re-export inbound reference remains at src/index.ts:1; coordinated caller edits or deletion cohort are not modeled",
      reExportEdits: [],
      stages: [],
    });
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

  it("blocks a consumer when a default assignment stays distinct from a named alias", () => {
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

    expect(plan).toMatchObject({
      supported: false,
      unsupportedReason:
        "non-re-export inbound reference remains at src/index.ts:1; coordinated caller edits or deletion cohort are not modeled",
      reExportEdits: [],
      stages: [],
    });
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

  it("blocks a forwarded consumer when the same-file star fallback is ambiguous", () => {
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

    expect(plan).toMatchObject({
      supported: false,
      unsupportedReason:
        "non-re-export inbound reference remains at src/index.ts:1; coordinated caller edits or deletion cohort are not modeled",
      reExportEdits: [],
      stages: [],
    });
  });

  it("removing a file removes its exports and reports its newly orphaned target", () => {
    const graph = new IRGraph();
    addEntry(graph, "src/feature.ts");
    addSymbol(graph, "src/feature.ts", "feature");
    addSymbol(graph, "src/support.ts", "support");
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
      schemaVersion: "1.4.0",
      selected: { kind: "dependency", file: "package.json", name: "some-package" },
      supported: false,
      unsupportedReason: "dependency deletion has no graph cascade model",
      reExportEdits: [],
      stages: [],
    });
  });
});
