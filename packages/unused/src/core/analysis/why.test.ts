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
function staticRef(
  g: IRGraph,
  fromFile: string,
  toPath: string,
  name: string,
  partitions?: readonly ["test"],
): void {
  g.addEdge({
    kind: "references",
    referenceKind: "static",
    from: fileId(fromFile),
    to: symbolId(toPath, name),
    name,
    site: { file: fromFile, span: SPAN },
    ...(partitions === undefined ? {} : { partitions }),
  });
}
function entrypoint(
  g: IRGraph,
  kind: "production" | "config" | "test",
  path: string,
  reason: string,
  targetSymbol?: string,
): void {
  g.addNode({
    kind: "entrypoint",
    id: entrypointId(kind, path, targetSymbol),
    entryKind: kind,
    file: path,
    ...(targetSymbol === undefined ? {} : { targetSymbol }),
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

  it("starts an exact symbol entrypoint path at the configured declaration", () => {
    const g = new IRGraph();
    file(g, "src/operations.ts");
    exportSym(g, "src/operations.ts", "run", 7);
    exportSym(g, "src/operations.ts", "unusedSibling", 11);
    entrypoint(
      g,
      "production",
      "src/operations.ts",
      "configured public operation",
      symbolId("src/operations.ts", "run"),
    );

    const r = ask(g, "run");
    expect(r.outcome).toBe("alive");
    if (r.outcome !== "alive") return;
    expect(r.paths[0]?.hops[0]).toEqual({
      file: "src/operations.ts",
      line: 7,
      symbol: "run",
      entrypoint: { kind: "production", reason: "configured public operation" },
    });
    expect(ask(g, "unusedSibling").outcome).toBe("dead");
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

  it("explains a test-scoped production-carrier edge as test-environment-only", () => {
    const g = new IRGraph();
    file(g, "lib/application.ex");
    entrypoint(g, "production", "lib/application.ex", "application-callback");
    file(g, "test/neutral_test.exs");
    entrypoint(g, "test", "test/neutral_test.exs", "test-file");
    file(g, "lib/callback.ex");
    exportSym(g, "lib/callback.ex", "Callback.perform/0", 4);
    staticRef(g, "lib/application.ex", "lib/callback.ex", "Callback.perform/0", ["test"]);

    const r = ask(g, "Callback.perform/0");
    expect(r).toMatchObject({ outcome: "alive", entrypointKind: "test", testOnly: true });
    if (r.outcome !== "alive") return;
    expect(r.paths[0]).toMatchObject({
      entrypointKind: "production",
      entrypointReason: "application-callback",
      hops: [
        {
          file: "lib/application.ex",
          entrypoint: { kind: "production", reason: "application-callback" },
        },
        { file: "lib/callback.ex", symbol: "Callback.perform/0" },
      ],
    });
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
      language: "ts",
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

  it("resolves a file-qualified Elixir function whose identity contains an arity slash", () => {
    const g = new IRGraph();
    file(g, "lib/neutral/callback.ex");
    exportSym(g, "lib/neutral/callback.ex", "Neutral.Callback.handle/1", 7);

    const r = ask(g, "lib/neutral/callback.ex:Neutral.Callback.handle/1");
    expect(r.outcome).toBe("dead");
    if (r.outcome !== "dead") return;
    expect(r.subject).toMatchObject({
      kind: "export",
      file: "lib/neutral/callback.ex",
      name: "Neutral.Callback.handle/1",
      line: 7,
    });
  });

  it("reports only an active bounded hazard against its affected symbol", () => {
    const build = (carrierReachable: boolean) => {
      const g = new IRGraph();
      file(g, "lib/application.ex");
      entrypoint(g, "production", "lib/application.ex", "application-callback");
      file(g, "lib/router.ex");
      exportSym(g, "lib/router.ex", "Neutral.Router.dispatch/0");
      file(g, "lib/handler.ex");
      exportSym(g, "lib/handler.ex", "Neutral.Handler.possible/0");
      exportSym(g, "lib/handler.ex", "Neutral.Handler.live/0");
      staticRef(g, "lib/application.ex", "lib/handler.ex", "Neutral.Handler.live/0");
      if (carrierReachable) {
        staticRef(g, "lib/application.ex", "lib/router.ex", "Neutral.Router.dispatch/0");
      }
      g.addHazard({
        file: fileId("lib/router.ex"),
        carrierSymbol: symbolId("lib/router.ex", "Neutral.Router.dispatch/0"),
        hazardClass: "elixir-dynamic-dispatch",
        detail: "bounded neutral dispatch",
        site: { file: "lib/router.ex", span: { ...SPAN, startLine: 9, endLine: 9 } },
        effect: {
          scope: {
            kind: "symbols",
            ids: [symbolId("lib/handler.ex", "Neutral.Handler.possible/0")],
          },
          worlds: ["production"],
        },
      });
      return ask(g, "Neutral.Handler.possible/0");
    };

    const inactive = build(false);
    expect(inactive.outcome).toBe("dead");
    if (inactive.outcome === "dead") expect(inactive.hazards).toEqual([]);
    const active = build(true);
    expect(active.outcome).toBe("dead");
    if (active.outcome === "dead") {
      expect(active.hazards).toEqual([
        {
          hazardClass: "elixir-dynamic-dispatch",
          detail: "bounded neutral dispatch",
          worlds: ["production"],
          site: "lib/router.ex:9",
        },
      ]);
    }
  });

  it("preserves overlapping bounded effect worlds through executable-symbol closure", () => {
    const g = new IRGraph();
    file(g, "lib/application.ex");
    entrypoint(g, "production", "lib/application.ex", "application-callback");
    file(g, "lib/router.ex");
    exportSym(g, "lib/router.ex", "Neutral.Router.dispatch/0");
    staticRef(g, "lib/application.ex", "lib/router.ex", "Neutral.Router.dispatch/0");
    file(g, "lib/handler.ex");
    exportSym(g, "lib/handler.ex", "Neutral.Handler.possible/0");
    exportSym(g, "lib/handler.ex", "Neutral.Handler.consequence/0");
    g.addEdge({
      kind: "references",
      referenceKind: "static",
      from: symbolId("lib/handler.ex", "Neutral.Handler.possible/0"),
      to: symbolId("lib/handler.ex", "Neutral.Handler.consequence/0"),
      name: "Neutral.Handler.consequence/0",
      site: { file: "lib/handler.ex", span: SPAN },
    });

    for (const [line, world] of [
      [9, "production"],
      [10, "test"],
    ] as const) {
      g.addHazard({
        file: fileId("lib/router.ex"),
        carrierSymbol: symbolId("lib/router.ex", "Neutral.Router.dispatch/0"),
        hazardClass: "elixir-dynamic-dispatch",
        detail: `bounded neutral ${world} dispatch`,
        site: { file: "lib/router.ex", span: { ...SPAN, startLine: line, endLine: line } },
        effect: {
          scope: {
            kind: "symbols",
            ids: [symbolId("lib/handler.ex", "Neutral.Handler.possible/0")],
          },
          worlds: [world],
        },
      });
    }

    const result = ask(g, "Neutral.Handler.consequence/0");
    expect(result.outcome).toBe("dead");
    if (result.outcome === "dead") {
      expect(result.hazards).toEqual([
        {
          hazardClass: "elixir-dynamic-dispatch",
          detail: "bounded neutral production dispatch",
          worlds: ["production"],
          site: "lib/router.ex:9",
        },
        {
          hazardClass: "elixir-dynamic-dispatch",
          detail: "bounded neutral test dispatch",
          worlds: ["test"],
          site: "lib/router.ex:10",
        },
      ]);
    }
  });

  it("describes an active computed-atom escape without calling it an invocation", () => {
    const g = new IRGraph();
    file(g, "lib/application.ex");
    entrypoint(g, "production", "lib/application.ex", "application-callback");
    file(g, "lib/candidate.ex");
    g.addHazard({
      file: fileId("lib/application.ex"),
      hazardClass: "elixir-computed-atom-escape",
      detail: "computed atom escapes before its consumer can be classified",
      site: { file: "lib/application.ex", span: { ...SPAN, startLine: 14, endLine: 14 } },
      effect: { scope: { kind: "unit" }, worlds: ["production"] },
    });

    const result = ask(g, "lib/candidate.ex");
    expect(result.outcome).toBe("dead");
    if (result.outcome === "dead") {
      expect(result.hazards).toEqual([
        {
          hazardClass: "elixir-computed-atom-escape",
          detail: "computed atom escapes before its consumer can be classified",
          worlds: ["production"],
          site: "lib/application.ex:14",
        },
      ]);
    }
  });

  it("returns not-found for a nonexistent name", () => {
    expect(ask(dupGraph(), "doesNotExist").outcome).toBe("not-found");
  });

  it("returns not-found for a real file naming a nonexistent export", () => {
    expect(ask(dupGraph(), "src/a.ts:ghost").outcome).toBe("not-found");
  });

  it("returns captured evidence for an unused dependency claim", () => {
    const g = new IRGraph();
    const claim: Claim = {
      id: "dep_test",
      language: "ts",
      subject: {
        kind: "dependency",
        name: "unused-package",
        loc: { file: "package.json", span: [8, 8] },
      },
      verdict: "unused",
      confidence: "high",
      evidence: [
        {
          type: "static-reachability",
          detail: "Declared in dependencies but not referenced from this workspace.",
          source: "package-manifest",
        },
      ],
      provenance: { analyzer: "ts-reference-graph", version: "0.1.0", generatedAt: "T" },
    };

    const result = ask(g, "unused-package", [claim]);
    expect(result.outcome).toBe("dead");
    if (result.outcome !== "dead") return;
    expect(result.subject).toEqual({
      kind: "dependency",
      file: "package.json",
      name: "unused-package",
    });
    expect(result.claimId).toBe("dep_test");
    expect(result.evidence[0]?.source).toBe("package-manifest");
  });

  it("disambiguates the same unused dependency across workspaces", () => {
    const dependencyClaim = (workspace: string): Claim => ({
      id: `dep_${workspace}`,
      language: "ts",
      subject: {
        kind: "dependency",
        name: "shared-package",
        loc: { file: `${workspace}/package.json`, span: [3, 3], package: workspace },
      },
      verdict: "unused",
      confidence: "high",
      evidence: [
        { type: "static-reachability", detail: "No references.", source: "package-manifest" },
      ],
      provenance: { analyzer: "ts-reference-graph", version: "0.1.0", generatedAt: "T" },
    });
    const claims = [dependencyClaim("packages/a"), dependencyClaim("packages/b")];

    const ambiguous = ask(new IRGraph(), "shared-package", claims);
    expect(ambiguous.outcome).toBe("ambiguous");
    if (ambiguous.outcome !== "ambiguous") return;
    expect(ambiguous.candidates.map((candidate) => candidate.label)).toEqual([
      "packages/a:shared-package",
      "packages/b:shared-package",
    ]);

    const qualified = ask(new IRGraph(), "packages/a:shared-package", claims);
    expect(qualified.outcome).toBe("dead");
    if (qualified.outcome !== "dead") return;
    expect(qualified.subject.file).toBe("packages/a/package.json");
  });
});
