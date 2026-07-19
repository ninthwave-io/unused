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

export const ALL_PRESETS: readonly Preset[] = [VITE_PRESET, NEXT_PRESET];

function presetByName(name: PresetName): Preset {
  const preset = ALL_PRESETS.find((p) => p.name === name);
  if (preset === undefined) throw new Error(`unknown preset: ${name}`); // unreachable — PresetName is closed
  return preset;
}

// ---------------------------------------------------------------------------
// Auto-activation (spec T4.4 item 1)
// ---------------------------------------------------------------------------

/** Does `unitDir` look like it uses `preset`'s framework — a marker config file, or a declared dependency? */
export async function detectPreset(preset: Preset, unitDir: string): Promise<boolean> {
  for (const name of preset.markerConfigFiles) {
    if (await isFile(join(unitDir, name))) return true;
  }
  return hasDeclaredDependency(unitDir, preset.markerDependency);
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

async function hasDeclaredDependency(unitDir: string, name: string): Promise<boolean> {
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
  return hasKey(pkg.dependencies, name) || hasKey(pkg.devDependencies, name);
}

function hasKey(value: unknown, key: string): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.hasOwn(value, key);
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

/** Absolute path → POSIX, relative to `unitDir`. */
function toPosixRel(unitDir: string, abs: string): string {
  return relative(unitDir, abs).split(sep).join("/");
}
