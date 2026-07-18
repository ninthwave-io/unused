/**
 * Claim-emission unit tests (T2.4). Hand-built graphs isolate each M2 emission
 * rule and each hazard keep-alive class (`core/analysis` must not import a
 * frontend — ADR 0003). The real-fixture join is in `frontends/ts/analyze.test.ts`.
 */
import { describe, expect, it } from "vitest";
import type { Claim, Provenance } from "../claims/types.js";
import {
  entrypointId,
  fileId,
  type HazardAnnotation,
  IRGraph,
  type ReferenceKind,
  type Site,
  symbolId,
} from "../ir/index.js";
import { emitClaims } from "./claims.js";
import { computeReachability } from "./reachability.js";

const PROVENANCE: Provenance = {
  analyzer: "ts-reference-graph",
  version: "0.1.0",
  generatedAt: "1970-01-01T00:00:00.000Z",
};

const SPAN = { start: 0, end: 0, startLine: 1, endLine: 1 };
const site = (file: string): Site => ({ file, span: SPAN });

interface SymbolOpts {
  local?: boolean;
  suppression?: { reason: string | null; valid: boolean };
}

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

function addSymbol(g: IRGraph, rel: string, name: string, opts: SymbolOpts = {}): void {
  addFile(g, rel);
  const local = opts.local ?? true;
  g.addNode({
    kind: "symbol",
    id: symbolId(rel, name),
    file: rel,
    exportedName: name,
    isDefault: false,
    typeOnly: false,
    local,
    span: SPAN,
    ...(opts.suppression !== undefined ? { suppression: opts.suppression } : {}),
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

function ref(g: IRGraph, fromRel: string, toId: string, kind: ReferenceKind, name?: string): void {
  g.addEdge({
    kind: "references",
    referenceKind: kind,
    from: fileId(fromRel),
    to: toId,
    site: site(fromRel),
    ...(name !== undefined ? { name } : {}),
  });
}

function hazard(g: IRGraph, fileRel: string, hazardClass: string): void {
  const annotation: HazardAnnotation = {
    file: fileId(fileRel),
    hazardClass,
    detail: `test hazard ${hazardClass}`,
    site: site(fileRel),
  };
  g.addHazard(annotation);
}

function run(g: IRGraph, fileLineCounts?: Map<string, number>): Claim[] {
  const reachability = computeReachability(g);
  return emitClaims({
    graph: g,
    reachability,
    provenance: PROVENANCE,
    ...(fileLineCounts !== undefined ? { fileLineCounts } : {}),
  });
}

/** Compact projection for assertions. */
function shape(claims: Claim[]): Array<{
  kind: string;
  name: string;
  file: string;
  verdict: string;
  confidence: string;
}> {
  return claims.map((c) => ({
    kind: c.subject.kind,
    name: c.subject.name,
    file: c.subject.loc.file,
    verdict: c.verdict,
    confidence: c.confidence,
  }));
}

describe("export claims", () => {
  it("flags an unreached local export in a reachable file at high confidence", () => {
    const g = new IRGraph();
    addEntry(g, "src/index.ts");
    addSymbol(g, "src/lib.ts", "used");
    addSymbol(g, "src/lib.ts", "dead");
    ref(g, "src/index.ts", symbolId("src/lib.ts", "used"), "static", "used");

    expect(shape(run(g))).toEqual([
      { kind: "export", name: "dead", file: "src/lib.ts", verdict: "unused", confidence: "high" },
    ]);
    const [claim] = run(g);
    expect(claim?.evidence[0]?.source).toBe("reference-graph");
    expect(claim?.evidence[0]?.type).toBe("static-reachability");
  });

  it("does not claim a forwarded (re-export) symbol — only declared locals", () => {
    const g = new IRGraph();
    addEntry(g, "src/index.ts");
    addSymbol(g, "src/barrel.ts", "used");
    addSymbol(g, "src/barrel.ts", "deadLocal");
    addSymbol(g, "src/barrel.ts", "fwd", { local: false });
    ref(g, "src/index.ts", symbolId("src/barrel.ts", "used"), "static", "used");

    expect(shape(run(g)).map((c) => c.name)).toEqual(["deadLocal"]);
  });

  it("does not claim exports of an UNreachable file (subsumed by the file claim)", () => {
    const g = new IRGraph();
    addEntry(g, "src/index.ts");
    // orphan file, reachable by nothing; its export must not be separately claimed.
    addSymbol(g, "src/orphan.ts", "x");

    const names = shape(run(g)).filter((c) => c.kind === "export");
    expect(names).toEqual([]);
  });
});

describe("file claims", () => {
  it("flags an orphan file (no inbound edge, not an entrypoint) with a whole-file span", () => {
    const g = new IRGraph();
    addEntry(g, "src/index.ts");
    addFile(g, "src/orphan.ts");
    const lines = new Map([[fileId("src/orphan.ts"), 7]]);

    const claims = run(g, lines);
    expect(shape(claims)).toEqual([
      {
        kind: "file",
        name: "src/orphan.ts",
        file: "src/orphan.ts",
        verdict: "unused",
        confidence: "high",
      },
    ]);
    expect(claims[0]?.subject.loc.span).toEqual([1, 7]);
  });

  it("never claims a declaration (`.d.ts`) file, even orphaned (ambient/global keep-alive)", () => {
    const g = new IRGraph();
    addEntry(g, "src/index.ts");
    addFile(g, "src/globals.d.ts");

    expect(run(g)).toEqual([]);
  });

  it("does not claim a file that has an inbound reference edge to one of its symbols", () => {
    // A barrel forwards `origin.ts#thing`, but the barrel entry is never consumed:
    // origin.ts has an inbound re-export edge, so it is not a bare orphan file.
    const g = new IRGraph();
    addEntry(g, "src/index.ts");
    addFile(g, "src/barrel.ts");
    addSymbol(g, "src/origin.ts", "thing");
    // barrel#thing (forwarded) -> origin.ts#thing
    g.addNode({
      kind: "symbol",
      id: symbolId("src/barrel.ts", "thing"),
      file: "src/barrel.ts",
      exportedName: "thing",
      isDefault: false,
      typeOnly: false,
      local: false,
      span: SPAN,
    });
    g.addEdge({
      kind: "references",
      referenceKind: "re-export",
      from: symbolId("src/barrel.ts", "thing"),
      to: symbolId("src/origin.ts", "thing"),
      site: site("src/barrel.ts"),
      name: "thing",
    });

    // barrel.ts itself is a bare orphan → claimed; origin.ts has an inbound edge → not claimed.
    expect(shape(run(g)).map((c) => c.name)).toEqual(["src/barrel.ts"]);
  });
});

describe("hazard keep-alive (rule 3)", () => {
  it("emits NO claims for a project carrying an unscoped computed-import hazard", () => {
    const g = new IRGraph();
    addEntry(g, "src/index.ts");
    addSymbol(g, "src/lib.ts", "used");
    addSymbol(g, "src/lib.ts", "dead");
    ref(g, "src/index.ts", symbolId("src/lib.ts", "used"), "static", "used");
    hazard(g, "src/index.ts", "computed-dynamic-import");

    expect(run(g)).toEqual([]);
  });

  it("emits NO claims for a project carrying a computed-require hazard", () => {
    const g = new IRGraph();
    addEntry(g, "src/index.ts");
    addFile(g, "src/orphan.ts");
    hazard(g, "src/index.ts", "computed-require");

    expect(run(g)).toEqual([]);
  });

  it("keeps a config-referenced file alive (no file claim on it)", () => {
    const g = new IRGraph();
    addEntry(g, "src/index.ts");
    addFile(g, "src/test-setup.ts");
    hazard(g, "src/test-setup.ts", "config-referenced-file");

    expect(run(g)).toEqual([]);
  });

  it("an unresolvable-import hazard affects nothing else — a clean sibling stays claimable", () => {
    const g = new IRGraph();
    addEntry(g, "src/index.ts");
    addSymbol(g, "src/lib.ts", "used");
    addSymbol(g, "src/lib.ts", "dead");
    ref(g, "src/index.ts", symbolId("src/lib.ts", "used"), "static", "used");
    hazard(g, "src/index.ts", "unresolvable-import");

    expect(shape(run(g)).map((c) => c.name)).toEqual(["dead"]);
  });

  it("still claims a suppressed symbol, carrying its suppression reason (PRD §4/§6)", () => {
    const g = new IRGraph();
    addEntry(g, "src/index.ts");
    addSymbol(g, "src/lib.ts", "used");
    addSymbol(g, "src/lib.ts", "dead", {
      suppression: { reason: "legacy shim, remove in v2", valid: true },
    });
    ref(g, "src/index.ts", symbolId("src/lib.ts", "used"), "static", "used");

    const claims = run(g);
    expect(claims).toHaveLength(1);
    expect(claims[0]?.suppression).toEqual({ reason: "legacy shim, remove in v2" });
  });
});

describe("entrypoint boundary (T2.4 review)", () => {
  it("emits NO claims when there is no production entrypoint (nothing anchors liveness)", () => {
    const g = new IRGraph();
    // A dead-looking orphan file, but no entrypoint of any kind.
    addFile(g, "src/thing.ts");
    expect(run(g)).toEqual([]);
  });

  it("a config-only project (config roots, zero production roots) still emits nothing", () => {
    const g = new IRGraph();
    addConfigEntry(g, "vite.config.ts");
    addFile(g, "src/orphan.ts");
    expect(run(g)).toEqual([]);
  });

  it("never claims a config-root file, while a real orphan beside it is still flagged", () => {
    const g = new IRGraph();
    addEntry(g, "src/index.ts"); // a production root, so claiming is enabled
    addConfigEntry(g, "vite.config.ts"); // config root — must not be claimed
    addFile(g, "src/orphan.ts"); // genuine orphan — must be claimed
    expect(shape(run(g)).map((c) => c.name)).toEqual(["src/orphan.ts"]);
  });
});

describe("determinism", () => {
  it("emits claims sorted by id, identical across runs", () => {
    const g = new IRGraph();
    addEntry(g, "src/index.ts");
    addSymbol(g, "src/a.ts", "used");
    addSymbol(g, "src/a.ts", "deadA");
    addSymbol(g, "src/b.ts", "used");
    addSymbol(g, "src/b.ts", "deadB");
    ref(g, "src/index.ts", symbolId("src/a.ts", "used"), "static", "used");
    ref(g, "src/index.ts", symbolId("src/b.ts", "used"), "static", "used");

    const first = run(g);
    const second = run(g);
    expect(JSON.stringify(first)).toEqual(JSON.stringify(second));
    const ids = first.map((c) => c.id);
    expect([...ids].sort()).toEqual(ids);
  });
});
