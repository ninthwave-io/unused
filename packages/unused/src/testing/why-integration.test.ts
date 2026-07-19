/**
 * `whyAlive` end-to-end over real fixtures (T8.1, docs/phasing.md M8). Lives in
 * `testing/` (not `core/`) because it wires the whole pipeline —
 * `analyzeProjectWithGraph` (frontend) → `whyAlive` (core) → `renderWhyPath`
 * (reporter) — which the core module-boundary forbids inside `core/`. This is
 * the check that path reconstruction from the stored predecessor map matches the
 * actual analyzer output (re-export chains, hazard caps, test-only partitions).
 */
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { whyAlive } from "../core/analysis/index.js";
import type { AnalyzeWithGraph } from "../frontends/ts/analyze.js";
import { analyzeProjectWithGraph } from "../frontends/ts/analyze.js";
import { renderWhyPath } from "../reporters/index.js";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const FIXTURES = join(HERE, "../../../../fixtures/ts");
const CLOCK = new Date("2026-07-18T00:00:00.000Z");

const cache = new Map<string, AnalyzeWithGraph>();
async function analysisOf(fixture: string): Promise<AnalyzeWithGraph> {
  const hit = cache.get(fixture);
  if (hit !== undefined) return hit;
  const a = await analyzeProjectWithGraph(join(FIXTURES, fixture), { now: CLOCK });
  cache.set(fixture, a);
  return a;
}
function ask(a: AnalyzeWithGraph, query: string) {
  return whyAlive({ graph: a.graph, reachability: a.reachability, claims: a.result.claims, query });
}

beforeAll(async () => {
  await Promise.all(
    ["re-export-chain", "basic-dead-export", "string-computed-import", "test-root-recognition"].map(
      analysisOf,
    ),
  );
});

describe("whyAlive over fixtures — alive via a re-export chain", () => {
  it("renders entrypoint → barrel → declaration, passing through the re-export hop", async () => {
    const r = ask(await analysisOf("re-export-chain"), "usedThing");
    expect(r.outcome).toBe("alive");
    if (r.outcome !== "alive") return;
    expect(r.entrypointKind).toBe("production");
    expect(r.subject).toEqual({
      kind: "export",
      file: "src/lib/usedThing.ts",
      name: "usedThing",
      line: 1,
    });
    const path = r.paths[0];
    if (path === undefined) throw new Error("expected a path");
    expect(renderWhyPath(path, false)).toBe(
      "src/index.ts (production entrypoint) → src/barrel.ts:2 usedThing → src/lib/usedThing.ts:1 usedThing",
    );
  });
});

describe("whyAlive over fixtures — dead", () => {
  it("reports verdict + confidence + evidence for a clean high-confidence dead export", async () => {
    const r = ask(await analysisOf("basic-dead-export"), "subtract");
    expect(r.outcome).toBe("dead");
    if (r.outcome !== "dead") return;
    expect(r.verdict).toBe("unused");
    expect(r.confidence).toBe("high");
    expect(r.evidence[0]?.detail).toContain("0 inbound references");
    expect(r.hazards).toEqual([]);
  });

  it("attributes the computed-import hazard to a medium-capped dead file", async () => {
    const r = ask(await analysisOf("string-computed-import"), "src/mods/alpha.ts");
    expect(r.outcome).toBe("dead");
    if (r.outcome !== "dead") return;
    expect(r.confidence).toBe("medium");
    expect(r.hazards.map((h) => h.hazardClass)).toContain("computed-dynamic-import");
  });
});

describe("whyAlive over fixtures — test-only", () => {
  it("flags a production-dead, test-reachable file as alive-but-test-only", async () => {
    const r = ask(await analysisOf("test-root-recognition"), "src/feature.ts");
    expect(r.outcome).toBe("alive");
    if (r.outcome !== "alive") return;
    expect(r.testOnly).toBe(true);
    expect(r.entrypointKind).toBe("test");
  });
});
