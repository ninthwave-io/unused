/**
 * Claim-emission unit tests (T2.4). Hand-built graphs isolate each M2 emission
 * rule and each hazard keep-alive class (`core/analysis` must not import a
 * frontend — ADR 0003). The real-fixture join is in `frontends/ts/analyze.test.ts`.
 */
import { describe, expect, it, vi } from "vitest";
import type { Claim, Provenance } from "../claims/types.js";
import {
  entrypointId,
  fileId,
  type HazardClass,
  type HazardEffect,
  IRGraph,
  type ReferenceKind,
  type Site,
  symbolId,
} from "../ir/index.js";
import { type DependencyClaimInput, emitClaims } from "./claims.js";
import { computeDeletionPlan } from "./deletion-plan.js";
import { effectsForSubject, evaluateHazards } from "./hazard-evaluation.js";
import { PerformanceTracker } from "./performance.js";
import { computePartitionedReachability } from "./reachability.js";
import { whyAlive } from "./why.js";

const PROVENANCE: Provenance = {
  analyzer: "ts-reference-graph",
  version: "0.1.0",
  generatedAt: "1970-01-01T00:00:00.000Z",
};

const SPAN = { start: 0, end: 0, startLine: 1, endLine: 1 };
const site = (file: string): Site => ({ file, span: SPAN });
const symbolEffect = (ids: readonly string[]): HazardEffect => ({
  scope: { kind: "symbols", ids },
  worlds: ["production"],
});

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

function addSymbolEntry(g: IRGraph, rel: string, name: string): void {
  g.addNode({
    kind: "entrypoint",
    id: entrypointId("production", rel, symbolId(rel, name)),
    entryKind: "production",
    file: rel,
    targetSymbol: symbolId(rel, name),
    reason: "configured operation",
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

function ref(
  g: IRGraph,
  fromRel: string,
  toId: string,
  kind: ReferenceKind,
  name?: string,
  partitions?: readonly ["test"],
): void {
  g.addEdge({
    kind: "references",
    referenceKind: kind,
    from: fileId(fromRel),
    to: toId,
    site: site(fromRel),
    ...(name !== undefined ? { name } : {}),
    ...(partitions !== undefined ? { partitions } : {}),
  });
}

function hazard(
  g: IRGraph,
  fileRel: string,
  hazardClass: HazardClass,
  subtreePrefix?: string,
): void {
  g.addHazard({
    file: fileId(fileRel),
    hazardClass,
    detail: `test hazard ${hazardClass}`,
    site: site(fileRel),
    ...(subtreePrefix !== undefined ? { subtreePrefix } : {}),
  });
}

function run(g: IRGraph, fileLineCounts?: Map<string, number>): Claim[] {
  const reachability = computePartitionedReachability(g);
  return emitClaims({
    graph: g,
    reachability,
    provenance: PROVENANCE,
    ...(fileLineCounts !== undefined ? { fileLineCounts } : {}),
  });
}

function claimConfidence(claims: readonly Claim[], name: string): string | undefined {
  return claims.find((claim) => claim.subject.name === name)?.confidence;
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

/** `shape`, but deterministically ordered by `kind:name` (claim ids are hashes). */
function sorted(claims: Claim[]): ReturnType<typeof shape> {
  return shape(claims).sort((a, b) => `${a.kind}:${a.name}`.localeCompare(`${b.kind}:${b.name}`));
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

  it("claims every unreachable file even when dead code references its symbols", () => {
    // A barrel forwards `origin.ts#thing`, but the barrel entry is never consumed:
    // The barrel is never consumed, so neither it nor its origin is reachable
    // from a root. An inbound edge from dead code does not make origin.ts alive.
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

    expect(shape(run(g)).map((c) => c.name)).toEqual(["src/barrel.ts", "src/origin.ts"]);
  });
});

describe("hazard registry — scoped effects (T3.1)", () => {
  it("computed-dynamic-import caps ONLY the static-prefix subtree; out-of-scope files stay high", () => {
    const g = new IRGraph();
    addEntry(g, "src/index.ts");
    addFile(g, "src/mods/alpha.ts"); // under the subtree ⇒ capped
    addFile(g, "src/mods/beta.ts"); // under the subtree ⇒ capped
    addFile(g, "src/unrelated.ts"); // outside the subtree ⇒ unaffected
    hazard(g, "src/index.ts", "computed-dynamic-import", "src/mods/");

    expect(sorted(run(g))).toEqual([
      {
        kind: "file",
        name: "src/mods/alpha.ts",
        file: "src/mods/alpha.ts",
        verdict: "unused",
        confidence: "medium",
      },
      {
        kind: "file",
        name: "src/mods/beta.ts",
        file: "src/mods/beta.ts",
        verdict: "unused",
        confidence: "medium",
      },
      {
        kind: "file",
        name: "src/unrelated.ts",
        file: "src/unrelated.ts",
        verdict: "unused",
        confidence: "high",
      },
    ]);
  });

  it("a prefix respects the directory boundary — `src/mods/` does not cap `src/modsX.ts`", () => {
    const g = new IRGraph();
    addEntry(g, "src/index.ts");
    addFile(g, "src/mods/alpha.ts"); // in scope
    addFile(g, "src/modsX.ts"); // NOT in scope (prefix has a trailing slash)
    hazard(g, "src/index.ts", "computed-dynamic-import", "src/mods/");

    expect(sorted(run(g)).map((c) => `${c.name}:${c.confidence}`)).toEqual([
      "src/mods/alpha.ts:medium",
      "src/modsX.ts:high",
    ]);
  });

  it("computed-require with no static prefix caps the importer's whole package (medium)", () => {
    const g = new IRGraph();
    addEntry(g, "src/index.ts");
    addFile(g, "src/a.ts");
    addFile(g, "src/deep/b.ts");
    hazard(g, "src/index.ts", "computed-require"); // no subtreePrefix ⇒ "" ⇒ whole package

    expect(sorted(run(g)).map((c) => `${c.name}:${c.confidence}`)).toEqual([
      "src/a.ts:medium",
      "src/deep/b.ts:medium",
    ]);
  });

  it.each([
    ["computed-dynamic-import", "src/plugins/"],
    ["computed-require", undefined],
  ] as const)("%s applies only while its carrier file is reachable", (hazardClass, prefix) => {
    const build = (carrierReachable: boolean): Claim[] => {
      const g = new IRGraph();
      addEntry(g, "src/index.ts");
      addFile(g, "src/loader.ts");
      addFile(g, "src/plugins/candidate.ts");
      hazard(g, "src/loader.ts", hazardClass, prefix);
      if (carrierReachable) {
        ref(g, "src/index.ts", fileId("src/loader.ts"), "side-effect");
      }
      return run(g);
    };

    const confidence = (claims: readonly Claim[]): string | undefined =>
      claims.find((c) => c.subject.loc.file === "src/plugins/candidate.ts")?.confidence;
    expect(confidence(build(false))).toBe("high");
    expect(confidence(build(true))).toBe("medium");
  });

  it("activates an outgoing hazard whose carrier is reachable only from tests", () => {
    const g = new IRGraph();
    addEntry(g, "src/index.ts");
    addTestEntry(g, "test/loader.test.ts");
    addFile(g, "src/plugins/candidate.ts");
    hazard(g, "test/loader.test.ts", "computed-dynamic-import", "src/plugins/");

    const candidate = run(g).find((claim) => claim.subject.loc.file === "src/plugins/candidate.ts");
    expect(candidate?.confidence).toBe("medium");
  });

  it("propagates carrier activation through a chain of dynamic hazard scopes", () => {
    const g = new IRGraph();
    addEntry(g, "src/index.ts");
    addFile(g, "src/loader.ts");
    addFile(g, "src/plugins/candidate.ts");
    addFile(g, "src/handlers/candidate.ts");
    ref(g, "src/index.ts", fileId("src/loader.ts"), "side-effect");
    hazard(g, "src/loader.ts", "computed-dynamic-import", "src/plugins/");
    hazard(g, "src/plugins/candidate.ts", "computed-require", "src/handlers/");

    const byFile = Object.fromEntries(
      run(g)
        .filter((claim) => claim.subject.kind === "file")
        .map((claim) => [claim.subject.loc.file, claim.confidence]),
    );
    expect(byFile["src/plugins/candidate.ts"]).toBe("medium");
    expect(byFile["src/handlers/candidate.ts"]).toBe("medium");
  });

  it("caps only explicit dynamic-dispatch targets while preserving the carrier", () => {
    const g = new IRGraph();
    addEntry(g, "lib/application.ex");
    addSymbol(g, "lib/router.ex", "Neutral.Router.dispatch/1");
    addSymbol(g, "lib/handlers.ex", "Neutral.Handlers.possible/0");
    addSymbol(g, "lib/handlers.ex", "Neutral.Other.same_file/0");
    addSymbol(g, "lib/unrelated.ex", "Neutral.Unrelated.dead/0");
    ref(g, "lib/application.ex", fileId("lib/router.ex"), "side-effect");
    ref(g, "lib/application.ex", fileId("lib/handlers.ex"), "side-effect");
    ref(g, "lib/application.ex", fileId("lib/unrelated.ex"), "side-effect");
    g.addHazard({
      file: fileId("lib/router.ex"),
      hazardClass: "elixir-dynamic-dispatch",
      detail: "bounded neutral dispatch",
      site: site("lib/router.ex"),
      effect: symbolEffect([symbolId("lib/handlers.ex", "Neutral.Handlers.possible/0")]),
    });

    const byName = Object.fromEntries(
      run(g).map((claim) => [claim.subject.name, claim.confidence]),
    );
    expect(byName["Neutral.Handlers.possible/0"]).toBe("medium");
    expect(byName["Neutral.Other.same_file/0"]).toBe("high");
    expect(byName["Neutral.Unrelated.dead/0"]).toBe("high");
  });

  it("does not activate explicit targets when only the target, not the carrier, is reachable", () => {
    const g = new IRGraph();
    addEntry(g, "lib/application.ex");
    addSymbol(g, "lib/dormant_router.ex", "Neutral.Router.dispatch/1");
    addSymbol(g, "lib/handlers.ex", "Neutral.Handlers.possible/0");
    ref(g, "lib/application.ex", fileId("lib/handlers.ex"), "side-effect");
    g.addHazard({
      file: fileId("lib/dormant_router.ex"),
      hazardClass: "elixir-dynamic-dispatch",
      detail: "bounded neutral dispatch",
      site: site("lib/dormant_router.ex"),
      effect: symbolEffect([symbolId("lib/handlers.ex", "Neutral.Handlers.possible/0")]),
    });

    expect(
      run(g).find((claim) => claim.subject.name === "Neutral.Handlers.possible/0")?.confidence,
    ).toBe("high");
  });

  it("caps a whole-file deletion when it contains an explicit dynamic target", () => {
    const g = new IRGraph();
    addEntry(g, "lib/application.ex");
    addSymbol(g, "lib/router.ex", "Neutral.Router.dispatch/1");
    addSymbol(g, "lib/candidate.ex", "Neutral.Candidate.possible/0");
    ref(g, "lib/application.ex", fileId("lib/router.ex"), "side-effect");
    g.addHazard({
      file: fileId("lib/router.ex"),
      hazardClass: "elixir-dynamic-dispatch",
      detail: "bounded neutral dispatch",
      site: site("lib/router.ex"),
      effect: symbolEffect([symbolId("lib/candidate.ex", "Neutral.Candidate.possible/0")]),
    });

    expect(shape(run(g))).toContainEqual(
      expect.objectContaining({
        kind: "file",
        file: "lib/candidate.ex",
        confidence: "medium",
      }),
    );
  });

  it("activates a dynamic hazard from its exact carrier symbol, not a reachable sibling function", () => {
    const build = (dispatchReachable: boolean): Claim[] => {
      const g = new IRGraph();
      addEntry(g, "lib/application.ex");
      addSymbol(g, "lib/router.ex", "Neutral.Router.live/0");
      addSymbol(g, "lib/router.ex", "Neutral.Router.dispatch/0");
      addSymbol(g, "lib/handlers.ex", "Neutral.Handlers.possible/0");
      ref(
        g,
        "lib/application.ex",
        symbolId("lib/router.ex", "Neutral.Router.live/0"),
        "static",
        "Neutral.Router.live/0",
      );
      ref(g, "lib/application.ex", fileId("lib/handlers.ex"), "side-effect");
      if (dispatchReachable) {
        ref(
          g,
          "lib/application.ex",
          symbolId("lib/router.ex", "Neutral.Router.dispatch/0"),
          "static",
          "Neutral.Router.dispatch/0",
        );
      }
      g.addHazard({
        file: fileId("lib/router.ex"),
        carrierSymbol: symbolId("lib/router.ex", "Neutral.Router.dispatch/0"),
        hazardClass: "elixir-dynamic-dispatch",
        detail: "bounded neutral dispatch",
        site: site("lib/router.ex"),
        effect: symbolEffect([symbolId("lib/handlers.ex", "Neutral.Handlers.possible/0")]),
      });
      const reachability = computePartitionedReachability(g);
      expect(
        reachability.production.reachableSymbols.has(
          symbolId("lib/router.ex", "Neutral.Router.dispatch/0"),
        ),
      ).toBe(dispatchReachable);
      return run(g);
    };

    expect(claimConfidence(build(false), "Neutral.Handlers.possible/0")).toBe("high");
    expect(claimConfidence(build(true), "Neutral.Handlers.possible/0")).toBe("medium");
  });

  it("propagates a bounded dispatch to an exact symbol without activating a file carrier beside it", () => {
    const g = new IRGraph();
    addEntry(g, "lib/application.ex");
    addSymbol(g, "lib/router.ex", "Neutral.Router.dispatch/0");
    addSymbol(g, "lib/target.ex", "Neutral.Target.possible/0");
    addFile(g, "lib/unrelated.ex");
    ref(
      g,
      "lib/application.ex",
      symbolId("lib/router.ex", "Neutral.Router.dispatch/0"),
      "static",
      "Neutral.Router.dispatch/0",
    );
    g.addHazard({
      file: fileId("lib/router.ex"),
      carrierSymbol: symbolId("lib/router.ex", "Neutral.Router.dispatch/0"),
      hazardClass: "elixir-dynamic-dispatch",
      detail: "bounded neutral dispatch",
      site: site("lib/router.ex"),
      effect: symbolEffect([symbolId("lib/target.ex", "Neutral.Target.possible/0")]),
    });
    g.addHazard({
      file: fileId("lib/target.ex"),
      hazardClass: "computed-dynamic-import",
      detail: "dormant file-level loader beside the possible function",
      site: site("lib/target.ex"),
      subtreePrefix: "lib/unrelated",
    });

    expect(run(g).find((claim) => claim.subject.loc.file === "lib/unrelated.ex")?.confidence).toBe(
      "high",
    );
  });

  it("caps executable descendants and activates their exact downstream carriers", () => {
    const g = new IRGraph();
    addEntry(g, "lib/application.ex");
    addSymbol(g, "lib/router.ex", "Neutral.Router.dispatch/0");
    addSymbol(g, "lib/first.ex", "Neutral.First.possible/0");
    addSymbol(g, "lib/second.ex", "Neutral.Second.called/0");
    addSymbol(g, "lib/final.ex", "Neutral.Final.possible/0");
    ref(
      g,
      "lib/application.ex",
      symbolId("lib/router.ex", "Neutral.Router.dispatch/0"),
      "static",
      "Neutral.Router.dispatch/0",
    );
    ref(g, "lib/application.ex", fileId("lib/first.ex"), "side-effect");
    ref(g, "lib/application.ex", fileId("lib/second.ex"), "side-effect");
    ref(g, "lib/application.ex", fileId("lib/final.ex"), "side-effect");
    g.addEdge({
      kind: "references",
      from: symbolId("lib/first.ex", "Neutral.First.possible/0"),
      to: symbolId("lib/second.ex", "Neutral.Second.called/0"),
      referenceKind: "static",
      site: site("lib/first.ex"),
      name: "Neutral.Second.called/0",
    });
    g.addHazard({
      file: fileId("lib/router.ex"),
      carrierSymbol: symbolId("lib/router.ex", "Neutral.Router.dispatch/0"),
      hazardClass: "elixir-dynamic-dispatch",
      detail: "first bounded neutral dispatch",
      site: site("lib/router.ex"),
      effect: symbolEffect([symbolId("lib/first.ex", "Neutral.First.possible/0")]),
    });
    g.addHazard({
      file: fileId("lib/second.ex"),
      carrierSymbol: symbolId("lib/second.ex", "Neutral.Second.called/0"),
      hazardClass: "elixir-dynamic-dispatch",
      detail: "downstream bounded neutral dispatch",
      site: site("lib/second.ex"),
      effect: symbolEffect([symbolId("lib/final.ex", "Neutral.Final.possible/0")]),
    });

    const claims = run(g);
    expect(claimConfidence(claims, "Neutral.First.possible/0")).toBe("medium");
    expect(claimConfidence(claims, "Neutral.Second.called/0")).toBe("medium");
    expect(claimConfidence(claims, "Neutral.Final.possible/0")).toBe("medium");
  });

  it("keeps dependency effects isolated to their owning frontend fragment", () => {
    const g = new IRGraph();
    addEntry(g, "lib/application.ex");
    addFile(g, "src/index.ts");
    g.addHazard({
      file: fileId("lib/application.ex"),
      hazardClass: "elixir-dynamic-dispatch",
      detail: "opaque neutral dispatch",
      site: site("lib/application.ex"),
    });
    const reachability = computePartitionedReachability(g);
    const typescript = evaluateHazards({
      graph: g,
      reachability,
      analysisFiles: new Set(["src/index.ts"]),
      dependencies: [{ packageName: "neutral-dependency", loc: { file: "package.json" } }],
    });
    const elixir = evaluateHazards({
      graph: g,
      reachability,
      analysisFiles: new Set(["lib/application.ex"]),
      dependencies: [],
    });

    expect(
      effectsForSubject([typescript, elixir], {
        kind: "dependency",
        file: "package.json",
        name: "neutral-dependency",
      }),
    ).toEqual([]);
  });

  it("applies an explicit file effect only at that file and retains its world", () => {
    const g = new IRGraph();
    addEntry(g, "lib/router.ex");
    addFile(g, "lib/unrelated.ex");
    g.addHazard({
      file: fileId("lib/router.ex"),
      hazardClass: "elixir-dynamic-dispatch",
      detail: "file-local neutral uncertainty",
      site: site("lib/router.ex"),
      effect: { scope: { kind: "file" }, worlds: ["test"] },
    });
    const evaluation = evaluateHazards({
      graph: g,
      reachability: computePartitionedReachability(g),
    });

    expect(evaluation.effectsForSubject({ kind: "file", file: "lib/router.ex" })).toEqual([
      expect.objectContaining({
        effectScope: { kind: "file" },
        worlds: ["test"],
      }),
    ]);
    expect(evaluation.effectsForSubject({ kind: "file", file: "lib/unrelated.ex" })).toEqual([]);
  });

  it("caps test-reachable targets reached independently by a production-active hazard", () => {
    const g = new IRGraph();
    addEntry(g, "lib/application.ex");
    addTestEntry(g, "test/router_test.exs");
    addSymbol(g, "lib/router.ex", "Neutral.Router.dispatch/0");
    addSymbol(g, "lib/first.ex", "Neutral.First.possible/0");
    addSymbol(g, "lib/second.ex", "Neutral.Second.called/0");
    ref(
      g,
      "lib/application.ex",
      symbolId("lib/router.ex", "Neutral.Router.dispatch/0"),
      "static",
      "Neutral.Router.dispatch/0",
    );
    ref(
      g,
      "test/router_test.exs",
      symbolId("lib/first.ex", "Neutral.First.possible/0"),
      "static",
      "Neutral.First.possible/0",
    );
    g.addEdge({
      kind: "references",
      from: symbolId("lib/first.ex", "Neutral.First.possible/0"),
      to: symbolId("lib/second.ex", "Neutral.Second.called/0"),
      referenceKind: "static",
      site: site("lib/first.ex"),
      name: "Neutral.Second.called/0",
    });
    g.addHazard({
      file: fileId("lib/router.ex"),
      carrierSymbol: symbolId("lib/router.ex", "Neutral.Router.dispatch/0"),
      hazardClass: "elixir-dynamic-dispatch",
      detail: "production-active bounded dispatch",
      site: site("lib/router.ex"),
      effect: symbolEffect([symbolId("lib/first.ex", "Neutral.First.possible/0")]),
    });

    const claims = run(g);
    expect(claims.find((claim) => claim.subject.loc.file === "lib/first.ex")).toMatchObject({
      verdict: "test-only",
      confidence: "medium",
    });
    expect(claims.find((claim) => claim.subject.loc.file === "lib/second.ex")).toMatchObject({
      verdict: "test-only",
      confidence: "medium",
    });
  });

  it("shares one captured evaluation across claims, why, and deletion planning", () => {
    const g = new IRGraph();
    addEntry(g, "src/loader.ts");
    addFile(g, "src/plugins/dead.ts");
    hazard(g, "src/loader.ts", "computed-dynamic-import", "src/plugins/");
    const reachability = computePartitionedReachability(g);
    const performance = new PerformanceTracker();
    const evaluation = evaluateHazards({ graph: g, reachability, performance });
    const claims = emitClaims({
      graph: g,
      reachability,
      provenance: PROVENANCE,
      performance,
      hazardEvaluation: evaluation,
    });

    expect(
      whyAlive({
        graph: g,
        reachability,
        claims,
        query: "src/plugins/dead.ts",
        performance,
        hazardEvaluations: [evaluation],
      }).outcome,
    ).toBe("dead");
    expect(
      computeDeletionPlan({
        graph: g,
        reachability,
        subject: { kind: "file", file: "src/plugins/dead.ts" },
        performance,
        hazardEvaluations: [evaluation],
      }).supported,
    ).toBe(false);
    expect(performance.snapshot().counters.fixedPointIterations).toBe(1);
  });

  it("combines overlapping subtree effects lazily while retaining the strongest cap", () => {
    const g = new IRGraph();
    addEntry(g, "src/loader.ts");
    addFile(g, "src/plugins/narrow/candidate.ts");
    addFile(g, "src/plugins/narrow/broken.ts");
    hazard(g, "src/loader.ts", "computed-dynamic-import", "src/plugins/");
    hazard(g, "src/loader.ts", "project-references", "src/plugins/narrow/");
    hazard(g, "src/plugins/narrow/broken.ts", "parse-error");
    const reachability = computePartitionedReachability(g);
    const evaluation = evaluateHazards({ graph: g, reachability });
    const claims = emitClaims({
      graph: g,
      reachability,
      provenance: PROVENANCE,
      hazardEvaluation: evaluation,
    });

    expect(claims.find((claim) => claim.subject.loc.file.endsWith("candidate.ts"))).toMatchObject({
      confidence: "medium",
    });
    expect(claims.find((claim) => claim.subject.loc.file.endsWith("broken.ts"))).toBeUndefined();
    const candidateWhy = whyAlive({
      graph: g,
      reachability,
      claims,
      query: "src/plugins/narrow/candidate.ts",
      hazardEvaluations: [evaluation],
    });
    expect(candidateWhy).toMatchObject({
      outcome: "dead",
      hazards: [{ hazardClass: "computed-dynamic-import" }, { hazardClass: "project-references" }],
    });
    const brokenWhy = whyAlive({
      graph: g,
      reachability,
      claims,
      query: "src/plugins/narrow/broken.ts",
      hazardEvaluations: [evaluation],
    });
    expect(brokenWhy).toMatchObject({
      outcome: "dead",
      hazards: expect.arrayContaining([
        expect.objectContaining({ hazardClass: "computed-dynamic-import" }),
        expect.objectContaining({ hazardClass: "project-references" }),
        expect.objectContaining({ hazardClass: "parse-error" }),
      ]),
    });
  });

  it("drains a reverse-ordered loader chain in one indexed activation pass", () => {
    const g = new IRGraph();
    const count = 200;
    addEntry(g, "src/root.ts");
    for (let index = count - 1; index >= 0; index -= 1) {
      const file = `src/layer_${index}/loader.ts`;
      addFile(g, file);
      hazard(g, file, "computed-dynamic-import", `src/layer_${index + 1}/`);
    }
    ref(g, "src/root.ts", fileId("src/layer_0/loader.ts"), "side-effect");
    const performance = new PerformanceTracker();
    const reachability = computePartitionedReachability(g);
    emitClaims({ graph: g, reachability, provenance: PROVENANCE, performance });

    expect(performance.snapshot().counters.fixedPointIterations).toBe(1);
  });

  it("keeps many overlapping bounded sources on a delta-driven propagation curve", () => {
    const g = new IRGraph();
    const sourceCount = 800;
    const chainLength = 150;
    addEntry(g, "lib/application.ex");
    addSymbol(g, "lib/router.ex", "Neutral.Router.dispatch/0");
    ref(
      g,
      "lib/application.ex",
      symbolId("lib/router.ex", "Neutral.Router.dispatch/0"),
      "static",
      "Neutral.Router.dispatch/0",
    );
    for (let index = 0; index < chainLength; index += 1) {
      addSymbol(g, "lib/chain.ex", `Neutral.Chain.step_${index}/0`);
      if (index > 0) {
        g.addEdge({
          kind: "references",
          referenceKind: "static",
          from: symbolId("lib/chain.ex", `Neutral.Chain.step_${index - 1}/0`),
          to: symbolId("lib/chain.ex", `Neutral.Chain.step_${index}/0`),
          name: `Neutral.Chain.step_${index}/0`,
          site: site("lib/chain.ex"),
        });
      }
    }
    for (let index = 0; index < sourceCount; index += 1) {
      g.addHazard({
        file: fileId("lib/router.ex"),
        carrierSymbol: symbolId("lib/router.ex", "Neutral.Router.dispatch/0"),
        hazardClass: "elixir-dynamic-dispatch",
        detail: `bounded neutral source ${index}`,
        site: {
          file: "lib/router.ex",
          span: { ...SPAN, startLine: index + 1, endLine: index + 1 },
        },
        effect: symbolEffect([symbolId("lib/chain.ex", "Neutral.Chain.step_0/0")]),
      });
    }

    const performanceTracker = new PerformanceTracker();
    const started = performance.now();
    const evaluation = evaluateHazards({
      graph: g,
      reachability: computePartitionedReachability(g),
      performance: performanceTracker,
    });
    const elapsed = performance.now() - started;

    expect(
      evaluation.effectsForSubject({
        kind: "export",
        file: "lib/chain.ex",
        name: `Neutral.Chain.step_${chainLength - 1}/0`,
      }),
    ).toHaveLength(sourceCount);
    expect(performanceTracker.snapshot().counters.fixedPointIterations).toBe(1);
    expect(elapsed).toBeLessThan(1_500);
  });

  it("bounds a symbol-set hazard without suppressing its owning file", () => {
    const dead = new IRGraph();
    addEntry(dead, "lib/application.ex");
    addSymbol(dead, "lib/orphan_server.ex", "Neutral.OrphanServer.handle_call/3");
    dead.addHazard({
      file: fileId("lib/orphan_server.ex"),
      hazardClass: "elixir-behaviour-callback",
      detail: "bounded neutral callback surface",
      site: site("lib/orphan_server.ex"),
      effect: symbolEffect([
        symbolId("lib/orphan_server.ex", "Neutral.OrphanServer.handle_call/3"),
      ]),
    });

    expect(shape(run(dead))).toContainEqual({
      kind: "file",
      name: "lib/orphan_server.ex",
      file: "lib/orphan_server.ex",
      verdict: "unused",
      confidence: "high",
    });

    const reachable = new IRGraph();
    addEntry(reachable, "lib/application.ex");
    addSymbol(reachable, "lib/server.ex", "Neutral.Server.handle_call/3");
    addSymbol(reachable, "lib/server.ex", "Neutral.Server.ordinary/0");
    addSymbol(reachable, "lib/helper.ex", "Neutral.Helper.ordinary/0");
    ref(reachable, "lib/application.ex", fileId("lib/server.ex"), "side-effect");
    ref(reachable, "lib/application.ex", fileId("lib/helper.ex"), "side-effect");
    reachable.addEdge({
      kind: "references",
      from: symbolId("lib/server.ex", "Neutral.Server.handle_call/3"),
      to: symbolId("lib/helper.ex", "Neutral.Helper.ordinary/0"),
      referenceKind: "static",
      site: site("lib/server.ex"),
      name: "Neutral.Helper.ordinary/0",
    });
    reachable.addHazard({
      file: fileId("lib/server.ex"),
      hazardClass: "elixir-behaviour-callback",
      detail: "bounded neutral callback surface",
      site: site("lib/server.ex"),
      effect: symbolEffect([symbolId("lib/server.ex", "Neutral.Server.handle_call/3")]),
    });

    const reachableClaims = run(reachable);
    expect(reachableClaims.find((claim) => claim.subject.name.endsWith("handle_call/3"))).toBe(
      undefined,
    );
    expect(
      reachableClaims.find((claim) => claim.subject.name.endsWith("ordinary/0")),
    ).toMatchObject({ verdict: "unused", confidence: "high" });
    expect(claimConfidence(reachableClaims, "Neutral.Helper.ordinary/0")).toBe("high");
  });

  it("config-referenced-file yields a file claim at medium (scoped, not suppressed)", () => {
    const g = new IRGraph();
    addEntry(g, "src/index.ts");
    addFile(g, "src/test-setup.ts");
    hazard(g, "src/test-setup.ts", "config-referenced-file");

    expect(shape(run(g))).toEqual([
      {
        kind: "file",
        name: "src/test-setup.ts",
        file: "src/test-setup.ts",
        verdict: "unused",
        confidence: "medium",
      },
    ]);
  });

  it("computed-cjs-exports caps a file's dead EXPORTS to medium; the file's own liveness is unaffected", () => {
    const g = new IRGraph();
    addEntry(g, "src/index.ts");
    addSymbol(g, "src/lib.ts", "used");
    addSymbol(g, "src/lib.ts", "dead");
    ref(g, "src/index.ts", symbolId("src/lib.ts", "used"), "static", "used");
    hazard(g, "src/lib.ts", "computed-cjs-exports");
    // An orphan file that also carries the hazard: the symbol-set scope does not
    // touch the FILE claim, so it stays high.
    addFile(g, "src/orphan.ts");
    hazard(g, "src/orphan.ts", "computed-cjs-exports");

    expect(sorted(run(g))).toEqual([
      { kind: "export", name: "dead", file: "src/lib.ts", verdict: "unused", confidence: "medium" },
      {
        kind: "file",
        name: "src/orphan.ts",
        file: "src/orphan.ts",
        verdict: "unused",
        confidence: "high",
      },
    ]);
  });

  it("parse-error suppresses only its own file (no-claim); a sibling orphan stays claimable", () => {
    const g = new IRGraph();
    addEntry(g, "src/index.ts");
    addFile(g, "src/broken.ts");
    addFile(g, "src/orphan.ts");
    hazard(g, "src/broken.ts", "parse-error");

    expect(shape(run(g)).map((c) => c.name)).toEqual(["src/orphan.ts"]);
  });

  it("an unresolvable-import hazard (scope: none) affects nothing — a clean sibling stays claimable", () => {
    const g = new IRGraph();
    addEntry(g, "src/index.ts");
    addSymbol(g, "src/lib.ts", "used");
    addSymbol(g, "src/lib.ts", "dead");
    ref(g, "src/index.ts", symbolId("src/lib.ts", "used"), "static", "used");
    hazard(g, "src/index.ts", "unresolvable-import");

    expect(shape(run(g)).map((c) => c.name)).toEqual(["dead"]);
  });

  it("a capped claim explains the downgrade from the hazard SITE in its evidence detail", () => {
    const g = new IRGraph();
    addEntry(g, "src/index.ts");
    addFile(g, "src/mods/alpha.ts");
    // Hazard site is reachable src/loader.ts (the importer), the subtree is src/mods/.
    addFile(g, "src/loader.ts");
    ref(g, "src/index.ts", fileId("src/loader.ts"), "side-effect");
    hazard(g, "src/loader.ts", "computed-dynamic-import", "src/mods/");

    const [claim] = run(g);
    expect(claim?.confidence).toBe("medium");
    expect(claim?.evidence).toHaveLength(1);
    expect(claim?.evidence[0]?.type).toBe("static-reachability");
    expect(claim?.evidence[0]?.detail).toContain("capped medium");
    expect(claim?.evidence[0]?.detail).toContain("src/loader.ts:1");
  });

  it("the strongest cap wins when several hazards cover one file (no-claim beats medium)", () => {
    const g = new IRGraph();
    addEntry(g, "src/index.ts");
    addFile(g, "src/x.ts");
    hazard(g, "src/index.ts", "computed-require"); // whole package ⇒ x.ts medium
    hazard(g, "src/x.ts", "parse-error"); // file scope no-claim ⇒ suppresses x.ts

    expect(run(g)).toEqual([]);
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

  it("keeps a reasonless directive unsuppressed and emits an audit warning", () => {
    const g = new IRGraph();
    addEntry(g, "src/index.ts");
    addSymbol(g, "src/lib.ts", "used");
    addSymbol(g, "src/lib.ts", "dead", {
      suppression: { reason: null, valid: false },
    });
    ref(g, "src/index.ts", symbolId("src/lib.ts", "used"), "static", "used");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const claims = run(g);
      expect(claims).toHaveLength(1);
      expect(claims[0]?.suppression).toBeUndefined();
      expect(warn).toHaveBeenCalledWith(
        expect.stringMatching(/src\/lib\.ts:1.*requires a non-empty reason.*unsuppressed/),
      );
    } finally {
      warn.mockRestore();
    }
  });
});

describe("hazard registry — T3.1b classes (fooling-input: claimed WITHOUT, capped/alive WITH)", () => {
  it("checker-only-type-relationship suppresses a file's dead EXPORTS (symbol-set, no-claim)", () => {
    // A file that participates in declaration merging (a `declare global` /
    // `declare module` block) carries the hazard. Its dead export would be a
    // high-confidence claim; with the hazard it is kept alive (no-claim).
    const build = (withHazard: boolean): Claim[] => {
      const g = new IRGraph();
      addEntry(g, "src/index.ts");
      addSymbol(g, "src/globals.ts", "used");
      addSymbol(g, "src/globals.ts", "Marker"); // referenced only through the merge
      ref(g, "src/index.ts", symbolId("src/globals.ts", "used"), "static", "used");
      // globals.ts is kept alive by the used-symbol edge (a live file), so only its
      // export is at stake — exactly the symbol-set case.
      if (withHazard) hazard(g, "src/globals.ts", "checker-only-type-relationship");
      return run(g);
    };
    // WITHOUT detection: Marker is a confident dead export.
    expect(shape(build(false))).toEqual([
      {
        kind: "export",
        name: "Marker",
        file: "src/globals.ts",
        verdict: "unused",
        confidence: "high",
      },
    ]);
    // WITH detection: suppressed entirely (kept alive).
    expect(build(true)).toEqual([]);
  });

  it("emit-decorator-metadata caps a decorated file's dead exports to medium (symbol-set)", () => {
    const build = (withHazard: boolean): Claim[] => {
      const g = new IRGraph();
      addEntry(g, "src/index.ts");
      addSymbol(g, "src/service.ts", "used");
      addSymbol(g, "src/service.ts", "Service"); // decorated class, no static importer
      ref(g, "src/index.ts", symbolId("src/service.ts", "used"), "static", "used");
      if (withHazard) hazard(g, "src/service.ts", "emit-decorator-metadata");
      return run(g);
    };
    expect(shape(build(false)).map((c) => c.confidence)).toEqual(["high"]);
    expect(shape(build(true))).toEqual([
      {
        kind: "export",
        name: "Service",
        file: "src/service.ts",
        verdict: "unused",
        confidence: "medium",
      },
    ]);
  });

  it("conditional-exports-divergence suppresses the whole target file (file scope, no-claim)", () => {
    const build = (withHazard: boolean): Claim[] => {
      const g = new IRGraph();
      addEntry(g, "src/index.ts");
      addFile(g, "src/impl.browser.ts"); // reachable only under the browser branch
      if (withHazard) hazard(g, "src/impl.browser.ts", "conditional-exports-divergence");
      return run(g);
    };
    expect(shape(build(false))).toEqual([
      {
        kind: "file",
        name: "src/impl.browser.ts",
        file: "src/impl.browser.ts",
        verdict: "unused",
        confidence: "high",
      },
    ]);
    expect(build(true)).toEqual([]);
  });

  it("project-references caps the WHOLE package at medium (directory-subtree, no prefix)", () => {
    const build = (withHazard: boolean): Claim[] => {
      const g = new IRGraph();
      addEntry(g, "src/index.ts");
      addFile(g, "src/a.ts");
      addSymbol(g, "src/lib.ts", "used");
      addSymbol(g, "src/lib.ts", "dead");
      ref(g, "src/index.ts", symbolId("src/lib.ts", "used"), "static", "used");
      // whole-package cap: attach the hazard to tsconfig.json (not a file node),
      // no subtreePrefix ⇒ "" ⇒ every file/export is in scope.
      if (withHazard) hazard(g, "tsconfig.json", "project-references");
      return run(g);
    };
    expect(sorted(build(false)).map((c) => `${c.name}:${c.confidence}`)).toEqual([
      "dead:high",
      "src/a.ts:high",
    ]);
    expect(sorted(build(true)).map((c) => `${c.name}:${c.confidence}`)).toEqual([
      "dead:medium",
      "src/a.ts:medium",
    ]);
  });

  it("jsx-runtime-dependency (scope none) affects nothing — a clean sibling stays claimable at high", () => {
    const g = new IRGraph();
    addEntry(g, "src/index.ts");
    addSymbol(g, "src/lib.ts", "used");
    addSymbol(g, "src/lib.ts", "dead");
    ref(g, "src/index.ts", symbolId("src/lib.ts", "used"), "static", "used");
    hazard(g, "src/index.ts", "jsx-runtime-dependency");

    expect(shape(run(g))).toEqual([
      { kind: "export", name: "dead", file: "src/lib.ts", verdict: "unused", confidence: "high" },
    ]);
  });
});

describe("hazard registry — the unmodelled-class invariant (degrade toward alive)", () => {
  it("an UNREGISTERED hazard class ⇒ NO claims at all + a loud internal warning", () => {
    const g = new IRGraph();
    addEntry(g, "src/index.ts");
    addFile(g, "src/orphan.ts");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      // A class outside the closed vocabulary — planted via a cast (a bug, or a
      // frontend citing a class core has not modelled). The engine must not
      // silently claim; it suppresses the whole project and warns.
      hazard(g, "src/index.ts", "totally-unmodelled-hazard" as HazardClass);
      expect(run(g)).toEqual([]);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]?.[0])).toContain("unregistered hazard class");
    } finally {
      warn.mockRestore();
    }
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

describe("tier-2 partition: test-only verdicts (T5.1/T5.2)", () => {
  it("flags a file reached only from a test as a whole-file test-only claim, naming the test entrypoint", () => {
    const g = new IRGraph();
    addEntry(g, "src/index.ts");
    addSymbol(g, "src/index.ts", "publicApi"); // a production-alive symbol
    addSymbol(g, "src/feature.ts", "computeFeature"); // reached only by the test
    addTestEntry(g, "test/feature.test.ts");
    // The test also exercises production code, so it is NOT itself a zombie —
    // isolating the test-only FILE behaviour on feature.ts.
    ref(g, "test/feature.test.ts", symbolId("src/index.ts", "publicApi"), "static", "publicApi");
    ref(
      g,
      "test/feature.test.ts",
      symbolId("src/feature.ts", "computeFeature"),
      "static",
      "computeFeature",
    );

    const claims = run(g);
    expect(shape(claims)).toEqual([
      {
        kind: "file",
        name: "src/feature.ts",
        file: "src/feature.ts",
        verdict: "test-only",
        confidence: "high",
      },
    ]);
    // Evidence is tier-2 and names the effective test-world root keeping it alive.
    expect(claims[0]?.evidence[0]?.type).toBe("test-only");
    expect(claims[0]?.evidence[0]?.detail).toContain("test/feature.test.ts");
  });

  it("flags a dead export used only from a test as a test-only export, in an otherwise-alive file", () => {
    const g = new IRGraph();
    addEntry(g, "src/index.ts");
    addSymbol(g, "src/lib.ts", "used"); // production reaches this ⇒ lib.ts is alive
    addSymbol(g, "src/lib.ts", "testOnly"); // only a test reaches this
    ref(g, "src/index.ts", symbolId("src/lib.ts", "used"), "static", "used");
    addTestEntry(g, "test/lib.test.ts");
    ref(g, "test/lib.test.ts", symbolId("src/lib.ts", "testOnly"), "static", "testOnly");

    // lib.ts is production-alive (the test reaches it too), so it is not a
    // zombie; only the test-only EXPORT is flagged.
    expect(shape(run(g))).toEqual([
      {
        kind: "export",
        name: "testOnly",
        file: "src/lib.ts",
        verdict: "test-only",
        confidence: "high",
      },
    ]);
  });

  it("a shared util imported by BOTH production and a test stays production-alive (not test-only)", () => {
    // The classic partition trap: a symbol in both partitions is production-
    // reachable, so it is never flagged test-only.
    const g = new IRGraph();
    addEntry(g, "src/index.ts");
    addSymbol(g, "src/shared.ts", "sharedUtil");
    ref(g, "src/index.ts", symbolId("src/shared.ts", "sharedUtil"), "static", "sharedUtil");
    addTestEntry(g, "test/shared.test.ts");
    ref(g, "test/shared.test.ts", symbolId("src/shared.ts", "sharedUtil"), "static", "sharedUtil");

    expect(run(g)).toEqual([]);
  });

  it("a file reachable from BOTH config and a test is alive (config wins over test-only)", () => {
    const g = new IRGraph();
    addEntry(g, "src/index.ts"); // production baseline so claiming is enabled
    addConfigEntry(g, "vite.config.ts");
    addSymbol(g, "src/buildHelper.ts", "buildHelper");
    ref(
      g,
      "vite.config.ts",
      symbolId("src/buildHelper.ts", "buildHelper"),
      "static",
      "buildHelper",
    );
    addTestEntry(g, "test/build.test.ts");
    ref(
      g,
      "test/build.test.ts",
      symbolId("src/buildHelper.ts", "buildHelper"),
      "static",
      "buildHelper",
    );

    // config-reachable ⇒ alive & never flagged; the test reaching it too does
    // not downgrade it to test-only, and the test is not a zombie.
    expect(run(g)).toEqual([]);
  });

  it("a test-only verdict is capped by the same hazard machinery as unused (medium under a subtree cap)", () => {
    const g = new IRGraph();
    addEntry(g, "src/index.ts");
    addSymbol(g, "src/index.ts", "publicApi");
    addSymbol(g, "src/mods/plugin.ts", "plugin"); // reached only by the test
    addTestEntry(g, "test/plugin.test.ts");
    ref(g, "test/plugin.test.ts", symbolId("src/index.ts", "publicApi"), "static", "publicApi");
    ref(g, "test/plugin.test.ts", symbolId("src/mods/plugin.ts", "plugin"), "static", "plugin");
    // A computed-dynamic-import subtree cap over src/mods/ downgrades everything there.
    hazard(g, "src/index.ts", "computed-dynamic-import", "src/mods/");

    const claims = run(g).filter((c) => c.subject.name === "src/mods/plugin.ts");
    expect(claims[0]).toMatchObject({ verdict: "test-only", confidence: "medium" });
  });
});

describe("tier-2 partition: zombie tests (T5.2 point 3)", () => {
  it("flags a test whose whole reach (via a helper chain) is test-only/dead as a zombie test", () => {
    const g = new IRGraph();
    addEntry(g, "src/index.ts");
    addSymbol(g, "src/index.ts", "publicApi"); // production-alive, NOT reached by the test
    addSymbol(g, "src/helper.ts", "helper");
    addSymbol(g, "src/leaf.ts", "leafThing");
    ref(g, "src/helper.ts", symbolId("src/leaf.ts", "leafThing"), "static", "leafThing"); // helper → leaf
    addTestEntry(g, "test/chain.test.ts");
    ref(g, "test/chain.test.ts", symbolId("src/helper.ts", "helper"), "static", "helper"); // test → helper

    const claims = run(g);
    const zombie = claims.find((c) => c.subject.kind === "test");
    expect(zombie).toMatchObject({
      verdict: "test-only",
      confidence: "high",
      subject: { kind: "test", name: "test/chain.test.ts" },
    });
    expect(zombie?.id).toMatch(/^tst_[0-9a-f]{16}$/);
    // The helper chain it keeps alive is itself reported test-only (order-independent).
    const files = claims.filter((c) => c.subject.kind === "file");
    expect(files.map((c) => c.subject.name).sort()).toEqual(["src/helper.ts", "src/leaf.ts"]);
    expect(files.every((c) => c.verdict === "test-only" && c.confidence === "high")).toBe(true);
  });

  it("does NOT flag a test that reaches production-alive code (conservative — not a zombie)", () => {
    const g = new IRGraph();
    addEntry(g, "src/index.ts");
    addSymbol(g, "src/index.ts", "publicApi");
    addTestEntry(g, "test/real.test.ts");
    ref(g, "test/real.test.ts", symbolId("src/index.ts", "publicApi"), "static", "publicApi");

    expect(run(g).some((c) => c.subject.kind === "test")).toBe(false);
    expect(run(g)).toEqual([]);
  });

  it("does NOT flag a test that imports nothing (reaches only itself) as a zombie", () => {
    const g = new IRGraph();
    addEntry(g, "src/index.ts");
    addTestEntry(g, "test/empty.test.ts");
    expect(run(g).some((c) => c.subject.kind === "test")).toBe(false);
  });

  it("does not let an unrelated test-environment edge mask a zombie test", () => {
    const g = new IRGraph();
    addEntry(g, "lib/application.ex");
    addSymbol(g, "lib/application.ex", "Application.start/2");
    addSymbol(g, "lib/conditional.ex", "Conditional.test_callback/0");
    ref(
      g,
      "lib/application.ex",
      symbolId("lib/conditional.ex", "Conditional.test_callback/0"),
      "static",
      "Conditional.test_callback/0",
      ["test"],
    );
    addSymbol(g, "test/helper.ex", "TestHelper.only/0");
    addTestEntry(g, "test/zombie_test.exs");
    ref(
      g,
      "test/zombie_test.exs",
      symbolId("test/helper.ex", "TestHelper.only/0"),
      "static",
      "TestHelper.only/0",
    );

    const claims = run(g);
    expect(claims.find((claim) => claim.subject.name === "test/zombie_test.exs")).toMatchObject({
      verdict: "test-only",
      subject: { kind: "test" },
    });
    expect(claims.find((claim) => claim.subject.name === "lib/conditional.ex")).toMatchObject({
      verdict: "test-only",
      subject: { kind: "file" },
    });
  });
});

describe("dependency claims (core)", () => {
  const DEP: DependencyClaimInput = {
    packageName: "left-pad",
    loc: { file: "package.json", span: [7, 7] },
  };

  const runWithDeps = (g: IRGraph, dependencies: DependencyClaimInput[]): Claim[] => {
    const reachability = computePartitionedReachability(g);
    return emitClaims({ graph: g, reachability, provenance: PROVENANCE, dependencies });
  };

  it("emits a dependency/unused claim at high when no project hazard caps it", () => {
    const g = new IRGraph();
    addEntry(g, "src/index.ts");
    const claims = runWithDeps(g, [DEP]);
    expect(shape(claims)).toEqual([
      {
        kind: "dependency",
        name: "left-pad",
        file: "package.json",
        verdict: "unused",
        confidence: "high",
      },
    ]);
    expect(claims[0]?.subject.loc.span).toEqual([7, 7]);
    expect(claims[0]?.evidence[0]?.source).toBe("reference-graph");
  });

  it("emits a dependency/test-only claim when the frontend tagged the dep test-only (T5.2 point 4)", () => {
    const g = new IRGraph();
    addEntry(g, "src/index.ts");
    const testOnlyDep: DependencyClaimInput = {
      packageName: "supertest",
      loc: { file: "package.json", span: [9, 9] },
      verdict: "test-only",
    };
    const claims = runWithDeps(g, [testOnlyDep]);
    expect(shape(claims)).toEqual([
      {
        kind: "dependency",
        name: "supertest",
        file: "package.json",
        verdict: "test-only",
        confidence: "high",
      },
    ]);
    expect(claims[0]?.evidence[0]?.type).toBe("test-only");
    expect(claims[0]?.evidence[0]?.detail).toContain("only from test files");
  });

  it("respects a project-scope cap: unresolvable-entrypoint-target downgrades deps to medium", () => {
    const g = new IRGraph();
    addEntry(g, "src/index.ts");
    hazard(g, "package.json", "unresolvable-entrypoint-target"); // scope project, cap medium
    expect(sorted(runWithDeps(g, [DEP]))[0]).toMatchObject({
      kind: "dependency",
      confidence: "medium",
    });
  });

  it("respects a whole-package cap: a project-references hazard (empty prefix) downgrades deps", () => {
    const g = new IRGraph();
    addEntry(g, "src/index.ts");
    hazard(g, "tsconfig.json", "project-references"); // directory-subtree, no prefix ⇒ whole package
    expect(shape(runWithDeps(g, [DEP]))).toEqual([
      expect.objectContaining({ kind: "dependency", confidence: "medium" }),
    ]);
  });

  it("emits no dependency claim when there is no production entrypoint (nothing anchors liveness)", () => {
    const g = new IRGraph();
    addConfigEntry(g, "vite.config.ts"); // a root, but not a production one
    expect(runWithDeps(g, [DEP])).toEqual([]);
  });

  it("suppresses dependency claims when an unregistered hazard forces whole-project no-claim", () => {
    const g = new IRGraph();
    addEntry(g, "src/index.ts");
    hazard(g, "src/index.ts", "totally-unknown-hazard" as HazardClass);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(runWithDeps(g, [DEP])).toEqual([]);
    warn.mockRestore();
  });
});

describe("per-unit hazard-cap scoping (T4 / reference-codebase §4.3)", () => {
  // A three-unit workspace: root plus two members with no relationship.
  const UNITS = [
    { rootRelDir: "" },
    { rootRelDir: "packages/pkg-a" },
    { rootRelDir: "packages/pkg-b" },
  ];
  const runUnits = (
    g: IRGraph,
    units: readonly { rootRelDir: string }[],
    dependencies?: DependencyClaimInput[],
  ): Claim[] => {
    const reachability = computePartitionedReachability(g);
    return emitClaims({
      graph: g,
      reachability,
      provenance: PROVENANCE,
      units,
      ...(dependencies !== undefined ? { dependencies } : {}),
    });
  };
  const confByFile = (claims: Claim[]): Record<string, string> =>
    Object.fromEntries(claims.map((c) => [c.subject.loc.file, c.confidence]));

  it("a computed-require with no static prefix in unit A caps unit A's files but NOT unit B's", () => {
    const g = new IRGraph();
    addEntry(g, "packages/pkg-a/src/index.ts");
    addEntry(g, "packages/pkg-b/src/index.ts");
    addSymbol(g, "packages/pkg-a/src/dead-a.ts", "deadA");
    addSymbol(g, "packages/pkg-b/src/dead-b.ts", "deadB");
    // Empty-prefix (whole-package) computed-require hazard, sited in pkg-a.
    hazard(g, "packages/pkg-a/src/index.ts", "computed-require");

    const byFile = confByFile(runUnits(g, UNITS));
    expect(byFile["packages/pkg-a/src/dead-a.ts"]).toBe("medium"); // pkg-a: capped by its own hazard
    expect(byFile["packages/pkg-b/src/dead-b.ts"]).toBe("high"); // pkg-b: unrelated unit — never capped
  });

  it("a config-reachable opaque carrier in a vendored top-level file caps only the root unit", () => {
    const g = new IRGraph();
    addEntry(g, "packages/pkg-a/src/index.ts");
    addSymbol(g, "packages/pkg-a/src/dead-a.ts", "deadA");
    addConfigEntry(g, "vendor/bundle.js"); // root-owned, reachable in the config partition
    addFile(g, "vendor/dead.js");
    hazard(g, "vendor/bundle.js", "computed-require"); // owner ⇒ root unit ""

    const byFile = confByFile(runUnits(g, UNITS));
    expect(byFile["vendor/dead.js"]).toBe("medium"); // root-owned — capped
    expect(byFile["packages/pkg-a/src/dead-a.ts"]).toBe("high"); // member — the root cap must not reach it
  });

  it("a whole-package hazard in unit A caps unit A's dependency claim but not unit B's", () => {
    const g = new IRGraph();
    addEntry(g, "packages/pkg-a/src/index.ts");
    addEntry(g, "packages/pkg-b/src/index.ts");
    hazard(g, "packages/pkg-a/src/index.ts", "computed-require");

    const claims = runUnits(g, UNITS, [
      { packageName: "dep-a", loc: { file: "packages/pkg-a/package.json", span: [3, 3] } },
      { packageName: "dep-b", loc: { file: "packages/pkg-b/package.json", span: [3, 3] } },
    ]);
    const byName = Object.fromEntries(
      claims
        .filter((c) => c.subject.kind === "dependency")
        .map((c) => [c.subject.name, c.confidence]),
    );
    expect(byName["dep-a"]).toBe("medium"); // declared in pkg-a — capped by pkg-a's hazard
    expect(byName["dep-b"]).toBe("high"); // declared in pkg-b — not capped
  });

  it("an unreachable whole-package carrier leaves every unit's dependency claims high", () => {
    const g = new IRGraph();
    addEntry(g, "packages/pkg-a/src/index.ts");
    addEntry(g, "packages/pkg-b/src/index.ts");
    addFile(g, "packages/pkg-a/src/dormant-loader.ts");
    hazard(g, "packages/pkg-a/src/dormant-loader.ts", "computed-require");

    const claims = runUnits(g, UNITS, [
      { packageName: "dep-a", loc: { file: "packages/pkg-a/package.json", span: [3, 3] } },
      { packageName: "dep-b", loc: { file: "packages/pkg-b/package.json", span: [3, 3] } },
    ]);
    const byName = Object.fromEntries(
      claims
        .filter((claim) => claim.subject.kind === "dependency")
        .map((claim) => [claim.subject.name, claim.confidence]),
    );
    expect(byName).toMatchObject({ "dep-a": "high", "dep-b": "high" });
  });

  it("no `units` supplied ⇒ one root unit ⇒ a whole-package cap covers the whole run (back-compat)", () => {
    const g = new IRGraph();
    addEntry(g, "src/index.ts");
    addEntry(g, "packages/a/loader.ts");
    addSymbol(g, "packages/a/dead.ts", "deadA");
    addSymbol(g, "packages/b/dead.ts", "deadB");
    hazard(g, "packages/a/loader.ts", "computed-require"); // reachable carrier, empty prefix

    // Default single root unit: every file is root-owned, so both are capped —
    // byte-identical to the pre-`units` single-graph behaviour.
    const byFile = confByFile(run(g));
    expect(byFile["packages/a/dead.ts"]).toBe("medium");
    expect(byFile["packages/b/dead.ts"]).toBe("medium");
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

describe("repository fragment scoping", () => {
  const scopedRun = (
    graph: IRGraph,
    analysisFiles: ReadonlySet<string>,
    claimableFiles: ReadonlySet<string> = analysisFiles,
  ): Claim[] =>
    emitClaims({
      graph,
      reachability: computePartitionedReachability(graph),
      provenance: PROVENANCE,
      analysisFiles,
      claimableFiles,
    });

  it("emits only subjects owned by the selected fragment", () => {
    const g = new IRGraph();
    addEntry(g, "web/src/index.ts");
    addFile(g, "web/src/dead.ts");
    addEntry(g, "server/lib/app.ex");
    addFile(g, "server/lib/dead.ex");

    const claims = scopedRun(g, new Set(["web/src/index.ts", "web/src/dead.ts"]));

    expect(claims.map((claim) => claim.subject.loc.file)).toEqual(["web/src/dead.ts"]);
  });

  it("isolates unknown hazards and claim exclusions in another fragment", () => {
    const g = new IRGraph();
    addEntry(g, "web/src/index.ts");
    addFile(g, "web/src/claimable.ts");
    addFile(g, "web/generated/excluded.ts");
    addEntry(g, "server/lib/app.ex");
    hazard(g, "server/lib/app.ex", "unknown-elixir-hazard" as HazardClass);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const claims = scopedRun(
      g,
      new Set(["web/src/index.ts", "web/src/claimable.ts", "web/generated/excluded.ts"]),
      new Set(["web/src/index.ts", "web/src/claimable.ts"]),
    );

    expect(claims.map((claim) => claim.subject.loc.file)).toEqual(["web/src/claimable.ts"]);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("requires a fragment-local root or an inbound production bridge", () => {
    const g = new IRGraph();
    addEntry(g, "web/src/index.ts");
    addFile(g, "native/src/callback.rs");
    addFile(g, "native/src/dead.rs");
    const rustFiles = new Set(["native/src/callback.rs", "native/src/dead.rs"]);

    expect(scopedRun(g, rustFiles)).toEqual([]);

    ref(g, "web/src/index.ts", fileId("native/src/callback.rs"), "static");
    expect(scopedRun(g, rustFiles).map((claim) => claim.subject.loc.file)).toEqual([
      "native/src/dead.rs",
    ]);
  });
});

describe("private symbols in entrypoint files", () => {
  it("claims an unreachable contains-only item while keeping the exported surface alive", () => {
    const g = new IRGraph();
    addEntry(g, "src/lib.rs");
    addSymbol(g, "src/lib.rs", "public_api");
    g.addNode({
      kind: "symbol",
      id: symbolId("src/lib.rs", "private_dead"),
      file: "src/lib.rs",
      exportedName: "private_dead",
      isDefault: false,
      typeOnly: false,
      local: true,
      span: SPAN,
    });
    g.addEdge({
      kind: "contains",
      from: fileId("src/lib.rs"),
      to: symbolId("src/lib.rs", "private_dead"),
      site: site("src/lib.rs"),
      name: "private_dead",
    });

    expect(shape(run(g))).toEqual([
      {
        kind: "export",
        name: "private_dead",
        file: "src/lib.rs",
        verdict: "unused",
        confidence: "high",
      },
    ]);
  });
});

describe("exact symbol entrypoint claims", () => {
  it.each(["default", "run"])(
    "keeps only the configured %s export alive and claims its named sibling",
    (target) => {
      const g = new IRGraph();
      addEntry(g, "src/index.ts");
      addSymbol(g, "src/operations.ts", target);
      addSymbol(g, "src/operations.ts", "unusedSibling");
      addSymbolEntry(g, "src/operations.ts", target);

      expect(shape(run(g))).toEqual([
        {
          kind: "export",
          name: "unusedSibling",
          file: "src/operations.ts",
          verdict: "unused",
          confidence: "high",
        },
      ]);
    },
  );
});
