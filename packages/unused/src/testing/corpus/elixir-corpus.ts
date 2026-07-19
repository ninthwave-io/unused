/**
 * Elixir corpus harness (ADR 0011): the same load → analyze → score → gate
 * pipeline as the TS corpus, pointed at `fixtures/elixir` and driven by the
 * Elixir frontend.
 *
 * The Elixir frontend compiles the target project (`mix compile`), so scoring
 * the Elixir corpus needs a real Elixir toolchain — and the Phoenix fixtures
 * additionally need their hex dependencies fetched. Neither is available in the
 * TS-only CI job, so the Elixir gate test is **gated** on {@link isMixAvailable}
 * (skips wholesale when `mix` is absent) and skips any single fixture whose
 * dependencies are declared but not fetched ({@link isFixtureRunnable}). The
 * committed `fixtures/scoreboard.elixir.json` is regenerated locally
 * (`pnpm run scoreboard:elixir`), the multi-language counterpart to the TS
 * scoreboard.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Claim } from "../../core/claims/types.js";
import { analyzeElixirProject } from "../../frontends/elixir/index.js";
import type { Analyzer } from "./analyzer.js";
import { type LabelCase, loadLabelCases } from "./labels.js";

const FIXED_CLOCK = new Date(0);
const ELIXIR_ANALYZER_NAME = "elixir-reference-graph";

/** Absolute path to `fixtures/elixir`, resolved relative to this module (src or dist). */
export function elixirFixturesRoot(): string {
  return fileURLToPath(new URL("../../../../../fixtures/elixir", import.meta.url));
}

/** Absolute path to `fixtures/scoreboard.elixir.json`. */
export function elixirScoreboardPath(): string {
  return path.join(elixirFixturesRoot(), "..", "scoreboard.elixir.json");
}

/** The real Elixir reference-graph analyzer over one fixture mini-project. */
export const elixirAnalyzer: Analyzer = {
  name: ELIXIR_ANALYZER_NAME,
  async analyze(fixtureDir: string): Promise<Claim[]> {
    const run = await analyzeElixirProject(fixtureDir, { now: FIXED_CLOCK });
    return [...run.claims];
  },
};

/** `true` iff `mix` is runnable — the Elixir gate test skips entirely when it is not. */
export function isMixAvailable(): boolean {
  try {
    const result = spawnSync("mix", ["--version"], { encoding: "utf8", timeout: 60_000 });
    return result.status === 0;
  } catch {
    return false;
  }
}

/**
 * A fixture is runnable here iff its declared external dependencies are already
 * fetched. A fixture whose `mix.exs` declares hex deps (the Phoenix HEEx case)
 * cannot be compiled without a prior `mix deps.get`; when its `deps/` directory
 * is absent we skip it rather than fail the whole gate (deps fetching is a
 * network operation the gate must not perform).
 */
export function isFixtureRunnable(fixtureDir: string): boolean {
  if (!declaresExternalDeps(fixtureDir)) return true;
  return existsSync(path.join(fixtureDir, "deps"));
}

/** `true` iff the fixture's `mix.exs` declares a non-empty `deps` list. */
function declaresExternalDeps(fixtureDir: string): boolean {
  try {
    const mixExs = readFileSync(path.join(fixtureDir, "mix.exs"), "utf8");
    // A `defp deps, do: [ {:pkg, ...} ]` (or `deps: [...]`) with at least one
    // `{:atom` entry means the project needs `mix deps.get` before it compiles.
    return /deps.*\{\s*:[a-z]/s.test(mixExs);
  } catch {
    return false;
  }
}

/** Load every Elixir fixture case, tagged with whether it can run in this environment. */
export async function loadElixirCases(): Promise<
  Array<{ labelCase: LabelCase; runnable: boolean }>
> {
  const cases = await loadLabelCases(elixirFixturesRoot());
  return cases.map((labelCase) => ({
    labelCase,
    runnable: isFixtureRunnable(labelCase.dir),
  }));
}
