/**
 * File discovery for the TS/JS frontend (T2.1, phasing.md M2).
 *
 * Recursively walks a target directory for source files, returning **absolute
 * paths in deterministic (lexicographically sorted) order** so downstream
 * analysis and snapshots are reproducible.
 *
 * ## Scope (M2)
 *  - Extensions: `.ts .tsx .mts .cts .js .jsx .mjs .cjs`.
 *  - Excluded directories: `node_modules`, `dist`, and any hidden entry
 *    (name starting with `.`). Hidden files are likewise skipped.
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

const EXCLUDED_DIRS = new Set(["node_modules", "dist"]);

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
    // Hidden entries (dot-prefixed) — dirs and files — are skipped.
    if (entry.name.startsWith(".")) continue;
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
