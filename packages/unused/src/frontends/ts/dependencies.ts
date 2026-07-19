/**
 * Dependency-claim computation for the TS/JS frontend (T4.1, phasing.md M4).
 *
 * Decides which **declared** dependencies (a workspace package.json's
 * `dependencies` map) are claimable `unused` and which are kept alive, then
 * hands core only the unused leftovers (core owns id/subject/confidence — see
 * `core/analysis/claims.ts`'s {@link DependencyClaimInput}). Dependency
 * liveness is ecosystem-specific — package.json, `@types`, JSX runtimes,
 * `workspace:` siblings, config/scripts wiring — so it lives in the frontend,
 * not core (ADR 0003).
 *
 * ## What counts as "referenced" (conservative-first)
 * A dependency is kept alive (never claimed) when it is referenced by a source
 * file — reachable OR unreachable (a dep imported only by dead code is a human
 * cascade decision, not our claim) — where "referenced" is any of:
 *  - an **external import** of the package name in a file owned by the workspace
 *    (a `references`→`dependency` edge whose site is in the unit);
 *  - a **triple-slash `/// <reference types="X" />` directive** — these live in
 *    comments and never become graph edges, so they are scanned separately (a
 *    prod dep pulled in only for its ambient types would otherwise false-flag);
 *  - a **cross-package reference** to a sibling workspace package — the
 *    `workspace:` case: imported by name (resolves internal, so it produces a
 *    file→file edge, not a dependency node) or by a relative path. A
 *    `workspace:` dep whose sibling is never referenced IS claimable;
 *  - **hoisting**: a dependency declared in the ROOT package.json hoists to every
 *    member, so it is alive if referenced by ANY unit; the same any-unit rule
 *    covers a member that redeclares a root-declared name (phantom hoisting).
 *
 * ## Keep-alive rules (each a registered hazard rationale — hazard-registry.ts)
 *  - **`@types/*` pairing (blunt v1)** — every `@types/*` dependency is kept
 *    alive whenever the project contains any TypeScript file. A blunt,
 *    false-positive-proof rule (a recall improvement — per-package `@types`
 *    pairing — is deferred). See `bin-only-dependency` / `config-named-dependency`
 *    / `jsx-runtime-dependency` in the registry for the rest.
 *  - **JSX runtime** — under an automatic-runtime tsconfig (`jsx: react-jsx`) the
 *    runtime package (`jsxImportSource` value, default `react`) is kept alive
 *    whenever any source file exists, since automatic JSX can live in `.js`/`.mjs`
 *    (CRA-style) as well as `.tsx`/`.jsx` (blunt, false-positive-proof).
 *  - **bin-only** — a dependency whose installed package.json declares a `bin`
 *    is a CLI run via scripts/hooks; kept alive. **Pre-install conservatism:** a
 *    dependency whose manifest cannot be read (no `node_modules` — an unbuilt or
 *    un-installed checkout) is treated as potentially-bin and kept alive, since
 *    we cannot rule out a CLI whose bin name differs from the package name. This
 *    does not apply to `workspace:` siblings (resolved by name, never a bin).
 *  - **config/scripts named** — a dependency whose name (or a conventional
 *    plugin/preset shorthand) appears as a token in a config string or a
 *    package.json `scripts` value is wired by config; kept alive.
 *
 * v1 scope: only `dependencies` are analysed. `devDependencies` liveness needs
 * script/tool modelling we do not have (a dev-only tool run by a task we do not
 * parse would false-positive), so they are out of scope — documented debt.
 * `peerDependencies`/`optionalDependencies` (their own semantics) are also out.
 */

import { readFileSync, statSync } from "node:fs";
import { join, posix, relative, sep } from "node:path";
import type { DependencyClaimInput } from "../../core/analysis/index.js";
import type { Loc } from "../../core/claims/index.js";
import type { IRGraph } from "../../core/ir/index.js";
import { packageNameOf } from "./resolve.js";

/** One workspace package unit dependency analysis reasons about. */
export interface DependencyUnit {
  /** Absolute path to the package directory. */
  readonly dir: string;
  /** POSIX, root-relative directory (`""` for the root package). */
  readonly rootRelDir: string;
  /** The package's `package.json` `name`, or `null`. */
  readonly name: string | null;
}

export interface DependencyAnalysisInput {
  /** Absolute analysis root. */
  readonly root: string;
  /** The package units (root + every workspace member). */
  readonly units: readonly DependencyUnit[];
  /** The built reference graph (referenced package names + cross-package edges). */
  readonly graph: IRGraph;
  /** Absolute paths of every discovered source file (for the TS-file test). */
  readonly files: readonly string[];
  /**
   * Discovered source file contents, keyed by absolute path — scanned for
   * triple-slash `/// <reference types="X" />` directives (comment-borne
   * dependency references that never become graph edges).
   */
  readonly fileContents: ReadonlyMap<string, string>;
  /**
   * Packages the JSX automatic runtime keeps alive (the `jsxImportSource` value
   * per unit with an automatic-runtime tsconfig, default `react`), already gated
   * on "any source file exists" by the composition layer — automatic JSX can
   * live in `.js`/`.mjs` as well as `.tsx`/`.jsx`, so this is not restricted to
   * JSX-extension files. Empty when no unit uses the automatic runtime.
   */
  readonly jsxRuntimePackages: ReadonlySet<string>;
  /**
   * Tokens extracted from every scanned config string and package.json `scripts`
   * value — the corpus a `config-named-dependency` keep-alive matches against.
   */
  readonly configTokens: ReadonlySet<string>;
  /**
   * POSIX root-relative paths of the discovered test files (the `test`
   * reachability roots). A dependency referenced ONLY from these files — and by
   * no production/config file and no keep-alive rule — is `test-only` rather
   * than `unused` (T5.2 point 4). Absent/empty ⇒ every reference counts as
   * production (pre-M5 behaviour).
   */
  readonly testFiles?: ReadonlySet<string>;
}

/**
 * The declared dependencies (across all units) that are claimable `unused` —
 * ready to hand to `emitClaims` as {@link DependencyClaimInput}s. Deterministic:
 * units in input order, dependencies in package.json key order.
 */
export function computeUnusedDependencies(input: DependencyAnalysisInput): DependencyClaimInput[] {
  const { units, graph } = input;
  const testFiles = input.testFiles ?? EMPTY_SET;
  const owner = ownerResolver(units);
  // Production (non-test) references keep a dependency fully alive; references
  // that come ONLY from test files make it `test-only` (T5.2 point 4). Both are
  // tracked per unit, split by whether the referencing site is a test file.
  const referencedExternalByUnit = units.map(() => new Set<string>());
  const crossRefByUnit = units.map(() => new Set<string>());
  const testReferencedExternalByUnit = units.map(() => new Set<string>());
  const testCrossRefByUnit = units.map(() => new Set<string>());

  for (const edge of graph.edges()) {
    if (edge.kind !== "references") continue;
    const target = graph.getNode(edge.to);
    if (target === undefined) continue;
    const fromUnit = owner(edge.site.file);
    const isTest = testFiles.has(edge.site.file);
    if (target.kind === "dependency") {
      // An external import of `packageName` from a file in `fromUnit`.
      if (fromUnit >= 0) {
        (isTest ? testReferencedExternalByUnit : referencedExternalByUnit)[fromUnit]?.add(
          target.packageName,
        );
      }
      continue;
    }
    // A reference into another workspace package's files (workspace: sibling use).
    const toFile =
      target.kind === "file" ? target.path : target.kind === "symbol" ? target.file : null;
    if (toFile === null || fromUnit < 0) continue;
    const toUnit = owner(toFile);
    if (toUnit < 0 || toUnit === fromUnit) continue;
    const toName = units[toUnit]?.name;
    if (toName != null) (isTest ? testCrossRefByUnit : crossRefByUnit)[fromUnit]?.add(toName);
  }

  // Triple-slash `/// <reference types="X" />` directives live in comments and
  // never become graph edges; scan them into the referencing file's unit,
  // split prod vs test by the directive's own file.
  addReferenceTypesDirectives(
    input,
    owner,
    testFiles,
    referencedExternalByUnit,
    testReferencedExternalByUnit,
  );

  // Hoisting: a root-declared dependency is alive if ANY unit references it
  // externally (root deps hoist to every member; the same any-unit test covers a
  // member that redeclares a root-declared name — phantom hoisting).
  const referencedExternalAnyUnit = unionOf(referencedExternalByUnit);
  const testReferencedExternalAnyUnit = unionOf(testReferencedExternalByUnit);
  const rootDeclaredNames = rootDeclaredDependencyNames(units);
  // Workspace member package names — governed by cross-package references, never
  // the external-import or pre-install-bin rules (a sibling is not a bin tool).
  const workspaceMemberNames = new Set(
    units.map((u) => u.name).filter((n): n is string => n !== null),
  );

  const anyTsFile = input.files.some((f) => TS_FILE_RE.test(f));

  const out: DependencyClaimInput[] = [];
  units.forEach((unit, unitIndex) => {
    const declared = readDeclaredDependencies(unit.dir);
    if (declared === null) return;
    const referencedExternal = referencedExternalByUnit[unitIndex] ?? EMPTY_SET;
    const crossRef = crossRefByUnit[unitIndex] ?? EMPTY_SET;
    const testReferencedExternal = testReferencedExternalByUnit[unitIndex] ?? EMPTY_SET;
    const testCrossRef = testCrossRefByUnit[unitIndex] ?? EMPTY_SET;
    const pkgFileRel =
      unit.rootRelDir === "" ? "package.json" : posix.join(unit.rootRelDir, "package.json");

    for (const depName of declared.names) {
      const isSibling = workspaceMemberNames.has(depName);
      // A keep-alive rule or a production/config reference keeps the dependency
      // fully alive (never claimed).
      const prodAlive =
        referencedExternal.has(depName) ||
        crossRef.has(depName) ||
        (rootDeclaredNames.has(depName) && referencedExternalAnyUnit.has(depName)) ||
        (depName.startsWith("@types/") && anyTsFile) ||
        input.jsxRuntimePackages.has(depName) ||
        isConfigNamed(depName, input.configTokens) ||
        (!isSibling && isMaybeBinDependency(depName, unit.dir, input.root));
      if (prodAlive) continue;

      // Not production-alive: `test-only` if a test file references it, else
      // `unused` (referenced by nothing at all).
      const testRef =
        testReferencedExternal.has(depName) ||
        testCrossRef.has(depName) ||
        (rootDeclaredNames.has(depName) && testReferencedExternalAnyUnit.has(depName));

      // `subject.loc.package` is stamped by the composition layer's
      // `annotateClaimPackages` post-pass (the single source of truth for every
      // claim kind in a monorepo), which owns this package.json path to its unit.
      const line = declared.lines.get(depName) ?? 1;
      const loc: Loc = { file: pkgFileRel, span: [line, line] };
      out.push({ packageName: depName, loc, verdict: testRef ? "test-only" : "unused" });
    }
  });

  return out;
}

/** Union of every unit's referenced-external package names (for hoisting). */
function unionOf(sets: readonly Set<string>[]): Set<string> {
  const union = new Set<string>();
  for (const set of sets) for (const name of set) union.add(name);
  return union;
}

/** The `dependencies` names declared by the root package (`rootRelDir === ""`). */
function rootDeclaredDependencyNames(units: readonly DependencyUnit[]): Set<string> {
  const rootUnit = units.find((u) => u.rootRelDir === "");
  const declared = rootUnit ? readDeclaredDependencies(rootUnit.dir) : null;
  return new Set(declared?.names ?? []);
}

// ---------------------------------------------------------------------------
// Triple-slash reference-types directives (comment-borne dependency references)
// ---------------------------------------------------------------------------

/** `/// <reference types="X" />` — a comment directive that pulls in a package's ambient types. */
const REFERENCE_TYPES_RE = /\/\/\/\s*<reference\s+types\s*=\s*["']([^"']+)["']\s*\/>/g;

/**
 * Scan every discovered source file's contents for `/// <reference types="X" />`
 * directives and record `X` as an external reference in the owning unit — the
 * directive is a real dependency use that carries no import edge (a prod dep
 * referenced solely this way would otherwise false-flag). A directive in a test
 * file routes to the test bucket, so a dep pulled in only by a test this way is
 * `test-only`, not fully alive (T5.2). Values that are paths (`./local.d.ts`),
 * not package names, are ignored.
 */
function addReferenceTypesDirectives(
  input: DependencyAnalysisInput,
  owner: (fileRel: string) => number,
  testFiles: ReadonlySet<string>,
  referencedExternalByUnit: readonly Set<string>[],
  testReferencedExternalByUnit: readonly Set<string>[],
): void {
  for (const [abs, content] of input.fileContents) {
    if (!content.includes("<reference")) continue; // cheap pre-filter
    const fileRel = toPosixRel(input.root, abs);
    const unitIndex = owner(fileRel);
    if (unitIndex < 0) continue;
    const bucket = (
      testFiles.has(fileRel) ? testReferencedExternalByUnit : referencedExternalByUnit
    )[unitIndex];
    if (bucket === undefined) continue;
    REFERENCE_TYPES_RE.lastIndex = 0;
    let match: RegExpExecArray | null = REFERENCE_TYPES_RE.exec(content);
    while (match !== null) {
      const pkg = match[1] !== undefined ? packageNameOf(match[1]) : null;
      if (pkg !== null) bucket.add(pkg);
      match = REFERENCE_TYPES_RE.exec(content);
    }
  }
}

// ---------------------------------------------------------------------------
// Workspace ownership (deepest unit whose directory contains a file)
// ---------------------------------------------------------------------------

/**
 * Returns a resolver mapping a POSIX root-relative file path to the index of the
 * unit that owns it (the deepest `rootRelDir` prefix; the root unit `""` owns
 * everything else), or `-1` when no unit owns it.
 */
function ownerResolver(units: readonly DependencyUnit[]): (fileRel: string) => number {
  const byDepth = units
    .map((unit, index) => ({ index, rootRelDir: unit.rootRelDir }))
    .sort((a, b) => b.rootRelDir.length - a.rootRelDir.length);
  return (fileRel: string): number => {
    for (const { index, rootRelDir } of byDepth) {
      if (rootRelDir === "" || fileRel === rootRelDir || fileRel.startsWith(`${rootRelDir}/`)) {
        return index;
      }
    }
    return -1;
  };
}

// ---------------------------------------------------------------------------
// package.json `dependencies` reading (names + best-effort line spans)
// ---------------------------------------------------------------------------

interface DeclaredDependencies {
  readonly names: readonly string[];
  /** dependency name → 1-based line of its entry in package.json (best-effort). */
  readonly lines: ReadonlyMap<string, number>;
}

const DEP_KEY_RE = /"([^"]+)"\s*:/;
const DEPENDENCIES_OPEN_RE = /"dependencies"\s*:\s*\{/;

/** Read a unit's `dependencies` names + line spans, or `null` when unreadable/absent. */
function readDeclaredDependencies(dir: string): DeclaredDependencies | null {
  let raw: string;
  try {
    raw = readFileSync(join(dir, "package.json"), "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const deps = (parsed as { dependencies?: unknown } | null)?.dependencies;
  if (deps === null || typeof deps !== "object" || Array.isArray(deps)) return null;
  const names = Object.keys(deps as Record<string, unknown>);
  if (names.length === 0) return null;
  return { names, lines: dependencyLineMap(raw, new Set(names)) };
}

/**
 * Map each dependency name to the 1-based line of its entry inside the
 * `dependencies` object (span = the dependency line, per the T4.1 loc contract).
 * Best-effort and bounded to the `dependencies` block by brace tracking, so a
 * same-named `devDependencies` entry is not matched. Any name not located falls
 * back to `[1, 1]` at the call site.
 */
function dependencyLineMap(raw: string, wanted: ReadonlySet<string>): Map<string, number> {
  const lines = raw.split(/\r\n|\r|\n/);
  const map = new Map<string, number>();
  let inBlock = false;
  let depth = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] as string;
    if (!inBlock) {
      if (DEPENDENCIES_OPEN_RE.test(line)) {
        inBlock = true;
        depth = 1; // the `dependencies` object opened on this line
      }
      continue;
    }
    const match = DEP_KEY_RE.exec(line);
    if (match?.[1] !== undefined && wanted.has(match[1]) && !map.has(match[1])) {
      map.set(match[1], i + 1);
    }
    for (const ch of line) {
      if (ch === "{") depth += 1;
      else if (ch === "}") depth -= 1;
    }
    if (depth <= 0) break; // closed the `dependencies` object
  }
  return map;
}

// ---------------------------------------------------------------------------
// Keep-alive rules
// ---------------------------------------------------------------------------

const TS_FILE_RE = /\.(?:ts|tsx|mts|cts)$/i;

const EMPTY_SET: ReadonlySet<string> = new Set();

/**
 * Is `depName` (or a conventional plugin/preset shorthand of it) present in the
 * scanned config/scripts token set? Deliberately generous — over-keeping a
 * dependency alive only costs recall, never a false positive.
 */
function isConfigNamed(depName: string, tokens: ReadonlySet<string>): boolean {
  if (tokens.has(depName)) return true;
  for (const shorthand of pluginShorthands(depName)) {
    if (tokens.has(shorthand)) return true;
  }
  return false;
}

const UNSCOPED_SHORTHAND_PREFIXES = [
  "eslint-plugin-",
  "eslint-config-",
  "babel-plugin-",
  "babel-preset-",
  "stylelint-config-",
  "postcss-",
];
const SCOPED_SHORTHAND_INFIXES = ["eslint-plugin", "eslint-config", "plugin", "preset"];

/**
 * The conventional shorthand name(s) a config might reference a plugin/preset by
 * (ESLint/Babel/PostCSS ecosystem conventions), e.g. `eslint-plugin-react` → `react`,
 * `@scope/eslint-plugin-x` → `@scope/x`, `@scope/eslint-plugin` → `@scope`,
 * `@babel/preset-env` → `@babel/env`.
 */
function pluginShorthands(name: string): string[] {
  const out: string[] = [];
  if (name.startsWith("@")) {
    const slash = name.indexOf("/");
    if (slash <= 0) return out;
    const scope = name.slice(0, slash);
    const rest = name.slice(slash + 1);
    for (const infix of SCOPED_SHORTHAND_INFIXES) {
      if (rest === infix) out.push(scope);
      else if (rest.startsWith(`${infix}-`)) out.push(`${scope}/${rest.slice(infix.length + 1)}`);
    }
    return out;
  }
  for (const prefix of UNSCOPED_SHORTHAND_PREFIXES) {
    if (name.startsWith(prefix) && name.length > prefix.length) out.push(name.slice(prefix.length));
  }
  return out;
}

/**
 * Should `depName` be kept alive because it is (or, pre-install, might be) a
 * `bin` CLI? Reads the installed manifest from the unit's own `node_modules`
 * first, then the root's (hoisting):
 *  - installed manifest with a non-empty `bin` ⇒ kept alive (a CLI run via a
 *    script/hook, with no source import);
 *  - installed manifest with no `bin` ⇒ NOT kept alive here (claimable);
 *  - **manifest not readable**: if `node_modules` exists (installed) the package
 *    is genuinely absent ⇒ claimable; if no `node_modules` exists at all
 *    (pre-install / unbuilt checkout) we cannot rule out a CLI whose bin name
 *    differs from the package name and which is not named in scripts, so we keep
 *    it alive — documented pre-install conservatism (favours zero false
 *    positives over recall, per the top quality metric).
 */
function isMaybeBinDependency(depName: string, unitDir: string, root: string): boolean {
  const segments = depName.split("/");
  const bases = unitDir === root ? [root] : [unitDir, root];
  let sawNodeModules = false;
  for (const base of bases) {
    const nodeModules = join(base, "node_modules");
    if (isDirectory(nodeModules)) sawNodeModules = true;
    let pkg: unknown;
    try {
      pkg = JSON.parse(readFileSync(join(nodeModules, ...segments, "package.json"), "utf8"));
    } catch {
      continue; // not installed at this base
    }
    const bin = (pkg as { bin?: unknown } | null)?.bin;
    if (typeof bin === "string" && bin.length > 0) return true;
    if (bin !== null && typeof bin === "object" && Object.keys(bin as object).length > 0)
      return true;
    return false; // installed here, definitively no bin ⇒ claimable
  }
  // Manifest not found anywhere: pre-install (no node_modules) ⇒ conservative
  // keep-alive; installed but package absent ⇒ claimable.
  return !sawNodeModules;
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** Absolute path → POSIX, root-relative. */
function toPosixRel(root: string, abs: string): string {
  return relative(root, abs).split(sep).join("/");
}

// ---------------------------------------------------------------------------
// Config-token extraction (used by the composition layer to build configTokens)
// ---------------------------------------------------------------------------

/**
 * Tokenize a config/script string into the identifier-ish tokens a dependency
 * name could match: split on non-name characters, then also split each token on
 * `/` so a `plugin:react/recommended`-style value yields `react`. Deliberately
 * loose — a superset only costs recall.
 */
export function addConfigTokens(target: Set<string>, value: string): void {
  for (const token of value.split(/[^A-Za-z0-9_@./-]+/)) {
    if (token === "") continue;
    target.add(token);
    if (token.includes("/")) {
      for (const segment of token.split("/")) if (segment !== "") target.add(segment);
    }
  }
}
