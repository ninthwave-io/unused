/**
 * IR assembly tests (T2.3 acceptance). Builds the reference-graph IR end-to-end
 * from the read-only corpus at `fixtures/ts/**` (discover → parse → resolve →
 * emit) and from targeted `__testfixtures__` trees for the entrypoint matrix and
 * the namespace re-export boundary case.
 *
 * Snapshots are hand-verified for correctness (not merely recorded): each covers
 * one mapping mechanism from architecture.md §3.
 */
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { fileId, type IREdge, type IRGraph, irToJSON, symbolId } from "../../core/ir/index.js";
import { discover } from "./discover.js";
import { detectProductionEntrypoints, emitIR, type PackageJsonLike } from "./emit.js";
import { parseFile, parseSource } from "./parse.js";
import { Resolver } from "./resolve.js";

const repoRoot = fileURLToPath(new URL("../../../../../", import.meta.url));
const corpus = (c: string): string => join(repoRoot, "fixtures/ts", c);
const testfx = (c: string): string =>
  fileURLToPath(new URL(`./__testfixtures__/${c}`, import.meta.url));

/** Full pipeline: discover → parse every file → resolve → emit IR. */
async function buildIR(root: string): Promise<IRGraph> {
  const files = await discover(root);
  const records = await Promise.all(files.map((f) => parseFile(f)));
  const resolver = new Resolver({ projectRoot: root, discoveredFiles: new Set(files) });
  return emitIR({ projectRoot: root, records, resolver });
}

// ---------------------------------------------------------------------------
// IR snapshots over the corpus (≥6 mechanisms, hand-verified)
// ---------------------------------------------------------------------------

describe("IR snapshots (corpus)", () => {
  const cases = [
    "re-export-chain",
    "export-star-chain",
    "side-effect-import",
    "tsconfig-paths-alias",
    "entrypoint-exports-map",
    "string-computed-import",
    "basic-dead-export",
  ];
  for (const c of cases) {
    it(`${c}`, async () => {
      const graph = await buildIR(corpus(c));
      expect(irToJSON(graph)).toMatchSnapshot();
    });
  }
});

// ---------------------------------------------------------------------------
// Every-edge-has-a-span invariant (architecture.md §3)
// ---------------------------------------------------------------------------

describe("provenance invariant: every edge and hazard carries a valid span", () => {
  it.each(["re-export-chain", "tsconfig-paths-alias", "string-computed-import"])(
    "%s",
    async (c) => {
      const graph = await buildIR(corpus(c));
      const json = irToJSON(graph);
      expect(json.edges.length).toBeGreaterThan(0);
      for (const edge of json.edges) {
        assertSite(edge.site, `${edge.kind} ${edge.from} -> ${edge.to}`);
      }
      for (const hz of json.hazards) {
        assertSite(hz.site, `hazard ${hz.hazardClass} @ ${hz.file}`);
      }
    },
  );
});

function assertSite(
  site: { file: string; span: { start: number; end: number; startLine: number; endLine: number } },
  ctx: string,
): void {
  expect(site.file, `${ctx}: site.file`).toBeTruthy();
  expect(typeof site.span.start, `${ctx}: start`).toBe("number");
  expect(typeof site.span.end, `${ctx}: end`).toBe("number");
  expect(site.span.startLine, `${ctx}: startLine >= 1`).toBeGreaterThanOrEqual(1);
  expect(site.span.endLine, `${ctx}: endLine >= startLine`).toBeGreaterThanOrEqual(
    site.span.startLine,
  );
}

// ---------------------------------------------------------------------------
// Entrypoint detection matrix (spec T2.3.1)
// ---------------------------------------------------------------------------

describe("entrypoint detection matrix", () => {
  const root = testfx("entrypoints");
  const resolver = new Resolver({ projectRoot: root });
  const detect = (pkg: PackageJsonLike | null, fallback?: Set<string>) =>
    detectProductionEntrypoints(
      pkg,
      root,
      resolver,
      fallback ? { fallbackFiles: fallback } : undefined,
    );

  it("main only", () => {
    expect(detect({ main: "./src/index.ts" })).toEqual([{ file: "src/index.ts", reason: "main" }]);
  });

  it("bare-relative main (no ./ prefix) is normalized", () => {
    expect(detect({ main: "src/index.ts" })).toEqual([{ file: "src/index.ts", reason: "main" }]);
  });

  it("module field", () => {
    expect(detect({ module: "./src/esm.ts" })).toEqual([{ file: "src/esm.ts", reason: "module" }]);
  });

  it("exports map with conditions — every condition's target is an entrypoint", () => {
    const hits = detect({
      exports: {
        ".": { import: "./src/index.ts", require: "./src/cli.ts" },
        "./worker": { import: "./src/worker.ts" },
      },
    });
    expect(hits.map((h) => h.file).sort()).toEqual(["src/cli.ts", "src/index.ts", "src/worker.ts"]);
    expect(hits.every((h) => h.reason === "exports")).toBe(true);
  });

  it("bin string form", () => {
    expect(detect({ bin: "./src/cli.ts" })).toEqual([{ file: "src/cli.ts", reason: "bin" }]);
  });

  it("bin object form — every binary is an entrypoint", () => {
    const hits = detect({ bin: { unused: "./src/cli.ts", other: "./src/worker.ts" } });
    expect(hits.map((h) => h.file).sort()).toEqual(["src/cli.ts", "src/worker.ts"]);
    expect(hits.every((h) => h.reason === "bin")).toBe(true);
  });

  it("de-dupes across fields; first field wins the reason (main > exports)", () => {
    const hits = detect({ main: "./src/index.ts", exports: { ".": "./src/index.ts" } });
    expect(hits).toEqual([{ file: "src/index.ts", reason: "main" }]);
  });

  it("no package.json ⇒ zero-config fallback to src/index.ts when present", () => {
    expect(detect(null, new Set(["src/index.ts", "src/other.ts"]))).toEqual([
      { file: "src/index.ts", reason: "fallback:src/index.ts" },
    ]);
  });

  it("no package.json, no index file ⇒ no entrypoints (entrypoint-less package)", () => {
    expect(detect(null, new Set(["src/other.ts"]))).toEqual([]);
  });

  it("wildcard exports subpath is skipped in M2 (glob expansion is M4)", () => {
    expect(detect({ exports: { "./*": "./src/*.ts" } })).toEqual([]);
  });
});

describe("entrypoint nodes in the assembled IR", () => {
  it("re-export-chain: package.json main ⇒ one production entrypoint on src/index.ts", async () => {
    const graph = await buildIR(corpus("re-export-chain"));
    const eps = graph.entrypoints();
    expect(eps).toEqual([
      {
        kind: "entrypoint",
        id: "entrypoint:production:src/index.ts",
        entryKind: "production",
        file: "src/index.ts",
        reason: "main",
      },
    ]);
  });

  it("entrypoint-exports-map: two exports-map entries ⇒ two production entrypoints", async () => {
    const graph = await buildIR(corpus("entrypoint-exports-map"));
    expect(
      graph
        .entrypoints()
        .map((e) => e.file)
        .sort(),
    ).toEqual(["src/index.ts", "src/worker.ts"]);
  });
});

// ---------------------------------------------------------------------------
// The namespace re-export boundary case (mandatory — spec T2.3.3)
// ---------------------------------------------------------------------------

describe("namespace re-export boundary case: import * as ns from './b'; export { ns }", () => {
  it("b's liveness rides an explicit edge chain reachable from a's export surface", async () => {
    const root = testfx("namespace-reexport");
    const graph = await buildIR(root);
    const aRel = "src/a.ts";
    const bRel = "src/b.ts";

    // a's export surface contains the forwarded `ns` symbol (not declared locally).
    const surface = graph.exportSurface(aRel);
    const ns = surface.find((s) => s.exportedName === "ns");
    expect(ns, "a.ts exports `ns`").toBeDefined();
    expect(ns?.local, "`ns` is forwarded (a re-export), not declared").toBe(false);

    // The chain: the ns symbol has a re-export edge to b's FILE (whole surface).
    const nsOut = graph.outEdges(symbolId(aRel, "ns"));
    const reexport = nsOut.find(
      (e) => e.kind === "references" && e.referenceKind === "re-export" && e.to === fileId(bRel),
    );
    expect(reexport, "ns --re-export--> b.ts").toBeDefined();
    expect(reexport?.name).toBe("*");

    // And the namespace import itself is a static, whole-surface edge a.ts -> b.ts.
    const aOut = graph.outEdges(fileId(aRel));
    expect(
      aOut.some(
        (e) => e.kind === "references" && e.referenceKind === "static" && e.to === fileId(bRel),
      ),
      "a.ts --static(*)--> b.ts (the import edge)",
    ).toBe(true);

    // Proof: b.ts is reachable from a.ts's export surface via the ns chain.
    expect(
      reachableFrom(
        graph,
        surface.map((s) => s.id),
      ).has(fileId(bRel)),
    ).toBe(true);
  });
});

/** Minimal forward walk over out-edges (test-local; core reachability is T2.4). */
function reachableFrom(graph: IRGraph, seeds: string[]): Set<string> {
  const seen = new Set<string>(seeds);
  const stack = [...seeds];
  while (stack.length > 0) {
    const id = stack.pop() as string;
    for (const edge of graph.outEdges(id) as readonly IREdge[]) {
      if (!seen.has(edge.to)) {
        seen.add(edge.to);
        stack.push(edge.to);
      }
    }
  }
  return seen;
}

// ---------------------------------------------------------------------------
// Boundary / determinism
// ---------------------------------------------------------------------------

describe("re-export chain: only the imported name propagates (unusedThing stays a leaf)", () => {
  it("barrel's usedThing forwards to its origin; unusedThing symbol has an unreferenced re-export edge", async () => {
    const graph = await buildIR(corpus("re-export-chain"));
    const usedOut = graph.outEdges(symbolId("src/barrel.ts", "usedThing"));
    expect(
      usedOut.some(
        (e) =>
          e.referenceKind === "re-export" && e.to === symbolId("src/lib/usedThing.ts", "usedThing"),
      ),
    ).toBe(true);
    // index.ts imports usedThing (not unusedThing): the static edge targets the symbol.
    const idxOut = graph.outEdges(fileId("src/index.ts"));
    expect(
      idxOut.some(
        (e) => e.referenceKind === "static" && e.to === symbolId("src/barrel.ts", "usedThing"),
      ),
    ).toBe(true);
    expect(idxOut.some((e) => e.to === symbolId("src/barrel.ts", "unusedThing"))).toBe(false);
  });
});

describe("determinism", () => {
  it("same project built twice ⇒ identical serialised IR", async () => {
    const a = irToJSON(await buildIR(corpus("export-star-chain")));
    const b = irToJSON(await buildIR(corpus("export-star-chain")));
    expect(a).toEqual(b);
  });
});

// ---------------------------------------------------------------------------
// import = require(...) — sole-importer keep-alive (inherited T2.1 FP fix)
// ---------------------------------------------------------------------------

describe("import = require('./m') gives the target a keep-alive edge (sole importer)", () => {
  it("util.ts and legacy.ts are reachable from index.ts via import=", async () => {
    const graph = await buildIR(testfx("import-equals"));
    const idxOut = graph.outEdges(fileId("src/index.ts"));
    // Each import= produced a resolved module reference → keep-alive edge to the file.
    expect(idxOut.some((e) => e.to === fileId("src/util.ts"))).toBe(true);
    expect(idxOut.some((e) => e.to === fileId("src/legacy.ts"))).toBe(true);
    // The import-equals hazard is still recorded (confidence cap for M3).
    expect(graph.hazards().some((h) => h.hazardClass === "import-equals")).toBe(true);
    // legacy.ts (a bare `export = value` module) has no named symbol but stays a
    // reachable file node — exactly the FP this fixture guards.
    expect(graph.hasNode(fileId("src/legacy.ts"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Re-export forms: `export * as ns from`, `export { default } from`
// ---------------------------------------------------------------------------

describe("re-export forms", () => {
  it("`export * as ns from './x'` ⇒ a forwarded ns symbol edged to x's file surface", async () => {
    const graph = await buildIR(testfx("reexport-forms"));
    const ns = graph.nodeOfKind("symbol", symbolId("src/ns.ts", "things"));
    expect(ns?.local).toBe(false);
    const out = graph.outEdges(symbolId("src/ns.ts", "things"));
    expect(
      out.some(
        (e) => e.referenceKind === "re-export" && e.to === fileId("src/x.ts") && e.name === "*",
      ),
    ).toBe(true);
  });

  it("`export { default } from './x'` ⇒ default symbol edged to x's default export", async () => {
    const graph = await buildIR(testfx("reexport-forms"));
    const def = graph.nodeOfKind("symbol", symbolId("src/def.ts", "default"));
    expect(def?.isDefault).toBe(true);
    const out = graph.outEdges(symbolId("src/def.ts", "default"));
    expect(
      out.some((e) => e.referenceKind === "re-export" && e.to === symbolId("src/x.ts", "default")),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Circular re-export (a → b → a): emit must terminate; edges both ways exist
// ---------------------------------------------------------------------------

describe("circular star re-export terminates and records both edges", () => {
  it("a.ts ↔ b.ts star edges both present; assembly does not loop", async () => {
    // buildIR resolving would hang if emit traversed the cycle; it emits one
    // file-level edge per star re-export and never walks — so this just returns.
    const graph = await buildIR(testfx("circular-reexport"));
    const aOut = graph.outEdges(fileId("src/a.ts"));
    const bOut = graph.outEdges(fileId("src/b.ts"));
    expect(aOut.some((e) => e.referenceKind === "re-export" && e.to === fileId("src/b.ts"))).toBe(
      true,
    );
    expect(bOut.some((e) => e.referenceKind === "re-export" && e.to === fileId("src/a.ts"))).toBe(
      true,
    );
    // Local exports on each side still exist as leaf symbols.
    expect(graph.hasNode(symbolId("src/a.ts", "fromA"))).toBe(true);
    expect(graph.hasNode(symbolId("src/b.ts", "fromB"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// External dependencies + builtins (dependency node for M4; builtins ignored)
// ---------------------------------------------------------------------------

describe("external packages become dependency nodes; builtins are ignored", () => {
  it("`import from 'react'` ⇒ dependency node + edge; `node:fs` ⇒ no node/edge", () => {
    const root = testfx("entrypoints");
    const file = join(root, "src/synthetic.ts");
    const record = parseSource(
      file,
      "import { useState } from 'react';\nimport * as fs from 'node:fs';\nexport const x = useState;\nvoid fs;\n",
    );
    const resolver = new Resolver({ projectRoot: root, discoveredFiles: new Set([file]) });
    const graph = emitIR({ projectRoot: root, records: [record], resolver, packageJson: null });

    const dep = graph.nodeOfKind("dependency", "dependency:react");
    expect(dep?.packageName).toBe("react");
    const out = graph.outEdges(fileId("src/synthetic.ts"));
    expect(out.some((e) => e.to === "dependency:react" && e.name === "useState")).toBe(true);
    // No dependency node was fabricated for the Node builtin, and it emitted no edge.
    expect(graph.nodes().some((n) => n.kind === "dependency" && n.packageName === "fs")).toBe(
      false,
    );
    expect(out.some((e) => e.to.includes("fs"))).toBe(false);
  });
});
