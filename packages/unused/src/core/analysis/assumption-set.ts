/**
 * The published **assumption set** (T3.3, architecture.md §4, PRD §4), rendered
 * from code so it can never drift from analyzer behaviour.
 *
 * `high` confidence means "zero false positives under a published, enumerated
 * assumption set" (PRD §4). That set has two parts, both generated here:
 *
 *  1. **Global analysis assumptions** — {@link GLOBAL_ASSUMPTIONS}, a versioned
 *     constant describing what the analyzer takes for granted about resolution,
 *     entrypoints, aliases, package managers, and symlinks.
 *  2. **Per-hazard downgrade clauses** — one clause per {@link HAZARD_REGISTRY}
 *     entry (its scope, cap, and rationale). These are the mechanisms where
 *     syntax cannot prove a reference absent; a subject in a hazard's scope is
 *     capped (or suppressed) rather than confidently flagged.
 *
 * {@link renderAssumptionSet} folds both into one deterministic markdown
 * document. `pnpm run assumptions` writes it to `docs/generated/assumption-set.md`
 * (committed), and a sync test asserts regenerating produces no diff — the same
 * anti-drift pattern the scoreboard uses. This module is **pure**: it imports
 * only the registry and does no I/O (the writer lives in `testing/`), so core's
 * "no network, no side effects" contract holds.
 */

import { HAZARD_REGISTRY, type HazardClassEntry } from "./hazard-registry.js";

/**
 * Assumption-set schema version. Bump on a MATERIAL change to the assumption
 * wording or the set of globals (a behaviour-affecting change), so a consumer
 * pinning a version can detect it. Independent of the analyzer/tool version.
 */
export const ASSUMPTION_SET_VERSION = "1.1.0";

/** One global analysis assumption (independent of any single hazard class). */
export interface GlobalAssumption {
  /** Stable slug (kebab-case), for cross-referencing from docs/reports. */
  readonly id: string;
  readonly title: string;
  /** One paragraph of prose — what is assumed and why it bounds `high` confidence. */
  readonly detail: string;
}

/**
 * The versioned global assumptions (PRD §4 / architecture.md §4). Order is
 * significant and stable (it is the rendered order).
 */
export const GLOBAL_ASSUMPTIONS: readonly GlobalAssumption[] = [
  {
    id: "tsconfig-governed-resolution",
    title: "Module resolution follows tsconfig and package.json",
    detail:
      "Specifiers are resolved exactly as the TypeScript/Node toolchain would: the project's tsconfig (`paths`, `baseUrl`, and its `extends` chain) plus package.json `exports`/`imports` maps, resolved with a single deterministic condition set (types → import → node → default). A specifier the analyzer cannot resolve to a file or a package degrades toward alive (it is never re-read as absent). Resolution that lands outside the analyzable file set is treated as a keep-alive edge to an un-analyzed module, never a dead end.",
  },
  {
    id: "entrypoints-are-complete-public-api",
    title: "Declared entrypoints are the complete public API",
    detail:
      "The reachability roots are the package.json `main`/`module`/`exports`/`bin` targets (every condition's target, and wildcard `exports` subpaths expanded against the file set), plus a zero-config `index` fallback and detected config roots (e.g. `vite.config.ts`). Everything reachable from a root is alive; a library's `exports` surface is therefore never flagged. A declared target that points into an unbuilt `dist/` is first remapped to the same subpath under `src/` (a narrow heuristic for analyzing before a build); any declared target that still cannot be resolved raises the `unresolvable-entrypoint-target` hazard and caps the whole package at medium rather than silently collapsing to a single `index.*` fallback. A package with no declared entrypoint at all anchors no liveness — the analyzer proves nothing rather than flag the whole codebase.",
  },
  {
    id: "test-files-keep-alive-interim",
    title: "Test files are reachability roots (interim, ahead of M5)",
    detail:
      "Files matching zero-config test conventions — a `*.test.*`, `*.spec.*`, `*.e2e.*`, or `*.cy.*` basename, a file under a `__tests__/` or `cypress/` directory anywhere, or a file under a `test/`, `tests/`, `spec/`, or `e2e/` directory at a package root — are treated as `test` reachability roots. Everything reachable from a test root is alive; the test files themselves are never claimed. This is the M3-interim staging of tier-2: test-reachable code is simply kept alive, with no `unused` claim at any confidence. Consequently nothing reachable only from tests is ever flagged in this milestone, trading the (future) test-only signal for a hard zero-false-positive guarantee on production dead code. The full tier-2 semantics — the `test-only` verdict, the production/test/config partition, and the zombie-test report — remain M5.",
  },
  {
    id: "bundler-aliases-out-of-scope",
    title: "Bundler-only aliases are out of scope unless configured",
    detail:
      "Remaps that live only in a bundler config — webpack `resolve.alias`, Vite `resolve.alias`, and similar — are not followed, because the analyzer reads tsconfig and package.json, not bundler configs. A module reachable only through such an alias may look unreferenced. Aliases expressed in tsconfig `paths` ARE followed; bundler-specific ones require explicit configuration (deferred) to be modelled.",
  },
  {
    id: "yarn-pnp-unsupported",
    title: "Yarn Plug'n'Play is unsupported in v1",
    detail:
      "Resolution assumes a `node_modules` layout. Yarn PnP's `.pnp.cjs` resolution table is not consulted, so dependency resolution under a pure-PnP install is not modelled. A workspace M4 will refuse (rather than silently mis-analyze) a detected PnP project; until then, PnP is outside the assumption set that backs `high` confidence.",
  },
  {
    id: "symlinks-not-followed",
    title: "Symlinks are not followed",
    detail:
      "Neither discovery nor resolution follows symlinks (`symlinks: false`): a symlinked directory is not descended and a symlinked file is not collected or `realpath()`-ed. This avoids cycles and escaping the project tree, but means a module reachable only through a symlink (some monorepo layouts) is not analyzed as internal — it degrades toward alive (an outside-project keep-alive), never a confident dead claim.",
  },
];

/** Deterministic markdown for the whole assumption set (globals + per-hazard clauses). */
export function renderAssumptionSet(): string {
  const lines: string[] = [];

  lines.push(
    "<!-- GENERATED FILE — do not edit by hand. Regenerate with `pnpm run assumptions`.",
    "     Source: packages/unused/src/core/analysis/assumption-set.ts + hazard-registry.ts. -->",
    "",
    `# Analysis assumption set (v${ASSUMPTION_SET_VERSION})`,
    "",
    "`unused`'s `high`-confidence verdicts hold under the assumptions enumerated",
    'here (PRD §4): `high` means "safe to act without re-deriving the reference',
    'graph". Both parts below are generated from code — the global assumptions',
    "constant and one downgrade clause per hazard registry entry — so this",
    "document cannot drift from analyzer behaviour.",
    "",
    "## Global assumptions",
    "",
  );

  for (const assumption of GLOBAL_ASSUMPTIONS) {
    lines.push(`### ${assumption.title}`, "", assumption.detail, "");
  }

  lines.push(
    "## Per-hazard downgrade clauses",
    "",
    "Each mechanism below is one where syntax cannot prove a reference absent",
    "(architecture.md §4). A subject inside a hazard's **scope** is capped at its",
    "**confidence cap** — or suppressed entirely when the cap is `no-claim` —",
    "never emitted as a confident `unused`. Scope kinds: `directory-subtree` (a",
    "path-prefixed set of files), `file`, `symbol-set` (a file's exports only),",
    "`none` (provenance only, no claim effect).",
    "",
  );

  for (const entry of sortedRegistryEntries()) {
    lines.push(
      `### ${entry.hazardClass}`,
      "",
      `- **Scope:** ${entry.scope}`,
      `- **Confidence cap:** ${entry.scope === "none" ? "n/a (no claim effect)" : entry.cap}`,
      "",
      entry.rationale,
      "",
    );
  }

  // Single trailing newline (join adds none); collapse any double blank tail.
  return `${lines.join("\n").replace(/\n+$/, "")}\n`;
}

/** Registry entries in a stable, class-name-sorted order (rendering determinism). */
function sortedRegistryEntries(): HazardClassEntry[] {
  return Object.values(HAZARD_REGISTRY).sort((a, b) =>
    a.hazardClass < b.hazardClass ? -1 : a.hazardClass > b.hazardClass ? 1 : 0,
  );
}
