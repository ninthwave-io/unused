import { describe, expect, it } from "vitest";
import { PerformanceTracker } from "../core/analysis/index.js";
import { fileId, IRGraph, symbolId } from "../core/ir/index.js";
import { applyConfigSymbolEntrypoints } from "./config-symbol-entrypoints.js";
import { ConfigError, EMPTY_CONFIG, type EntrySymbolLanguage } from "./ts/config.js";

function addSymbol(graph: IRGraph, file: string, name: string): string {
  graph.addNode({ kind: "file", id: fileId(file), path: file });
  const id = symbolId(file, name);
  graph.addNode({
    kind: "symbol",
    id,
    file,
    exportedName: name,
    isDefault: name === "default",
    typeOnly: false,
    local: true,
    span: { start: 0, end: 3, startLine: 1, endLine: 1 },
  });
  return id;
}

function languageMap(
  entries: ReadonlyArray<readonly [string, EntrySymbolLanguage]>,
): ReadonlyMap<string, EntrySymbolLanguage> {
  return new Map(entries);
}

describe("applyConfigSymbolEntrypoints", () => {
  it("resolves repository and nested-workspace rules in one indexed pass", () => {
    const graph = new IRGraph();
    const root = addSymbol(graph, "src/api.ts", "run");
    const nested = addSymbol(graph, "services/backend/lib/worker.ex", "Neutral.Worker.perform/1");
    const performance = new PerformanceTracker();
    applyConfigSymbolEntrypoints({
      graph,
      config: {
        ...EMPTY_CONFIG,
        entrySymbols: [{ language: "ts", file: "src/api.ts", name: "run", reason: "public API" }],
        workspaces: {
          "services/backend": {
            entry: [],
            entrySymbols: [
              {
                language: "ex",
                file: "lib/worker.ex",
                name: "Neutral.Worker.perform/1",
                reason: "runtime callback",
              },
            ],
            project: [],
            suppressions: [],
          },
        },
      },
      units: [
        { rootRelDir: "", name: "root" },
        { rootRelDir: "services/backend", name: "backend" },
      ],
      symbolLanguages: languageMap([
        [root, "ts"],
        [nested, "ex"],
      ]),
      performance,
    });

    expect(graph.entrypoints()).toEqual([
      expect.objectContaining({ file: "src/api.ts", targetSymbol: root, reason: "public API" }),
      expect.objectContaining({
        file: "services/backend/lib/worker.ex",
        targetSymbol: nested,
        reason: "runtime callback",
      }),
    ]);
    expect(performance.snapshot().counters.resolutionAttempts).toBe(2);
    expect(performance.snapshot().phasesMs["convention-config-roots"]).toBeGreaterThan(0);
  });

  it("matches a workspace by a unique package name", () => {
    const graph = new IRGraph();
    const target = addSymbol(graph, "crates/native/src/lib.rs", "neutral_callback");
    applyConfigSymbolEntrypoints({
      graph,
      config: {
        ...EMPTY_CONFIG,
        workspaces: {
          "native-core": {
            entry: [],
            entrySymbols: [
              {
                language: "rs",
                file: "src/lib.rs",
                name: "neutral_callback",
                reason: "NIF operation",
              },
            ],
            project: [],
            suppressions: [],
          },
        },
      },
      units: [{ rootRelDir: "crates/native", name: "native-core" }],
      symbolLanguages: languageMap([[target, "rs"]]),
    });
    expect(graph.entrypoints()[0]).toMatchObject({ targetSymbol: target, reason: "NIF operation" });
  });

  it("fails closed for unmatched symbols, including a language mismatch", () => {
    const graph = new IRGraph();
    const target = addSymbol(graph, "src/api.ts", "run");
    expect(() =>
      applyConfigSymbolEntrypoints({
        graph,
        config: {
          ...EMPTY_CONFIG,
          entrySymbols: [
            { language: "ex", file: "src/api.ts", name: "run", reason: "wrong language" },
          ],
        },
        units: [{ rootRelDir: "", name: "root" }],
        symbolLanguages: languageMap([[target, "ts"]]),
      }),
    ).toThrow(ConfigError);
  });

  it("fails closed for unmatched and ambiguous workspace keys", () => {
    const override = {
      entry: [],
      entrySymbols: [
        { language: "ts" as const, file: "src/api.ts", name: "run", reason: "public" },
      ],
      project: [],
      suppressions: [],
    };
    for (const units of [
      [{ rootRelDir: "packages/other", name: "other" }],
      [
        { rootRelDir: "packages/a", name: "shared" },
        { rootRelDir: "packages/b", name: "shared" },
      ],
    ]) {
      expect(() =>
        applyConfigSymbolEntrypoints({
          graph: new IRGraph(),
          config: {
            ...EMPTY_CONFIG,
            workspaces: { [units.length === 1 ? "missing" : "shared"]: override },
          },
          units,
          symbolLanguages: new Map(),
        }),
      ).toThrow(ConfigError);
    }
  });

  it("rejects a root/workspace effective selector collision", () => {
    const graph = new IRGraph();
    const target = addSymbol(graph, "src/api.ts", "run");
    expect(() =>
      applyConfigSymbolEntrypoints({
        graph,
        config: {
          ...EMPTY_CONFIG,
          entrySymbols: [{ language: "ts", file: "src/api.ts", name: "run", reason: "root" }],
          workspaces: {
            root: {
              entry: [],
              entrySymbols: [
                { language: "ts", file: "src/api.ts", name: "run", reason: "workspace" },
              ],
              project: [],
              suppressions: [],
            },
          },
        },
        units: [{ rootRelDir: "", name: "root" }],
        symbolLanguages: languageMap([[target, "ts"]]),
      }),
    ).toThrow(/duplicates another effective entrySymbols selector/);
  });
});
