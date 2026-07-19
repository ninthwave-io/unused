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
  IRGraph,
  type ReferenceKind,
  type Site,
  symbolId,
} from "../ir/index.js";
import { type DependencyClaimInput, emitClaims } from "./claims.js";
import { computePartitionedReachability } from "./reachability.js";

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
    // Hazard site is src/loader.ts (the importer), the subtree is src/mods/.
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
    // Evidence is tier-2 and names the test entrypoint keeping it alive.
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
