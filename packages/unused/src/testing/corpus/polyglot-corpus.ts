/** Polyglot bridge corpus adapter and environment paths (ADR 0013, P4). */

import path from "node:path";
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
    return [...(await analyzeProjectAuto(fixtureDir, { now: FIXED_CLOCK })).claims];
  },
};

export async function loadPolyglotCases() {
  return loadLabelCases(polyglotFixturesRoot());
}
