/**
 * Reachability unit tests (T2.4). Graphs are built by hand from `core/ir`
 * primitives — a `core/analysis` test must not import a frontend (ADR 0003,
 * dependency-cruiser) — so each test isolates one reachability rule on a
 * minimal, hand-verified graph. The end-to-end behaviour over real IR is
 * covered by `frontends/ts/analyze.test.ts`.
 */
import { describe, expect, it } from "vitest";
import {
  entrypointId,
  fileId,
  type IREdge,
  IRGraph,
  type ReferenceKind,
  type Site,
  symbolId,
} from "../ir/index.js";
import {
  computePartitionedReachability,
  computeReachability,
  type Predecessor,
  type Reachability,
  whyReachable,
} from "./reachability.js";

// --- tiny graph DSL --------------------------------------------------------

const SPAN = { start: 0, end: 0, startLine: 1, endLine: 1 };
const site = (file: string): Site => ({ file, span: SPAN });

function addFile(g: IRGraph, rel: string): void {
  g.addNode({ kind: "file", id: fileId(rel), path: rel });
}

function addEntry(g: IRGraph, rel: string, reason = "main"): void {
  addFile(g, rel);
  g.addNode({
    kind: "entrypoint",
    id: entrypointId("production", rel),
    entryKind: "production",
    file: rel,
    reason,
  });
}

function addSymbolEntry(g: IRGraph, rel: string, name: string, reason: string): void {
  const targetSymbol = symbolId(rel, name);
  g.addNode({
    kind: "entrypoint",
    id: entrypointId("production", rel, targetSymbol),
    entryKind: "production",
    file: rel,
    targetSymbol,
    reason,
  });
}

function addConfigEntry(g: IRGraph, rel: string): void {
  addFile(g, rel);
  g.addNode({
    kind: "entrypoint",
    id: entrypointId("config", rel),
    entryKind: "config",
    file: rel,
    reason: "config-root",
  });
}

function addTestEntry(g: IRGraph, rel: string): void {
  addFile(g, rel);
  g.addNode({
    kind: "entrypoint",
    id: entrypointId("test", rel),
    entryKind: "test",
    file: rel,
    reason: "test-file",
  });
}

function addSymbol(g: IRGraph, rel: string, name: string, local = true): void {
  addFile(g, rel);
  g.addNode({
    kind: "symbol",
    id: symbolId(rel, name),
    file: rel,
    exportedName: name,
    isDefault: false,
    typeOnly: false,
    local,
    span: SPAN,
  });
  g.addEdge({ kind: "exports", from: fileId(rel), to: symbolId(rel, name), site: site(rel), name });
  if (local) {
    g.addEdge({
      kind: "contains",
      from: fileId(rel),
      to: symbolId(rel, name),
      site: site(rel),
      name,
    });
  }
}

function ref(
  g: IRGraph,
  fromRel: string,
  toId: string,
  referenceKind: ReferenceKind,
  name?: string,
  partitions?: IREdge["partitions"],
): IREdge {
  const edge: IREdge = {
    kind: "references",
    referenceKind,
    from: fileId(fromRel),
    to: toId,
    site: site(fromRel),
    ...(name !== undefined ? { name } : {}),
    ...(partitions !== undefined ? { partitions } : {}),
  };
  g.addEdge(edge);
  return edge;
}

// --- tests -----------------------------------------------------------------

describe("star-chain name resolution (rule 1)", () => {
  it("resolves a single origin through a two-level `export *` chain; the sibling stays dead", () => {
    // index → "widgetA" → api =*=> mid =*=> widgets{widgetA, widgetB}
    const g = new IRGraph();
    addEntry(g, "src/index.ts");
    addFile(g, "src/api.ts");
    addFile(g, "src/mid.ts");
    addSymbol(g, "src/widgets.ts", "widgetA");
    addSymbol(g, "src/widgets.ts", "widgetB");
    ref(g, "src/index.ts", fileId("src/api.ts"), "static", "widgetA");
    ref(g, "src/api.ts", fileId("src/mid.ts"), "re-export", "*");
    ref(g, "src/mid.ts", fileId("src/widgets.ts"), "re-export", "*");

    const r = computeReachability(g);
    expect(r.reachableSymbols.has(symbolId("src/widgets.ts", "widgetA"))).toBe(true);
    expect(r.reachableSymbols.has(symbolId("src/widgets.ts", "widgetB"))).toBe(false);
    // Every barrel on the live chain is reachable, but the terminal surface is NOT
    // blanket-live — only the resolved name.
    expect(r.reachableFiles.has(fileId("src/widgets.ts"))).toBe(true);
    expect(r.surfaceLiveFiles.has(fileId("src/widgets.ts"))).toBe(false);
  });

  it("ambiguity (same name via two star sources) keeps BOTH surfaces alive — never drop a name", () => {
    const g = new IRGraph();
    addEntry(g, "src/index.ts");
    addFile(g, "src/barrel.ts");
    addSymbol(g, "src/s1.ts", "X");
    addSymbol(g, "src/s2.ts", "X");
    ref(g, "src/index.ts", fileId("src/barrel.ts"), "static", "X");
    ref(g, "src/barrel.ts", fileId("src/s1.ts"), "re-export", "*");
    ref(g, "src/barrel.ts", fileId("src/s2.ts"), "re-export", "*");

    const r = computeReachability(g);
    expect(r.reachableSymbols.has(symbolId("src/s1.ts", "X"))).toBe(true);
    expect(r.reachableSymbols.has(symbolId("src/s2.ts", "X"))).toBe(true);
    expect(r.surfaceLiveFiles.has(fileId("src/s1.ts"))).toBe(true);
    expect(r.surfaceLiveFiles.has(fileId("src/s2.ts"))).toBe(true);
  });

  it("an unresolved name keeps the whole downstream surface alive", () => {
    const g = new IRGraph();
    addEntry(g, "src/index.ts");
    addFile(g, "src/barrel.ts");
    addSymbol(g, "src/leaf.ts", "Z"); // barrel forwards leaf via `export *`, but the name is Y
    ref(g, "src/index.ts", fileId("src/barrel.ts"), "static", "Y");
    ref(g, "src/barrel.ts", fileId("src/leaf.ts"), "re-export", "*");

    const r = computeReachability(g);
    // Y is not found, so the barrel's whole forwarded surface is kept alive.
    expect(r.surfaceLiveFiles.has(fileId("src/barrel.ts"))).toBe(true);
    expect(r.reachableSymbols.has(symbolId("src/leaf.ts", "Z"))).toBe(true);
  });
});

describe("export-surface reachability (rule 2)", () => {
  it("a named import into a non-entrypoint file reaches only that symbol, not the whole surface", () => {
    const g = new IRGraph();
    addEntry(g, "src/index.ts");
    addSymbol(g, "src/lib.ts", "used");
    addSymbol(g, "src/lib.ts", "unused");
    ref(g, "src/index.ts", symbolId("src/lib.ts", "used"), "static", "used");

    const r = computeReachability(g);
    expect(r.reachableSymbols.has(symbolId("src/lib.ts", "used"))).toBe(true);
    expect(r.reachableSymbols.has(symbolId("src/lib.ts", "unused"))).toBe(false);
    expect(r.reachableFiles.has(fileId("src/lib.ts"))).toBe(true);
    expect(r.surfaceLiveFiles.has(fileId("src/lib.ts"))).toBe(false); // exports NOT blanket-traversed
  });

  it("a side-effect import reaches the FILE but leaves its exports flaggable", () => {
    const g = new IRGraph();
    addEntry(g, "src/index.ts");
    addSymbol(g, "src/polyfill.ts", "helper");
    ref(g, "src/index.ts", fileId("src/polyfill.ts"), "side-effect");

    const r = computeReachability(g);
    expect(r.reachableFiles.has(fileId("src/polyfill.ts"))).toBe(true);
    expect(r.surfaceLiveFiles.has(fileId("src/polyfill.ts"))).toBe(false);
    expect(r.reachableSymbols.has(symbolId("src/polyfill.ts", "helper"))).toBe(false);
  });

  it("an entrypoint's own export surface is live by assumption (public API)", () => {
    const g = new IRGraph();
    addEntry(g, "src/index.ts");
    addSymbol(g, "src/index.ts", "publicApi");

    const r = computeReachability(g);
    expect(r.surfaceLiveFiles.has(fileId("src/index.ts"))).toBe(true);
    expect(r.reachableSymbols.has(symbolId("src/index.ts", "publicApi"))).toBe(true);
  });

  it("an exact symbol entrypoint roots its file and dependencies without surface-live siblings", () => {
    const g = new IRGraph();
    addSymbol(g, "src/api.ts", "run");
    addSymbol(g, "src/api.ts", "unusedSibling");
    addSymbol(g, "src/dependency.ts", "helper");
    g.addEdge({
      kind: "references",
      referenceKind: "static",
      from: symbolId("src/api.ts", "run"),
      to: symbolId("src/dependency.ts", "helper"),
      site: site("src/api.ts"),
      name: "helper",
    });
    addSymbolEntry(g, "src/api.ts", "run", "configured public operation");

    const r = computeReachability(g);
    expect(r.reachableFiles).toEqual(new Set([fileId("src/api.ts"), fileId("src/dependency.ts")]));
    expect(r.surfaceLiveFiles.has(fileId("src/api.ts"))).toBe(false);
    expect(r.reachableSymbols.has(symbolId("src/api.ts", "run"))).toBe(true);
    expect(r.reachableSymbols.has(symbolId("src/dependency.ts", "helper"))).toBe(true);
    expect(r.reachableSymbols.has(symbolId("src/api.ts", "unusedSibling"))).toBe(false);
    expect(whyReachable(r, symbolId("src/api.ts", "run")).entrypoint).toMatchObject({
      reason: "configured public operation",
      targetSymbol: symbolId("src/api.ts", "run"),
    });
  });

  it("a whole-module dynamic-resolved (require) edge makes the target surface live", () => {
    const g = new IRGraph();
    addEntry(g, "src/index.ts");
    addSymbol(g, "src/cjs.ts", "a");
    addSymbol(g, "src/cjs.ts", "b");
    ref(g, "src/index.ts", fileId("src/cjs.ts"), "dynamic-resolved");

    const r = computeReachability(g);
    expect(r.surfaceLiveFiles.has(fileId("src/cjs.ts"))).toBe(true);
    expect(r.reachableSymbols.has(symbolId("src/cjs.ts", "a"))).toBe(true);
    expect(r.reachableSymbols.has(symbolId("src/cjs.ts", "b"))).toBe(true);
  });
});

describe("termination", () => {
  it("terminates on a circular `export *` chain (a ⇄ b), reaching both surfaces", () => {
    const g = new IRGraph();
    addEntry(g, "src/a.ts", "main");
    addSymbol(g, "src/a.ts", "fromA");
    addSymbol(g, "src/b.ts", "fromB");
    ref(g, "src/a.ts", fileId("src/b.ts"), "re-export", "*");
    ref(g, "src/b.ts", fileId("src/a.ts"), "re-export", "*");

    const r = computeReachability(g);
    expect(r.reachableSymbols.has(symbolId("src/a.ts", "fromA"))).toBe(true);
    expect(r.reachableSymbols.has(symbolId("src/b.ts", "fromB"))).toBe(true);
    expect(r.surfaceLiveFiles.has(fileId("src/b.ts"))).toBe(true);
  });
});

describe("config roots as seeds (architecture §3)", () => {
  it("seeds a config root surface-live and keeps its imported helper alive, without a production root", () => {
    const g = new IRGraph();
    addConfigEntry(g, "vite.config.ts");
    addSymbol(g, "src/build.ts", "buildOptions");
    ref(g, "vite.config.ts", symbolId("src/build.ts", "buildOptions"), "static", "buildOptions");

    const r = computeReachability(g);
    expect(r.entrypointFiles.has(fileId("vite.config.ts"))).toBe(true);
    expect(r.productionEntrypointFiles.size).toBe(0); // config is not a production root
    expect(r.surfaceLiveFiles.has(fileId("vite.config.ts"))).toBe(true);
    expect(r.reachableSymbols.has(symbolId("src/build.ts", "buildOptions"))).toBe(true);
  });
});

describe("partitioned reachability (T5.1)", () => {
  it("separates production, config, and test reach; a test-only file is test-reachable only", () => {
    const g = new IRGraph();
    addEntry(g, "src/index.ts");
    addSymbol(g, "src/prod.ts", "prodThing");
    ref(g, "src/index.ts", symbolId("src/prod.ts", "prodThing"), "static", "prodThing");
    addSymbol(g, "src/feature.ts", "computeFeature");
    addTestEntry(g, "test/feature.test.ts");
    ref(
      g,
      "test/feature.test.ts",
      symbolId("src/feature.ts", "computeFeature"),
      "static",
      "computeFeature",
    );

    const p = computePartitionedReachability(g);
    // The test world includes the production baseline, while the independent
    // production walk remains the authority for alive-vs-test-only priority.
    expect(p.production.reachableFiles.has(fileId("src/prod.ts"))).toBe(true);
    expect(p.test.reachableFiles.has(fileId("src/prod.ts"))).toBe(true);
    // The test-only file is reachable only from the test partition.
    expect(p.test.reachableFiles.has(fileId("src/feature.ts"))).toBe(true);
    expect(p.production.reachableFiles.has(fileId("src/feature.ts"))).toBe(false);
    expect(p.config.reachableFiles.size).toBe(0);
    // The production partition still records the production root.
    expect(p.production.productionEntrypointFiles.size).toBe(1);
    // The effective test world preserves the production root's provenance while
    // adding test-only edges and roots.
    expect(p.test.productionEntrypointFiles.size).toBe(1);
  });

  it("activates test-scoped edges from production and config baselines only in the test world", () => {
    const g = new IRGraph();
    addEntry(g, "lib/application.ex");
    addSymbol(g, "lib/test_target.ex", "TestTarget.callback/0");
    ref(
      g,
      "lib/application.ex",
      symbolId("lib/test_target.ex", "TestTarget.callback/0"),
      "static",
      "TestTarget.callback/0",
      ["test"],
    );
    addConfigEntry(g, "config/runtime.exs");
    addSymbol(g, "lib/config_target.ex", "ConfigTarget.callback/0");
    ref(
      g,
      "config/runtime.exs",
      symbolId("lib/config_target.ex", "ConfigTarget.callback/0"),
      "static",
      "ConfigTarget.callback/0",
      ["test"],
    );
    addTestEntry(g, "test/neutral_test.exs");

    const p = computePartitionedReachability(g);
    for (const [id, entryKind, reason] of [
      [symbolId("lib/test_target.ex", "TestTarget.callback/0"), "production", "main"],
      [symbolId("lib/config_target.ex", "ConfigTarget.callback/0"), "config", "config-root"],
    ] as const) {
      expect(p.production.reachableSymbols.has(id)).toBe(false);
      expect(p.config.reachableSymbols.has(id)).toBe(false);
      expect(p.test.reachableSymbols.has(id)).toBe(true);
      expect(whyReachable(p.test, id).entrypoint).toMatchObject({
        entryKind,
        reason,
      });
    }
  });

  it("leaves ordinary shared edges active in production, config, and the effective test world", () => {
    const g = new IRGraph();
    addEntry(g, "src/index.ts");
    addConfigEntry(g, "vite.config.ts");
    addTestEntry(g, "test/index.test.ts");
    addSymbol(g, "src/prod.ts", "prod");
    addSymbol(g, "src/config.ts", "config");
    addSymbol(g, "src/test.ts", "test");
    ref(g, "src/index.ts", symbolId("src/prod.ts", "prod"), "static", "prod");
    ref(g, "vite.config.ts", symbolId("src/config.ts", "config"), "static", "config");
    ref(g, "test/index.test.ts", symbolId("src/test.ts", "test"), "static", "test");

    const p = computePartitionedReachability(g);
    expect(p.production.reachableSymbols.has(symbolId("src/prod.ts", "prod"))).toBe(true);
    expect(p.config.reachableSymbols.has(symbolId("src/config.ts", "config"))).toBe(true);
    expect(p.test.reachableSymbols.has(symbolId("src/prod.ts", "prod"))).toBe(true);
    expect(p.test.reachableSymbols.has(symbolId("src/config.ts", "config"))).toBe(true);
    expect(p.test.reachableSymbols.has(symbolId("src/test.ts", "test"))).toBe(true);
  });

  it("does not resolve a production named import through a test-scoped star re-export", () => {
    const g = new IRGraph();
    addEntry(g, "src/index.ts");
    addFile(g, "src/barrel.ts");
    addSymbol(g, "src/target.ts", "value");
    ref(g, "src/index.ts", fileId("src/barrel.ts"), "static", "value");
    ref(g, "src/barrel.ts", fileId("src/target.ts"), "re-export", "*", ["test"]);

    const p = computePartitionedReachability(g);
    expect(p.production.reachableSymbols.has(symbolId("src/target.ts", "value"))).toBe(false);
    expect(p.config.reachableSymbols.has(symbolId("src/target.ts", "value"))).toBe(false);
    expect(p.test.reachableSymbols.has(symbolId("src/target.ts", "value"))).toBe(true);
  });

  it("a symbol imported by BOTH production and a test is in the production partition (the shared-util trap)", () => {
    const g = new IRGraph();
    addEntry(g, "src/index.ts");
    addSymbol(g, "src/shared.ts", "sharedUtil");
    ref(g, "src/index.ts", symbolId("src/shared.ts", "sharedUtil"), "static", "sharedUtil");
    addTestEntry(g, "test/shared.test.ts");
    ref(g, "test/shared.test.ts", symbolId("src/shared.ts", "sharedUtil"), "static", "sharedUtil");

    const p = computePartitionedReachability(g);
    expect(p.production.reachableSymbols.has(symbolId("src/shared.ts", "sharedUtil"))).toBe(true);
    expect(p.test.reachableSymbols.has(symbolId("src/shared.ts", "sharedUtil"))).toBe(true);
  });

  it("seedFilter restricts the seeded roots (a config-only walk ignores the production root)", () => {
    const g = new IRGraph();
    addEntry(g, "src/index.ts");
    addConfigEntry(g, "vite.config.ts");

    const configOnly = computeReachability(g, { seedFilter: (e) => e.entryKind === "config" });
    expect(configOnly.entrypointFiles.has(fileId("vite.config.ts"))).toBe(true);
    expect(configOnly.entrypointFiles.has(fileId("src/index.ts"))).toBe(false);
    expect(configOnly.productionEntrypointFiles.size).toBe(0);
  });
});

describe("whyReachable", () => {
  it("returns the entrypoint→symbol edge chain for a reachable symbol", () => {
    const g = new IRGraph();
    addEntry(g, "src/index.ts");
    addSymbol(g, "src/lib.ts", "used");
    addSymbol(g, "src/lib.ts", "unused");
    const edge = ref(g, "src/index.ts", symbolId("src/lib.ts", "used"), "static", "used");

    const r = computeReachability(g);
    const why = whyReachable(r, symbolId("src/lib.ts", "used"));
    expect(why.reachable).toBe(true);
    expect(why.entrypoint?.file).toBe("src/index.ts");
    expect(why.entrypoint?.reason).toBe("main");
    expect(why.entrypoint?.entryKind).toBe("production");
    expect(why.edges).toEqual([edge]);
    expect(why.edges[0]?.from).toBe(fileId("src/index.ts"));
  });

  it("reports an unreachable symbol as not reachable", () => {
    const g = new IRGraph();
    addEntry(g, "src/index.ts");
    addSymbol(g, "src/lib.ts", "used");
    addSymbol(g, "src/lib.ts", "unused");
    ref(g, "src/index.ts", symbolId("src/lib.ts", "used"), "static", "used");

    const r = computeReachability(g);
    const why = whyReachable(r, symbolId("src/lib.ts", "unused"));
    expect(why.reachable).toBe(false);
    expect(why.edges).toEqual([]);
  });

  it("terminates on a cyclic predecessor chain (guarded), never looping forever", () => {
    // A pathological predecessor map with a 2-cycle and no entrypoint terminal:
    // whyReachable must break on the cycle guard and return a finite chain.
    const eXY: IREdge = {
      kind: "references",
      referenceKind: "static",
      from: fileId("src/y.ts"),
      to: fileId("src/x.ts"),
      site: site("src/y.ts"),
    };
    const eYX: IREdge = {
      kind: "references",
      referenceKind: "static",
      from: fileId("src/x.ts"),
      to: fileId("src/y.ts"),
      site: site("src/x.ts"),
    };
    const predecessor = new Map<string, Predecessor>([
      [fileId("src/x.ts"), { via: "edge", edge: eXY }],
      [fileId("src/y.ts"), { via: "edge", edge: eYX }],
    ]);
    const reach: Reachability = {
      reachableFiles: new Set(),
      surfaceLiveFiles: new Set(),
      reachableSymbols: new Set(),
      entrypointFiles: new Set(),
      productionEntrypointFiles: new Set(),
      predecessor,
    };

    const why = whyReachable(reach, fileId("src/x.ts"));
    expect(why.reachable).toBe(true);
    expect(why.edges.length).toBeLessThanOrEqual(2); // finite — did not loop
  });

  it("multi-hop chain: threads the why-path across a transitive import", () => {
    // index → greet(greet.ts) ; greet.ts → format(format.ts)
    const g = new IRGraph();
    addEntry(g, "src/index.ts");
    addSymbol(g, "src/greet.ts", "greet");
    addSymbol(g, "src/format.ts", "format");
    ref(g, "src/index.ts", symbolId("src/greet.ts", "greet"), "static", "greet");
    // an edge originating from greet.ts's file to format's symbol
    const e2: IREdge = {
      kind: "references",
      referenceKind: "static",
      from: fileId("src/greet.ts"),
      to: symbolId("src/format.ts", "format"),
      site: site("src/greet.ts"),
      name: "format",
    };
    g.addEdge(e2);

    const r = computeReachability(g);
    const why = whyReachable(r, symbolId("src/format.ts", "format"));
    expect(why.reachable).toBe(true);
    expect(why.entrypoint?.file).toBe("src/index.ts");
    // two edges: index→greet, then greet→format
    expect(why.edges.map((e) => e.from)).toEqual([fileId("src/index.ts"), fileId("src/greet.ts")]);
  });
});
