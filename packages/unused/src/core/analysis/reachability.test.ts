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
): IREdge {
  const edge: IREdge = {
    kind: "references",
    referenceKind,
    from: fileId(fromRel),
    to: toId,
    site: site(fromRel),
    ...(name !== undefined ? { name } : {}),
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
