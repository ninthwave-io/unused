/**
 * The hazard registry (T3.1, phasing.md M3 — the false-positive spine).
 *
 * Every mechanism where syntax cannot prove a reference absent is a registry
 * entry (architecture.md §4). Each entry pins three things the claim engine
 * (`claims.ts`) reads to turn a hazard into a *scoped* confidence effect rather
 * than the blanket whole-project suppression M2 used:
 *
 *  - **scope of effect** — which subjects the hazard can plausibly reach, so
 *    only those get downgraded (files outside the scope stay claimable at full
 *    confidence). The concrete target of a `directory-subtree` scope (the path
 *    prefix) is data the frontend supplies on the {@link HazardAnnotation}
 *    (`subtreePrefix`); the registry only fixes the scope *kind*.
 *  - **confidence cap** — the ceiling a subject in scope may be claimed at:
 *    `medium`/`low` downgrade (PRD §4 confidence contract), `no-claim`
 *    suppresses entirely.
 *  - **activation** — whether the annotation always applies, or only while its
 *    carrier file is reachable from a production, config, or test root, or is
 *    itself inside an already-active outgoing hazard's conservative scope. The
 *    latter is computed to a fixed point: dead code cannot dynamically load
 *    anything, but a dynamically loadable carrier can.
 *  - **rationale** — the per-hazard downgrade clause the assumption-set doc is
 *    generated from (T3.3).
 *
 * ## The core invariant (CLAUDE.md non-negotiable, degrade toward alive)
 * The {@link HazardClass} vocabulary is a **closed enum** in core (this is the
 * M3 close-the-vocabulary item). {@link HAZARD_REGISTRY} is typed
 * `Record<HazardClass, …>`, so the compiler forces every class to have an entry.
 * {@link lookupHazard} is still defensive at runtime: any class string not in
 * the map (a cast, a bug, a future class added to the enum but not the registry)
 * returns `undefined`, and the claim engine treats an unregistered class as
 * **project-scope no-claim + a loud internal warning** — never a silent pass.
 */

import type { HazardClass } from "../ir/index.js";

/**
 * Which subjects a hazard can plausibly affect.
 *  - `project`          — a whole workspace package. With a `no-claim` cap this is
 *                         the unregistered-class fallback in `claims.ts` (whole-
 *                         project suppression); with a `medium`/`low` cap it caps
 *                         every file (and its exports) OWNED BY THE HAZARD SITE'S
 *                         workspace unit — a member's unresolvable entrypoint caps
 *                         that member, not its siblings — plus that unit's
 *                         dependency claims. Used by `unresolvable-entrypoint-target`.
 *  - `directory-subtree`— every file whose repo-relative path starts with the
 *                         annotation's `subtreePrefix` (absent ⇒ `""` ⇒ the
 *                         hazard site's OWNING workspace package, i.e. the unit
 *                         that owns the annotation's file — never the whole
 *                         monorepo; `claims.ts` resolves the owning unit from the
 *                         run's workspace boundaries). Caps the file claim AND any
 *                         dead-export claim of an in-scope file.
 *  - `file`             — exactly the annotation's file (its file claim and its
 *                         export claims).
 *  - `symbol-set`       — only the export claims of the annotation's file; the
 *                         file's own liveness is unaffected.
 *  - `none`             — no claim effect (provenance only); registered so the
 *                         closed-vocabulary invariant holds for keep-alive edges
 *                         and un-scoped markers.
 */
export type HazardScope = "project" | "directory-subtree" | "file" | "symbol-set" | "none";

/** The ceiling a subject in a hazard's scope may be claimed at. */
export type ConfidenceCap = "medium" | "low" | "no-claim";

/** When a registered annotation is allowed to affect claims. */
export type HazardActivation = "always" | "carrier-reachable";

export interface HazardClassEntry {
  readonly hazardClass: HazardClass;
  readonly scope: HazardScope;
  readonly activation: HazardActivation;
  /** Ignored for `scope: "none"` (no subject is ever in scope). */
  readonly cap: ConfidenceCap;
  /** One-line downgrade clause; feeds the generated assumption set (T3.3). */
  readonly rationale: string;
}

/**
 * The closed hazard vocabulary → its scope/cap/rationale. `Record<HazardClass,…>`
 * makes an unregistered *enum member* a compile error; {@link lookupHazard}
 * handles out-of-enum strings at runtime.
 */
export const HAZARD_REGISTRY: Readonly<Record<HazardClass, HazardClassEntry>> = {
  "computed-dynamic-import": {
    hazardClass: "computed-dynamic-import",
    scope: "directory-subtree",
    activation: "carrier-reachable",
    cap: "medium",
    rationale:
      "When its carrier file is reachable from a production, config, test, or already-active dynamic-hazard scope, a dynamic import() with a computed specifier may resolve at runtime to any module under the specifier's static prefix (or, when there is no static prefix, the importer's own workspace package — never the whole monorepo: a computed import in one package cannot reach a sibling package's private modules). Files in that scope cannot be proven unreferenced, so they are capped at medium confidence. An unreachable carrier does not activate the hazard.",
  },
  "computed-require": {
    hazardClass: "computed-require",
    scope: "directory-subtree",
    activation: "carrier-reachable",
    cap: "medium",
    rationale:
      "When its carrier file is reachable from a production, config, test, or already-active dynamic-hazard scope, a require() with a computed (non-string-literal) argument may resolve at runtime to any module under the argument's static prefix (or, when there is no static prefix, the importer's own workspace package — never the whole monorepo: a computed require in one package cannot reach a sibling package's private modules). Files in that scope cannot be proven unreferenced, so they are capped at medium confidence. An unreachable carrier does not activate the hazard.",
  },
  "computed-cjs-exports": {
    hazardClass: "computed-cjs-exports",
    scope: "symbol-set",
    activation: "always",
    cap: "medium",
    rationale:
      "A computed CommonJS export assignment (`module.exports[k] = …` / `exports[k] = …` under a runtime key) may re-expose any of the file's exports under a name static analysis cannot enumerate. The file's exports are capped at medium confidence; the file's own liveness is unaffected.",
  },
  "config-referenced-file": {
    hazardClass: "config-referenced-file",
    scope: "file",
    activation: "always",
    cap: "medium",
    rationale:
      "A source file named only as a string inside a project config file (e.g. a test runner's setupFiles) may be loaded by a tool the analyzer does not model. The file is capped at medium confidence rather than proven dead.",
  },
  "parse-error": {
    hazardClass: "parse-error",
    scope: "file",
    activation: "always",
    cap: "no-claim",
    rationale:
      "A file the parser could not fully read: its references cannot be enumerated, so it might reference anything and cannot itself be proven dead. It is never claimed; its importers keep any names they cannot resolve through it alive.",
  },
  "unresolvable-import": {
    hazardClass: "unresolvable-import",
    scope: "none",
    activation: "always",
    cap: "medium",
    rationale:
      "A static import specifier that resolved to nothing analyzable: the target is unknown, not a real project file, so it affects no other subject's claimability (the importing file's unrelated dead siblings stay claimable).",
  },
  "outside-project": {
    hazardClass: "outside-project",
    scope: "none",
    activation: "always",
    cap: "medium",
    rationale:
      "A specifier that resolves outside the analyzable project: the target is not a tracked file, so it affects no other subject's claimability.",
  },
  "internal-declaration": {
    hazardClass: "internal-declaration",
    scope: "none",
    activation: "always",
    cap: "medium",
    rationale:
      "A `.d.ts` declaration reached in place of a runtime module: kept alive in the graph via a keep-alive edge (reachability), never a claim-scoping annotation.",
  },
  "declaration-companion": {
    hazardClass: "declaration-companion",
    scope: "none",
    activation: "always",
    cap: "medium",
    rationale:
      "The `.d.ts` companion of an imported source file: kept alive in the graph via a keep-alive edge (reachability), never a claim-scoping annotation.",
  },
  "import-equals": {
    hazardClass: "import-equals",
    scope: "none",
    activation: "always",
    cap: "medium",
    rationale:
      "TS `import x = require(...)` / `import x = A.B` CJS interop: the resolvable module edge is emitted as a real reference; the marker is provenance only and scopes no claim.",
  },
  "export-assignment": {
    hazardClass: "export-assignment",
    scope: "none",
    activation: "always",
    cap: "medium",
    rationale:
      "TS `export = …` CJS interop: recorded for provenance (declaration merging etc.); the value reference is walked as a normal use-site, so the marker scopes no claim.",
  },
  "checker-only-type-relationship": {
    hazardClass: "checker-only-type-relationship",
    scope: "symbol-set",
    activation: "always",
    cap: "no-claim",
    rationale:
      "A file that participates in declaration merging — a `declare module '...'` augmentation or a `declare global` block — contributes members to a type through a relationship that exists only in the type checker, with no import/export edge tying the contribution to any consumer. The syntactic reference graph therefore cannot prove its exported declarations dead, so the file's export claims are suppressed (kept alive). Scope is deliberately the whole file's export surface — the blunter symbol-set rather than the specific merged name — because the frontend does not model which individual declarations merge; a base interface used only through such a merge with no direct type reference remains a known gap (a per-symbol scope is post-v1).",
  },
  "emit-decorator-metadata": {
    hazardClass: "emit-decorator-metadata",
    scope: "symbol-set",
    activation: "always",
    cap: "medium",
    rationale:
      "Under tsconfig `emitDecoratorMetadata`, a class carrying decorators has its constructor-parameter and property type annotations emitted as runtime `design:*` metadata — turning type-position references into runtime references — and is commonly instantiated by a decorator-driven reflection container (DI, ORM) with no static importer. The decorated file's export claims therefore cannot be proven dead and are capped at medium. We choose this scoped cap over rewriting type-position references to value references because the two-sided type rule already keeps type-referenced symbols alive, so the rewrite is a no-op for M3 liveness while the cap yields the conservative downgrade the confidence contract requires. Bluntness: the cap covers all exports of the decorated file, not only the reflected class; the file's own liveness (a decorated class alone in an unimported file) is not covered by symbol-set scope and relies on a real inbound edge.",
  },
  "conditional-exports-divergence": {
    hazardClass: "conditional-exports-divergence",
    scope: "file",
    activation: "always",
    cap: "no-claim",
    rationale:
      "A package.json `exports` entry that maps different targets under different conditions (e.g. `browser` vs `import`), or a top-level `browser` field that remaps a module, has branches the analyzer's single condition set (types → import → node → default) does not select. A file that is only the target of a non-selected branch has no inbound edge under the resolved condition set, yet is genuinely the public/runtime module under another — so it cannot be claimed. Its file claim is suppressed. (Non-selected `exports` targets are additionally seeded as entrypoints during detection, so this cap is defence-in-depth there; the top-level `browser` remap is the branch entrypoint detection does not read, which this cap uniquely protects.)",
  },
  "project-references": {
    hazardClass: "project-references",
    scope: "directory-subtree",
    activation: "always",
    cap: "medium",
    rationale:
      "A tsconfig with `references` composes this project with sibling TypeScript projects that may consume its files across the project boundary — a cross-project use the single-project reference graph cannot see. Until real cross-project analysis lands (post-v1), the whole package that owns the referencing tsconfig is capped at medium rather than claimed dead — scoped to that workspace unit, not the whole monorepo (a member's `references` caps that member, not its siblings). This is deliberately blunt: every claim in a project-referenced package is downgraded, trading recall for the guarantee that no externally-consumed file is confidently flagged.",
  },
  "unresolvable-entrypoint-target": {
    hazardClass: "unresolvable-entrypoint-target",
    scope: "project",
    activation: "always",
    cap: "medium",
    rationale:
      "One or more declared package.json entrypoint targets (`main`/`module`/`exports`/`bin`) could not be resolved to a project file, even after a conservative `dist/**`→`src/**` remap — the declared public API could not be resolved, so the entrypoint assumption (that the declared entrypoints are the complete public API) is broken. This is the common `npx`-on-an-unbuilt-checkout case (targets point into a `dist/` that has not been built). With the public-API surface incomplete, any file could still be reachable from the missing entry, so no file can be confidently proven dead: the whole package that declared the target is capped at medium rather than flagged — scoped to that workspace unit, not the whole monorepo (one member's unbuilt `dist/` does not cap its siblings). Deliberately blunt (every claim in that package downgraded) — the precise fix is to build the project or configure the entrypoints so they resolve.",
  },
  "jsx-runtime-dependency": {
    hazardClass: "jsx-runtime-dependency",
    scope: "none",
    activation: "always",
    cap: "medium",
    rationale:
      "JSX compiled with the automatic runtime (tsconfig `jsx: react-jsx`/`react-jsxdev`, optionally with `jsxImportSource`) injects imports of `react/jsx-runtime` (or the configured source's `/jsx-runtime`) that never appear in source — so the JSX runtime package is used without any visible import. ACTIVE at M4 (dependency claims): when a project has an automatic-runtime tsconfig, the runtime package (the `jsxImportSource` value, defaulting to `react`) is kept alive whenever any source file exists — never claimed as an unused dependency even though nothing imports it. The keep-alive is not restricted to `.tsx`/`.jsx` files because automatic JSX also compiles from `.js`/`.mjs` (CRA-style); the blunt any-source-file rule is false-positive-proof. This is the classic `react`-declared-but-not-imported false positive the rule exists to prevent.",
  },
  "bin-only-dependency": {
    hazardClass: "bin-only-dependency",
    scope: "none",
    activation: "always",
    cap: "medium",
    rationale:
      "A declared dependency whose installed package.json declares a `bin` field is a command-line tool (e.g. a linter, bundler, or test runner) commonly invoked through package.json scripts, a Makefile, or a git hook rather than imported from source. Such a package can have zero static import edges yet still be genuinely used, so a declared dependency that ships a `bin` is kept alive (never claimed) as a dependency-liveness keep-alive rationale — a no-claim-effect entry, like the JSX runtime rule. Pre-install conservatism: when no `node_modules` is present to inspect (an un-installed or unbuilt checkout), a bin cannot be confirmed or ruled out, so every otherwise-unreferenced dependency is kept alive — a CLI whose bin name differs from its package name and is not named in scripts would otherwise false-flag. This trades recall (dependency claims are weaker before an install) for the zero-false-positive guarantee; a `workspace:` sibling, resolved by name and never a bin, is exempt.",
  },
  "config-named-dependency": {
    hazardClass: "config-named-dependency",
    scope: "none",
    activation: "always",
    cap: "medium",
    rationale:
      "A declared dependency whose name — or its conventional plugin/preset shorthand (an `eslint-plugin-x` referenced as `x`, an `@scope/eslint-plugin-x` as `@scope/x`, a `babel-plugin-x`/`babel-preset-x` as `x`, and the common `@scope/plugin-x`/`@scope/preset-x` forms) — appears as a token inside a project config string or a package.json `scripts` value is wired in by configuration rather than a source import (an ESLint plugin named in `.eslintrc`, a tool named in a script). It is kept alive (never claimed) as a dependency-liveness keep-alive rationale. Deliberately generous: config matching only reduces recall, never adds a false positive.",
  },
  "capacitor-platform-dependency": {
    hazardClass: "capacitor-platform-dependency",
    scope: "none",
    activation: "always",
    cap: "medium",
    rationale:
      "In a Capacitor app (a `capacitor.config.{ts,js,mjs,cjs,json}` present at the workspace root), the native-platform packages `@capacitor/ios` and `@capacitor/android`, and the `@capacitor/cli`, exist solely so the Capacitor CLI (`npx cap sync`/`cap add`) can locate and copy the native iOS/Android platform code — they are NEVER imported from JS/TS in any Capacitor app, by design. A pure reference-graph view therefore always sees zero references and would false-flag them as unused dependencies. Keyed off the presence of a `capacitor.config.*` at the unit root, they are kept alive (never claimed) — the same config-marker-activated keep-alive class as the vite/next presets, restricted to the platform/CLI packages (Capacitor *plugins* such as `@capacitor/camera` DO expose a JS API and are left claimable).",
  },
  "elixir-behaviour-callback": {
    hazardClass: "elixir-behaviour-callback",
    scope: "symbol-set",
    activation: "always",
    cap: "no-claim",
    rationale:
      "An Elixir module that declares one or more behaviours (`@behaviour`, or `use GenServer`/`Supervisor`/`Agent`/`Task`/a custom behaviour, detected reflectively via the compiled module's `:behaviour` attributes) has its callback functions — `handle_call/3`, `init/1`, `child_spec/1`, and the rest — invoked reflectively by the OTP runtime or the behaviour dispatcher, never called by name from user source. A syntactic call-graph therefore sees zero callers and would false-flag every callback as unused. Because the frontend does not model which of a behaviour module's functions are callbacks versus ordinary helpers, the cap is deliberately the whole module's public-function surface (symbol-set): all of its function claims are suppressed (never emitted). The module's own file liveness is unaffected — a behaviour module referenced by nothing (not in any supervision tree, not aliased) is still claimable as a dead file.",
  },
  "elixir-dynamic-dispatch": {
    hazardClass: "elixir-dynamic-dispatch",
    scope: "project",
    activation: "carrier-reachable",
    cap: "medium",
    rationale:
      "When its carrier file is reachable from a production, config, test, or already-active dynamic-hazard scope, a file that performs dynamic dispatch — `apply/2,3`, `Kernel.apply`, `:erlang.apply/3`, or a `Module.concat`/`String.to_atom`-computed module target — can invoke at runtime a module and function that no static reference names. The resolved target is structurally invisible to the compiler tracer and to `mix xref` alike (confirmed in the ADR 0011 research). Since the computed target could be any module in the application, the whole workspace unit that owns the dispatching file is capped at medium confidence rather than any claim being suppressed outright: code is still surfaced, but never at `high` (a confident 'delete this') while an active `apply` might reach it. An unreachable carrier does not activate the hazard. Precise per-target resolution is post-v1; until then the unit-wide medium cap is the honest, false-positive-proof downgrade.",
  },
  "elixir-phoenix-runtime": {
    hazardClass: "elixir-phoenix-runtime",
    scope: "symbol-set",
    activation: "always",
    cap: "no-claim",
    rationale:
      "A Phoenix/OTP runtime-dispatch module — a `Phoenix.LiveView`/`Phoenix.LiveComponent`/`Phoenix.Channel`/`Phoenix.Endpoint`/`Phoenix.Router` behaviour implementation, or an Elixir protocol implementation (`defimpl`, detected via the compiled module's `__impl__/1`) or protocol definition (`__protocol__/1`) — exposes functions the framework or the protocol dispatcher calls by convention at runtime (`mount/3`, `handle_event/3`, `render/1`, a `defimpl` body dispatched by `Protocol.impl_for/1`), with no static caller anywhere. HEEx template component references, by contrast, ARE visible to the tracer (empirically confirmed in the ADR 0011 skeleton phase: `~H` and `.heex` component invocations compile to ordinary function calls the tracer records) and need no hazard. Like the behaviour-callback class, the whole module's public-function surface is suppressed (symbol-set, no-claim), because the frontend does not model which functions are the framework-called ones; the module's file liveness is unaffected.",
  },
  "rustler-ambiguous-registration": {
    hazardClass: "rustler-ambiguous-registration",
    scope: "symbol-set",
    activation: "carrier-reachable",
    cap: "no-claim",
    rationale:
      "A reachable Rust or Elixir source file uses Rustler registration syntax whose literal module/function/arity identity cannot be proven (for example a computed init module, an unsupported NIF rename, or duplicate loaders). Runtime dispatch may therefore reach any convention-exposed symbol in that file. Its symbol surface is not claimed; unrelated files remain fully analyzable. An unreachable carrier does not activate the hazard.",
  },
};

/** Strength order — a stronger cap wins when a subject is in multiple hazards' scope. */
const CAP_STRENGTH: Readonly<Record<ConfidenceCap, number>> = { medium: 1, low: 2, "no-claim": 3 };

/** `true` iff `a` is at least as strong (restrictive) as `b`. */
export function capIsStrongerOrEqual(a: ConfidenceCap, b: ConfidenceCap): boolean {
  return CAP_STRENGTH[a] >= CAP_STRENGTH[b];
}

/**
 * Registry entry for a hazard class, or `undefined` for any class not in the
 * closed vocabulary (the unregistered-class case the claim engine treats as
 * project-scope no-claim + a loud warning). Accepts a plain `string` so a
 * planted/unknown class is testable without a cast at the call site.
 */
export function lookupHazard(hazardClass: string): HazardClassEntry | undefined {
  return Object.hasOwn(HAZARD_REGISTRY, hazardClass)
    ? HAZARD_REGISTRY[hazardClass as HazardClass]
    : undefined;
}
