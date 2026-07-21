/** Rust corpus adapter and environment paths for P3 precision gates. */

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { analyzeRustProject } from "../../frontends/rust/index.js";
import type { Analyzer } from "./analyzer.js";
import { loadLabelCases } from "./labels.js";

const FIXED_CLOCK = new Date(0);

export function rustFixturesRoot(): string {
  return fileURLToPath(new URL("../../../../../fixtures/rust", import.meta.url));
}

export function rustScoreboardPath(): string {
  return path.join(rustFixturesRoot(), "..", "scoreboard.rust.json");
}

export function isCargoAvailable(): boolean {
  try {
    return spawnSync("cargo", ["--version"], { encoding: "utf8", timeout: 60_000 }).status === 0;
  } catch {
    return false;
  }
}

export const rustAnalyzer: Analyzer = {
  name: "rust-reference-graph",
  async analyze(fixtureDir: string) {
    return [...(await analyzeRustProject(fixtureDir, { now: FIXED_CLOCK })).claims];
  },
};

export async function loadRustCases() {
  return loadLabelCases(rustFixturesRoot());
}
