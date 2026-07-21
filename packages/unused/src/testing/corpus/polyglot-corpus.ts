/** Polyglot bridge corpus adapter and environment paths (ADR 0013, P4). */

import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path, { basename } from "node:path";
import { fileURLToPath } from "node:url";
import { analyzeProjectAuto } from "../../frontends/dispatch.js";
import type { Analyzer } from "./analyzer.js";
import { isMixAvailable } from "./elixir-corpus.js";
import { loadLabelCases } from "./labels.js";
import { isCargoAvailable } from "./rust-corpus.js";

const FIXED_CLOCK = new Date(0);

export function polyglotFixturesRoot(): string {
  return fileURLToPath(new URL("../../../../../fixtures/polyglot", import.meta.url));
}

export function polyglotScoreboardPath(): string {
  return path.join(polyglotFixturesRoot(), "..", "scoreboard.polyglot.json");
}

export function isPolyglotToolchainAvailable(): boolean {
  return isMixAvailable() && isCargoAvailable();
}

export const polyglotAnalyzer: Analyzer = {
  name: "polyglot-reference-graph",
  async analyze(fixtureDir: string) {
    // Compiler-backed frontends write build state. Keep corpus runs isolated so
    // Vitest workers (and repeated gate calculations) cannot share Mix/Cargo
    // caches and turn a compiler diagnostic run into an accidentally fresh one.
    const isolated = await mkdtemp(path.join(tmpdir(), "unused-polyglot-corpus-"));
    try {
      await cp(fixtureDir, isolated, {
        recursive: true,
        filter: (source) => !["_build", "target"].includes(basename(source)),
      });
      return [...(await analyzeProjectAuto(isolated, { now: FIXED_CLOCK })).claims];
    } finally {
      await rm(isolated, { recursive: true, force: true });
    }
  },
};

export async function loadPolyglotCases() {
  return loadLabelCases(polyglotFixturesRoot());
}
