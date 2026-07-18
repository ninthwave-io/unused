/**
 * Writes `docs/generated/assumption-set.md`, the committed, generated-from-code
 * assumption set (T3.3). Same pattern as `testing/corpus/scoreboard.ts`: the
 * pure renderer lives in core (`core/analysis/assumption-set.ts`), the file I/O
 * lives here in `testing/` so core stays side-effect-free.
 *
 * Regenerate with `pnpm run assumptions` from the repo root. Deterministic: the
 * rendered markdown is a pure function of the globals constant + the hazard
 * registry, so a run with no source change produces no diff. `assumption-set-doc.test.ts`
 * asserts exactly that (regenerating the committed file yields no change).
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { renderAssumptionSet } from "../core/analysis/assumption-set.js";

/**
 * Absolute path to `docs/generated/assumption-set.md`. Computed relative to this
 * module so it resolves the same whether run as TS source (Vitest) or compiled
 * JS (`pnpm run assumptions`, which builds to `packages/unused/dist` — the same
 * depth below the repo root as `src`). `.../packages/unused/src/testing/
 * assumption-set-doc.ts` → repo root is four directories up.
 */
export function assumptionSetDocPath(): string {
  return fileURLToPath(new URL("../../../../docs/generated/assumption-set.md", import.meta.url));
}

export async function writeAssumptionSetDoc(
  outPath: string = assumptionSetDocPath(),
): Promise<void> {
  await mkdir(path.dirname(outPath), { recursive: true });
  await writeFile(outPath, renderAssumptionSet(), "utf8");
}

async function main(): Promise<void> {
  const outPath = assumptionSetDocPath();
  await writeAssumptionSetDoc(outPath);
  console.log(`wrote ${outPath}`);
}

// Runs only when this module is the process entrypoint (`pnpm run assumptions`),
// never on import — importing it (e.g. from the sync test) must not write files.
const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
