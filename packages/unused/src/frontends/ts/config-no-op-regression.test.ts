/**
 * T4.3 acceptance: "no-config regression: zero-config output identical
 * pre/post this milestone" (phasing.md M4).
 *
 * `__testfixtures__/config-regression/golden-*.json` were captured by running
 * `analyzeProject` on these exact corpus fixtures BEFORE any T4.3/T4.4 code
 * (config loading, `ignore`/`project`/`entry` scoping, preset auto-detection)
 * existed — i.e. the actual pre-milestone output, not a re-derived
 * expectation. This test re-runs the POST-milestone `analyzeProject` (which
 * now always calls `loadConfig`/`filterFilesByConfig`/`activePresetsForUnit`
 * — the config layer is unconditionally "in the code path", per the spec)
 * over the same two fixtures, with no config file present in either, and
 * asserts the result is byte-for-byte identical (`run.durationMs` and
 * `run.root` excluded — durationMs is wall-clock and root is an absolute,
 * machine-dependent path; every other field, including `configHash`, must
 * match exactly).
 *
 * Two fixtures, per the spec's "≥2 corpus fixtures": `tsconfig-paths-alias`
 * (single package, alias resolution) and `workspace-pnpm-monorepo` (a real
 * monorepo — exercises the T4.2 workspace-unit path the config layer's
 * per-unit filtering/entry-seeding/preset-detection all thread through).
 * Neither fixture declares a `vite`/`next` dependency or ships a
 * `vite.config.*`/`next.config.*`/`index.html` — confirmed by inspection — so
 * T4.4 preset auto-activation is also exercised as a true no-op here, not
 * just T4.3's config loading.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { analyzeProject } from "./analyze.js";

const repoRoot = fileURLToPath(new URL("../../../../../", import.meta.url));
const corpus = (c: string): string => join(repoRoot, "fixtures/ts", c);
const golden = (name: string): unknown =>
  JSON.parse(
    readFileSync(
      fileURLToPath(
        new URL(`./__testfixtures__/config-regression/golden-${name}.json`, import.meta.url),
      ),
      "utf8",
    ),
  );
const FIXED_CLOCK = new Date(0);

const CASES = ["tsconfig-paths-alias", "workspace-pnpm-monorepo"] as const;

describe("analyzeProject — no-config regression (T4.3 acceptance)", () => {
  for (const caseName of CASES) {
    it(`${caseName}: byte-identical to the pre-T4.3/T4.4 captured output`, async () => {
      const run = await analyzeProject(corpus(caseName), { now: FIXED_CLOCK });
      const { durationMs: _durationMs, root: _root, ...rest } = run.run;
      const normalized = { ...run, run: rest };
      expect(normalized).toEqual(golden(caseName));
    });
  }
});
