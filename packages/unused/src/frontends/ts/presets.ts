/**
 * Framework presets (T4.4, phasing.md M4, PRD §6, architecture.md §6). A
 * preset contributes entrypoint conventions ON TOP OF zero-config
 * auto-detection — it never replaces or narrows it. v1 ships `vite` and
 * `next` (PRD §6: "v1 ships one or two").
 *
 * ## Interface (spec T4.4)
 * `{ name, entryPatterns, hazardRules? }` — `entryPatterns` are package-
 * relative globs (compiled with the shared `glob.ts`, so the PRD §6 brace
 * syntax works here too) matched against the analyzed file set; a match
 * becomes an ADDITIONAL production entrypoint. `hazardRules` is reserved for
 * a future preset that needs to contribute its own hazard class instead of
 * (or in addition to) entrypoint seeding — v1's two presets need only entry
 * conventions, so it is always empty here.
 *
 * Making a file a production entrypoint is already sufficient to satisfy
 * "kept alive, never claimable" for a whole file (`core/analysis/claims.ts`
 * never claims an entrypoint file) AND every export it declares (T2.4's
 * reachability walk marks an entrypoint's own file "surface-live", which
 * marks every export it declares reachable via the file's own `exports`
 * edges — see `reachability.ts`'s `markSurfaceLive`/`processFile`). So a
 * Next.js API route handler (`export function GET() {}`) needs no separate
 * "endpoint reservation" mechanism beyond being seeded as a normal production
 * entrypoint; PRD's "kept-alive, never claimable" endpoint-reservation note
 * falls out of the existing entrypoint contract for free.
 *
 * ## Auto-activation vs config-forced (spec T4.4 item 1)
 * A preset auto-activates PER PACKAGE UNIT (a monorepo member using vite does
 * not drag vite conventions onto a sibling that doesn't) when its marker
 * config file or dependency is present — {@link detectPreset}. `unused.config
 * .jsonc`'s `presets` field, when present (even `[]`), FORCES exactly that
 * set for EVERY unit, overriding auto-detection entirely (documented
 * decision: the spec did not define per-workspace preset overrides, so a
 * forced preset list is root-level and uniform — narrower than per-unit
 * auto-detection, but simple, testable, and consistent with `entry`/`ignore`/
 * `project`'s root-vs-override split existing only for those three fields).
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, join, posix, relative, resolve as resolvePath, sep } from "node:path";
import type { PresetName, UnusedConfig } from "./config.js";
import { globToRegExp } from "./glob.js";

// ---------------------------------------------------------------------------
// Preset definitions
// ---------------------------------------------------------------------------

export interface Preset {
  readonly name: PresetName;
  /** Package-relative glob patterns; a match is seeded as a production entrypoint. */
  readonly entryPatterns: readonly string[];
  /** Reserved (spec T4.4 interface shape); no v1 preset needs a dedicated hazard rule. */
  readonly hazardRules: readonly never[];
  /** Config-file basenames whose presence at a package root marks the preset active. */
  readonly markerConfigFiles: readonly string[];
  /** Dependency name whose presence in `dependencies`/`devDependencies` marks the preset active. */
  readonly markerDependency: string;
  /**
   * Additional dependency-name PREFIXES any one of which, matched against a
   * declared dependency, marks the preset active — Storybook publishes its
   * pieces as `@storybook/*` (react-vite, addon-*, …) and a repo may declare any
   * of them without the bare `storybook` meta-package. Optional; empty for
   * single-package-name presets.
   */
  readonly markerDependencyPrefixes?: readonly string[];
  /**
   * A directory whose presence at the package root marks the preset active —
   * Storybook's `.storybook` config directory is the canonical marker (a repo
   * using Storybook always has it, even if the dependency form varies). Optional.
   */
  readonly markerDir?: string;
}

/** Route-tree convention files (App Router) — Next always invokes these by filename, never an import edge. */
const APP_ROUTER_CONVENTION_FILES = [
  "page",
  "layout",
  "loading",
  "error",
  "global-error",
  "not-found",
  "route",
  "template",
  "default",
] as const;

/**
 * File-based metadata conventions (App Router — reviewer fix, false-positive
 * finding). Next generates a route's metadata — the sitemap, robots.txt, the
 * web manifest, Open Graph / Twitter share images, and favicons — from these
 * files with no import edge either, exactly like the route-tree files above.
 * Each also has one or more STATIC forms (`icon.png`, `robots.txt`,
 * `manifest.json`, `sitemap.xml`, ...) that `discover.ts` never collects in
 * the first place (not a source extension) — only the dynamic "generator"
 * form (`.ts`/`.js`/`.tsx`, used for `ImageResponse`-returning generators)
 * needs a pattern here, so this reuses {@link NEXT_SOURCE_EXTENSIONS} like
 * every other convention file (over-triggering only costs recall, never
 * precision — the established direction throughout this preset).
 *
 * Fooling input this closes: `app/sitemap.ts` / `app/robots.ts` were
 * previously unmatched by {@link APP_ROUTER_CONVENTION_FILES} and so were
 * confidently flagged `unused`/`high` — a genuine false positive on code
 * Next always invokes.
 */
const APP_METADATA_CONVENTION_FILES = [
  "sitemap",
  "robots",
  "manifest",
  "opengraph-image",
  "twitter-image",
  "icon",
  "apple-icon",
] as const;

const APP_CONVENTION_FILES = [
  ...APP_ROUTER_CONVENTION_FILES,
  ...APP_METADATA_CONVENTION_FILES,
] as const;

const NEXT_SOURCE_EXTENSIONS = ["js", "jsx", "ts", "tsx"] as const;

/** `<prefix>/**\/{page,layout,...,sitemap,robots,...}.{js,jsx,ts,tsx}` for one `app`-router root (`app` or `src/app`). */
function appRouterPatterns(prefix: string): string[] {
  return APP_CONVENTION_FILES.flatMap((name) =>
    NEXT_SOURCE_EXTENSIONS.map((ext) => `${prefix}/**/${name}.${ext}`),
  );
}

const NEXT_ENTRY_PATTERNS: readonly string[] = [
  // Pages Router (incl. pages/api/** — an API route is just another page-tree
  // file here; being a production entrypoint already reserves it, see above).
  "pages/**/*.{js,jsx,ts,tsx}",
  "src/pages/**/*.{js,jsx,ts,tsx}",
  // App Router convention files only — NOT every file under app/**, so an
  // ordinary component placed alongside a route stays claimable (the T4.4
  // fixture's "orphan component dead/high" requirement).
  ...appRouterPatterns("app"),
  ...appRouterPatterns("src/app"),
  // Middleware / instrumentation (spec T4.4 item 3).
  "middleware.{js,ts}",
  "src/middleware.{js,ts}",
  "instrumentation.{js,ts}",
  "src/instrumentation.{js,ts}",
];

export const VITE_PRESET: Preset = {
  name: "vite",
  // vite.config.* is ALREADY a config root via analyze.ts's generic
  // `*.config.{js,ts,mjs,cjs,mts,cts}` recognition (T3.6) — no glob needed
  // here for that half of spec T4.4 item 2. The other half (index.html as an
  // entrypoint carrier) needs bespoke handling (index.html is not a source
  // file `discover.ts` collects) — see `viteHtmlEntrypoints` below.
  entryPatterns: [],
  hazardRules: [],
  markerConfigFiles: [
    "vite.config.js",
    "vite.config.ts",
    "vite.config.mjs",
    "vite.config.cjs",
    "vite.config.mts",
    "vite.config.cts",
  ],
  markerDependency: "vite",
};

export const NEXT_PRESET: Preset = {
  name: "next",
  entryPatterns: NEXT_ENTRY_PATTERNS,
  hazardRules: [],
  markerConfigFiles: ["next.config.js", "next.config.ts", "next.config.mjs", "next.config.cjs"],
  markerDependency: "next",
};

/**
 * Storybook (reference-codebase real-customer smoke, FP class 1 — the single largest
 * false-positive class found: 89/163 file claims were auto-discovered
 * `.stories.*` files). Storybook renders every file matched by the `stories`
 * glob(s) in `.storybook/main.{ts,js,cjs,mjs}` — those files are NEVER
 * statically imported by application code, by design, so a pure reference graph
 * flags every one of them dead. The preset reads that glob list and seeds each
 * matched file as a production entrypoint (its whole export surface + imports
 * kept alive), exactly as knip's built-in `storybook` plugin does.
 *
 * `entryPatterns` is empty: the story globs are not a fixed package-relative
 * pattern set but are READ from `.storybook/main.*` per project (see
 * {@link storybookStoryEntrypoints}), the same bespoke-carrier shape vite's
 * `index.html` uses. Activation: a `.storybook` directory at the package root
 * (the canonical marker), the bare `storybook` dependency, or any `@storybook/*`
 * package.
 */
export const STORYBOOK_PRESET: Preset = {
  name: "storybook",
  entryPatterns: [],
  hazardRules: [],
  markerConfigFiles: [],
  markerDependency: "storybook",
  markerDependencyPrefixes: ["@storybook/"],
  markerDir: ".storybook",
};

/**
 * AWS CDK (reference-codebase real-customer smoke, FP class 2). A CDK app declares its
 * deployable entrypoint in `cdk.json`'s `app` field — a shell command string
 * (`"npx tsx bin/app.ts"`), NOT `package.json`'s `main`/`bin` — and that
 * entry file instantiates the real infrastructure stacks (live code). Without
 * this convention the entry file is claimed dead, which cascades every stack it
 * imports to `test-only` and every stack test to a false zombie. The preset
 * parses `cdk.json#app` (see {@link cdkAppEntrypoints}) AND seeds every script
 * under the `bin/` directory — the CDK convention for app entry scripts, where a
 * multi-app repo keeps additional entries (`bin/github-oidc.ts`) that `cdk deploy
 * --app "tsx bin/github-oidc.ts"` invokes from a task runner the analyzer does
 * not parse; over-seeding a `bin/` helper only costs recall, never precision, and
 * only in a package already identified as a CDK app. Activation: a `cdk.json` at
 * the package root, or the `aws-cdk-lib` dependency.
 */
export const CDK_PRESET: Preset = {
  name: "cdk",
  entryPatterns: ["bin/**/*.{js,jsx,ts,tsx,mjs,cjs,mts,cts}"],
  hazardRules: [],
  markerConfigFiles: ["cdk.json"],
  markerDependency: "aws-cdk-lib",
};

export const ALL_PRESETS: readonly Preset[] = [
  VITE_PRESET,
  NEXT_PRESET,
  STORYBOOK_PRESET,
  CDK_PRESET,
];

function presetByName(name: PresetName): Preset {
  const preset = ALL_PRESETS.find((p) => p.name === name);
  if (preset === undefined) throw new Error(`unknown preset: ${name}`); // unreachable — PresetName is closed
  return preset;
}

// ---------------------------------------------------------------------------
// Auto-activation (spec T4.4 item 1)
// ---------------------------------------------------------------------------

/**
 * Does `unitDir` look like it uses `preset`'s framework — a marker config file,
 * a marker directory (`.storybook`), or a declared dependency (its exact name or
 * one of its `markerDependencyPrefixes`)?
 */
export async function detectPreset(preset: Preset, unitDir: string): Promise<boolean> {
  for (const name of preset.markerConfigFiles) {
    if (await isFile(join(unitDir, name))) return true;
  }
  if (preset.markerDir !== undefined && (await isDirectory(join(unitDir, preset.markerDir)))) {
    return true;
  }
  return hasDeclaredDependency(unitDir, preset.markerDependency, preset.markerDependencyPrefixes);
}

/**
 * The active preset set for one package unit: `config.presets` — when
 * present, even `[]` — FORCES exactly that set for every unit (no
 * auto-detection); otherwise each of {@link ALL_PRESETS} is auto-activated
 * independently via {@link detectPreset}. With `EMPTY_CONFIG` (`presets`
 * `undefined`) this is pure auto-detection — the T4.3/T4.4 no-config
 * regression contract: a project with no vite/next marker activates nothing.
 */
export async function activePresetsForUnit(
  config: UnusedConfig,
  unitDir: string,
): Promise<readonly Preset[]> {
  if (config.presets !== undefined) return config.presets.map(presetByName);
  const hits = await Promise.all(ALL_PRESETS.map((p) => detectPreset(p, unitDir)));
  return ALL_PRESETS.filter((_, i) => hits[i] === true);
}

async function hasDeclaredDependency(
  unitDir: string,
  name: string,
  prefixes: readonly string[] = [],
): Promise<boolean> {
  let raw: string;
  try {
    raw = await readFile(join(unitDir, "package.json"), "utf8");
  } catch {
    return false;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return false;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return false;
  const pkg = parsed as { dependencies?: unknown; devDependencies?: unknown };
  return (
    hasMatchingKey(pkg.dependencies, name, prefixes) ||
    hasMatchingKey(pkg.devDependencies, name, prefixes)
  );
}

/** Does `value` (a deps map) declare `name`, or any key starting with one of `prefixes`? */
function hasMatchingKey(value: unknown, name: string, prefixes: readonly string[]): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  if (Object.hasOwn(value, name)) return true;
  if (prefixes.length === 0) return false;
  return Object.keys(value as Record<string, unknown>).some((key) =>
    prefixes.some((prefix) => key.startsWith(prefix)),
  );
}

// ---------------------------------------------------------------------------
// entryPatterns application (glob-based; vite/next both use this for
// everything except vite's index.html carrier)
// ---------------------------------------------------------------------------

export interface PresetEntryHit {
  /** Root-relative POSIX path. */
  readonly file: string;
  readonly reason: string;
}

/**
 * Match `preset.entryPatterns` (package-relative) against `analyzedFiles`
 * (root-relative POSIX, the already ignore/project-filtered set) that belong
 * to the unit at `unitRootRelDir`, returning root-relative hits.
 */
export function matchPresetEntryPatterns(
  preset: Preset,
  analyzedFiles: readonly string[],
  unitRootRelDir: string,
): PresetEntryHit[] {
  if (preset.entryPatterns.length === 0) return [];
  const patterns = preset.entryPatterns.map(globToRegExp);
  const prefix = unitRootRelDir === "" ? "" : `${unitRootRelDir}/`;
  const out: PresetEntryHit[] = [];
  for (const fileRel of analyzedFiles) {
    if (!fileRel.startsWith(prefix)) continue;
    const pkgRel = fileRel.slice(prefix.length);
    if (patterns.some((re) => re.test(pkgRel))) {
      out.push({ file: fileRel, reason: `preset:${preset.name}` });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// vite: index.html as an entrypoint carrier (spec T4.4 item 2)
// ---------------------------------------------------------------------------

/**
 * `<script src="...">` tags in HTML source (cheap regex, not an HTML parser —
 * documented limits below). Matches any `<script ...>` tag carrying a `src`
 * attribute, single- or double-quoted, in either attribute order
 * (`type="module" src="..."` or `src="..." type="module"`).
 */
const SCRIPT_SRC_RE = /<script\b[^>]*\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)')[^>]*>/gi;

/**
 * Vite's entrypoint carrier: every `.html` file directly at a package root
 * (NOT recursive — "any .html at package root", spec T4.4 item 2) is scanned
 * for `<script src="...">` module references; each that resolves to an
 * analyzed source file becomes a production entrypoint.
 *
 * **Documented limits** (a cheap regex, not an HTML parser, spec-permitted):
 *  - Does not check `type="module"` — any `<script src>` counts. A classic
 *    (non-module) script pointing at a project file is rare enough, and
 *    over-seeding an entrypoint only costs recall, never precision.
 *  - Does not understand HTML comments — a commented-out `<script>` tag would
 *    still be matched (same false-positive-safe direction: it only makes a
 *    file appear MORE alive than it is).
 *  - `src` is resolved either root-relative (a leading `/`, the common Vite
 *    convention — `/src/main.tsx` resolves against the package/serving root)
 *    or relative to the `.html` file's own directory otherwise; a query
 *    string or fragment (`?raw`, `#foo`) is stripped before resolution.
 *  - An external URL (`http:`, `https:`, `//host/...`) is skipped — nothing
 *    to seed.
 *  - No extension resolution beyond what's literally written PLUS the usual
 *    source extensions tried on an extension-less stem (matches every other
 *    heuristic path resolver in this codebase, e.g. `analyze.ts`'s
 *    `candidatePaths`).
 */
export async function viteHtmlEntrypoints(
  unitDir: string,
  unitRootRelDir: string,
  analyzedFileSet: ReadonlySet<string>,
): Promise<PresetEntryHit[]> {
  const htmlFiles = await topLevelHtmlFiles(unitDir);
  const out: PresetEntryHit[] = [];
  const seen = new Set<string>();
  for (const htmlAbs of htmlFiles) {
    let source: string;
    try {
      source = await readFile(htmlAbs, "utf8");
    } catch {
      continue;
    }
    SCRIPT_SRC_RE.lastIndex = 0;
    let match: RegExpExecArray | null = SCRIPT_SRC_RE.exec(source);
    while (match !== null) {
      const src = (match[1] ?? match[2] ?? "").trim();
      match = SCRIPT_SRC_RE.exec(source);
      if (src === "") continue;
      const candidate = resolveHtmlScriptSrc(src, unitDir, dirname(htmlAbs), analyzedFileSet);
      if (candidate === null) continue;
      const fileRel = unitRootRelDir === "" ? candidate : posix.join(unitRootRelDir, candidate);
      if (seen.has(fileRel)) continue;
      seen.add(fileRel);
      out.push({ file: fileRel, reason: "preset:vite:index.html" });
    }
  }
  return out;
}

const SOURCE_EXTENSIONS_FOR_RESOLUTION = [
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
] as const;

/**
 * Resolve one `<script src>` value against `unitDir` (root-relative `/...`)
 * or the HTML file's own directory (relative), against `analyzedFileSet`
 * (package-relative-to-unit POSIX paths). Returns the matched path relative
 * to `unitDir`, or `null` when nothing in the analyzed set matches.
 */
function resolveHtmlScriptSrc(
  src: string,
  unitDir: string,
  htmlDir: string,
  analyzedFileSet: ReadonlySet<string>,
): string | null {
  if (/^([a-z][a-z0-9+.-]*:)?\/\//i.test(src)) return null; // an external URL — nothing to seed
  const withoutQuery = src.split(/[?#]/)[0] ?? "";
  if (withoutQuery === "") return null;
  const baseDir = withoutQuery.startsWith("/") ? unitDir : htmlDir;
  const relTarget = withoutQuery.startsWith("/") ? withoutQuery.slice(1) : withoutQuery;
  const abs = resolvePath(baseDir, relTarget);
  const candidates = [abs, ...SOURCE_EXTENSIONS_FOR_RESOLUTION.map((ext) => abs + ext)];
  for (const candidate of candidates) {
    const rel = toPosixRel(unitDir, candidate);
    if (analyzedFileSet.has(rel)) return rel;
  }
  return null;
}

// ---------------------------------------------------------------------------
// storybook: story globs from `.storybook/main.*` (reference-codebase FP class 1)
// ---------------------------------------------------------------------------

const STORYBOOK_MAIN_BASENAMES = [
  "main.ts",
  "main.tsx",
  "main.js",
  "main.jsx",
  "main.cjs",
  "main.mjs",
  "main.cts",
  "main.mts",
] as const;

/**
 * Storybook's conventional default story glob TAIL — the keep-alive fallback
 * used when a project's own `stories` list cannot be read or parsed, or when a
 * declared glob is unresolvable ("never silently dead"). Prefixed with the
 * owning unit's root-relative directory at use.
 */
const STORYBOOK_DEFAULT_STORY_GLOB_TAIL = "**/*.stories.{js,jsx,mjs,cjs,ts,tsx,mts,cts}";

/**
 * Story files Storybook auto-discovers via the `stories` glob(s) in
 * `<unitDir>/.storybook/main.*`, seeded as production entrypoints. The main
 * config is read directly here (exactly like vite's `index.html` carrier) rather
 * than resolved through the graph — the `stories` value is a glob list, not an
 * import edge. (`discover.ts` does descend the otherwise-hidden `.storybook`
 * directory, and `analyze.ts` roots its config files, so `main.*` and its
 * siblings are kept alive; this reader only needs the glob strings.)
 *
 * **Root-relative, cross-unit resolution (reviewer fix — the aggregator shape).**
 * Each glob is written relative to `.storybook/`, so it is rebased to a
 * repo-ROOT-relative glob (a `../src/…` glob in `apps/web/.storybook` becomes an
 * `apps/web/src/…` glob) and matched against the WHOLE analyzed file set
 * (`analyzedFilesRootRel`), not just the owning unit's files. This is what a
 * "Storybook host" package needs: a `stories` entry reaching up into sibling
 * packages (`../../packages/<name>/…/x.stories.tsx`) collects stories from
 * SIBLING packages that carry no Storybook marker of their own — those matches
 * must still be seeded, wherever they land, or the sibling's `.stories.*` files
 * are confidently (and wrongly) flagged dead. `@(a|b)` extglob alternation is
 * rewritten to `{a,b}` for the shared compiler.
 *
 * Robustness ("never silently dead", spec item 1): when no main config exists,
 * the `stories` value cannot be located, or it uses the object form
 * (`{ directory, files }`) this string-scan deliberately does not model, we fall
 * back to the owning unit's default story glob; a declared glob that escapes the
 * repo root (unresolvable) additionally re-arms that keep-alive default rather
 * than being silently dropped. A `.mdx` glob simply matches nothing (mdx is not
 * a discovered source extension).
 */
export async function storybookStoryEntrypoints(
  unitDir: string,
  unitRootRelDir: string,
  analyzedFilesRootRel: readonly string[],
): Promise<PresetEntryHit[]> {
  const globs = await readStorybookStoryGlobs(join(unitDir, ".storybook"), unitRootRelDir);
  const patterns = globs.map((g) => globToRegExp(g));
  const out: PresetEntryHit[] = [];
  const seen = new Set<string>();
  for (const fileRel of analyzedFilesRootRel) {
    if (!patterns.some((re) => re.test(fileRel))) continue;
    if (seen.has(fileRel)) continue;
    seen.add(fileRel);
    out.push({ file: fileRel, reason: "preset:storybook" });
  }
  return out;
}

/** Read + resolve `.storybook/main.*`'s `stories` globs to repo-ROOT-relative globs; the unit default when unreadable/unparseable/unresolvable. */
async function readStorybookStoryGlobs(
  storyDir: string,
  unitRootRelDir: string,
): Promise<string[]> {
  const unitDefault =
    unitRootRelDir === ""
      ? STORYBOOK_DEFAULT_STORY_GLOB_TAIL
      : `${unitRootRelDir}/${STORYBOOK_DEFAULT_STORY_GLOB_TAIL}`;

  let source: string | null = null;
  for (const base of STORYBOOK_MAIN_BASENAMES) {
    try {
      source = await readFile(join(storyDir, base), "utf8");
      break;
    } catch {
      // try the next candidate basename
    }
  }
  if (source === null) return [unitDefault];
  const raw = extractStoriesGlobStrings(source);
  if (raw === null) return [unitDefault];

  const resolved: string[] = [];
  let anyUnresolvable = false;
  for (const glob of raw) {
    const rel = storyGlobToRootRelative(glob, unitRootRelDir);
    if (rel === null) anyUnresolvable = true;
    else resolved.push(rel);
  }
  if (resolved.length === 0) return [unitDefault];
  // A glob that escaped the repo root was dropped — re-arm the keep-alive default
  // so no story file is ever silently lost ("never silently dead").
  if (anyUnresolvable) resolved.push(unitDefault);
  return resolved;
}

/**
 * The string-literal globs of the `stories:` array in `.storybook/main.*`
 * source, or `null` when the array cannot be located or uses the object form
 * (`{ directory, files }`) — the caller then keep-alives with the default glob.
 */
function extractStoriesGlobStrings(source: string): string[] | null {
  const key = /\bstories\s*:\s*\[/.exec(source);
  if (key === null) return null;
  const open = key.index + key[0].length - 1; // index of the `[`
  let depth = 0;
  let close = -1;
  for (let i = open; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === "[") depth += 1;
    else if (ch === "]") {
      depth -= 1;
      if (depth === 0) {
        close = i;
        break;
      }
    }
  }
  if (close === -1) return null;
  const inner = source.slice(open + 1, close);
  if (inner.includes("{")) return null; // object-form entries — not modelled by this scan
  const out: string[] = [];
  const re = /(['"])((?:\\.|(?!\1)[^\\\r\n])*)\1/g;
  let m: RegExpExecArray | null = re.exec(inner);
  while (m !== null) {
    if (m[2] !== undefined && m[2] !== "") out.push(m[2]);
    m = re.exec(inner);
  }
  return out.length > 0 ? out : null;
}

/**
 * One Storybook `stories` glob (written relative to `.storybook/`) → a repo-ROOT-
 * relative glob for the shared compiler, or `null` when it is absolute or escapes
 * the repo root (unresolvable). The `.storybook` directory sits at
 * `<unitRootRelDir>/.storybook`, so the glob is joined onto that and normalised:
 * `../src/(star)(star)` in `apps/web/.storybook` becomes `apps/web/src/(star)(star)`,
 * and an aggregator's `../../packages/(star)/(star)(star)` in `host/.storybook`
 * becomes `packages/(star)/(star)(star)` — a sibling-collecting glob. `@(a|b)`
 * extglob alternation is rewritten to `{a,b}`.
 */
function storyGlobToRootRelative(glob: string, unitRootRelDir: string): string | null {
  const trimmed = glob.trim();
  if (trimmed === "" || trimmed.startsWith("/")) return null;
  const storybookDirRootRel = unitRootRelDir === "" ? ".storybook" : `${unitRootRelDir}/.storybook`;
  const combined = posix.join(storybookDirRootRel, trimmed);
  if (combined === ".." || combined.startsWith("../")) return null; // escapes the repo root
  return combined.replace(
    /@\(([^()]*)\)/g,
    (_full, inner: string) => `{${inner.split("|").join(",")}}`,
  );
}

// ---------------------------------------------------------------------------
// cdk: entry file from `cdk.json#app` (reference-codebase FP class 2)
// ---------------------------------------------------------------------------

/** A `.ts`/`.tsx`/`.js`/`.jsx` (incl. `.mts`/`.cts`/`.mjs`/`.cjs`) file token. */
const CDK_SOURCE_TOKEN_RE = /\.(?:[cm]?tsx?|[cm]?jsx?)$/i;

/**
 * The AWS CDK app entry file declared in `<unitDir>/cdk.json`'s `app` field,
 * seeded as a production entrypoint. `app` is a shell command
 * (`"npx tsx bin/app.ts"`) — we extract every source-file-looking token
 * conservatively and seed each one that resolves to an analyzed file (trying the
 * `.js`→`.ts` habit and extensionless stems, like the html carrier). In
 * practice `app` names a single entry file, but seeding every resolvable token
 * (deduped) only ever over-approximates the entrypoint set, which costs recall,
 * never precision.
 */
export async function cdkAppEntrypoints(
  unitDir: string,
  unitRootRelDir: string,
  analyzedFileSetPkgRel: ReadonlySet<string>,
): Promise<PresetEntryHit[]> {
  let raw: string;
  try {
    raw = await readFile(join(unitDir, "cdk.json"), "utf8");
  } catch {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  const app = (parsed as { app?: unknown } | null)?.app;
  if (typeof app !== "string" || app === "") return [];
  const out: PresetEntryHit[] = [];
  const seen = new Set<string>();
  for (const token of app.split(/\s+/)) {
    if (!CDK_SOURCE_TOKEN_RE.test(token)) continue;
    const pkgRel = resolveCdkAppToken(token, analyzedFileSetPkgRel);
    if (pkgRel === null) continue;
    const fileRel = unitRootRelDir === "" ? pkgRel : posix.join(unitRootRelDir, pkgRel);
    if (seen.has(fileRel)) continue;
    seen.add(fileRel);
    out.push({ file: fileRel, reason: "preset:cdk:cdk.json" });
  }
  return out;
}

/** Resolve a `cdk.json#app` file token to a unit-package-relative analyzed file. */
function resolveCdkAppToken(
  token: string,
  analyzedFileSetPkgRel: ReadonlySet<string>,
): string | null {
  const clean = (token.replace(/^\.\//, "").split(/[?#]/)[0] ?? "").trim();
  if (clean === "" || clean.startsWith("..") || clean.startsWith("/")) return null;
  if (analyzedFileSetPkgRel.has(clean)) return clean;
  const stem = stripSourceExtensionRel(clean);
  for (const ext of SOURCE_EXTENSIONS_FOR_RESOLUTION) {
    if (analyzedFileSetPkgRel.has(stem + ext)) return stem + ext;
  }
  return null;
}

/** Strip a trailing source extension from a package-relative path (leaving the stem). */
function stripSourceExtensionRel(rel: string): string {
  const lower = rel.toLowerCase();
  for (const ext of SOURCE_EXTENSIONS_FOR_RESOLUTION) {
    if (lower.endsWith(ext)) return rel.slice(0, rel.length - ext.length);
  }
  return rel;
}

/** Absolute `.html` files directly inside `dir` (not recursive — "at package root"). */
async function topLevelHtmlFiles(dir: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const name of entries) {
    if (name.toLowerCase().endsWith(".html")) out.push(join(dir, name));
  }
  return out;
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/** Absolute path → POSIX, relative to `unitDir`. */
function toPosixRel(unitDir: string, abs: string): string {
  return relative(unitDir, abs).split(sep).join("/");
}
