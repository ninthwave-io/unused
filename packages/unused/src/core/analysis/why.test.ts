/**
 * `whyAlive` unit tests (T8.1, docs/phasing.md M8). Pure core: synthetic
 * {@link IRGraph}s built here, so the resolution / liveness / dead-lookup logic
 * is tested without the frontend pipeline (the fixture-driven end-to-end path,
 * including re-export-chain rendering, lives in `testing/why-integration.test.ts`
 * — reporters/frontends imports are forbidden inside `core/`, ADR 0003).
 */
import { describe, expect, it } from "vitest";
import type { Claim } from "../claims/types.js";
import { entrypointId, fileId, IRGraph, symbolId } from "../ir/index.js";
import { computePartitionedReachability } from "./reachability.js";
import { whyAlive } from "./why.js";

const SPAN = { start: 0, end: 5, startLine: 1, endLine: 1 };

function file(g: IRGraph, path: string): void {
  g.addNode({ kind: "file", id: fileId(path), path });
}
function exportSym(g: IRGraph, path: string, name: string, line = 1): void {
  g.addNode({
    kind: "symbol",
    id: symbolId(path, name),
    file: path,
    exportedName: name,
    isDefault: false,
    typeOnly: false,
    local: true,
    span: { ...SPAN, startLine: line, endLine: line },
  });
  g.addEdge({
    kind: "exports",
    from: fileId(path),
    to: symbolId(path, name),
    site: { file: path, span: SPAN },
  });
}
function staticRef(g: IRGraph, fromFile: string, toPath: string, name: string): void {
  g.addEdge({
    kind: "references",
    referenceKind: "static",
    from: fileId(fromFile),
    to: symbolId(toPath, name),
    name,
    site: { file: fromFile, span: SPAN },
  });
}
function entrypoint(
  g: IRGraph,
  kind: "production" | "config" | "test",
  path: string,
  reason: string,
): void {
  g.addNode({
    kind: "entrypoint",
    id: entrypointId(kind, path),
    entryKind: kind,
    file: path,
    reason,
  });
}

function ask(g: IRGraph, query: string, claims: readonly Claim[] = []) {
  return whyAlive({ graph: g, reachability: computePartitionedReachability(g), claims, query });
}

describe("whyAlive — alive", () => {
  it("builds a production path (entrypoint hop → declaration hop) from stored provenance", () => {
    const g = new IRGraph();
    file(g, "src/index.ts");
    file(g, "src/lib.ts");
    exportSym(g, "src/lib.ts", "thing", 3);
    staticRef(g, "src/index.ts", "src/lib.ts", "thing");
    entrypoint(g, "production", "src/index.ts", "main");

    const r = ask(g, "thing");
    expect(r.outcome).toBe("alive");
    if (r.outcome !== "alive") return;
    expect(r.entrypointKind).toBe("production");
    expect(r.testOnly).toBe(false);
    expect(r.subject).toEqual({ kind: "export", file: "src/lib.ts", name: "thing", line: 3 });
    const path = r.paths[0];
    expect(path?.hops[0]).toEqual({
      file: "src/index.ts",
      entrypoint: { kind: "production", reason: "main" },
    });
    expect(path?.hops.at(-1)).toMatchObject({ file: "src/lib.ts", symbol: "thing", line: 3 });
  });

  it("resolves a file subject that is itself an entrypoint as alive", () => {
    const g = new IRGraph();
    file(g, "src/index.ts");
    entrypoint(g, "production", "src/index.ts", "main");
    const r = ask(g, "src/index.ts");
    expect(r.outcome).toBe("alive");
    if (r.outcome !== "alive") return;
    expect(r.entrypointKind).toBe("production");
  });
});

describe("whyAlive — test-only (tier-2)", () => {
  it("flags a symbol reachable only from a test root as alive-but-test-only", () => {
    const g = new IRGraph();
    file(g, "src/index.ts"); // production entrypoint anchoring the partition
    entrypoint(g, "production", "src/index.ts", "main");
    file(g, "test/f.spec.ts");
    file(g, "src/helper.ts");
    exportSym(g, "src/helper.ts", "helper");
    staticRef(g, "test/f.spec.ts", "src/helper.ts", "helper");
    entrypoint(g, "test", "test/f.spec.ts", "test-file");

    const r = ask(g, "helper");
    expect(r.outcome).toBe("alive");
    if (r.outcome !== "alive") return;
    expect(r.testOnly).toBe(true);
    expect(r.entrypointKind).toBe("test");
    expect(r.paths[0]?.hops[0]?.entrypoint?.kind).toBe("test");
  });
});

describe("whyAlive — dead", () => {
  function deadGraph(): IRGraph {
    const g = new IRGraph();
    file(g, "src/index.ts");
    entrypoint(g, "production", "src/index.ts", "main");
    file(g, "src/orphan.ts");
    exportSym(g, "src/orphan.ts", "deadThing", 6);
    return g;
  }

  it("surfaces verdict/confidence/evidence from the subject's claim", () => {
    const claim: Claim = {
      id: "exp_test",
      subject: { kind: "export", name: "deadThing", loc: { file: "src/orphan.ts", span: [6, 6] } },
      verdict: "unused",
      confidence: "high",
      evidence: [
        {
          type: "static-reachability",
          detail: "0 inbound references to `deadThing`.",
          source: "reference-graph",
        },
      ],
      provenance: { analyzer: "ts-reference-graph", version: "0.1.0", generatedAt: "T" },
    };
    const r = ask(deadGraph(), "deadThing", [claim]);
    expect(r.outcome).toBe("dead");
    if (r.outcome !== "dead") return;
    expect(r.verdict).toBe("unused");
    expect(r.confidence).toBe("high");
    expect(r.claimId).toBe("exp_test");
    expect(r.evidence[0]?.detail).toContain("0 inbound references");
  });

  it("reports the hazard classes checked near a dead subject (file-attached + subtree-covering)", () => {
    const g = deadGraph();
    // A directory-subtree hazard whose static prefix covers the subject file,
    // even though its site is elsewhere (the computed-import shape).
    g.addHazard({
      file: fileId("src/index.ts"),
      hazardClass: "computed-dynamic-import",
      detail: "dynamic import() with a computed specifier",
      site: { file: "src/index.ts", span: { ...SPAN, startLine: 4, endLine: 4 } },
      subtreePrefix: "src/",
    });
    const r = ask(g, "deadThing");
    expect(r.outcome).toBe("dead");
    if (r.outcome !== "dead") return;
    expect(r.hazards.map((h) => h.hazardClass)).toContain("computed-dynamic-import");
    expect(r.hazards[0]?.site).toBe("src/index.ts:4");
  });

  it("synthesises an unreachable-evidence entry when the subject is subsumed (no standalone claim)", () => {
    const r = ask(deadGraph(), "deadThing");
    expect(r.outcome).toBe("dead");
    if (r.outcome !== "dead") return;
    expect(r.verdict).toBeUndefined();
    expect(r.evidence[0]?.detail).toContain("unreachable from any production");
  });
});

describe("whyAlive — resolution outcomes", () => {
  function dupGraph(): IRGraph {
    const g = new IRGraph();
    for (const f of ["src/a.ts", "src/b.ts"]) {
      file(g, f);
      exportSym(g, f, "dup");
    }
    return g;
  }

  it("lists candidates for a bare name resolving to several declarations", () => {
    const r = ask(dupGraph(), "dup");
    expect(r.outcome).toBe("ambiguous");
    if (r.outcome !== "ambiguous") return;
    expect(r.candidates.map((c) => c.label)).toEqual(["src/a.ts:dup", "src/b.ts:dup"]);
  });

  it("resolves a qualified `file:name` past the ambiguity", () => {
    const r = ask(dupGraph(), "src/a.ts:dup");
    expect(r.outcome).toBe("dead"); // resolved to one, but no entrypoint reaches it
    if (r.outcome !== "dead") return;
    expect(r.subject).toMatchObject({ kind: "export", file: "src/a.ts", name: "dup" });
  });

  it("returns not-found for a nonexistent name", () => {
    expect(ask(dupGraph(), "doesNotExist").outcome).toBe("not-found");
  });

  it("returns not-found for a real file naming a nonexistent export", () => {
    expect(ask(dupGraph(), "src/a.ts:ghost").outcome).toBe("not-found");
  });
});
