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
export const ASSUMPTION_SET_VERSION = "1.4.0";

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
    id: "monorepo-workspaces-per-package",
    title: "Monorepo workspaces are analyzed per package",
    detail:
      "In a monorepo — npm, pnpm, yarn-classic, or bun workspaces, auto-detected from `pnpm-workspace.yaml` or the `workspaces` field — every workspace package contributes its own entrypoints (`main`/`module`/`exports`/`bin`, plus config and test roots) to one shared reference graph, so a symbol used across packages is alive. Cross-workspace imports resolve to a sibling's source — via the `workspace:` protocol, a direct relative import, or a bare/subpath import of a sibling package name (resolved through the sibling's `exports`/`main`) — and are classified internal, never as an external dependency. Each claim is tagged with the workspace package that owns its file (`subject.loc.package`). Root-level files outside every member are analyzed under the root package. A would-be member removed by a negative glob (e.g. `!packages/legacy`) is excluded: its whole subtree is out of scope — discovered but never claimed, and imported as an outside-project keep-alive — so externally-built code under it is not flagged.",
  },
  {
    id: "dependency-liveness-declared-dependencies",
    title: "Dependency claims cover per-workspace `dependencies` only",
    detail:
      'A `dependency` claim is raised for a package listed in a workspace package.json\'s `dependencies` map that no source file references — where a reference is a normal import, a `/// <reference types="…" />` triple-slash directive (comment-borne, so scanned separately from the import graph), or, for a `workspace:` sibling, a cross-package import by name or relative path. References from unreachable (dead) files still keep a dependency alive: deleting it is a human cascade decision, not our claim. A dependency declared in the ROOT package.json hoists to every workspace member, so it is alive if ANY unit references it (the same any-unit rule covers a member that redeclares a root-declared name — phantom hoisting). `devDependencies` are out of scope in v1: their liveness needs modelling of the scripts and tools that run them, which we do not have — flagging them would risk false positives, so they are left alone (documented debt); `peer`/`optional` dependencies are likewise not analysed. Several declared dependencies are kept alive despite having no reference: every `@types/*` package whenever the project contains any TypeScript file (a blunt, false-positive-proof rule — precise `@types` pairing is a deferred recall improvement); the JSX runtime package (`react`, or the `jsxImportSource` value) under an automatic-runtime tsconfig (`jsx: react-jsx`) whenever any source file exists, since automatic JSX can live in `.js`/`.mjs` as well as `.tsx`/`.jsx`; a package whose installed manifest declares a `bin` (a CLI run via scripts/hooks), and — pre-install, when no `node_modules` is present to inspect — any dependency, conservatively treated as a potential CLI whose bin name may differ from the package name (recall is sacrificed for zero false positives until the project is installed); a package whose name or conventional plugin/preset shorthand appears in a config string or a package.json `scripts` value; and a `workspace:` sibling that the workspace actually references. Dependency claims are `high` confidence unless a project-wide hazard caps the whole workspace, exactly as for file claims.',
  },
  {
    id: "yarn-pnp-unsupported",
    title: "Yarn Plug'n'Play is unsupported in v1",
    detail:
      "Resolution assumes a `node_modules` layout. Yarn PnP's `.pnp.cjs`/`.pnp.mjs` resolution table is not consulted, so a pure-PnP install cannot be resolved correctly. A detected PnP project is therefore refused outright — analysis stops with a clear unsupported message and a non-zero exit — rather than risk a silently-wrong result. Detection also walks up from the analysis root to the repository boundary (a `.git` marker), so running inside a member of a PnP monorepo is refused too. (Workaround: Yarn's `nodeLinker: node-modules`.)",
  },
  {
    id: "symlinks-not-followed",
    title: "Symlinks are not followed",
    detail:
      "Neither discovery nor resolution follows symlinks (`symlinks: false`): a symlinked directory is not descended and a symlinked file is not collected or `realpath()`-ed. This avoids cycles and escaping the project tree. Workspace members are resolved by package name (see above), so a symlinked monorepo layout is handled without following the symlink; a module reachable only through some other symlink still degrades toward alive (an outside-project keep-alive), never a confident dead claim.",
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
