<!-- GENERATED FILE — do not edit by hand. Regenerate with `pnpm run assumptions`.
     Source: packages/unused/src/core/analysis/assumption-set.ts + hazard-registry.ts. -->

# Analysis assumption set (v1.26.0)

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

Reachability roots are partitioned into production, config, and test (architecture §3). Files matching zero-config test conventions — a `*.test.*`, `*.spec.*`, `*.e2e.*`, or `*.cy.*` basename, a file under a `__tests__/` or `cypress/` directory anywhere, or a file under a `test/`, `tests/`, `spec/`, or `e2e/` directory at a package root — are `test` roots. A subject reachable in the production or config world is alive and never flagged. A subject (export, file, or dependency) reachable only in the effective test world — never in production or config — is claimed `test-only`: normally a test root exercises it, while a language frontend may also contribute an explicitly test-scoped edge from a real production/config root. Its evidence names the actual effective-world root keeping it alive, with that root's immutable kind and reason, and it runs through the identical hazard-cap machinery as an `unused` claim (`high` when no hazard applies). A test file that itself reaches no production- or config-reachable subject — everything it exercises is `test-only` or dead — is a zombie test, surfaced as a `test`/`test-only` claim (a test file is never a `file` claim; the zombie verdict is the one way it appears). Code imported from BOTH production and a test is in the production partition, so it stays production-alive and is never `test-only` — the classic shared-helper false positive this partition avoids. The false-positive guarantee accordingly extends to tier 2: a `test-only` claim on production-alive code, or an `unused` claim on test-only code (which would tell you to delete code the test environment still reaches), is a false positive the golden-fixture gates reject. `test-only` subjects are excluded from `estDeletableLoc`; removal requires a partition-aware deletion consequence plan rather than a straight deletion. The wasted-CI-seconds figure for zombie tests is reported separately.

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

### Podfile token scanning prefers keep-alives over Ruby lexer guesses

Native-config discovery recognizes exact literal Node commands in bare Ruby `system` calls and calls explicitly owned by `Kernel`. For Podfiles it inspects every receiver-eligible `system` token without carrying guessed quote, comment, percent-literal, regex, heredoc, interpolation, or `=begin`/`=end` state across the source; exact literal argv (or a single literal shell command) is still required. Ruby's lexical boundaries and malformed-file recovery are context-sensitive, so guessed state can hide an executable same-line or later call and produce a false dead claim. Consequently, an apparent literal call inside inert text or a comment may conservatively keep a dead script alive. This bounded recall loss is intentional: native configuration that cannot be disproved stays alive.

### Elixir analysis compiles the project (experimental frontend, ADR 0011)

The Elixir frontend (experimental in v0.1.0) is the one place `unused` executes user code, and this is disclosed rather than hidden. Unlike the TypeScript frontend — which parses source and never runs it — obtaining a function-level reference graph for Elixir requires the real compiler: `mix xref` has been module/file-level only since Elixir 1.10 and structurally cannot answer whether a single function is unused, so the frontend injects a custom compiler tracer (`Code.put_compiler_option(:tracers, …)`) and runs `mix compile.elixir --force` in child `mix` processes rooted at the target project. Production compiles in the caller's Mix environment; tests compile separately under explicit `MIX_ENV=test` so effective test-only `elixirc_paths` such as `test/support` are available. Each compile runs under its own temporary `MIX_BUILD_PATH`; already-compiled dependencies from the matching source environment are linked read-only, and the application's tracked `priv` tree is linked into only its temporary app layout so compile-time `Application.app_dir/2` resource reads keep working. The application's own build manifests, BEAM files, consolidated protocols, and tracked resources are not changed. Compilation still runs project compile-time code, but reflection then reads compile info, attributes, exports, and optional documentation directly from sorted BEAM paths; it never loads a project module merely to enumerate its surface, so unavailable native `@on_load` hooks are not executed by reflection. Missing documentation retains the export surface with line-0 evidence, while missing or malformed core BEAM metadata fails closed. Consequences: Elixir plus fetched, cleanly compiled dependency artifacts for each analyzed environment are required — if the toolchain is absent or production compilation is incomplete, the frontend REFUSES; if only the test environment is incomplete, it publishes the bounded partial result described below. No network and no telemetry beyond what the project's own build performs; temporary artifacts are removed after analysis.

### Elixir entrypoints, and runtime dispatch is kept alive (experimental)

The Elixir reachability roots are the OTP application callback module (`mix.exs` `application/0` `mod:`, read from the compiled `.app` resource), everything its supervision tree references (child modules appear as ordinary alias/call references in the tracer, so supervised children are reached transitively), `Phoenix.Endpoint`/`Phoenix.Router` modules when Phoenix is a dependency, and `Mix.Task` modules (`lib/mix/tasks/**`, invoked by CLI name) — all production roots. `config/*.exs` module references are config roots (a module named in config is kept alive). `test/` + ExUnit is the test partition. A public function is a symbol named `Mod.fun/arity` (kind `export` in v1); a module is a symbol named `Mod`; a `.ex`/`.exs` file is a `file` subject. Reflectively-dispatched CALLBACK FUNCTIONS are kept alive, never flagged — but only relative to a module that is itself reachable: a behaviour/OTP module (`@behaviour`/`use GenServer`), a Phoenix runtime module or protocol implementation (`defimpl`), or a plain OTP-supervisable module (one defining `child_spec/1`) has its callback claims suppressed when it is supervised, aliased, or config-named. A module reachable by NOTHING is still claimable as a dead file (the keep-alive suppresses callback claims, not the module's own file claim). Compiler-confirmed dynamic dispatch is capped to medium unless a bounded source-role proof makes it exact: a conventional guarded `__using__/1` self-`apply` dispatcher must account for every literal `use Module, :helper` site, with nested compiler expansions excluded only when the unique outer target is proven. A generated Phoenix `action/2` dispatcher is owner/arity bounded only with an external `Phoenix.Controller` witness from a declared `phoenix` dependency and no source `apply` at that carrier site. An ordinary `apply/3` site preserves independently proven module and function dimensions; it preserves arity only for a closed proper list of unambiguously separated arguments. A computed argument list cannot erase a literal `__MODULE__` bound. An unknown module with a proven name and/or arity searches the corresponding cross-module candidate set; with no other proven dimension, or with ambiguous same-line source cardinality, it remains boundary-wide. Function-scoped `String.to_atom/1` or `String.to_existing_atom/1` is non-dispatch only when it is the complete direct key argument of a compiler-confirmed standard-library `Map` operation; the complete first field of a two-element tuple returned as a complete `Enum.map/2` function clause and passed immediately to compiler-confirmed `Enum.into(%{})`; the exact right-hand side of one local assignment from a binary-guarded variable in a function-level rescued definition, when every later same-function reference is the complete value of a map field inside a compiler-confirmed `Enum.map/2`; or the complete third/value argument of compiler-confirmed `Map.put/3` with a literal atom key, as the sole `{:ok, value}` body of one lexically matched `try/rescue` directly inside a `case`/`with` clause. That clause binder pattern must be either one exact local or one exact two-element `{:ok, local}` success tuple, and that same local must have a positive conjunctive `is_binary/1` guard. Wrong-status, extra-element, nested, wildcard, aliasing, pinned, or multiple-binder clause patterns remain opaque. The inline role requires one producer in that try and unique compiler-confirmed producer, guard, and `Map.put/3` events on the same carrier. Immediate atom receivers; apply, capture, MFA, dynamic Map receivers/functions/keys, reassignment or binder mismatch, arbitrary or nested tuples, unmatched rescue/clause scopes, interpolation or nesting ambiguity, intervening or otherwise unproven pipelines, unknown flows, unmatched selectors, and same-line/cardinality ambiguity remain opaque and capped. Comments and non-interpolating strings, heredocs, charlists, and sigils are position-preservingly masked; because interpolation expressions execute, any later `#{...}` conservatively invalidates the local assignment proof, while interpolation in the inline try invalidates that proof. HEEx `~H`/`.heex` component references are visible to the tracer (empirically confirmed) and need no special handling. A project with no application callback, mix task, or Phoenix endpoint anchors no liveness and is proven-nothing rather than flagged wholesale, exactly as a TypeScript project with no entrypoint. Full parity (dependency claims via `mix.lock`, umbrella apps, per-callback precision) is post-v1.

### Elixir computed atoms use exact local role summaries (experimental)

ADR 0014 Phase 1B1 supersedes the older closed source-shape list in the preceding assumption while retaining every legacy exact-safe shape as a compatibility terminal. Compiler-confirmed `String.to_atom/1` and `String.to_existing_atom/1` values are followed within one function through indexed parentheses/containers, simple assignments, `with` bindings, pipelines, literal atom allowlists, and exact literal callback-result expressions. All producers on an exact carrier/partition share one value-role graph; a finite bitmask fixed point processes each unique edge a bounded number of times rather than rescanning shared assignment uses. A sparse validated language registry classifies exact public `Map`, `Keyword`, `MapSet`, `Atom`, and `Enum` argument/result roles. Phase 1B1.2 audits every explicit callback position, its result disposition, and every registered implicit protocol/custom-type boundary against public Elixir 1.20.2 and Ecto 3.14.1 semantics. Each audit records callback-fed logical inputs and version-pinned official documentation; validation rejects unknown result roles and optimistic roles on callback-fed inputs. Zero-arity lazy callbacks and directly materialized callback results retain precision. Map/Keyword update and merge collections, transformed enumerable inputs, `Enum.reduce/3` inputs, both `Enum.into/3` protocol inputs, and Ecto custom-type callback values remain omitted and fail closed. One-argument Map/Keyword/MapSet constructors omit their `Enumerable` inputs, and `Enum.member?/2` plus `Enum.into/2` omit all values crossing their registered `Enumerable`/`Collectable` boundaries. The independently validated `Enum.map/2 |> Enum.into(%{})` source shape remains precise because it proves both the list enumerable and literal built-in map collector; no other omitted protocol role inherits that compatibility terminal. `Enum.flat_map/2` callback results are re-enumerated, `Enum.reduce/3` results re-enter the callback as the next accumulator, and `Enum.into/3` transform results enter an arbitrary collector, so those results escape. Ecto dynamic type positions remain invocation selectors. The position-stable delimiter pass nests literal `fn ... end` blocks relative to their enclosing call, so multi-argument, multi-clause, and nested callback commas do not inflate logical arity; `fn:` remains an ordinary keyword key. The registered built-in `convention:ecto` plugin owns an intentionally small typed `Ecto.Changeset` and `Ecto.Type` provider, enabled before graph emission only with the declared `ecto` dependency, one structurally valid and unambiguous Hex lock entry at the audited version 3.14.1, and no project-owned module spoof. Missing locks, path/git dependencies, malformed or duplicate entries, and other versions omit the provider. Phase 1B2B.4 adds exact successful-result propagation for `Ecto.Changeset.add_error/3,4` and the provider-only `convention:money` plugin for `Money.new/2`. Stored keys, metadata, changesets, and validated currencies propagate into returned values rather than becoming data terminals; binary/integer guard-impossible atom positions remain omitted. Money activates only for the 30 semantically audited Hex releases from `1.0.0-beta` through `1.15.0`, excluding `0.0.1-dev` and future versions. Every summarized call requires unique source cardinality and one canonical compiler event on the same carrier/partition, so aliases and imports resolve through compiler identity while production and test joins remain distinct. Phase 1B2A additionally propagates finite, position-specific argument and return effects through exact compiler-confirmed same-module private calls. Only one unambiguous top-level `defp` with parenthesized variable-only parameters participates; production and test summaries are independent. Multiple callers join their return effects. Public or cross-module boundaries, default arguments, multiple clauses, missing or duplicate compiler joins, unknown calls, unresolved recursion, and ambiguous definitions fail closed. Strongly connected components converge a finite bitmask over pre-indexed call adjacency without per-path state. This phase adds no public/inter-module summary and changes no public JSON schema. Project-owned core lookalikes, omitted argument roles, unknown calls or returns, rebinding, interpolation, ambiguous cardinality, callback ambiguity, captures, MFA selectors, `apply`, and computed receivers fail closed as computed-value escape or invocation. Atom-to-string conversion is terminal non-executable data. Returned or stored collections, including replacement/update keys, propagate their computed atom rather than consuming it unless a callback boundary makes the same input executable. Indexed counters include joined outcomes, unjoined opaque fallbacks, legacy/indexed disagreements, private definitions, argument summaries, exact call edges, and SCC iterations; event-populated general and callback-result fixtures, callback-input and dense local-flow scaling fixtures, and a 250/500/1,000-private-function chain assert bounded role-edge, queue-visit, and summary work.

### Elixir semantic providers require exact compiled and locked release ownership

ADR 0014 Phase 1B2B.5 supersedes only the older dependency/version applicability wording in the computed-atom assumption. A convention provider separately declares its recursive Mix compiler application, OTP application, lock key, Hex package, public `hexpm` repository, and each audited version's exact inner and outer checksums. The isolated Mix layout uses `Mix.Dep.cached/0`, consults bounded non-symlink `.app` resources, and exposes one sanitized recursive compiler/OTP inventory for framework detection plus a Hex-only inventory that atomically carries the exact lock identity attached by Mix to that same `Mix.Dep`. Providers consume only that Hex inventory, so an artifact and an unrelated or stale tuple cannot be cross-paired. Activation requires exactly one matching artifact whose attached lock identity is an exact audited release. Missing, duplicate, malformed, `app: false`, path/git, private-repository, lock-only, compiler-only, wrong-package, wrong-application, unaudited-version, and stale or fabricated checksum evidence restores conservative escape. Explicit aliases work only when every distinct identity is declared and agrees. Project-owned modules still defeat dependency summaries. Provider/provider callee duplicates are permitted in the static registry because dependencies can be exclusive, but a callee owned by multiple applicable providers is omitted rather than merged or selected by order. Applicability is O(recursive artifacts + providers + summaries).

### Elixir private computed-value summaries have explicit conservative bounds

ADR 0014 Phase 1B2A summarizes only a direct, unambiguous, variable-parameter `defp` inside one exactly joined literal module body. Module scope is classified from both source and compiler evidence: ordinary `def`/`defp` scaffolding plus reviewed metadata and typespec attributes are accepted only when the complete expected event multiset joins the exact source construct at the same file, line, module, and partition. Phase 1B2A.2 additionally accepts exact direct-body `alias`/`import`/`require` lexical declarations, custom attributes whose complete single-line right-hand side is independently parsed literal data up to 32 nested containers, and audited built-in Kernel word/string/date/time sigils. Every sigil requires the exact canonical `Kernel.sigil_*/2` compiler identity and cardinality as part of its attribute bundle; calendar sigils also require the canonical Date/Time struct expansion. Safety is never inferred from an inert-looking callee alone. Direct `use`, compile hooks including `@after_verify`, quoted/generated definitions, custom or DSL macros, executable attributes, dynamic declarations, custom sigils, non-owner event sources, unknown events, and missing, extra, or ambiguous event bundles disable every private summary for the module; production rejection is inherited by tests. An empty test module-event set may inherit only an already-safe production classification after exact duplicate re-emissions are removed, while any surviving test module event requires a complete test bundle. A private identity with more than 64 distinct private callees or more than 64 exact callers is initialized as opaque escape before local transfer solving; this explicit constant bounds dense-hub work while retaining the pre-Phase-1B2A conservative result. Module constructs and events are indexed once, and delta queues reevaluate only affected callers or callees inside recursive components. Counters expose accepted event classes, module rejection reasons, opaque identities, member evaluations, and committed outcome bits. Neutral 250/500/1,000-edge chain, cycle, dense-hub, and literal-attribute-heavy fixtures enforce the bounds.

### Exact same-module public atom parameters have bounded summaries

ADR 0014 Phase 1B2A.3 extends parameter summaries, but never public result summaries, to one exact same-module public `def`. The source must contain one direct top-level clause with parenthesized distinct variable-only parameters, and reflection must contain exactly one canonical function record at the same module, file, source line, arity, partition, and compiler-validated owner. The complete module source/compiler safety bundle from Phase 1B2A.2 still applies. Guards, defaults, patterns, multiple clauses, delegates, macros, generated siblings, missing or duplicate reflection, and ambiguous calls fail closed. Only an exact compiler `local` call in the same module and partition may consume a public parameter summary; multiple independently exact callsites are permitted. A parameter can end at data, invocation, or escape, or propagate to the call result so the caller's indexed sink decides it. A computed atom created inside a public function and returned from it remains an escape because callers outside the analyzed body are not a closed world; result summaries remain private-only. Public and private parameter nodes share indexed call adjacency, Tarjan components, monotone bitmasks, delta queues, and the 64-caller/callee bounded-escape fallback. Dedicated public counters and neutral 250/500/1,000-function plus 65-callee fixtures prove the complexity and conservative bound. No cross-module, dependency, sibling-boundary, or merged-repository summary is inferred.

### Cross-module public atom parameters require one complete Mix boundary

ADR 0014 Phase 1B2B supersedes only Phase 1B2A.3's cross-module exclusion. Inside one production-complete and test-complete TraceResult, a separate canonical index keyed by module, partition, name, and arity must resolve exactly one eligible project-owned reflected public definition with its own exact source file and line. Each admitted edge requires one source call and one compiler `remote` or `imported` event to agree on the canonical target; aliases and imports rely only on compiler `to_mod`, never source guessing. Caller and callee remain in the same production/test world. Missing, duplicate, conflicting, wrong-world, guarded, defaulted, patterned, multi-clause, generated, unsafe-module, no-parenthesis, dependency, sibling-boundary, and incomplete-trace targets fail closed. Exact cross-module parameter edges reuse the shared Tarjan SCC graph, monotone bitmasks, delta queues, and 64-caller/callee bound without per-producer walks. Parameter-derived values may return for the caller's exact sink to classify, but atoms created in public callees still escape; public result summaries are never materialized and private result summaries remain private-only. Phase 1B2B.1 adds an instrumentation-only decision ledger whose compiler records/groups, source joins, target identities, call decisions, admitted dependency/non-summary edges, and producer attributions remain distinct accounting universes with exact sum invariants. A below-31-bit diagnostic reason mask propagates beside, but never changes, semantic outcomes through the existing value graph and parameter/private-result SCC queues; it adds no producer-specific traversal or per-producer decision set. Phase 1B2B.2 adds separate below-31-bit local-escape and caller-eligibility masks through only those same queues and arrays. Joined escape primaries, joined producer caller exposure, caller-ineligible decisions, and unjoined producer fallbacks are separate exact accounting universes; overlap counters never drive semantics. No-parentheses carriers remain source-call-unindexed because the supported source range supplies no arity, and defensive unreachable branches remain zero-count controls. Dedicated canonical-target, edge, match, rejection, boundary, SCC, update, opaque, decision-ledger, local-cause, caller-eligibility, and producer-attribution counters plus 250/500/1,000-file chains, a 250/500/1,000/2,000 fixed-density cause series, terminal-bearing and terminal-free cycles, a 65-callee hub, and neutral real Mix fixtures enforce the contract. Dependencies, sibling Mix boundaries, repository merges, the public JSON schema, and stdout remain unchanged.

### Visible standalone Elixir scripts are analyzed without blanket rooting

The shared gitignore-bounded repository traversal inventories `.ex` and `.exs` once, including exact hidden Elixir config files `.formatter.exs` and `.iex.exs`. Compiler-traced sources, `mix.exs`, `config/**`, and `test/**` retain their existing owners; every other visible `.exs` is an unrooted, claimable file unless an exact GitHub Actions or Taskfile command names it, it is executable, it has an Elixir/Mix shebang, it calls `Mix.install`, it is an exact formatter/IEx config, or matching Ecto/Phoenix dependencies own a conventional `priv/**/migrations/*.exs` or `priv/**/seeds*.exs` path. Each rule roots only that script; arbitrary paths under `priv` remain claimable. A bounded code-position extractor masks comments and string/heredoc bodies, then adds provenance-bearing edges for compiler-known literal module aliases (including grouped aliases), remote calls with or without parentheses, function captures, MFA tuples, exact `Code.require_file` or `Code.eval_file` script loads, and script-defined module names. Parenthesized remote calls use one position-stable delimiter/block pass, including multiline arguments, anonymous-function bodies, masked literal sentinels, and trailing keyword lists; nested delimiters and block-local commas do not alter top-level arity, while proven nested no-parentheses syntax resolves the same module/function name conservatively at unknown arity. References from an unreachable script do not make their target live, but they block a single-target deletion plan. Script-defined modules or opaque dynamic loading/evaluation cap only that script file at medium rather than producing a high-confidence file claim. Residual syntax in a rooted script applies a carrier-reachable cap only to referenced module functions, or to its owning unit when the dynamic target is wholly opaque; unrelated project claims remain unaffected.

### Incomplete Elixir test compilation fails closed

Elixir test files and effective test-only compiler paths are traced in a separate child with `MIX_ENV=test`, `--no-start`, and a distinct isolated build. The analyzer starts ExUnit with `autorun: false` only to compile deterministically sorted `_test.exs` sources; it does not run `mix test`, require `test/test_helper.exs`, or start the analyzed application. Test modules and functions are accepted only from explicit test files and the non-production `elixirc_paths` delta. Exact production-event re-emission is discarded, but a compatibly reflected production module may contribute an additive `MIX_ENV=test` edge: it must name its reflected owner and use either that owner's exact validated reflected source or a single safe extensionless compiler pseudo-source, which is normalized to the unique owner. A content-free exact duplicate may also carry a safe repository-relative or unsafe external compiler/library/template source only when its semantic key and raw source exactly match bounded internal non-owner provenance recorded after validating the production event's `from_mod` owner. Safe production evidence remains unchanged, while unsafe evidence is normalized to the owner. Changed semantics, source mismatches, ownerless or unknown events, and spoofs fail closed; the provenance is weakly held, lazily allocated, and never serialized, while ordinary owner-sourced events allocate none and cannot authorize a non-owner duplicate. Ownerless events remain limited to the explicit test inventory; unknown owners, arbitrary file substitution, paths, extensions, novel production module/function semantics, conflicting ownership, malformed/truncated protocol, missing matching dependency artifacts, timeouts, runtime exits, or support/test/reflection failures discard every test fact and make the partition incomplete. Production and config reachability use shared edges only; the effective test world preserves the real production/config/test root ids, kinds, and reasons while adding test-scoped edges. Test-only classification subtracts the production/config worlds, and per-test zombie and deletion checks honor the same edge activity. An incomplete boundary is published as `status: partial` with `partitions.test: incomplete`, a deterministic warning is written to stderr, and a conservative safety root keeps every compiler-known production file, module, and public function alive. Exact outgoing bridge edges remain reachable too. No potentially test-reachable subject receives an unused/test-only claim or a supported deletion plan until the test partition completes; unrelated language boundaries remain analyzable.

## Per-hazard downgrade clauses

Each mechanism below is one where syntax cannot prove a reference absent
(architecture.md §4). Its **activation** policy says whether it always applies
or requires a carrier reachable from a root or an already-active dynamic scope.
A subject inside an active hazard's **scope** is capped at its **confidence
cap** — or suppressed entirely when the cap is `no-claim` — never emitted
as a confident `unused`. Scope kinds: `directory-subtree` (a
path-prefixed set of files), `file`, `symbol-set` (a file's exports only),
`none` (provenance only, no claim effect).

### bin-only-dependency

- **Activation:** always
- **Scope:** none
- **Confidence cap:** n/a (no claim effect)

A declared dependency whose installed package.json declares a `bin` field is a command-line tool (e.g. a linter, bundler, or test runner) commonly invoked through package.json scripts, a Makefile, or a git hook rather than imported from source. Such a package can have zero static import edges yet still be genuinely used, so a declared dependency that ships a `bin` is kept alive (never claimed) as a dependency-liveness keep-alive rationale — a no-claim-effect entry, like the JSX runtime rule. Pre-install conservatism: when no `node_modules` is present to inspect (an un-installed or unbuilt checkout), a bin cannot be confirmed or ruled out, so every otherwise-unreferenced dependency is kept alive — a CLI whose bin name differs from its package name and is not named in scripts would otherwise false-flag. This trades recall (dependency claims are weaker before an install) for the zero-false-positive guarantee; a `workspace:` sibling, resolved by name and never a bin, is exempt.

### capacitor-platform-dependency

- **Activation:** always
- **Scope:** none
- **Confidence cap:** n/a (no claim effect)

In a Capacitor app (a `capacitor.config.{ts,js,mjs,cjs,json}` present at the workspace root), the native-platform packages `@capacitor/ios` and `@capacitor/android`, and the `@capacitor/cli`, exist solely so the Capacitor CLI (`npx cap sync`/`cap add`) can locate and copy the native iOS/Android platform code — they are NEVER imported from JS/TS in any Capacitor app, by design. A pure reference-graph view therefore always sees zero references and would false-flag them as unused dependencies. Keyed off the presence of a `capacitor.config.*` at the unit root, they are kept alive (never claimed) — the same config-marker-activated keep-alive class as the vite/next presets, restricted to the platform/CLI packages (Capacitor *plugins* such as `@capacitor/camera` DO expose a JS API and are left claimable).

### checker-only-type-relationship

- **Activation:** always
- **Scope:** symbol-set
- **Confidence cap:** no-claim

A file that participates in declaration merging — a `declare module '...'` augmentation or a `declare global` block — contributes members to a type through a relationship that exists only in the type checker, with no import/export edge tying the contribution to any consumer. The syntactic reference graph therefore cannot prove its exported declarations dead, so the file's export claims are suppressed (kept alive). Scope is deliberately the whole file's export surface — the blunter symbol-set rather than the specific merged name — because the frontend does not model which individual declarations merge; a base interface used only through such a merge with no direct type reference remains a known gap (a per-symbol scope is post-v1).

### computed-cjs-exports

- **Activation:** always
- **Scope:** symbol-set
- **Confidence cap:** medium

A computed CommonJS export assignment (`module.exports[k] = …` / `exports[k] = …` under a runtime key) may re-expose any of the file's exports under a name static analysis cannot enumerate. The file's exports are capped at medium confidence; the file's own liveness is unaffected.

### computed-dynamic-import

- **Activation:** carrier-reachable
- **Scope:** directory-subtree
- **Confidence cap:** medium

When its carrier is reachable from a production, config, test, or explicitly propagated dynamic-hazard target, a dynamic import() with a computed specifier may resolve at runtime to any module under the specifier's static prefix (or, when there is no static prefix, the importer's own workspace package — never the whole monorepo: a computed import in one package cannot reach a sibling package's private modules). Files in that scope cannot be proven unreferenced, so they are capped at medium confidence. An unreachable carrier does not activate the hazard.

### computed-require

- **Activation:** carrier-reachable
- **Scope:** directory-subtree
- **Confidence cap:** medium

When its carrier is reachable from a production, config, test, or explicitly propagated dynamic-hazard target, a require() with a computed (non-string-literal) argument may resolve at runtime to any module under the argument's static prefix (or, when there is no static prefix, the importer's own workspace package — never the whole monorepo: a computed require in one package cannot reach a sibling package's private modules). Files in that scope cannot be proven unreferenced, so they are capped at medium confidence. An unreachable carrier does not activate the hazard.

### conditional-exports-divergence

- **Activation:** always
- **Scope:** file
- **Confidence cap:** no-claim

A package.json `exports` entry that maps different targets under different conditions (e.g. `browser` vs `import`), or a top-level `browser` field that remaps a module, has branches the analyzer's single condition set (types → import → node → default) does not select. A file that is only the target of a non-selected branch has no inbound edge under the resolved condition set, yet is genuinely the public/runtime module under another — so it cannot be claimed. Its file claim is suppressed. (Non-selected `exports` targets are additionally seeded as entrypoints during detection, so this cap is defence-in-depth there; the top-level `browser` remap is the branch entrypoint detection does not read, which this cap uniquely protects.)

### config-named-dependency

- **Activation:** always
- **Scope:** none
- **Confidence cap:** n/a (no claim effect)

A declared dependency whose name — or its conventional plugin/preset shorthand (an `eslint-plugin-x` referenced as `x`, an `@scope/eslint-plugin-x` as `@scope/x`, a `babel-plugin-x`/`babel-preset-x` as `x`, and the common `@scope/plugin-x`/`@scope/preset-x` forms) — appears as a token inside a project config string or a package.json `scripts` value is wired in by configuration rather than a source import (an ESLint plugin named in `.eslintrc`, a tool named in a script). It is kept alive (never claimed) as a dependency-liveness keep-alive rationale. Deliberately generous: config matching only reduces recall, never adds a false positive.

### config-referenced-file

- **Activation:** always
- **Scope:** file
- **Confidence cap:** medium

A source file named only as a string inside a project config file (e.g. a test runner's setupFiles) may be loaded by a tool the analyzer does not model. The file is capped at medium confidence rather than proven dead.

### declaration-companion

- **Activation:** always
- **Scope:** none
- **Confidence cap:** n/a (no claim effect)

The `.d.ts` companion of an imported source file: kept alive in the graph via a keep-alive edge (reachability), never a claim-scoping annotation.

### elixir-behaviour-callback

- **Activation:** always
- **Scope:** symbol-set
- **Confidence cap:** no-claim

An Elixir module that declares one or more behaviours (`@behaviour`, or `use GenServer`/`Supervisor`/`Agent`/`Task`/a custom behaviour, detected reflectively via the compiled module's `:behaviour` attributes) has its callback functions — `handle_call/3`, `init/1`, `child_spec/1`, and the rest — invoked reflectively by the OTP runtime or the behaviour dispatcher, never called by name from user source. A syntactic call-graph therefore sees zero callers and would false-flag every callback as unused. Because the frontend does not model which of a behaviour module's functions are callbacks versus ordinary helpers, the cap is deliberately the whole module's public-function surface (symbol-set): all of its function claims are suppressed (never emitted). The module's own file liveness is unaffected — a behaviour module referenced by nothing (not in any supervision tree, not aliased) is still claimable as a dead file.

### elixir-computed-atom-escape

- **Activation:** carrier-reachable
- **Scope:** project
- **Confidence cap:** medium

When its exact function carrier (or conservative file fallback) is reachable, a compiler-confirmed String.to_atom/1 or String.to_existing_atom/1 result whose consumer cannot be classified may escape into runtime dispatch that the compiler tracer cannot observe. The escape is distinct from a proven invocation but remains fail-closed: its explicit effect scope is capped at medium, with the owning workspace unit used when no narrower target is proven. An unreachable carrier does not activate the effect.

### elixir-dynamic-dispatch

- **Activation:** carrier-reachable
- **Scope:** project
- **Confidence cap:** medium

When its exact public-function carrier (or conservative file fallback) is reachable from a production, config, test, or explicitly affected dynamic target, code that performs dynamic dispatch — `apply/3`, `Kernel.apply/3`, `:erlang.apply/3`, or a `Module.concat`/atom-computed module target — can invoke at runtime a module and function that no static reference names. The resolved target is structurally invisible to the compiler tracer and to `mix xref` alike (confirmed in the ADR 0011 research). When source arguments bound the candidate set, the annotation names the exact affected symbols; those symbols and their statically proven executable symbol descendants (plus their whole-file deletion claims) are capped at medium, while a literal exact target is emitted as a runtime edge instead. Activation can continue through that exact executable symbol closure, never through unrelated functions sharing a file. When the module/function identity remains opaque, the annotation omits targets and the whole workspace unit that owns the dispatching file remains capped at medium without synthetically activating dormant hazards elsewhere in that unit. An unreachable carrier does not activate either form.

### elixir-phoenix-runtime

- **Activation:** always
- **Scope:** symbol-set
- **Confidence cap:** no-claim

A Phoenix/OTP runtime-dispatch module — a `Phoenix.LiveView`/`Phoenix.LiveComponent`/`Phoenix.Channel`/`Phoenix.Endpoint`/`Phoenix.Router` behaviour implementation, or an Elixir protocol implementation (`defimpl`, detected via the compiled module's `__impl__/1`) or protocol definition (`__protocol__/1`) — exposes functions the framework or the protocol dispatcher calls by convention at runtime (`mount/3`, `handle_event/3`, `render/1`, a `defimpl` body dispatched by `Protocol.impl_for/1`), with no static caller anywhere. HEEx template component references, by contrast, ARE visible to the tracer (empirically confirmed in the ADR 0011 skeleton phase: `~H` and `.heex` component invocations compile to ordinary function calls the tracer records) and need no hazard. Like the behaviour-callback class, the whole module's public-function surface is suppressed (symbol-set, no-claim), because the frontend does not model which functions are the framework-called ones; the module's file liveness is unaffected.

### elixir-script-opaque

- **Activation:** always
- **Scope:** file
- **Confidence cap:** medium

A visible standalone Elixir script defines modules or contains dynamic evaluation/loading that the bounded literal script extractor cannot fully model. The script file itself is capped at medium rather than confidently claimed dead. Literal references and exact script-to-script loads are still represented; arbitrary scripts are not blanket-rooted, and this file-scoped cap does not hide unrelated project claims.

### emit-decorator-metadata

- **Activation:** always
- **Scope:** symbol-set
- **Confidence cap:** medium

Under tsconfig `emitDecoratorMetadata`, a class carrying decorators has its constructor-parameter and property type annotations emitted as runtime `design:*` metadata — turning type-position references into runtime references — and is commonly instantiated by a decorator-driven reflection container (DI, ORM) with no static importer. The decorated file's export claims therefore cannot be proven dead and are capped at medium. We choose this scoped cap over rewriting type-position references to value references because the two-sided type rule already keeps type-referenced symbols alive, so the rewrite is a no-op for M3 liveness while the cap yields the conservative downgrade the confidence contract requires. Bluntness: the cap covers all exports of the decorated file, not only the reflected class; the file's own liveness (a decorated class alone in an unimported file) is not covered by symbol-set scope and relies on a real inbound edge.

### export-assignment

- **Activation:** always
- **Scope:** none
- **Confidence cap:** n/a (no claim effect)

TS `export = …` CJS interop: recorded for provenance (declaration merging etc.); the value reference is walked as a normal use-site, so the marker scopes no claim.

### import-equals

- **Activation:** always
- **Scope:** none
- **Confidence cap:** n/a (no claim effect)

TS `import x = require(...)` / `import x = A.B` CJS interop: the resolvable module edge is emitted as a real reference; the marker is provenance only and scopes no claim.

### internal-declaration

- **Activation:** always
- **Scope:** none
- **Confidence cap:** n/a (no claim effect)

A `.d.ts` declaration reached in place of a runtime module: kept alive in the graph via a keep-alive edge (reachability), never a claim-scoping annotation.

### jsx-runtime-dependency

- **Activation:** always
- **Scope:** none
- **Confidence cap:** n/a (no claim effect)

JSX compiled with the automatic runtime (tsconfig `jsx: react-jsx`/`react-jsxdev`, optionally with `jsxImportSource`) injects imports of `react/jsx-runtime` (or the configured source's `/jsx-runtime`) that never appear in source — so the JSX runtime package is used without any visible import. ACTIVE at M4 (dependency claims): when a project has an automatic-runtime tsconfig, the runtime package (the `jsxImportSource` value, defaulting to `react`) is kept alive whenever any source file exists — never claimed as an unused dependency even though nothing imports it. The keep-alive is not restricted to `.tsx`/`.jsx` files because automatic JSX also compiles from `.js`/`.mjs` (CRA-style); the blunt any-source-file rule is false-positive-proof. This is the classic `react`-declared-but-not-imported false positive the rule exists to prevent.

### outside-project

- **Activation:** always
- **Scope:** none
- **Confidence cap:** n/a (no claim effect)

A specifier that resolves outside the analyzable project: the target is not a tracked file, so it affects no other subject's claimability.

### parse-error

- **Activation:** always
- **Scope:** file
- **Confidence cap:** no-claim

A file the parser could not fully read: its references cannot be enumerated, so it might reference anything and cannot itself be proven dead. It is never claimed; its importers keep any names they cannot resolve through it alive.

### project-references

- **Activation:** always
- **Scope:** directory-subtree
- **Confidence cap:** medium

A tsconfig with `references` composes this project with sibling TypeScript projects that may consume its files across the project boundary — a cross-project use the single-project reference graph cannot see. Until real cross-project analysis lands (post-v1), the whole package that owns the referencing tsconfig is capped at medium rather than claimed dead — scoped to that workspace unit, not the whole monorepo (a member's `references` caps that member, not its siblings). This is deliberately blunt: every claim in a project-referenced package is downgraded, trading recall for the guarantee that no externally-consumed file is confidently flagged.

### rustler-ambiguous-registration

- **Activation:** carrier-reachable
- **Scope:** symbol-set
- **Confidence cap:** no-claim

A reachable Rust or Elixir source file uses Rustler registration syntax whose literal module/function/arity identity cannot be proven (for example a computed init module, an unsupported NIF rename, or duplicate loaders). Runtime dispatch may therefore reach any convention-exposed symbol in that file. Its symbol surface is not claimed; unrelated files remain fully analyzable. An unreachable carrier does not activate the hazard.

### unresolvable-entrypoint-target

- **Activation:** always
- **Scope:** project
- **Confidence cap:** medium

One or more declared package.json entrypoint targets (`main`/`module`/`exports`/`bin`) could not be resolved to a project file, even after a conservative `dist/**`→`src/**` remap — the declared public API could not be resolved, so the entrypoint assumption (that the declared entrypoints are the complete public API) is broken. This is the common `npx`-on-an-unbuilt-checkout case (targets point into a `dist/` that has not been built). With the public-API surface incomplete, any file could still be reachable from the missing entry, so no file can be confidently proven dead: the whole package that declared the target is capped at medium rather than flagged — scoped to that workspace unit, not the whole monorepo (one member's unbuilt `dist/` does not cap its siblings). Deliberately blunt (every claim in that package downgraded) — the precise fix is to build the project or configure the entrypoints so they resolve.

### unresolvable-import

- **Activation:** always
- **Scope:** none
- **Confidence cap:** n/a (no claim effect)

A static import specifier that resolved to nothing analyzable: the target is unknown, not a real project file, so it affects no other subject's claimability (the importing file's unrelated dead siblings stay claimable).
