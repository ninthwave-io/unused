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
 *  - `project`          — the whole project (only reached via the unregistered-
 *                         class fallback in `claims.ts`; no registered class
 *                         uses it, but it is a valid, future-proof scope).
 *  - `directory-subtree`— every file whose repo-relative path starts with the
 *                         annotation's `subtreePrefix` (absent ⇒ `""` ⇒ the
 *                         importer's whole package). Caps the file claim AND any
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

export interface HazardClassEntry {
  readonly hazardClass: HazardClass;
  readonly scope: HazardScope;
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
    cap: "medium",
    rationale:
      "A dynamic import() with a computed specifier may resolve, at runtime, to any module under the specifier's static prefix (or the importer's whole package when there is no static prefix). Files in that subtree cannot be proven unreferenced, so they are capped at medium confidence.",
  },
  "computed-require": {
    hazardClass: "computed-require",
    scope: "directory-subtree",
    cap: "medium",
    rationale:
      "A require() with a computed (non-string-literal) argument may resolve, at runtime, to any module under the argument's static prefix (or the importer's whole package when there is no static prefix). Files in that subtree cannot be proven unreferenced, so they are capped at medium confidence.",
  },
  "computed-cjs-exports": {
    hazardClass: "computed-cjs-exports",
    scope: "symbol-set",
    cap: "medium",
    rationale:
      "A computed CommonJS export assignment (`module.exports[k] = …` / `exports[k] = …` under a runtime key) may re-expose any of the file's exports under a name static analysis cannot enumerate. The file's exports are capped at medium confidence; the file's own liveness is unaffected.",
  },
  "config-referenced-file": {
    hazardClass: "config-referenced-file",
    scope: "file",
    cap: "medium",
    rationale:
      "A source file named only as a string inside a project config file (e.g. a test runner's setupFiles) may be loaded by a tool the analyzer does not model. The file is capped at medium confidence rather than proven dead.",
  },
  "parse-error": {
    hazardClass: "parse-error",
    scope: "file",
    cap: "no-claim",
    rationale:
      "A file the parser could not fully read: its references cannot be enumerated, so it might reference anything and cannot itself be proven dead. It is never claimed; its importers keep any names they cannot resolve through it alive.",
  },
  "unresolvable-import": {
    hazardClass: "unresolvable-import",
    scope: "none",
    cap: "medium",
    rationale:
      "A static import specifier that resolved to nothing analyzable: the target is unknown, not a real project file, so it affects no other subject's claimability (the importing file's unrelated dead siblings stay claimable).",
  },
  "outside-project": {
    hazardClass: "outside-project",
    scope: "none",
    cap: "medium",
    rationale:
      "A specifier that resolves outside the analyzable project: the target is not a tracked file, so it affects no other subject's claimability.",
  },
  "internal-declaration": {
    hazardClass: "internal-declaration",
    scope: "none",
    cap: "medium",
    rationale:
      "A `.d.ts` declaration reached in place of a runtime module: kept alive in the graph via a keep-alive edge (reachability), never a claim-scoping annotation.",
  },
  "declaration-companion": {
    hazardClass: "declaration-companion",
    scope: "none",
    cap: "medium",
    rationale:
      "The `.d.ts` companion of an imported source file: kept alive in the graph via a keep-alive edge (reachability), never a claim-scoping annotation.",
  },
  "import-equals": {
    hazardClass: "import-equals",
    scope: "none",
    cap: "medium",
    rationale:
      "TS `import x = require(...)` / `import x = A.B` CJS interop: the resolvable module edge is emitted as a real reference; the marker is provenance only and scopes no claim.",
  },
  "export-assignment": {
    hazardClass: "export-assignment",
    scope: "none",
    cap: "medium",
    rationale:
      "TS `export = …` CJS interop: recorded for provenance (declaration merging etc.); the value reference is walked as a normal use-site, so the marker scopes no claim.",
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
