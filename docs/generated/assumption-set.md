<!-- GENERATED FILE — do not edit by hand. Regenerate with `pnpm run assumptions`.
     Source: packages/unused/src/core/analysis/assumption-set.ts + hazard-registry.ts. -->

# Analysis assumption set (v1.5.0)

`unused`'s `high`-confidence verdicts hold under the assumptions enumerated
here (PRD §4): `high` means "safe to act without re-deriving the reference
graph". Both parts below are generated from code — the global assumptions
constant and one downgrade clause per hazard registry entry — so this
document cannot drift from analyzer behaviour.

## Global assumptions

### Module resolution follows tsconfig and package.json

Specifiers are resolved exactly as the TypeScript/Node toolchain would: the project's tsconfig (`paths`, `baseUrl`, and its `extends` chain) plus package.json `exports`/`imports` maps, resolved with a single deterministic condition set (types → import → node → default). A specifier the analyzer cannot resolve to a file or a package degrades toward alive (it is never re-read as absent). Resolution that lands outside the analyzable file set is treated as a keep-alive edge to an un-analyzed module, never a dead end.

### Declared entrypoints are the complete public API

The reachability roots are the package.json `main`/`module`/`exports`/`bin` targets (every condition's target, and wildcard `exports` subpaths expanded against the file set), plus a zero-config `index` fallback and detected config roots (e.g. `vite.config.ts`). Everything reachable from a root is alive; a library's `exports` surface is therefore never flagged. A declared target that points into an unbuilt `dist/` is first remapped to the same subpath under `src/` (a narrow heuristic for analyzing before a build); any declared target that still cannot be resolved raises the `unresolvable-entrypoint-target` hazard and caps the whole package at medium rather than silently collapsing to a single `index.*` fallback. A package with no declared entrypoint at all anchors no liveness — the analyzer proves nothing rather than flag the whole codebase.

### Test-only liveness: production, test, and config partitions

Reachability roots are partitioned into production, config, and test (architecture §3). Files matching zero-config test conventions — a `*.test.*`, `*.spec.*`, `*.e2e.*`, or `*.cy.*` basename, a file under a `__tests__/` or `cypress/` directory anywhere, or a file under a `test/`, `tests/`, `spec/`, or `e2e/` directory at a package root — are `test` roots. A subject reachable from a production or config root is alive and never flagged. A subject (export, file, or dependency) reachable ONLY from test roots — never from production or config — is claimed `test-only`: it is real, but the only thing exercising it is a test, so it is deletable together with that test. Its evidence names the test entrypoint keeping it alive, and it runs through the identical hazard-cap machinery as an `unused` claim (`high` when no hazard applies). A test file that itself reaches no production- or config-reachable subject — everything it exercises is `test-only` or dead — is a zombie test, surfaced as a `test`/`test-only` claim (a test file is never a `file` claim; the zombie verdict is the one way it appears). Code imported from BOTH production and a test is in the production partition, so it stays production-alive and is never `test-only` — the classic shared-helper false positive this partition avoids. The false-positive guarantee accordingly extends to tier 2: a `test-only` claim on production-alive code, or an `unused` claim on test-only code (which would tell you to delete code a test still imports), is a false positive the golden-fixture gates reject. `test-only` subjects are excluded from `estDeletableLoc` (deleting them is a code-plus-test cascade, not a straight deletion); the wasted-CI-seconds figure for zombie tests is reported separately.

### Bundler-only aliases are out of scope unless configured

Remaps that live only in a bundler config — webpack `resolve.alias`, Vite `resolve.alias`, and similar — are not followed, because the analyzer reads tsconfig and package.json, not bundler configs. A module reachable only through such an alias may look unreferenced. Aliases expressed in tsconfig `paths` ARE followed; bundler-specific ones require explicit configuration (deferred) to be modelled.

### Monorepo workspaces are analyzed per package

In a monorepo — npm, pnpm, yarn-classic, or bun workspaces, auto-detected from `pnpm-workspace.yaml` or the `workspaces` field — every workspace package contributes its own entrypoints (`main`/`module`/`exports`/`bin`, plus config and test roots) to one shared reference graph, so a symbol used across packages is alive. Cross-workspace imports resolve to a sibling's source — via the `workspace:` protocol, a direct relative import, or a bare/subpath import of a sibling package name (resolved through the sibling's `exports`/`main`) — and are classified internal, never as an external dependency. Each claim is tagged with the workspace package that owns its file (`subject.loc.package`). Root-level files outside every member are analyzed under the root package. A would-be member removed by a negative glob (e.g. `!packages/legacy`) is excluded: its whole subtree is out of scope — discovered but never claimed, and imported as an outside-project keep-alive — so externally-built code under it is not flagged.

### Dependency claims cover per-workspace `dependencies` only

A `dependency` claim is raised for a package listed in a workspace package.json's `dependencies` map that no source file references — where a reference is a normal import, a `/// <reference types="…" />` triple-slash directive (comment-borne, so scanned separately from the import graph), or, for a `workspace:` sibling, a cross-package import by name or relative path. References from unreachable (dead) files still keep a dependency alive: deleting it is a human cascade decision, not our claim. A dependency declared in the ROOT package.json hoists to every workspace member, so it is alive if ANY unit references it (the same any-unit rule covers a member that redeclares a root-declared name — phantom hoisting). `devDependencies` are out of scope in v1: their liveness needs modelling of the scripts and tools that run them, which we do not have — flagging them would risk false positives, so they are left alone (documented debt); `peer`/`optional` dependencies are likewise not analysed. Several declared dependencies are kept alive despite having no reference: every `@types/*` package whenever the project contains any TypeScript file (a blunt, false-positive-proof rule — precise `@types` pairing is a deferred recall improvement); the JSX runtime package (`react`, or the `jsxImportSource` value) under an automatic-runtime tsconfig (`jsx: react-jsx`) whenever any source file exists, since automatic JSX can live in `.js`/`.mjs` as well as `.tsx`/`.jsx`; a package whose installed manifest declares a `bin` (a CLI run via scripts/hooks), and — pre-install, when no `node_modules` is present to inspect — any dependency, conservatively treated as a potential CLI whose bin name may differ from the package name (recall is sacrificed for zero false positives until the project is installed); a package whose name or conventional plugin/preset shorthand appears in a config string or a package.json `scripts` value; and a `workspace:` sibling that the workspace actually references. A dependency referenced only from test files — by no production/config file and no keep-alive rule — is claimed `test-only` rather than `unused` (tier 2), at the same confidence. Dependency claims are `high` confidence unless a project-wide hazard caps the whole workspace, exactly as for file claims.

### Yarn Plug'n'Play is unsupported in v1

Resolution assumes a `node_modules` layout. Yarn PnP's `.pnp.cjs`/`.pnp.mjs` resolution table is not consulted, so a pure-PnP install cannot be resolved correctly. A detected PnP project is therefore refused outright — analysis stops with a clear unsupported message and a non-zero exit — rather than risk a silently-wrong result. Detection also walks up from the analysis root to the repository boundary (a `.git` marker), so running inside a member of a PnP monorepo is refused too. (Workaround: Yarn's `nodeLinker: node-modules`.)

### Symlinks are not followed

Neither discovery nor resolution follows symlinks (`symlinks: false`): a symlinked directory is not descended and a symlinked file is not collected or `realpath()`-ed. This avoids cycles and escaping the project tree. Workspace members are resolved by package name (see above), so a symlinked monorepo layout is handled without following the symlink; a module reachable only through some other symlink still degrades toward alive (an outside-project keep-alive), never a confident dead claim.

## Per-hazard downgrade clauses

Each mechanism below is one where syntax cannot prove a reference absent
(architecture.md §4). A subject inside a hazard's **scope** is capped at its
**confidence cap** — or suppressed entirely when the cap is `no-claim` —
never emitted as a confident `unused`. Scope kinds: `directory-subtree` (a
path-prefixed set of files), `file`, `symbol-set` (a file's exports only),
`none` (provenance only, no claim effect).

### bin-only-dependency

- **Scope:** none
- **Confidence cap:** n/a (no claim effect)

A declared dependency whose installed package.json declares a `bin` field is a command-line tool (e.g. a linter, bundler, or test runner) commonly invoked through package.json scripts, a Makefile, or a git hook rather than imported from source. Such a package can have zero static import edges yet still be genuinely used, so a declared dependency that ships a `bin` is kept alive (never claimed) as a dependency-liveness keep-alive rationale — a no-claim-effect entry, like the JSX runtime rule. Pre-install conservatism: when no `node_modules` is present to inspect (an un-installed or unbuilt checkout), a bin cannot be confirmed or ruled out, so every otherwise-unreferenced dependency is kept alive — a CLI whose bin name differs from its package name and is not named in scripts would otherwise false-flag. This trades recall (dependency claims are weaker before an install) for the zero-false-positive guarantee; a `workspace:` sibling, resolved by name and never a bin, is exempt.

### checker-only-type-relationship

- **Scope:** symbol-set
- **Confidence cap:** no-claim

A file that participates in declaration merging — a `declare module '...'` augmentation or a `declare global` block — contributes members to a type through a relationship that exists only in the type checker, with no import/export edge tying the contribution to any consumer. The syntactic reference graph therefore cannot prove its exported declarations dead, so the file's export claims are suppressed (kept alive). Scope is deliberately the whole file's export surface — the blunter symbol-set rather than the specific merged name — because the frontend does not model which individual declarations merge; a base interface used only through such a merge with no direct type reference remains a known gap (a per-symbol scope is post-v1).

### computed-cjs-exports

- **Scope:** symbol-set
- **Confidence cap:** medium

A computed CommonJS export assignment (`module.exports[k] = …` / `exports[k] = …` under a runtime key) may re-expose any of the file's exports under a name static analysis cannot enumerate. The file's exports are capped at medium confidence; the file's own liveness is unaffected.

### computed-dynamic-import

- **Scope:** directory-subtree
- **Confidence cap:** medium

A dynamic import() with a computed specifier may resolve, at runtime, to any module under the specifier's static prefix (or the importer's whole package when there is no static prefix). Files in that subtree cannot be proven unreferenced, so they are capped at medium confidence.

### computed-require

- **Scope:** directory-subtree
- **Confidence cap:** medium

A require() with a computed (non-string-literal) argument may resolve, at runtime, to any module under the argument's static prefix (or the importer's whole package when there is no static prefix). Files in that subtree cannot be proven unreferenced, so they are capped at medium confidence.

### conditional-exports-divergence

- **Scope:** file
- **Confidence cap:** no-claim

A package.json `exports` entry that maps different targets under different conditions (e.g. `browser` vs `import`), or a top-level `browser` field that remaps a module, has branches the analyzer's single condition set (types → import → node → default) does not select. A file that is only the target of a non-selected branch has no inbound edge under the resolved condition set, yet is genuinely the public/runtime module under another — so it cannot be claimed. Its file claim is suppressed. (Non-selected `exports` targets are additionally seeded as entrypoints during detection, so this cap is defence-in-depth there; the top-level `browser` remap is the branch entrypoint detection does not read, which this cap uniquely protects.)

### config-named-dependency

- **Scope:** none
- **Confidence cap:** n/a (no claim effect)

A declared dependency whose name — or its conventional plugin/preset shorthand (an `eslint-plugin-x` referenced as `x`, an `@scope/eslint-plugin-x` as `@scope/x`, a `babel-plugin-x`/`babel-preset-x` as `x`, and the common `@scope/plugin-x`/`@scope/preset-x` forms) — appears as a token inside a project config string or a package.json `scripts` value is wired in by configuration rather than a source import (an ESLint plugin named in `.eslintrc`, a tool named in a script). It is kept alive (never claimed) as a dependency-liveness keep-alive rationale. Deliberately generous: config matching only reduces recall, never adds a false positive.

### config-referenced-file

- **Scope:** file
- **Confidence cap:** medium

A source file named only as a string inside a project config file (e.g. a test runner's setupFiles) may be loaded by a tool the analyzer does not model. The file is capped at medium confidence rather than proven dead.

### declaration-companion

- **Scope:** none
- **Confidence cap:** n/a (no claim effect)

The `.d.ts` companion of an imported source file: kept alive in the graph via a keep-alive edge (reachability), never a claim-scoping annotation.

### emit-decorator-metadata

- **Scope:** symbol-set
- **Confidence cap:** medium

Under tsconfig `emitDecoratorMetadata`, a class carrying decorators has its constructor-parameter and property type annotations emitted as runtime `design:*` metadata — turning type-position references into runtime references — and is commonly instantiated by a decorator-driven reflection container (DI, ORM) with no static importer. The decorated file's export claims therefore cannot be proven dead and are capped at medium. We choose this scoped cap over rewriting type-position references to value references because the two-sided type rule already keeps type-referenced symbols alive, so the rewrite is a no-op for M3 liveness while the cap yields the conservative downgrade the confidence contract requires. Bluntness: the cap covers all exports of the decorated file, not only the reflected class; the file's own liveness (a decorated class alone in an unimported file) is not covered by symbol-set scope and relies on a real inbound edge.

### export-assignment

- **Scope:** none
- **Confidence cap:** n/a (no claim effect)

TS `export = …` CJS interop: recorded for provenance (declaration merging etc.); the value reference is walked as a normal use-site, so the marker scopes no claim.

### import-equals

- **Scope:** none
- **Confidence cap:** n/a (no claim effect)

TS `import x = require(...)` / `import x = A.B` CJS interop: the resolvable module edge is emitted as a real reference; the marker is provenance only and scopes no claim.

### internal-declaration

- **Scope:** none
- **Confidence cap:** n/a (no claim effect)

A `.d.ts` declaration reached in place of a runtime module: kept alive in the graph via a keep-alive edge (reachability), never a claim-scoping annotation.

### jsx-runtime-dependency

- **Scope:** none
- **Confidence cap:** n/a (no claim effect)

JSX compiled with the automatic runtime (tsconfig `jsx: react-jsx`/`react-jsxdev`, optionally with `jsxImportSource`) injects imports of `react/jsx-runtime` (or the configured source's `/jsx-runtime`) that never appear in source — so the JSX runtime package is used without any visible import. ACTIVE at M4 (dependency claims): when a project has an automatic-runtime tsconfig, the runtime package (the `jsxImportSource` value, defaulting to `react`) is kept alive whenever any source file exists — never claimed as an unused dependency even though nothing imports it. The keep-alive is not restricted to `.tsx`/`.jsx` files because automatic JSX also compiles from `.js`/`.mjs` (CRA-style); the blunt any-source-file rule is false-positive-proof. This is the classic `react`-declared-but-not-imported false positive the rule exists to prevent.

### outside-project

- **Scope:** none
- **Confidence cap:** n/a (no claim effect)

A specifier that resolves outside the analyzable project: the target is not a tracked file, so it affects no other subject's claimability.

### parse-error

- **Scope:** file
- **Confidence cap:** no-claim

A file the parser could not fully read: its references cannot be enumerated, so it might reference anything and cannot itself be proven dead. It is never claimed; its importers keep any names they cannot resolve through it alive.

### project-references

- **Scope:** directory-subtree
- **Confidence cap:** medium

A tsconfig with `references` composes this project with sibling TypeScript projects that may consume its files across the project boundary — a cross-project use the single-project reference graph cannot see. Until real cross-project analysis lands (post-v1), the whole package is capped at medium rather than claimed dead. This is deliberately blunt: every claim in a project-referenced package is downgraded, trading recall for the guarantee that no externally-consumed file is confidently flagged.

### unresolvable-entrypoint-target

- **Scope:** project
- **Confidence cap:** medium

One or more declared package.json entrypoint targets (`main`/`module`/`exports`/`bin`) could not be resolved to a project file, even after a conservative `dist/**`→`src/**` remap — the declared public API could not be resolved, so the entrypoint assumption (that the declared entrypoints are the complete public API) is broken. This is the common `npx`-on-an-unbuilt-checkout case (targets point into a `dist/` that has not been built). With the public-API surface incomplete, any file could still be reachable from the missing entry, so no file can be confidently proven dead: the whole package is capped at medium rather than flagged. Deliberately blunt (every claim downgraded) — the precise fix is to build the project or configure the entrypoints so they resolve.

### unresolvable-import

- **Scope:** none
- **Confidence cap:** n/a (no claim effect)

A static import specifier that resolved to nothing analyzable: the target is unknown, not a real project file, so it affects no other subject's claimability (the importing file's unrelated dead siblings stay claimable).
