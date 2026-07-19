#!/usr/bin/env node
/**
 * Packaging step (T9.1, docs/phasing.md M9): copies the hand-authored JSON
 * Schema files into a top-level `schemas/` directory so the published
 * npm tarball ships a stable, well-known location a consumer (or their
 * editor/CI) can point a validator at — `require("@ninthwave-io/unused/schemas/claim-run.schema.json")`
 * or a bare file read — without reaching into `dist/` internals or knowing
 * the source tree layout.
 *
 * The schemas themselves stay hand-authored under `src/**\/schema/` next to
 * the code they mirror (`core/claims/types.ts`'s docstring: "keep the two in
 * lockstep on any change"); this script is a pure copy, run by `build`
 * (`package.json`), never a second source of truth. `schemas/` is
 * gitignored (`.gitignore`) — it is a build artifact, exactly like `dist/`.
 */
import { copyFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/** [source relative to package root, destination filename under schemas/]. */
const SCHEMAS = [
  ["src/core/claims/schema/claim-run.schema.json", "claim-run.schema.json"],
  ["src/frontends/ts/schema/unused-config.schema.json", "unused-config.schema.json"],
  ["src/reporters/schema/sarif-2.1.0.schema.json", "sarif-2.1.0.schema.json"],
];

async function main() {
  const outDir = join(PACKAGE_ROOT, "schemas");
  await mkdir(outDir, { recursive: true });
  await Promise.all(
    SCHEMAS.map(([src, destName]) => copyFile(join(PACKAGE_ROOT, src), join(outDir, destName))),
  );
}

await main();
