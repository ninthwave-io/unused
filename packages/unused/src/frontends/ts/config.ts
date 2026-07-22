/**
 * `unused.config.jsonc` — config file discovery, parsing, and validation
 * (T4.3, phasing.md M4, PRD §6, ADR 0010).
 *
 * ## Format (ADR 0010)
 * JSONC only (`unused.config.jsonc`, also `unused.config.json`); no
 * `unused.config.ts` — the analyzer never executes user code. Comments and
 * trailing commas are stripped by the hand-rolled {@link stripJsonComments}
 * (`jsonc.ts`), never a general-purpose parser dependency.
 *
 * ## Fields (PRD §6)
 * `entry` (file globs, ADDITIVE to zero-config auto-detection — T2.3's frozen
 * no-config contract is untouched; this layers new production entrypoints on
 * top), `entrySymbols` (strict language/file/exportedName roots that keep one
 * exact public operation alive without making sibling exports surface-live),
 * `project` (globs narrowing what can be CLAIMED without removing graph
 * nodes or edges), `suppressions` (structured file-glob + claim-kind policy,
 * applied to emitted claims with a mandatory reason),
 * `ignoreDependencies` (names/glob patterns excluded from dependency-unused
 * claims), `workspaces` (per-package `{ entry?, entrySymbols?, project?, suppressions? }`
 * overrides, ADDITIVE to the root-level globs for that package's own files),
 * `gate: { threshold }` (parsed and validated now; consumed by `unused check`
 * at M7 — this module does not read it), `presets` (an array naming T4.4
 * framework presets; presence — even `[]` — FORCES exactly that preset set,
 * overriding auto-detection; absence leaves auto-detection in charge),
 * `ciSecondsPerTestFile` (a positive number overriding the T5.3 zombie-test
 * CI-seconds average — docs/design/report-and-badge.md §3 — default 5,
 * `core/claims/summary.ts`'s `DEFAULT_CI_SECONDS_PER_TEST_FILE`; consumed by
 * `analyze.ts`'s `computeSummary` call, this module only parses/validates it).
 *
 * ## Graph visibility vs reporting policy
 * **`project` = claimability scope, not visibility.** A file outside
 * `project` is still discovered, parsed, and represented in the reference
 * graph. Its edges remain available for truthful reachability and
 * counterfactual analysis, but the file does not become a production root
 * merely because it is outside claim scope. A dead out-of-project importer
 * therefore does not keep its target live; a reachable one does. `project`
 * only decides which files may receive a claim. Suppressions are later still:
 * they mark matching claims but never affect reachability, hazards, or
 * dependency evidence.
 *
 * ## Precedence (PRD §6)
 * flags > config > defaults. The only flag today is `--config <path>`, which
 * selects *which file* is loaded (`AnalyzeOptions.configPath`); there is no
 * flag yet that overrides an individual field's *value* (that lands with the
 * M6 flag surface). No config file present ⇒ {@link EMPTY_CONFIG}, under
 * which every function in this module is a documented no-op — this is the
 * T4.3 no-config regression contract (see `analyze.ts`).
 *
 * ## Validation errors (cli-ux §6)
 * `validateConfig` fails on the FIRST problem found (one-line error + the
 * exact fix, matching the "Config/usage error (exit 3)" contract) rather than
 * accumulating a report — config errors are rare and the fix is local, so
 * there is little value in a multi-error batch, and a single, always-present
 * message is easier to test and to write CLI copy against.
 */

import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { join, resolve as resolvePath } from "node:path";
import type { Claim, SubjectKind } from "../../core/claims/index.js";
import { globToRegExp } from "./glob.js";
import { stripJsonComments } from "./jsonc.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type GateThreshold = "high" | "medium" | "low";

/**
 * The framework presets known in v1 (PRD §6). `vite`/`next` shipped at M4; the
 * reference-codebase real-customer smoke round added `storybook` (auto-discovered
 * `.stories.*` files are live via `.storybook/main`'s glob) and `cdk` (an AWS
 * CDK app's entrypoint is declared in `cdk.json#app`, not `package.json`).
 */
export type PresetName = "vite" | "next" | "storybook" | "cdk";

/** Language ids accepted by exact configured symbol entrypoints. */
export type EntrySymbolLanguage = "ts" | "ex" | "rs";

/** An exact, auditable public operation rooted by configuration. */
export interface EntrySymbolRule {
  readonly language: EntrySymbolLanguage;
  readonly file: string;
  readonly name: string;
  readonly reason: string;
}

export interface WorkspaceConfigOverride {
  readonly entry: readonly string[];
  readonly entrySymbols?: readonly EntrySymbolRule[];
  readonly project: readonly string[];
  readonly suppressions: readonly SuppressionRule[];
}

export interface SuppressionRule {
  /** Globs matched root-relative, or package-relative inside a workspace override. */
  readonly files: readonly string[];
  /** Explicit claim kinds this policy suppresses. */
  readonly kinds: readonly SubjectKind[];
  /** Mandatory human explanation carried into JSON and SARIF. */
  readonly reason: string;
}

export interface GateConfig {
  readonly threshold: GateThreshold;
}

export interface UnusedConfig {
  readonly entry: readonly string[];
  readonly entrySymbols: readonly EntrySymbolRule[];
  readonly project: readonly string[];
  readonly suppressions: readonly SuppressionRule[];
  readonly ignoreDependencies: readonly string[];
  readonly workspaces: Readonly<Record<string, WorkspaceConfigOverride>>;
  /** Parsed + validated; consumed by `unused check` at M7, not read here. */
  readonly gate: GateConfig | undefined;
  /** `undefined` ⇒ not specified (auto-detection decides); present (even `[]`) ⇒ forced. */
  readonly presets: readonly PresetName[] | undefined;
  /**
   * T5.3 zombie-test CI-seconds average override (a positive number of
   * seconds; report-and-badge.md §3). `undefined` ⇒
   * `DEFAULT_CI_SECONDS_PER_TEST_FILE` (`core/claims/summary.ts`).
   */
  readonly ciSecondsPerTestFile: number | undefined;
}

/** The zero-config default — every function in this module is a no-op against it (T4.3 regression contract). */
export const EMPTY_CONFIG: UnusedConfig = {
  entry: [],
  entrySymbols: [],
  project: [],
  suppressions: [],
  ignoreDependencies: [],
  workspaces: {},
  gate: undefined,
  presets: undefined,
  ciSecondsPerTestFile: undefined,
};

/**
 * A deterministic hash of the resolved effective config (PRD §4
 * `run.configHash`; docs/phasing.md M7 T7.2 "configHash under-hashing" debt,
 * closed here) — covers every field {@link UnusedConfig} carries: `entry`,
 * `entrySymbols`, `project`, `suppressions`, `ignoreDependencies`, `workspaces` overrides,
 * `presets`, `gate`, `ciSecondsPerTestFile`.
 *
 * An earlier version hashed the resolved production-entrypoint set derived
 * from the IR graph instead of the config itself: it both **under-counted**
 * (a config that only changes `suppressions`/`project`/`gate`/`ciSecondsPerTestFile`
 * never touches the entrypoint set, so the hash silently failed to reflect a
 * real config change) and **over-counted** (the entrypoint set also shifts on
 * incidental preset-detection/wildcard-export changes unrelated to config,
 * churning the hash for reasons a baseline consumer cannot explain). Hashing
 * the config directly fixes both: `unused check` (M7) can trust
 * `run.configHash` as a genuine "did the config change since this baseline"
 * signal, not an approximation.
 *
 * Stable serialisation: array fields are copied in their declared order
 * (order is part of the resolved config, not normalised away) and the
 * `workspaces` map is emitted key-sorted so JSON key-insertion order (which
 * follows the source file, not the map's semantics) never perturbs the hash.
 * {@link EMPTY_CONFIG} (the zero-config default) always hashes to the same
 * value — the "no-config hash stays stable across runs" contract — since
 * every field is empty/`undefined` regardless of which repo it came from.
 */
export function computeConfigHash(config: UnusedConfig): string {
  const payload = JSON.stringify(canonicalConfigForHash(config));
  return createHash("sha256").update(payload, "utf8").digest("hex").slice(0, 12);
}

function canonicalConfigForHash(config: UnusedConfig): unknown {
  const workspaceKeys = Object.keys(config.workspaces).sort();
  return {
    entry: [...config.entry],
    ...(config.entrySymbols.length === 0
      ? {}
      : { entrySymbols: config.entrySymbols.map(canonicalEntrySymbol) }),
    project: [...config.project],
    suppressions: config.suppressions.map(canonicalSuppression),
    ignoreDependencies: [...config.ignoreDependencies],
    workspaces: workspaceKeys.map((key) => {
      const override = config.workspaces[key] as WorkspaceConfigOverride;
      return {
        key,
        entry: [...override.entry],
        ...((override.entrySymbols?.length ?? 0) === 0
          ? {}
          : { entrySymbols: override.entrySymbols?.map(canonicalEntrySymbol) }),
        project: [...override.project],
        suppressions: override.suppressions.map(canonicalSuppression),
      };
    }),
    gate: config.gate === undefined ? null : { threshold: config.gate.threshold },
    presets: config.presets === undefined ? null : [...config.presets],
    ciSecondsPerTestFile: config.ciSecondsPerTestFile ?? null,
  };
}

function canonicalEntrySymbol(rule: EntrySymbolRule): unknown {
  return { language: rule.language, file: rule.file, name: rule.name, reason: rule.reason };
}

function canonicalSuppression(rule: SuppressionRule): unknown {
  return { files: [...rule.files], kinds: [...rule.kinds], reason: rule.reason };
}

/**
 * Thrown by {@link loadConfig} for anything the CLI should report as a usage
 * error (PRD §3 exit 3): a missing `--config` target, unreadable file,
 * malformed JSON/JSONC, or a schema violation. `message` is already the
 * complete one-line-plus-fix text (cli-ux §6); the CLI prints it verbatim.
 */
export class ConfigError extends Error {
  readonly code = "CONFIG_ERROR";
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

// ---------------------------------------------------------------------------
// Discovery + loading
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG_FILENAMES = ["unused.config.jsonc", "unused.config.json"] as const;

/**
 * Find the config file to load: `explicitPath` (the `--config` flag,
 * resolved against `root`) when given — missing there is a usage error, never
 * a silent fall-through to auto-discovery — otherwise the first of
 * {@link DEFAULT_CONFIG_FILENAMES} that exists at `root`. `null` ⇒ no config
 * file (the zero-config path).
 */
export async function findConfigFile(root: string, explicitPath?: string): Promise<string | null> {
  if (explicitPath !== undefined) {
    const abs = resolvePath(root, explicitPath);
    if (!(await isReadableFile(abs))) {
      throw new ConfigError(
        `--config points to a file that does not exist or is not readable: ${explicitPath}. ` +
          "Fix: check the path (resolved against the analysis root), or drop --config to use auto-discovery.",
      );
    }
    return abs;
  }
  for (const name of DEFAULT_CONFIG_FILENAMES) {
    const abs = join(root, name);
    if (await isReadableFile(abs)) return abs;
  }
  return null;
}

/**
 * Load and validate the config for an analysis rooted at `root`. Returns
 * {@link EMPTY_CONFIG} when no config file is found (and no `--config` was
 * given) — the zero-config path stays byte-identical (T4.3 regression bar).
 * Throws {@link ConfigError} for a missing `--config` target, an unreadable
 * file, malformed JSON/JSONC, or any schema violation.
 */
export async function loadConfig(root: string, explicitPath?: string): Promise<UnusedConfig> {
  const path = await findConfigFile(root, explicitPath);
  if (path === null) return EMPTY_CONFIG;
  const display = displayPath(root, path);

  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    throw new ConfigError(`could not read ${display}: ${errMessage(err)}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonComments(raw));
  } catch (err) {
    throw new ConfigError(
      `${display} is not valid JSON/JSONC (${errMessage(err)}). ` +
        "Fix: check for a missing/extra comma, an unmatched brace, or an unquoted key.",
    );
  }

  return validateConfig(parsed, display);
}

// ---------------------------------------------------------------------------
// Validation (hand-rolled — mirrors schema/unused-config.schema.json)
// ---------------------------------------------------------------------------

const ALLOWED_TOP_LEVEL = new Set([
  "entry",
  "entrySymbols",
  "project",
  "suppressions",
  "ignoreDependencies",
  "workspaces",
  "gate",
  "presets",
  "ciSecondsPerTestFile",
]);
const ALLOWED_WORKSPACE_OVERRIDE_KEYS = new Set([
  "entry",
  "entrySymbols",
  "project",
  "suppressions",
]);
const ALLOWED_ENTRY_SYMBOL_KEYS = new Set(["language", "file", "name", "reason"]);
const ENTRY_SYMBOL_LANGUAGES: readonly EntrySymbolLanguage[] = ["ts", "ex", "rs"];
const ALLOWED_GATE_KEYS = new Set(["threshold"]);
const GATE_THRESHOLDS: readonly GateThreshold[] = ["high", "medium", "low"];
const PRESET_NAMES: readonly PresetName[] = ["vite", "next", "storybook", "cdk"];
const CLAIM_KINDS: readonly SubjectKind[] = ["export", "file", "dependency", "endpoint", "test"];

/**
 * Validate a parsed JSON value against the config contract, throwing
 * {@link ConfigError} (one-line error + fix, cli-ux §6) on the first problem.
 * `displayPath` is the already-relativized path shown in error text.
 */
export function validateConfig(parsed: unknown, displayPath: string): UnusedConfig {
  const fail = (field: string, problem: string, fix: string): never => {
    throw new ConfigError(`${displayPath}: field "${field}" ${problem}. Fix: ${fix}`);
  };

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return fail("<root>", "must be a JSON object", "wrap the config in { ... }");
  }
  const obj = parsed as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (!ALLOWED_TOP_LEVEL.has(key)) {
      fail(
        key,
        "is not a recognised config field",
        `remove it (typo?) — valid fields are ${[...ALLOWED_TOP_LEVEL].join(", ")}`,
      );
    }
  }

  const entry = readGlobArray(obj, "entry", fail);
  const entrySymbols = readEntrySymbols(obj, "entrySymbols", fail);
  const project = readGlobArray(obj, "project", fail);
  const suppressions = readSuppressions(obj, "suppressions", fail);
  const ignoreDependencies = readGlobArray(obj, "ignoreDependencies", fail);
  const workspaces = readWorkspaces(obj, fail);
  const gate = readGate(obj, fail);
  const presets = readPresets(obj, fail);
  const ciSecondsPerTestFile = readCiSecondsPerTestFile(obj, fail);

  return {
    entry,
    entrySymbols,
    project,
    suppressions,
    ignoreDependencies,
    workspaces,
    gate,
    presets,
    ciSecondsPerTestFile,
  };
}

type Fail = (field: string, problem: string, fix: string) => never;

function readGlobArray(obj: Record<string, unknown>, key: string, fail: Fail): readonly string[] {
  const value = obj[key];
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    return fail(key, "must be an array of strings", `use e.g. "${key}": ["src/**/*.ts"]`);
  }
  value.forEach((item, i) => {
    if (typeof item !== "string" || item === "") {
      fail(`${key}[${i}]`, "must be a non-empty string", `use e.g. "${key}": ["src/**/*.ts"]`);
    }
  });
  return value as string[];
}

function readWorkspaces(
  obj: Record<string, unknown>,
  fail: Fail,
): Readonly<Record<string, WorkspaceConfigOverride>> {
  const value = obj["workspaces"];
  if (value === undefined) return {};
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return fail(
      "workspaces",
      "must be an object keyed by package directory or name",
      'use e.g. "workspaces": { "packages/api": { "entry": ["src/server.ts"] } }',
    );
  }
  const out: Record<string, WorkspaceConfigOverride> = {};
  for (const [pkgKey, pkgValue] of Object.entries(value as Record<string, unknown>)) {
    if (pkgValue === null || typeof pkgValue !== "object" || Array.isArray(pkgValue)) {
      fail(
        `workspaces.${pkgKey}`,
        "must be an object",
        `use e.g. "workspaces": { "${pkgKey}": { "entry": [...] } }`,
      );
    }
    const pkgObj = pkgValue as Record<string, unknown>;
    for (const nestedKey of Object.keys(pkgObj)) {
      if (!ALLOWED_WORKSPACE_OVERRIDE_KEYS.has(nestedKey)) {
        fail(
          `workspaces.${pkgKey}.${nestedKey}`,
          "is not a recognised workspace-override field",
          `valid fields are ${[...ALLOWED_WORKSPACE_OVERRIDE_KEYS].join(", ")}`,
        );
      }
    }
    out[pkgKey] = {
      entry: readGlobArray(pkgObj, "entry", (f, p, x) => fail(`workspaces.${pkgKey}.${f}`, p, x)),
      entrySymbols: readEntrySymbols(pkgObj, "entrySymbols", (f, p, x) =>
        fail(`workspaces.${pkgKey}.${f}`, p, x),
      ),
      project: readGlobArray(pkgObj, "project", (f, p, x) =>
        fail(`workspaces.${pkgKey}.${f}`, p, x),
      ),
      suppressions: readSuppressions(pkgObj, "suppressions", (f, p, x) =>
        fail(`workspaces.${pkgKey}.${f}`, p, x),
      ),
    };
  }
  return out;
}

function readEntrySymbols(
  obj: Record<string, unknown>,
  key: string,
  fail: Fail,
): readonly EntrySymbolRule[] {
  const value = obj[key];
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    return fail(
      key,
      "must be an array of exact symbol entrypoints",
      `use e.g. "${key}": [{ "language": "ts", "file": "src/api.ts", "name": "run", "reason": "public API" }]`,
    );
  }

  const seen = new Set<string>();
  return value.map((item, index) => {
    const field = `${key}[${index}]`;
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      return fail(field, "must be an object", "provide language, file, name, and reason fields");
    }
    const rule = item as Record<string, unknown>;
    for (const nestedKey of Object.keys(rule)) {
      if (!ALLOWED_ENTRY_SYMBOL_KEYS.has(nestedKey)) {
        fail(
          `${field}.${nestedKey}`,
          "is not recognised",
          "valid fields are language, file, name, reason",
        );
      }
    }
    for (const required of ALLOWED_ENTRY_SYMBOL_KEYS) {
      if (!(required in rule)) {
        fail(`${field}.${required}`, "is required", `add the ${required} field`);
      }
    }
    const language = rule["language"];
    if (
      typeof language !== "string" ||
      !ENTRY_SYMBOL_LANGUAGES.includes(language as EntrySymbolLanguage)
    ) {
      fail(
        `${field}.language`,
        `must be one of ${ENTRY_SYMBOL_LANGUAGES.join(", ")}`,
        'use "ts", "ex", or "rs"',
      );
    }
    const file = rule["file"];
    if (typeof file !== "string" || !isCanonicalRelativeFile(file)) {
      fail(
        `${field}.file`,
        "must be an exact canonical POSIX relative file path without globs",
        'use e.g. "src/api.ts" (no leading slash, backslashes, . or .. segments, or glob syntax)',
      );
    }
    const name = rule["name"];
    if (typeof name !== "string" || name.trim() === "") {
      fail(`${field}.name`, "must be a non-blank exact exported symbol name", 'use e.g. "run"');
    }
    const reason = rule["reason"];
    if (typeof reason !== "string" || reason.trim() === "") {
      fail(`${field}.reason`, "must be a non-blank explanation", "say why this symbol is public");
    }
    const selector = `${language}\0${file}\0${name}`;
    if (seen.has(selector)) {
      fail(
        field,
        "duplicates an earlier entrySymbols selector",
        "keep exactly one rule for each language, file, and name",
      );
    }
    seen.add(selector);
    return {
      language: language as EntrySymbolLanguage,
      file: file as string,
      name: name as string,
      reason: reason as string,
    };
  });
}

function isCanonicalRelativeFile(file: string): boolean {
  if (file === "" || file.trim() === "" || file.includes("\\") || file.includes("\0")) {
    return false;
  }
  if (file.startsWith("/") || /^[A-Za-z]:/.test(file) || /[*?{}[\]]/.test(file)) return false;
  const segments = file.split("/");
  return !segments.some((segment) => segment === "" || segment === "." || segment === "..");
}

function readSuppressions(
  obj: Record<string, unknown>,
  key: string,
  fail: Fail,
): readonly SuppressionRule[] {
  const value = obj[key];
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    return fail(
      key,
      "must be an array of suppression rules",
      `use e.g. "${key}": [{ "files": ["src/generated/**"], "kinds": ["file"], "reason": "generated" }]`,
    );
  }
  return value.map((item, index) => {
    const field = `${key}[${index}]`;
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      return fail(field, "must be an object", "provide files, kinds, and reason fields");
    }
    const rule = item as Record<string, unknown>;
    const allowed = new Set(["files", "kinds", "reason"]);
    for (const nestedKey of Object.keys(rule)) {
      if (!allowed.has(nestedKey)) {
        fail(`${field}.${nestedKey}`, "is not recognised", "valid fields are files, kinds, reason");
      }
    }
    const files = rule["files"];
    if (!Array.isArray(files) || files.length === 0) {
      fail(
        `${field}.files`,
        "must be a non-empty array of glob strings",
        'use e.g. ["src/generated/**"]',
      );
    }
    files.forEach((file, fileIndex) => {
      if (typeof file !== "string" || file === "") {
        fail(
          `${field}.files[${fileIndex}]`,
          "must be a non-empty glob string",
          'use e.g. "src/generated/**"',
        );
      }
    });
    const kinds = rule["kinds"];
    if (!Array.isArray(kinds) || kinds.length === 0) {
      fail(
        `${field}.kinds`,
        "must be a non-empty array of claim kinds",
        `valid kinds are ${CLAIM_KINDS.join(", ")}`,
      );
    }
    kinds.forEach((kind, kindIndex) => {
      if (typeof kind !== "string" || !CLAIM_KINDS.includes(kind as SubjectKind)) {
        fail(
          `${field}.kinds[${kindIndex}]`,
          `must be one of ${CLAIM_KINDS.join(", ")}`,
          'use e.g. ["file", "export"]',
        );
      }
    });
    if (typeof rule["reason"] !== "string" || rule["reason"].trim() === "") {
      fail(
        `${field}.reason`,
        "must be a non-empty explanation",
        "say why this policy is necessary",
      );
    }
    return {
      files: files as string[],
      kinds: kinds as SubjectKind[],
      reason: rule["reason"] as string,
    };
  });
}

function readGate(obj: Record<string, unknown>, fail: Fail): GateConfig | undefined {
  const value = obj["gate"];
  if (value === undefined) return undefined;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return fail("gate", "must be an object", 'use e.g. "gate": { "threshold": "high" }');
  }
  const gateObj = value as Record<string, unknown>;
  for (const key of Object.keys(gateObj)) {
    if (!ALLOWED_GATE_KEYS.has(key)) {
      fail(`gate.${key}`, "is not a recognised gate field", 'the only valid field is "threshold"');
    }
  }
  const threshold = gateObj["threshold"];
  if (typeof threshold !== "string" || !GATE_THRESHOLDS.includes(threshold as GateThreshold)) {
    return fail(
      "gate.threshold",
      'must be one of "high", "medium", "low"',
      'use e.g. "gate": { "threshold": "high" }',
    );
  }
  return { threshold: threshold as GateThreshold };
}

function readPresets(obj: Record<string, unknown>, fail: Fail): readonly PresetName[] | undefined {
  const value = obj["presets"];
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    return fail("presets", "must be an array of preset names", 'use e.g. "presets": ["vite"]');
  }
  value.forEach((item, i) => {
    if (typeof item !== "string" || !PRESET_NAMES.includes(item as PresetName)) {
      fail(
        `presets[${i}]`,
        `is not a recognised preset name (got ${JSON.stringify(item)})`,
        `valid presets are ${PRESET_NAMES.join(", ")}`,
      );
    }
  });
  return value as PresetName[];
}

/**
 * `ciSecondsPerTestFile` (T5.3, report-and-badge.md §3): a positive,
 * finite number of seconds overriding `DEFAULT_CI_SECONDS_PER_TEST_FILE`
 * (`core/claims/summary.ts`). `undefined` when absent — the caller (`analyze.ts`)
 * passes that straight through to `computeSummary`, which then falls back to
 * the default.
 */
function readCiSecondsPerTestFile(obj: Record<string, unknown>, fail: Fail): number | undefined {
  const value = obj["ciSecondsPerTestFile"];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return fail(
      "ciSecondsPerTestFile",
      "must be a positive number",
      'use e.g. "ciSecondsPerTestFile": 5',
    );
  }
  return value;
}

// ---------------------------------------------------------------------------
// Workspace-unit scoping (shared by entry/project/suppression application)
// ---------------------------------------------------------------------------

/** The minimal per-package-unit shape config scoping needs (a subset of `analyze.ts`'s `AnalyzeUnit`). */
export interface ConfigUnit {
  /** POSIX, root-relative directory (`""` for the root package). */
  readonly rootRelDir: string;
  /** The unit's `package.json` `name`, or `null`. */
  readonly name: string | null;
}

/**
 * The workspace override for `unit`, matched by root-relative directory first
 * (PRD §6's `"packages/api"` key form), then by package name — the
 * `"<pkg-dir-or-name>"` key the spec describes. `undefined` when the config
 * declares no override for this unit.
 */
export function findWorkspaceOverride(
  config: UnusedConfig,
  unit: ConfigUnit,
): WorkspaceConfigOverride | undefined {
  if (unit.rootRelDir !== "" && config.workspaces[unit.rootRelDir] !== undefined) {
    return config.workspaces[unit.rootRelDir];
  }
  if (unit.name !== null && config.workspaces[unit.name] !== undefined) {
    return config.workspaces[unit.name];
  }
  return undefined;
}

/**
 * Resolve the owning unit index for a root-relative POSIX file path (the
 * deepest `rootRelDir` prefix; the root unit `""` owns everything no deeper
 * unit claims), mirroring `dependencies.ts`'s `ownerResolver`. `-1` only if
 * `units` is empty.
 */
function ownerIndex(units: readonly ConfigUnit[], fileRel: string): number {
  let best = -1;
  let bestLen = -1;
  for (let i = 0; i < units.length; i += 1) {
    const dir = units[i]?.rootRelDir ?? "";
    const matches = dir === "" || fileRel === dir || fileRel.startsWith(`${dir}/`);
    if (matches && dir.length > bestLen) {
      best = i;
      bestLen = dir.length;
    }
  }
  return best;
}

/** Strip a unit's `rootRelDir` prefix from a root-relative path (root unit ⇒ unchanged). */
function toPackageRelative(fileRel: string, rootRelDir: string): string {
  return rootRelDir === "" ? fileRel : fileRel.slice(rootRelDir.length + 1);
}

// ---------------------------------------------------------------------------
// Compatibility stage: config policy never removes graph-visible files
// ---------------------------------------------------------------------------

/**
 * Retained as the analyzer pipeline's configuration boundary, but deliberately
 * returns every discovered file. `project` and `suppressions` are reporting
 * controls and must never erase reference edges.
 */
export function filterFilesByConfig(
  files: readonly string[],
  _config: UnusedConfig,
  _units: readonly ConfigUnit[],
): string[] {
  return [...files];
}

// ---------------------------------------------------------------------------
// `project` application (claimability, NOT discovery — reviewer fix)
// ---------------------------------------------------------------------------

/**
 * Is `fileRel` (root-relative POSIX) inside the config `project` scope — i.e.
 * is it ALLOWED to be claimed? Checked at claim time (the
 * caller filters `emitClaims`'s output through this), never at discovery
 * time: `project` narrows claimability, not visibility (see the module
 * docstring). Root-level `project` is checked root-relative; a matching
 * workspace override's own `project` is checked package-relative and is
 * additionally restrictive (both must pass). Patterns are evaluated in order:
 * a leading `!` excludes a prior match and a later positive pattern can include
 * it again. A list containing only negations starts included; any positive
 * pattern makes the initial state excluded. Absent `project` at a given scope
 * is a no-op there — so with {@link EMPTY_CONFIG} this always returns `true`.
 */
export function isClaimable(
  fileRel: string,
  config: UnusedConfig,
  units: readonly ConfigUnit[],
): boolean {
  if (!matchesOrderedProject(fileRel, config.project)) return false;

  const idx = ownerIndex(units, fileRel);
  if (idx >= 0) {
    const unit = units[idx] as ConfigUnit;
    const override = findWorkspaceOverride(config, unit);
    const overrideProject = override?.project ?? [];
    if (overrideProject.length > 0) {
      const pkgRel = toPackageRelative(fileRel, unit.rootRelDir);
      if (!matchesOrderedProject(pkgRel, overrideProject)) return false;
    }
  }
  return true;
}

/** Knip-style ordered include/exclude matching for `project` patterns. */
function matchesOrderedProject(fileRel: string, patterns: readonly string[]): boolean {
  if (patterns.length === 0) return true;
  let included = !patterns.some((pattern) => !pattern.startsWith("!"));
  for (const pattern of patterns) {
    const negated = pattern.startsWith("!");
    const body = negated ? pattern.slice(1) : pattern;
    if (globToRegExp(body).test(fileRel)) included = !negated;
  }
  return included;
}

interface CompiledSuppression {
  readonly label: string;
  readonly rule: SuppressionRule;
  readonly patterns: readonly { readonly value: string; readonly matcher: RegExp }[];
  readonly unitIndex: number | undefined;
  matchedFile: boolean;
  matchedClaim: boolean;
}

/**
 * Apply structured config suppressions after graph analysis. Suppression never
 * removes a file, node, or edge: it only marks matching emitted claims. Inline
 * declaration suppressions already attached by the frontend take precedence.
 * Mixed-language dispatch disables per-frontend warnings, then invokes this
 * once over the merged claims/files so a rule matching either language is not
 * falsely reported as stale by the other frontend.
 */
export function applyConfigSuppressions(
  claims: readonly Claim[],
  config: UnusedConfig,
  units: readonly ConfigUnit[],
  analyzedFiles: readonly string[],
  options: { readonly emitWarnings?: boolean } = {},
): Claim[] {
  const compiled: CompiledSuppression[] = config.suppressions.map((rule, index) => ({
    label: `suppressions[${index}]`,
    rule,
    patterns: rule.files.map((value) => ({ value, matcher: globToRegExp(value) })),
    unitIndex: undefined,
    matchedFile: false,
    matchedClaim: false,
  }));

  for (const [key, override] of Object.entries(config.workspaces)) {
    const unitIndex = units.findIndex((unit) => unit.rootRelDir === key || unit.name === key);
    if (unitIndex < 0) continue;
    override.suppressions.forEach((rule, index) => {
      compiled.push({
        label: `workspaces.${key}.suppressions[${index}]`,
        rule,
        patterns: rule.files.map((value) => ({ value, matcher: globToRegExp(value) })),
        unitIndex,
        matchedFile: false,
        matchedClaim: false,
      });
    });
  }

  if (compiled.length === 0) return [...claims];

  const candidateFiles = new Set(analyzedFiles);
  for (const claim of claims) candidateFiles.add(claim.subject.loc.file);
  for (const file of candidateFiles) {
    for (const item of compiled) {
      if (matchedSuppressionPattern(item, file, units) !== undefined) item.matchedFile = true;
    }
  }

  const output = claims.map((claim) => {
    const matches = compiled.flatMap((item) => {
      if (!item.rule.kinds.includes(claim.subject.kind)) return [];
      const pattern = matchedSuppressionPattern(item, claim.subject.loc.file, units);
      return pattern === undefined ? [] : [{ item, pattern }];
    });
    for (const match of matches) match.item.matchedClaim = true;
    if (claim.suppression !== undefined || matches.length === 0) return claim;

    // Workspace-local policy is more specific than root policy.
    const selected = matches.find((match) => match.item.unitIndex !== undefined) ?? matches[0];
    return selected === undefined
      ? claim
      : {
          ...claim,
          suppression: {
            reason: selected.item.rule.reason,
            source: "config",
            pattern: selected.pattern,
          },
        };
  });

  if (options.emitWarnings !== false) {
    for (const item of compiled) {
      if (!item.matchedFile) {
        console.warn(
          `[unused] config "${item.label}" files globs matched no files — check for a typo.`,
        );
      } else if (!item.matchedClaim) {
        console.warn(
          `[unused] config "${item.label}" matched no current ${item.rule.kinds.join("/")} claims — suppression may be stale.`,
        );
      }
    }
  }

  return output;
}

function matchedSuppressionPattern(
  item: CompiledSuppression,
  fileRel: string,
  units: readonly ConfigUnit[],
): string | undefined {
  if (item.unitIndex === undefined) {
    return item.patterns.find((pattern) => pattern.matcher.test(fileRel))?.value;
  }
  if (ownerIndex(units, fileRel) !== item.unitIndex) return undefined;
  const unit = units[item.unitIndex];
  if (unit === undefined) return undefined;
  const pkgRel = toPackageRelative(fileRel, unit.rootRelDir);
  return item.patterns.find((pattern) => pattern.matcher.test(pkgRel))?.value;
}

// ---------------------------------------------------------------------------
// `entry` application (T4.3 item 5: entry globs seed production entrypoints)
// ---------------------------------------------------------------------------

export interface ConfigEntrypointHit {
  /** Root-relative POSIX path. */
  readonly file: string;
  readonly reason: string;
}

/**
 * Every graph-visible discovered file matched
 * by a config `entry` glob: root-level globs matched root-relative, plus each
 * unit's workspace-override `entry` globs matched package-relative. These are
 * ADDITIVE production entrypoints (PRD §6) — the caller seeds them into the
 * graph alongside auto-detection's `main`/`module`/`exports`/`bin`/fallback
 * roots, never replacing them.
 */
export function collectConfigEntrypoints(
  analyzedFiles: readonly string[],
  config: UnusedConfig,
  units: readonly ConfigUnit[],
): ConfigEntrypointHit[] {
  if (config.entry.length === 0 && Object.keys(config.workspaces).length === 0) return [];

  const rootEntry = config.entry.map(globToRegExp);
  const overrideEntryByUnit = units.map((unit) => {
    const override = findWorkspaceOverride(config, unit);
    return (override?.entry ?? []).map(globToRegExp);
  });

  const seen = new Set<string>();
  const out: ConfigEntrypointHit[] = [];
  const add = (file: string, reason: string): void => {
    if (seen.has(file)) return;
    seen.add(file);
    out.push({ file, reason });
  };

  for (const fileRel of analyzedFiles) {
    if (rootEntry.some((re) => re.test(fileRel))) add(fileRel, "config:entry");
    const idx = ownerIndex(units, fileRel);
    if (idx < 0) continue;
    const unit = units[idx] as ConfigUnit;
    const pkgRel = toPackageRelative(fileRel, unit.rootRelDir);
    const overrideEntry = overrideEntryByUnit[idx] ?? [];
    if (overrideEntry.some((re) => re.test(pkgRel))) {
      add(fileRel, `config:workspaces.${displayUnitKey(config, unit)}.entry`);
    }
  }
  return out;
}

/** The workspace key (`rootRelDir` or `name`) an override was matched under, for the entry `reason` text. */
function displayUnitKey(config: UnusedConfig, unit: ConfigUnit): string {
  if (unit.rootRelDir !== "" && config.workspaces[unit.rootRelDir] !== undefined) {
    return unit.rootRelDir;
  }
  if (unit.name !== null && config.workspaces[unit.name] !== undefined) return unit.name;
  return unit.rootRelDir;
}

// ---------------------------------------------------------------------------
// `ignoreDependencies` application
// ---------------------------------------------------------------------------

/**
 * Does `packageName` match any `ignoreDependencies` entry? Each entry is
 * compiled through the same glob engine as `entry`/`project`/`suppressions` (so a
 * plain name like `"@types/node"` matches literally, and a pattern like
 * `"@internal/*"` also works) — "names/patterns", per the spec.
 */
export function isIgnoredDependency(packageName: string, config: UnusedConfig): boolean {
  if (config.ignoreDependencies.length === 0) return false;
  return config.ignoreDependencies.some((pattern) => globToRegExp(pattern).test(packageName));
}

// ---------------------------------------------------------------------------
// Empty-match warnings (reviewer-adopted optional item: typo self-detection,
// Knip parity)
// ---------------------------------------------------------------------------

/**
 * Warn to stderr (`console.warn`, the same "loud, never silent" convention
 * `core/analysis/claims.ts` uses for an unregistered hazard class) when an
 * `entry`/`project` glob — root-level or inside a `workspaces`
 * override — matches zero files, or a `workspaces` key matches no known
 * package by directory or name. A config field that silently matches nothing
 * is almost always a typo (a stale path after a rename, a glob that doesn't
 * account for a `src/` prefix, a workspace key copy-pasted wrong) — this is
 * purely diagnostic, never a claim-affecting signal, so it degrades toward
 * "say nothing" only when there is truly nothing to say (`EMPTY_CONFIG`).
 *
 * `scopedFiles` is the graph-visible discovered set that `entry`/`project`
 * match against. Suppression rules report their own unmatched/stale warnings
 * in {@link applyConfigSuppressions} because they also need emitted claims.
 */
export function warnOnEmptyConfigMatches(
  config: UnusedConfig,
  _discoveredFiles: readonly string[],
  scopedFiles: readonly string[],
  units: readonly ConfigUnit[],
): void {
  const warn = (message: string): void => console.warn(`[unused] ${message} — check for a typo.`);

  for (const pattern of config.entry) {
    if (!matchesAny(pattern, scopedFiles))
      warn(`config "entry" pattern "${pattern}" matched no files`);
  }
  for (const pattern of config.project) {
    if (!matchesAny(projectPatternBody(pattern), scopedFiles)) {
      warn(`config "project" pattern "${pattern}" matched no files`);
    }
  }
  if (Object.keys(config.workspaces).length === 0) return;

  const scopedByUnit = groupByUnit(scopedFiles, units);
  for (const [key, override] of Object.entries(config.workspaces)) {
    const idx = units.findIndex((u) => u.rootRelDir === key || u.name === key);
    if (idx < 0) {
      warn(`config "workspaces" key "${key}" matched no workspace package (by directory or name)`);
      continue;
    }
    const unitScoped = scopedByUnit[idx] ?? [];
    for (const pattern of override.entry) {
      if (!matchesAny(pattern, unitScoped)) {
        warn(`config "workspaces.${key}.entry" pattern "${pattern}" matched no files`);
      }
    }
    for (const pattern of override.project) {
      if (!matchesAny(projectPatternBody(pattern), unitScoped)) {
        warn(`config "workspaces.${key}.project" pattern "${pattern}" matched no files`);
      }
    }
  }
}

function projectPatternBody(pattern: string): string {
  return pattern.startsWith("!") ? pattern.slice(1) : pattern;
}

function matchesAny(pattern: string, files: readonly string[]): boolean {
  const re = globToRegExp(pattern);
  return files.some((f) => re.test(f));
}

/** Group root-relative POSIX paths by owning unit index (deepest `rootRelDir` wins), package-relative. */
function groupByUnit(files: readonly string[], units: readonly ConfigUnit[]): string[][] {
  const groups: string[][] = units.map(() => []);
  for (const fileRel of files) {
    const idx = ownerIndex(units, fileRel);
    if (idx < 0) continue;
    const unit = units[idx] as ConfigUnit;
    groups[idx]?.push(toPackageRelative(fileRel, unit.rootRelDir));
  }
  return groups;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

async function isReadableFile(path: string): Promise<boolean> {
  try {
    const stats = await stat(path);
    return stats.isFile();
  } catch {
    return false;
  }
}

/** A display path for error text: relative to `root` when nested under it, absolute otherwise. */
function displayPath(root: string, abs: string): string {
  const r = resolvePath(root);
  if (abs === r) return abs;
  const prefix = r.endsWith("/") ? r : `${r}/`;
  return abs.startsWith(prefix) ? abs.slice(prefix.length) : abs;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
