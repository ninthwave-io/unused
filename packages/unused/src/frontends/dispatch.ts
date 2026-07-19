/**
 * Language dispatch for the CLI (ADR 0003/0011): pick the frontend(s) for a
 * project from its manifests and merge their claims into one {@link
 * AnalyzeResult}.
 *
 *  - `package.json` present, no `mix.exs`  ⇒ the TypeScript frontend.
 *  - `mix.exs` present, no `package.json`  ⇒ the Elixir frontend.
 *  - both present                          ⇒ run both, concatenate claims,
 *    recompute the summary over the union. The TS result is the base for the
 *    out-of-band header/baseline fields (`units`, `gateThreshold`, `repoName`);
 *    Elixir claims fall under the root unit for baseline purposes (mixed-language
 *    per-unit baselines are post-v1).
 *  - neither                               ⇒ the TS frontend (which reports "no
 *    entrypoints"), preserving today's behaviour.
 *
 * Living in `frontends/` keeps it on the correct side of the boundary rules
 * (a frontend may compose frontends; only cli/reporters/mcp are off-limits).
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { computeSummary } from "../core/claims/index.js";
import { analyzeElixirProject } from "./elixir/index.js";
import { type AnalyzeOptions, type AnalyzeResult, analyzeProject } from "./ts/analyze.js";

/**
 * Analyze `rootDir`, auto-selecting the language frontend(s). Elixir refusals
 * (`ElixirFrontendError`) propagate to the CLI, which maps them to exit 2 with a
 * clear message. A TS-and-Elixir repo where Elixir refuses is a hard error (we
 * do not silently drop half the analysis).
 */
export async function analyzeProjectAuto(
  rootDir: string,
  options: AnalyzeOptions = {},
): Promise<AnalyzeResult> {
  const hasPackageJson = existsSync(join(rootDir, "package.json"));
  const hasMixExs = existsSync(join(rootDir, "mix.exs"));

  if (hasMixExs && !hasPackageJson) {
    return analyzeElixirProject(rootDir, options);
  }
  if (!hasMixExs) {
    return analyzeProject(rootDir, options);
  }

  // Both manifests present: run both, merge.
  const [ts, elixir] = await Promise.all([
    analyzeProject(rootDir, options),
    analyzeElixirProject(rootDir, options),
  ]);
  const claims = [...ts.claims, ...elixir.claims].sort((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );
  return {
    ...ts,
    claims,
    summary: computeSummary(claims, {}),
    productionEntrypointCount: ts.productionEntrypointCount + elixir.productionEntrypointCount,
    fileCount: ts.fileCount + elixir.fileCount,
  };
}
