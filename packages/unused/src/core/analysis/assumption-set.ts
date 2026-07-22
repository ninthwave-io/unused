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
export const ASSUMPTION_SET_VERSION = "1.11.0";

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
    id: "test-only-liveness-partition",
    title: "Test-only liveness: production, test, and config partitions",
    detail:
      "Reachability roots are partitioned into production, config, and test (architecture §3). Files matching zero-config test conventions — a `*.test.*`, `*.spec.*`, `*.e2e.*`, or `*.cy.*` basename, a file under a `__tests__/` or `cypress/` directory anywhere, or a file under a `test/`, `tests/`, `spec/`, or `e2e/` directory at a package root — are `test` roots. A subject reachable in the production or config world is alive and never flagged. A subject (export, file, or dependency) reachable only in the effective test world — never in production or config — is claimed `test-only`: normally a test root exercises it, while a language frontend may also contribute an explicitly test-scoped edge from a real production/config root. Its evidence names the actual effective-world root keeping it alive, with that root's immutable kind and reason, and it runs through the identical hazard-cap machinery as an `unused` claim (`high` when no hazard applies). A test file that itself reaches no production- or config-reachable subject — everything it exercises is `test-only` or dead — is a zombie test, surfaced as a `test`/`test-only` claim (a test file is never a `file` claim; the zombie verdict is the one way it appears). Code imported from BOTH production and a test is in the production partition, so it stays production-alive and is never `test-only` — the classic shared-helper false positive this partition avoids. The false-positive guarantee accordingly extends to tier 2: a `test-only` claim on production-alive code, or an `unused` claim on test-only code (which would tell you to delete code the test environment still reaches), is a false positive the golden-fixture gates reject. `test-only` subjects are excluded from `estDeletableLoc`; removal requires a partition-aware deletion consequence plan rather than a straight deletion. The wasted-CI-seconds figure for zombie tests is reported separately.",
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
      'A `dependency` claim is raised for a package listed in a workspace package.json\'s `dependencies` map that no source file references — where a reference is a normal import, a `/// <reference types="…" />` triple-slash directive (comment-borne, so scanned separately from the import graph), or, for a `workspace:` sibling, a cross-package import by name or relative path. References from unreachable (dead) files still keep a dependency alive: deleting it is a human cascade decision, not our claim. A dependency declared in the ROOT package.json hoists to every workspace member, so it is alive if ANY unit references it (the same any-unit rule covers a member that redeclares a root-declared name — phantom hoisting). `devDependencies` are out of scope in v1: their liveness needs modelling of the scripts and tools that run them, which we do not have — flagging them would risk false positives, so they are left alone (documented debt); `peer`/`optional` dependencies are likewise not analysed. Several declared dependencies are kept alive despite having no reference: every `@types/*` package whenever the project contains any TypeScript file (a blunt, false-positive-proof rule — precise `@types` pairing is a deferred recall improvement); the JSX runtime package (`react`, or the `jsxImportSource` value) under an automatic-runtime tsconfig (`jsx: react-jsx`) whenever any source file exists, since automatic JSX can live in `.js`/`.mjs` as well as `.tsx`/`.jsx`; a package whose installed manifest declares a `bin` (a CLI run via scripts/hooks), and — pre-install, when no `node_modules` is present to inspect — any dependency, conservatively treated as a potential CLI whose bin name may differ from the package name (recall is sacrificed for zero false positives until the project is installed); a package whose name or conventional plugin/preset shorthand appears in a config string or a package.json `scripts` value; and a `workspace:` sibling that the workspace actually references. A dependency referenced only from test files — by no production/config file and no keep-alive rule — is claimed `test-only` rather than `unused` (tier 2), at the same confidence. Dependency claims are `high` confidence unless a project-wide hazard caps the whole workspace, exactly as for file claims.',
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
  {
    id: "podfile-literal-scanning-is-conservative",
    title: "Podfile token scanning prefers keep-alives over Ruby lexer guesses",
    detail:
      "Native-config discovery recognizes exact literal Node commands in bare Ruby `system` calls and calls explicitly owned by `Kernel`. For Podfiles it inspects every receiver-eligible `system` token without carrying guessed quote, comment, percent-literal, regex, heredoc, interpolation, or `=begin`/`=end` state across the source; exact literal argv (or a single literal shell command) is still required. Ruby's lexical boundaries and malformed-file recovery are context-sensitive, so guessed state can hide an executable same-line or later call and produce a false dead claim. Consequently, an apparent literal call inside inert text or a comment may conservatively keep a dead script alive. This bounded recall loss is intentional: native configuration that cannot be disproved stays alive.",
  },
  {
    id: "elixir-frontend-compiles-the-project",
    title: "Elixir analysis compiles the project (experimental frontend, ADR 0011)",
    detail:
      "The Elixir frontend (experimental in v0.1.0) is the one place `unused` executes user code, and this is disclosed rather than hidden. Unlike the TypeScript frontend — which parses source and never runs it — obtaining a function-level reference graph for Elixir requires the real compiler: `mix xref` has been module/file-level only since Elixir 1.10 and structurally cannot answer whether a single function is unused, so the frontend injects a custom compiler tracer (`Code.put_compiler_option(:tracers, …)`) and runs `mix compile.elixir --force` in child `mix` processes rooted at the target project. Production compiles in the caller's Mix environment; tests compile separately under explicit `MIX_ENV=test` so effective test-only `elixirc_paths` such as `test/support` are available. Each compile runs under its own temporary `MIX_BUILD_PATH`; already-compiled dependencies from the matching source environment are linked read-only, and the application's tracked `priv` tree is linked into only its temporary app layout so compile-time `Application.app_dir/2` resource reads keep working. The application's own build manifests, BEAM files, consolidated protocols, and tracked resources are not changed. Compilation still runs project compile-time code, but reflection then reads compile info, attributes, exports, and optional documentation directly from sorted BEAM paths; it never loads a project module merely to enumerate its surface, so unavailable native `@on_load` hooks are not executed by reflection. Missing documentation retains the export surface with line-0 evidence, while missing or malformed core BEAM metadata fails closed. Consequences: Elixir plus fetched, cleanly compiled dependency artifacts for each analyzed environment are required — if the toolchain is absent or production compilation is incomplete, the frontend REFUSES; if only the test environment is incomplete, it publishes the bounded partial result described below. No network and no telemetry beyond what the project's own build performs; temporary artifacts are removed after analysis.",
  },
  {
    id: "elixir-entrypoints-and-runtime-dispatch",
    title: "Elixir entrypoints, and runtime dispatch is kept alive (experimental)",
    detail:
      "The Elixir reachability roots are the OTP application callback module (`mix.exs` `application/0` `mod:`, read from the compiled `.app` resource), everything its supervision tree references (child modules appear as ordinary alias/call references in the tracer, so supervised children are reached transitively), `Phoenix.Endpoint`/`Phoenix.Router` modules when Phoenix is a dependency, and `Mix.Task` modules (`lib/mix/tasks/**`, invoked by CLI name) — all production roots. `config/*.exs` module references are config roots (a module named in config is kept alive). `test/` + ExUnit is the test partition. A public function is a symbol named `Mod.fun/arity` (kind `export` in v1); a module is a symbol named `Mod`; a `.ex`/`.exs` file is a `file` subject. Reflectively-dispatched CALLBACK FUNCTIONS are kept alive, never flagged — but only relative to a module that is itself reachable: a behaviour/OTP module (`@behaviour`/`use GenServer`), a Phoenix runtime module or protocol implementation (`defimpl`), or a plain OTP-supervisable module (one defining `child_spec/1`) has its callback claims suppressed when it is supervised, aliased, or config-named. A module reachable by NOTHING is still claimable as a dead file (the keep-alive suppresses callback claims, not the module's own file claim) — capped to medium by the unit's dynamic-dispatch hazard when an `apply`/`Module.concat` exists in the unit, never confidently dead while such a computed dispatch could reach it. HEEx `~H`/`.heex` component references are visible to the tracer (empirically confirmed) and need no special handling. A project with no application callback, mix task, or Phoenix endpoint anchors no liveness and is proven-nothing rather than flagged wholesale, exactly as a TypeScript project with no entrypoint. Full parity (dependency claims via `mix.lock`, umbrella apps, per-callback precision) is post-v1.",
  },
  {
    id: "elixir-test-partition-completeness",
    title: "Incomplete Elixir test compilation fails closed",
    detail:
      "Elixir test files and effective test-only compiler paths are traced in a separate child with `MIX_ENV=test`, `--no-start`, and a distinct isolated build. The analyzer starts ExUnit with `autorun: false` only to compile deterministically sorted `_test.exs` sources; it does not run `mix test`, require `test/test_helper.exs`, or start the analyzed application. Test modules and functions are accepted only from explicit test files and the non-production `elixirc_paths` delta. Exact production-event re-emission is discarded, but a compatibly reflected production module may contribute an additive `MIX_ENV=test` edge: it must name its reflected owner and use either that owner's exact validated reflected source or a single safe extensionless compiler pseudo-source, which is normalized to the unique owner. A content-free exact duplicate may also carry an absolute compiler/library source only when its semantic key and raw source exactly match the bounded internal provenance recorded as production validation normalized that same event to its owner; mismatches and spoofs fail closed, the weakly held provenance is never serialized, and ordinary owner-sourced events allocate none. Ownerless events remain limited to the explicit test inventory; unknown owners, arbitrary file substitution, paths, extensions, novel production module/function semantics, conflicting ownership, malformed/truncated protocol, missing matching dependency artifacts, timeouts, runtime exits, or support/test/reflection failures discard every test fact and make the partition incomplete. Production and config reachability use shared edges only; the effective test world preserves the real production/config/test root ids, kinds, and reasons while adding test-scoped edges. Test-only classification subtracts the production/config worlds, and per-test zombie and deletion checks honor the same edge activity. An incomplete boundary is published as `status: partial` with `partitions.test: incomplete`, a deterministic warning is written to stderr, and a conservative safety root keeps every compiler-known production file, module, and public function alive. Exact outgoing bridge edges remain reachable too. No potentially test-reachable subject receives an unused/test-only claim or a supported deletion plan until the test partition completes; unrelated language boundaries remain analyzable.",
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
    "(architecture.md §4). Its **activation** policy says whether it always applies",
    "or requires a carrier reachable from a root or an already-active dynamic scope.",
    "A subject inside an active hazard's **scope** is capped at its **confidence",
    "cap** — or suppressed entirely when the cap is `no-claim` — never emitted",
    "as a confident `unused`. Scope kinds: `directory-subtree` (a",
    "path-prefixed set of files), `file`, `symbol-set` (a file's exports only),",
    "`none` (provenance only, no claim effect).",
    "",
  );

  for (const entry of sortedRegistryEntries()) {
    lines.push(
      `### ${entry.hazardClass}`,
      "",
      `- **Activation:** ${entry.activation}`,
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
