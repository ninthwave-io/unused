/**
 * Monorepo workspace detection for the TS/JS frontend (T4.2, phasing.md M4).
 *
 * Auto-detects the four supported workspace managers at the analysis root and
 * returns the member package directories, so {@link analyzeProject} can give
 * each workspace package its own entrypoint set inside one shared reference
 * graph (cross-workspace imports resolve; PRD §6):
 *
 *  - **npm / yarn-classic** — a `workspaces` array (or `{ "packages": [...] }`
 *    object) in the root `package.json`. The two are indistinguishable by layout
 *    and behave identically here; the lockfile only refines the reported label.
 *  - **pnpm** — a `pnpm-workspace.yaml` with a `packages:` glob list. Takes
 *    precedence over a `workspaces` field if both are somehow present.
 *  - **bun** — a `workspaces` array in `package.json`, distinguished from npm
 *    only by a `bun.lock`/`bun.lockb` lockfile (label only; behaviour is shared).
 *
 * ## Yarn Plug'n'Play — refuse, never mis-analyze (PRD §6)
 * A `.pnp.cjs` / `.pnp.mjs` at the root means module resolution goes through
 * Yarn's PnP table, not a `node_modules` layout. Our resolver assumes
 * `node_modules`, so a PnP project would silently mis-resolve — and "a silent
 * wrong answer is worse than a refusal". Detection therefore throws a typed
 * {@link UnsupportedProjectError}; the CLI maps it to exit 2 with the message.
 *
 * ## No YAML dependency
 * pnpm-workspace.yaml is a fixed, simple shape (`packages:` → a block or flow
 * sequence of glob strings). We parse exactly that slice with a focused reader
 * rather than pull a YAML library into the shipped CLI (keeps the npx cold-start
 * budget and the dependency surface small). Anything we cannot parse degrades to
 * "no members" — which, combined with the whole-analysis entrypoint contract,
 * only costs recall, never precision.
 */

import type { Dirent } from "node:fs";
import { access, readdir, readFile } from "node:fs/promises";
import { dirname, join, relative, resolve as resolvePath, sep } from "node:path";
import type { PackageJsonLike } from "./emit.js";
import { globToRegExp } from "./glob.js";

/** The workspace managers auto-detected in v1 (PRD §6). */
export type WorkspaceManager = "npm" | "yarn" | "pnpm" | "bun";

/**
 * Thrown when the project uses a layout v1 deliberately refuses to analyze —
 * today only Yarn Plug'n'Play (PRD §6). The CLI surfaces the message and exits
 * 2 (analysis error) rather than emit a silently-wrong result.
 */
export class UnsupportedProjectError extends Error {
  /** Stable machine tag for callers that switch on the reason. */
  readonly code = "UNSUPPORTED_PROJECT";
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedProjectError";
  }
}

/** One discovered workspace member package. */
export interface WorkspaceMember {
  /** Absolute path to the member package directory. */
  readonly dir: string;
  /** POSIX, root-relative path of the member directory (e.g. `packages/app`). */
  readonly rootRelDir: string;
  /** The member's `package.json` `name`, or `null` when it declares none. */
  readonly name: string | null;
  /** The member's parsed `package.json` (entrypoint fields for emit). */
  readonly packageJson: PackageJsonLike;
}

/** The detected workspace layout at an analysis root. */
export interface WorkspaceLayout {
  /** The detected manager, or `null` for a single (non-workspace) package. */
  readonly manager: WorkspaceManager | null;
  /** Member packages (excludes the root package). Empty for single-package. */
  readonly members: readonly WorkspaceMember[];
  /**
   * Root-relative directories that matched a positive workspace glob but were
   * removed by a negative one (e.g. `packages/legacy` under `!packages/legacy`).
   * These are **excluded members**: they get no entrypoints yet their sources are
   * still on disk, so analysis must treat their whole subtree as out of scope —
   * otherwise their (externally-built) files would be confidently flagged unused.
   * The caller drops these subtrees from the analyzable set.
   */
  readonly excludedDirs: readonly string[];
}

/** `package.json` fields workspace detection reads (beyond the emit entrypoint fields). */
interface RootPackageJson extends PackageJsonLike {
  name?: unknown;
  workspaces?: unknown;
}

const PNP_FILES = [".pnp.cjs", ".pnp.mjs"] as const;
const IGNORED_WALK_DIRS = new Set(["node_modules", "dist", ".git"]);
/** Bound the package.json search depth — deeply-nested `**` members are rare and this caps cost. */
const MAX_MEMBER_DEPTH = 8;

/**
 * Detect the workspace layout at `root`. Throws {@link UnsupportedProjectError}
 * for a Yarn PnP project. Returns `{ manager: null, members: [] }` for a plain
 * single-package project (so callers can treat single-package as the degenerate
 * zero-member case).
 */
export async function detectWorkspaces(root: string): Promise<WorkspaceLayout> {
  const absRoot = resolvePath(root);

  // PnP refusal comes first: a PnP project must never reach glob detection.
  await assertNotPnP(absRoot);

  const rootPkg = await readPackageJsonAt(absRoot);

  // pnpm-workspace.yaml wins when present (pnpm's authoritative source).
  const pnpmGlobs = await readPnpmWorkspaceGlobs(absRoot);
  if (pnpmGlobs !== null) {
    return { manager: "pnpm", ...(await resolveMembers(absRoot, pnpmGlobs)) };
  }

  // npm / yarn-classic / bun: a `workspaces` field in package.json.
  const globs = workspaceGlobsOf(rootPkg?.workspaces);
  if (globs !== null && globs.length > 0) {
    return {
      manager: await labelPackageJsonManager(absRoot),
      ...(await resolveMembers(absRoot, globs)),
    };
  }

  return { manager: null, members: [], excludedDirs: [] };
}

/**
 * Throw {@link UnsupportedProjectError} when a Yarn PnP install is detected at
 * `root` **or any ancestor up to the repository boundary**. Walking up matters
 * because the analysis root is often a member deep inside a PnP monorepo whose
 * `.pnp.cjs` lives at the repo root — resolving that member without the PnP table
 * would be silently wrong. The walk stops at the first directory containing a
 * `.git` marker (the repo boundary) or the filesystem root, so it never inspects
 * unrelated ancestors (e.g. a stray `.pnp.cjs` in a parent outside the project).
 */
async function assertNotPnP(root: string): Promise<void> {
  let dir = root;
  for (;;) {
    for (const name of PNP_FILES) {
      if (await pathExists(join(dir, name))) {
        throw new UnsupportedProjectError(
          `Yarn Plug'n'Play is unsupported in v1. unused found ${name} at ${dir}. ` +
            "PnP resolves modules through its own table instead of node_modules, which unused's " +
            "resolver does not model — analysis is refused rather than risk a silently-wrong answer. " +
            "See docs/prd.md §6. Workaround: use nodeLinker: node-modules (a .yarnrc.yml setting).",
        );
      }
    }
    // Stop at the repo boundary (a `.git` dir/file) — never walk above the project.
    if (await pathExists(join(dir, ".git"))) return;
    const parent = dirname(dir);
    if (parent === dir) return; // filesystem root
    dir = parent;
  }
}

/**
 * Distinguish npm / yarn-classic / bun by lockfile (label only — the three share
 * the same `workspaces`-array layout and identical analysis). Default `npm`.
 */
async function labelPackageJsonManager(root: string): Promise<WorkspaceManager> {
  if ((await pathExists(join(root, "bun.lock"))) || (await pathExists(join(root, "bun.lockb")))) {
    return "bun";
  }
  if (await pathExists(join(root, "yarn.lock"))) return "yarn";
  return "npm";
}

// ---------------------------------------------------------------------------
// Member resolution (glob expansion → package dirs)
// ---------------------------------------------------------------------------

/**
 * Expand workspace globs against the filesystem into member packages. Every
 * candidate directory must contain a `package.json`. A positively-matched dir
 * removed by a negative pattern (`!glob`) becomes an **excluded member** — its
 * subtree is reported in `excludedDirs` so the caller keeps it out of scope.
 * Results are deterministic (root-relative-sorted) and de-duplicated.
 */
async function resolveMembers(
  root: string,
  patterns: readonly string[],
): Promise<{ members: WorkspaceMember[]; excludedDirs: string[] }> {
  const positives: RegExp[] = [];
  const negatives: RegExp[] = [];
  for (const raw of patterns) {
    const pattern = raw.trim();
    if (pattern === "") continue;
    if (pattern.startsWith("!")) negatives.push(globToRegExp(pattern.slice(1)));
    else positives.push(globToRegExp(pattern));
  }
  if (positives.length === 0) return { members: [], excludedDirs: [] };

  const packageDirs = await findPackageDirs(root);
  const members: WorkspaceMember[] = [];
  const excludedDirs: string[] = [];
  const seen = new Set<string>();
  for (const rel of packageDirs) {
    if (!positives.some((re) => re.test(rel))) continue;
    if (seen.has(rel)) continue;
    seen.add(rel);
    // A positively-matched member removed by a negative glob: excluded, out of scope.
    if (negatives.some((re) => re.test(rel))) {
      excludedDirs.push(rel);
      continue;
    }
    const dir = join(root, rel);
    const pkg = await readPackageJsonAt(dir);
    if (pkg === null) continue; // a matched dir without a readable package.json is not a member
    members.push({ dir, rootRelDir: rel, name: nameOf(pkg), packageJson: pkg });
  }
  members.sort((a, b) => (a.rootRelDir < b.rootRelDir ? -1 : a.rootRelDir > b.rootRelDir ? 1 : 0));
  excludedDirs.sort();
  return { members, excludedDirs };
}

/**
 * Root-relative POSIX paths of every directory under `root` (excluding `root`
 * itself, `node_modules`, `dist`, hidden dirs) that contains a `package.json`.
 * Bounded to {@link MAX_MEMBER_DEPTH}. This is the candidate set glob patterns
 * are matched against.
 */
async function findPackageDirs(root: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > MAX_MEMBER_DEPTH) return;
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith(".") || IGNORED_WALK_DIRS.has(entry.name)) continue;
      const full = join(dir, entry.name);
      if (await pathExists(join(full, "package.json"))) out.push(toPosixRel(root, full));
      await walk(full, depth + 1);
    }
  };
  await walk(root, 1);
  return out;
}

// ---------------------------------------------------------------------------
// package.json + pnpm-workspace.yaml reading
// ---------------------------------------------------------------------------

/** Normalize the `workspaces` field (array form, or `{ packages: [...] }`) to a glob list. */
function workspaceGlobsOf(workspaces: unknown): string[] | null {
  if (Array.isArray(workspaces))
    return workspaces.filter((g): g is string => typeof g === "string");
  if (workspaces !== null && typeof workspaces === "object") {
    const packages = (workspaces as { packages?: unknown }).packages;
    if (Array.isArray(packages)) return packages.filter((g): g is string => typeof g === "string");
  }
  return null;
}

/**
 * Parse the `packages:` glob list out of `<root>/pnpm-workspace.yaml`, or `null`
 * when the file is absent. Handles the two shapes pnpm emits: a block sequence
 *
 *     packages:
 *       - 'packages/*'
 *       - "apps/**"
 *
 * and a flow sequence (`packages: ['a', 'b']`). Comments and blank lines are
 * ignored. A present-but-unparseable file yields an empty list (→ no members).
 */
async function readPnpmWorkspaceGlobs(root: string): Promise<string[] | null> {
  let raw: string;
  try {
    raw = await readFile(join(root, "pnpm-workspace.yaml"), "utf8");
  } catch {
    // pnpm also accepts the `.yml` extension.
    try {
      raw = await readFile(join(root, "pnpm-workspace.yml"), "utf8");
    } catch {
      return null;
    }
  }
  return parsePnpmPackages(raw);
}

/** Extract the `packages:` sequence from pnpm-workspace.yaml source (see caller). */
export function parsePnpmPackages(source: string): string[] {
  const lines = source.split(/\r?\n/);
  const out: string[] = [];
  let inBlock = false;
  let keyIndent = -1;

  for (const line of lines) {
    const noComment = stripYamlComment(line);
    if (noComment.trim() === "") continue;
    const indent = noComment.length - noComment.trimStart().length;
    const trimmed = noComment.trim();

    if (!inBlock) {
      const match = /^packages\s*:(.*)$/.exec(trimmed);
      if (match === undefined || match === null) continue;
      const rest = (match[1] ?? "").trim();
      if (rest.startsWith("[")) {
        // Flow sequence on the same line: packages: ['a', 'b']
        for (const item of parseFlowSequence(rest)) out.push(item);
        return out;
      }
      inBlock = true;
      keyIndent = indent;
      continue;
    }

    // Inside the block sequence: items are `- glob`, indented past the key.
    if (indent <= keyIndent && !trimmed.startsWith("-")) break; // a sibling key ends the block
    const item = /^-\s*(.*)$/.exec(trimmed);
    if (item !== null && item[1] !== undefined) {
      const value = stripQuotes(item[1].trim());
      if (value !== "") out.push(value);
    }
  }
  return out;
}

/** Strip a `#` comment not inside a quoted string (best-effort, line-local). */
function stripYamlComment(line: string): string {
  let quote: string | null = null;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quote !== null) {
      if (ch === quote) quote = null;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
    } else if (ch === "#") {
      return line.slice(0, i);
    }
  }
  return line;
}

/** Parse a single-line YAML flow sequence `['a', "b", c]` into its string items. */
function parseFlowSequence(text: string): string[] {
  const inner = text.replace(/^\[/, "").replace(/\].*$/, "");
  return inner
    .split(",")
    .map((s) => stripQuotes(s.trim()))
    .filter((s) => s !== "");
}

function stripQuotes(value: string): string {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === "'" && last === "'") || (first === '"' && last === '"')) {
      return value.slice(1, -1);
    }
  }
  return value;
}

async function readPackageJsonAt(dir: string): Promise<RootPackageJson | null> {
  try {
    const parsed = JSON.parse(await readFile(join(dir, "package.json"), "utf8")) as unknown;
    return parsed !== null && typeof parsed === "object" ? (parsed as RootPackageJson) : null;
  } catch {
    return null;
  }
}

function nameOf(pkg: RootPackageJson): string | null {
  return typeof pkg.name === "string" && pkg.name !== "" ? pkg.name : null;
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/** Absolute path → POSIX, root-relative. */
function toPosixRel(root: string, abs: string): string {
  return relative(root, abs).split(sep).join("/");
}
