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
 *  - Nested `.gitignore` rules and negations apply by default; callers can
 *    disable them explicitly. tsconfig/workspace scoping remains downstream.
 *  - **Symlinks are not followed** — neither directory nor file symlinks.
 *    `Dirent.isDirectory()`/`isFile()` are false for symlinks, so a symlinked
 *    directory is never descended and a symlinked file is never collected.
 *    Revisit if real corpora need it; not following avoids cycles and
 *    escaping the target tree.
 */
import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import ignore, { type Ignore } from "ignore";

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]);

// `cdk.out` is the AWS CDK synth output (generated CloudFormation JSON + a
// bundled copy of the app's JS) — a build artifact, never source, excluded like
// `dist`. The CDK preset (presets.ts) reads `cdk.json#app` directly to seed the
// real `bin/app.ts` entrypoint; nothing under `cdk.out` should be analyzed.
const EXCLUDED_DIRS = new Set(["node_modules", "dist", "cdk.out"]);

export interface DiscoverOptions {
  /** Respect every applicable nested `.gitignore` by default. */
  readonly gitignore?: boolean;
}

interface IgnoreContext {
  readonly dir: string;
  readonly matcher: Ignore;
}

/** Return all source files under `rootDir`, absolute and lexicographically sorted. */
export async function discover(rootDir: string, options: DiscoverOptions = {}): Promise<string[]> {
  const results: string[] = [];
  const useGitignore = options.gitignore !== false;
  const inherited = useGitignore ? await ancestorIgnoreContexts(rootDir) : [];
  await walk(rootDir, results, inherited, useGitignore);
  results.sort();
  return results;
}

/**
 * `.gitignore` files above an analysis root still apply when `unused --cwd`
 * points at a repository subdirectory. Load them outermost-first, stopping at
 * the enclosing Git boundary; the root's own file is loaded by {@link walk}.
 */
async function ancestorIgnoreContexts(rootDir: string): Promise<IgnoreContext[]> {
  const root = resolve(rootDir);
  const repositoryRoot = await enclosingGitRoot(root);
  if (repositoryRoot === null || repositoryRoot === root) return [];

  const directories: string[] = [];
  let current = dirname(root);
  while (current === repositoryRoot || current.startsWith(`${repositoryRoot}${sep}`)) {
    directories.push(current);
    if (current === repositoryRoot) break;
    current = dirname(current);
  }
  directories.reverse();

  const contexts: IgnoreContext[] = [];
  for (const dir of directories) {
    const path = join(dir, ".gitignore");
    try {
      const info = await stat(path);
      if (!info.isFile()) continue;
      contexts.push({ dir, matcher: ignore().add(await readFile(path, "utf8")) });
    } catch {
      // No applicable ignore file at this ancestor.
    }
  }
  return contexts;
}

/** Absolute ancestor `.gitignore` paths applicable at `rootDir`, including its own. */
export async function ancestorGitignoreFiles(rootDir: string): Promise<string[]> {
  const root = resolve(rootDir);
  const repositoryRoot = await enclosingGitRoot(root);
  if (repositoryRoot === null) return [];
  const directories: string[] = [];
  let current = root;
  while (current === repositoryRoot || current.startsWith(`${repositoryRoot}${sep}`)) {
    directories.push(current);
    if (current === repositoryRoot) break;
    current = dirname(current);
  }
  directories.reverse();
  const files: string[] = [];
  for (const dir of directories) {
    const path = join(dir, ".gitignore");
    try {
      if ((await stat(path)).isFile()) files.push(path);
    } catch {
      // Missing is the common case.
    }
  }
  return files;
}

/**
 * Filter an arbitrary set of root-relative paths through the same applicable
 * ignore stack as source discovery. This lets compiler-driven frontends remain
 * conservative (their graph may retain ignored nodes as reference evidence)
 * while ensuring ignored files are never claimable.
 */
export async function filterGitignoredRelativePaths(
  rootDir: string,
  files: readonly string[],
): Promise<string[]> {
  const root = resolve(rootDir);
  const inherited = await ancestorIgnoreContexts(root);
  const contextCache = new Map<string, IgnoreContext | null>();
  const contextAt = async (dir: string): Promise<IgnoreContext | null> => {
    const cached = contextCache.get(dir);
    if (cached !== undefined) return cached;
    const path = join(dir, ".gitignore");
    try {
      if (!(await stat(path)).isFile()) {
        contextCache.set(dir, null);
        return null;
      }
      const context = { dir, matcher: ignore().add(await readFile(path, "utf8")) };
      contextCache.set(dir, context);
      return context;
    } catch {
      contextCache.set(dir, null);
      return null;
    }
  };

  const visible: string[] = [];
  for (const file of files) {
    const parts = file.split("/").filter((part) => part !== "");
    if (parts.length === 0 || parts.some((part) => part === "..")) continue;
    const contexts = [...inherited];
    const rootContext = await contextAt(root);
    if (rootContext !== null) contexts.push(rootContext);
    let current = root;
    let ignored = false;
    for (const part of parts.slice(0, -1)) {
      current = join(current, part);
      if (isGitIgnored(current, true, contexts)) {
        ignored = true;
        break;
      }
      const nested = await contextAt(current);
      if (nested !== null) contexts.push(nested);
    }
    if (!ignored && !isGitIgnored(join(root, ...parts), false, contexts)) visible.push(file);
  }
  return visible;
}

async function enclosingGitRoot(start: string): Promise<string | null> {
  let current = start;
  while (true) {
    try {
      await stat(join(current, ".git"));
      return current;
    } catch {
      const parent = dirname(current);
      if (parent === current) return null;
      current = parent;
    }
  }
}

async function walk(
  dir: string,
  results: string[],
  inherited: readonly IgnoreContext[],
  useGitignore: boolean,
): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  const contexts = [...inherited];
  const gitignore = entries.find((entry) => entry.name === ".gitignore" && entry.isFile());
  if (useGitignore && gitignore !== undefined) {
    contexts.push({
      dir,
      matcher: ignore().add(await readFile(join(dir, gitignore.name), "utf8")),
    });
  }
  for (const entry of entries) {
    // Hidden entries (dot-prefixed) — dirs and files — are skipped, EXCEPT the
    // `.storybook` config directory (see the module doc): its config files
    // reference real app code and carry the `stories` glob, so the tree is
    // descended and `analyze.ts` roots the config files.
    if (entry.name.startsWith(".") && entry.name !== ".storybook") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (EXCLUDED_DIRS.has(entry.name)) continue;
      if (useGitignore && isGitIgnored(full, true, contexts)) continue;
      await walk(full, results, contexts, useGitignore);
    } else if (entry.isFile()) {
      if (
        hasSourceExtension(entry.name) &&
        (!useGitignore || !isGitIgnored(full, false, contexts))
      ) {
        results.push(full);
      }
    }
    // Symlinks (isSymbolicLink()) fall through here and are intentionally
    // neither descended nor collected.
  }
}

/**
 * Apply ancestor `.gitignore` files from outermost to innermost. A nested
 * matcher can negate an ancestor rule, but only for paths below the directory
 * containing that nested `.gitignore`, matching Git's precedence model.
 */
function isGitIgnored(
  absolutePath: string,
  directory: boolean,
  contexts: readonly IgnoreContext[],
): boolean {
  let ignored = false;
  for (const context of contexts) {
    const local = relative(context.dir, absolutePath).split(sep).join("/");
    if (local === "" || local.startsWith("../")) continue;
    const result = context.matcher.test(directory ? `${local}/` : local);
    if (result.ignored) ignored = true;
    else if (result.unignored) ignored = false;
  }
  return ignored;
}

function hasSourceExtension(name: string): boolean {
  const dot = name.lastIndexOf(".");
  if (dot < 0) return false;
  return SOURCE_EXTENSIONS.has(name.slice(dot).toLowerCase());
}
