<!-- GENERATED FILE — do not edit by hand. Regenerate with `pnpm run assumptions`.
     Source: packages/unused/src/core/analysis/assumption-set.ts + hazard-registry.ts. -->

# Analysis assumption set (v1.0.0)

`unused`'s `high`-confidence verdicts hold under the assumptions enumerated
here (PRD §4): `high` means "safe to act without re-deriving the reference
graph". Both parts below are generated from code — the global assumptions
constant and one downgrade clause per hazard registry entry — so this
document cannot drift from analyzer behaviour.

## Global assumptions

### Module resolution follows tsconfig and package.json

Specifiers are resolved exactly as the TypeScript/Node toolchain would: the project's tsconfig (`paths`, `baseUrl`, and its `extends` chain) plus package.json `exports`/`imports` maps, resolved with a single deterministic condition set (types → import → node → default). A specifier the analyzer cannot resolve to a file or a package degrades toward alive (it is never re-read as absent). Resolution that lands outside the analyzable file set is treated as a keep-alive edge to an un-analyzed module, never a dead end.

### Declared entrypoints are the complete public API

The reachability roots are the package.json `main`/`module`/`exports`/`bin` targets (every condition's target, and wildcard `exports` subpaths expanded against the file set), plus a zero-config `index` fallback and detected config roots (e.g. `vite.config.ts`). Everything reachable from a root is alive; a library's `exports` surface is therefore never flagged. A package with no resolvable entrypoint anchors no liveness at all — the analyzer proves nothing rather than flag the whole codebase.

### Bundler-only aliases are out of scope unless configured

Remaps that live only in a bundler config — webpack `resolve.alias`, Vite `resolve.alias`, and similar — are not followed, because the analyzer reads tsconfig and package.json, not bundler configs. A module reachable only through such an alias may look unreferenced. Aliases expressed in tsconfig `paths` ARE followed; bundler-specific ones require explicit configuration (deferred) to be modelled.

### Yarn Plug'n'Play is unsupported in v1

Resolution assumes a `node_modules` layout. Yarn PnP's `.pnp.cjs` resolution table is not consulted, so dependency resolution under a pure-PnP install is not modelled. A workspace M4 will refuse (rather than silently mis-analyze) a detected PnP project; until then, PnP is outside the assumption set that backs `high` confidence.

### Symlinks are not followed

Neither discovery nor resolution follows symlinks (`symlinks: false`): a symlinked directory is not descended and a symlinked file is not collected or `realpath()`-ed. This avoids cycles and escaping the project tree, but means a module reachable only through a symlink (some monorepo layouts) is not analyzed as internal — it degrades toward alive (an outside-project keep-alive), never a confident dead claim.

## Per-hazard downgrade clauses

Each mechanism below is one where syntax cannot prove a reference absent
(architecture.md §4). A subject inside a hazard's **scope** is capped at its
**confidence cap** — or suppressed entirely when the cap is `no-claim` —
never emitted as a confident `unused`. Scope kinds: `directory-subtree` (a
path-prefixed set of files), `file`, `symbol-set` (a file's exports only),
`none` (provenance only, no claim effect).

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

JSX compiled with the automatic runtime (`jsxImportSource`) injects imports of `react/jsx-runtime` (or the configured source) that never appear in source — so the JSX runtime package is used without a visible import. This concerns *dependency* liveness (tier-1 dependency claims), which do not exist until M4; the entry is registered with no claim effect and activates at M4, when dependency claims can consume it.

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

### unresolvable-import

- **Scope:** none
- **Confidence cap:** n/a (no claim effect)

A static import specifier that resolved to nothing analyzable: the target is unknown, not a real project file, so it affects no other subject's claimability (the importing file's unrelated dead siblings stay claimable).
