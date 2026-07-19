/**
 * File discovery for the TS/JS frontend (T2.1, phasing.md M2).
 *
 * Recursively walks a target directory for source files, returning **absolute
 * paths in deterministic (lexicographically sorted) order** so downstream
 * analysis and snapshots are reproducible.
 *
 * ## Scope (M2)
 *  - Extensions: `.ts .tsx .mts .cts .js .jsx .mjs .cjs`.
 *  - Excluded directories: `node_modules`, `dist`, `cdk.out`, and any hidden
 *    entry (name starting with `.`). Hidden files are likewise skipped.
 *  - **`.storybook` exception** — the one hidden directory that IS descended.
 *    Storybook's config files there (`main.*`, `preview.*`, decorators, MSW
 *    handlers, store-reset helpers) import real application code that must stay
 *    alive, and `main.*` carries the `stories` glob the storybook preset reads;
 *    `analyze.ts` seeds those config files as reachability roots (never claimed).
 *  - **No config handling** — tsconfig `include`/`exclude`, workspace globs,
 *    and ignore files arrive in M4. This is the raw filesystem walk.
 *  - **Symlinks are not followed** — neither directory nor file symlinks.
 *    `Dirent.isDirectory()`/`isFile()` are false for symlinks, so a symlinked
 *    directory is never descended and a symlinked file is never collected.
 *    Revisit if real corpora need it; not following avoids cycles and
 *    escaping the target tree.
 */
import { readdir } from "node:fs/promises";
import { join } from "node:path";

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]);

// `cdk.out` is the AWS CDK synth output (generated CloudFormation JSON + a
// bundled copy of the app's JS) — a build artifact, never source, excluded like
// `dist`. The CDK preset (presets.ts) reads `cdk.json#app` directly to seed the
// real `bin/app.ts` entrypoint; nothing under `cdk.out` should be analyzed.
const EXCLUDED_DIRS = new Set(["node_modules", "dist", "cdk.out"]);

/** Return all source files under `rootDir`, absolute and lexicographically sorted. */
export async function discover(rootDir: string): Promise<string[]> {
  const results: string[] = [];
  await walk(rootDir, results);
  results.sort();
  return results;
}

async function walk(dir: string, results: string[]): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    // Hidden entries (dot-prefixed) — dirs and files — are skipped, EXCEPT the
    // `.storybook` config directory (see the module doc): its config files
    // reference real app code and carry the `stories` glob, so the tree is
    // descended and `analyze.ts` roots the config files.
    if (entry.name.startsWith(".") && entry.name !== ".storybook") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (EXCLUDED_DIRS.has(entry.name)) continue;
      await walk(full, results);
    } else if (entry.isFile()) {
      if (hasSourceExtension(entry.name)) results.push(full);
    }
    // Symlinks (isSymbolicLink()) fall through here and are intentionally
    // neither descended nor collected.
  }
}

function hasSourceExtension(name: string): boolean {
  const dot = name.lastIndexOf(".");
  if (dot < 0) return false;
  return SOURCE_EXTENSIONS.has(name.slice(dot).toLowerCase());
}
