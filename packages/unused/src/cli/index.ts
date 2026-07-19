#!/usr/bin/env node
/**
 * `unused` — CLI entrypoint. M2 (T2.5) shipped `[--json] [--cwd] [--config]`;
 * M6 (T6.1/T6.2/T6.3) added the full report + flag surface (the TTY report,
 * `--filter`, `--min-confidence`, `--all`, `--show-suppressed`, `--no-color`,
 * `--sarif <file>`, `--help`). M7 (T7.1/T7.2, docs/phasing.md) adds the two
 * CI-gate subcommands: `unused baseline` (write/update
 * `.unused/baseline.jsonl`, per workspace, + a bless summary) and
 * `unused check` (compare against it, exit 1 on new dead weight).
 * M8 (T8.2/T8.3, docs/phasing.md) adds `unused why <symbol|file>` (the
 * reference-path explanation, cli-ux §4) and `unused mcp` (the stdio MCP
 * server over the same engine, PRD §5). M9 (T9.3, docs/phasing.md) adds
 * `unused report [--md|--html]` (the shareable deletion-report artifact,
 * `.unused/report.<ext>`, docs/design/report-and-badge.md §1) and
 * `unused badge` (the shields.io endpoint JSON badge, `.unused/badge.json`,
 * report-and-badge.md §2). T9.1 adds the `engines.node >=22` startup check
 * (`checkNodeEngine`, called from `main()` before anything else runs).
 *
 * ## Flag composition (delegation-spec decision, PRD §3)
 * `--filter`/`--min-confidence` filter claims in **every** output —
 * `--json`, the SARIF file, and the TTY report all see the identical,
 * already-filtered claim set (`reporters/filter.ts`'s `applyClaimFilters`)
 * — so piping `unused --filter export --json` through a script yields
 * exactly the claims a human would see with `unused --filter export`.
 * `--sarif <file>` is a side-effect (writes a file) independent of stdout:
 * it composes with `--json` (both fire) and with the default TTY report
 * (the file still gets written; stdout still gets the human report).
 * `--all`/`--show-suppressed` are TTY-only presentation flags — `--json`
 * and SARIF always carry every (filtered) claim, suppressed or not,
 * un-truncated, matching PRD §4/§6 ("suppressed claims are still counted
 * and marked, not silently dropped, in every report").
 *
 * `unused check` deliberately does NOT accept `--min-confidence` (T7.2,
 * PRD §3/§6): the gate compares against `gate.threshold` (config, default
 * `"high"`) exclusively — a display-filtering flag must never look like it
 * also controls what fails the build, so it is rejected with a message
 * pointing at the real knob rather than silently ignored or (worse)
 * silently changing the gate.
 *
 * Exit codes (PRD §3 — a stable contract CI scripts are written against):
 *   0 — successful analysis (findings or none; report mode is informational,
 *       never a gate), a passing `unused check`, an `unused check` whose
 *       gate was skipped as not-evaluated (idVersion/schemaVersion-MAJOR
 *       mismatch — reviewer fix, see `runCheckCommand`: ids aren't
 *       comparable, so the comparison is skipped rather than either
 *       fabricating a pass or painting the whole repo "new"), a successful
 *       `unused baseline`/`unused report`/`unused badge`, or `--help`. A
 *       Node version below `engines.node` is exit 3, not 0 (`checkNodeEngine`
 *       — see below), and is checked before any of the above can run.
 *   1 — `unused check` gate failure: at least one claim at/above
 *       `gate.threshold` is new since the baseline (T7.2). Never emitted by
 *       the default report, `unused baseline`, `unused report`/`badge`, or a
 *       not-evaluated gate.
 *   2 — analysis could not proceed (nonexistent/unreadable `--cwd`,
 *       `analyzeProject` threw an analysis error e.g. Yarn PnP refusal, the
 *       requested `--sarif` path could not be written, or `unused
 *       report`/`unused badge` could not write their `.unused/` artifact).
 *   3 — usage error (unknown flag, a value-taking flag missing its
 *       argument, an invalid `--filter`/`--min-confidence` value naming the
 *       flag, `--md`/`--html` both given to `unused report`,
 *       `analyzeProject` threw `ConfigError`, a Node version below
 *       `engines.node`, or `unused check` found
 *       no baseline / an unparseable one — cli-ux §6).
 */

import { realpathSync } from "node:fs";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { whyAlive } from "../core/analysis/index.js";
import {
  type Confidence,
  diffAgainstBaseline,
  ID_VERSION,
  type SubjectKind,
} from "../core/claims/index.js";
import {
  type AnalyzeResult,
  type AnalyzeWithGraph,
  analyzeProject,
  analyzeProjectWithGraph,
} from "../frontends/ts/analyze.js";
import {
  BaselineError,
  type BaselineHeader,
  baselineDisplayPath,
  readAllBaselines,
  writeBaselines,
} from "../frontends/ts/baseline.js";
import { ConfigError } from "../frontends/ts/config.js";
import { UnsupportedProjectError } from "../frontends/ts/workspaces.js";
import { runMcpServer } from "../mcp/index.js";
import {
  applyClaimFilters,
  type BaselineUnitSummary,
  type CheckVersionMismatch,
  type ClaimFilterOptions,
  computeBadge,
  hasActiveFilters,
  type MismatchField,
  type ReportFormat,
  renderBadgeConfirmation,
  renderBadgeJson,
  renderBlessSummary,
  renderCheckReport,
  renderHelp,
  renderReportConfirmation,
  renderReportHtml,
  renderReportMarkdown,
  renderSarif,
  renderTtyReport,
  renderWhy,
  type TtyLayout,
} from "../reporters/index.js";

const EXIT_OK = 0;
const EXIT_GATE_FAILURE = 1;
const EXIT_ANALYSIS_ERROR = 2;
const EXIT_USAGE_ERROR = 3;

/** `engines.node` floor (package.json, ADR 0008: "Node ≥22 declared via engines and checked at startup with a clear error"). */
const MIN_NODE_MAJOR = 22;

/**
 * Checks `versionString` (`process.version`-shaped: `vX.Y.Z…`) against
 * {@link MIN_NODE_MAJOR}. Returns the error message to print when it's below
 * the floor, or `undefined` when it satisfies it (including when the string
 * is unparseable — degrading toward "let it run" rather than refusing on a
 * format this function doesn't recognise). Exported as a pure function, and
 * called with an explicit argument in tests, so this is verifiable without
 * actually running the CLI under an old Node binary (T9.1 acceptance).
 */
export function checkNodeEngine(versionString: string = process.version): string | undefined {
  const match = /^v?(\d+)\./.exec(versionString);
  const major = match?.[1] === undefined ? Number.NaN : Number(match[1]);
  if (Number.isNaN(major) || major >= MIN_NODE_MAJOR) return undefined;
  return (
    `unused requires Node.js >=${MIN_NODE_MAJOR} (found ${versionString}). ` +
    `Upgrade Node — e.g. \`nvm install ${MIN_NODE_MAJOR}\` — then try again.`
  );
}

const NO_ENTRYPOINTS_WARNING =
  "unused: no production entrypoints detected — nothing can be proven unused; " +
  "see docs/prd.md §6 (zero-config entrypoint detection).\n";

const VALID_KINDS: readonly SubjectKind[] = ["export", "file", "dependency", "endpoint", "test"];
const VALID_CONFIDENCE: readonly Confidence[] = ["high", "medium", "low"];

interface ParsedArgs {
  readonly help: boolean;
  readonly json: boolean;
  readonly cwd?: string;
  readonly config?: string;
  readonly sarif?: string;
  readonly filterKinds: readonly SubjectKind[];
  readonly minConfidence?: Confidence;
  readonly all: boolean;
  readonly showSuppressed: boolean;
  readonly noColor: boolean;
}

type ParseResult =
  | { readonly ok: true; readonly args: ParsedArgs }
  | { readonly ok: false; readonly message: string };

const HELP_ARGS: ParsedArgs = {
  help: true,
  json: false,
  filterKinds: [],
  all: false,
  showSuppressed: false,
  noColor: false,
};

/** Parses argv into flags. Any unrecognised token is a usage error — flags are never silently ignored. */
function parseArgs(argv: readonly string[]): ParseResult {
  // `--help`/`-h` wins over everything else, anywhere in argv — a confused
  // or malformed invocation (a typo'd flag alongside `--help`) should still
  // get help, not a cryptic "unknown argument" error (cli-ux §1: the CLI
  // "gets one chance" to be self-explaining).
  if (argv.includes("--help") || argv.includes("-h")) {
    return { ok: true, args: HELP_ARGS };
  }

  let json = false;
  let cwd: string | undefined;
  let config: string | undefined;
  let sarif: string | undefined;
  let all = false;
  let showSuppressed = false;
  let noColor = false;
  let minConfidence: Confidence | undefined;
  const filterKinds: SubjectKind[] = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    if (arg === "--help" || arg === "-h") {
      return { ok: true, args: HELP_ARGS };
    } else if (arg === "--json") {
      json = true;
    } else if (arg === "--all") {
      all = true;
    } else if (arg === "--show-suppressed") {
      showSuppressed = true;
    } else if (arg === "--no-color") {
      noColor = true;
    } else if (arg === "--cwd") {
      const value = argv[i + 1];
      if (value === undefined) return { ok: false, message: "--cwd requires a directory argument" };
      cwd = value;
      i += 1;
    } else if (arg === "--config") {
      const value = argv[i + 1];
      if (value === undefined) return { ok: false, message: "--config requires a path argument" };
      config = value;
      i += 1;
    } else if (arg === "--sarif") {
      const value = argv[i + 1];
      if (value === undefined)
        return { ok: false, message: "--sarif requires a file path argument" };
      sarif = value;
      i += 1;
    } else if (arg === "--filter") {
      const value = argv[i + 1];
      if (value === undefined) {
        return {
          ok: false,
          message: `--filter requires a kind argument (valid: ${VALID_KINDS.join(", ")})`,
        };
      }
      for (const token of value.split(",").map((t) => t.trim())) {
        if (token === "") continue;
        if (!(VALID_KINDS as readonly string[]).includes(token)) {
          return {
            ok: false,
            message: `invalid --filter value: "${token}" (valid: ${VALID_KINDS.join(", ")})`,
          };
        }
        filterKinds.push(token as SubjectKind);
      }
      i += 1;
    } else if (arg === "--min-confidence") {
      const value = argv[i + 1];
      if (value === undefined) {
        return {
          ok: false,
          message: `--min-confidence requires a level argument (valid: ${VALID_CONFIDENCE.join(", ")})`,
        };
      }
      if (!(VALID_CONFIDENCE as readonly string[]).includes(value)) {
        return {
          ok: false,
          message: `invalid --min-confidence value: "${value}" (valid: ${VALID_CONFIDENCE.join(", ")})`,
        };
      }
      minConfidence = value as Confidence;
      i += 1;
    } else {
      return { ok: false, message: `unknown argument: ${arg}` };
    }
  }

  return {
    ok: true,
    args: {
      help: false,
      json,
      all,
      showSuppressed,
      noColor,
      filterKinds,
      ...(cwd === undefined ? {} : { cwd }),
      ...(config === undefined ? {} : { config }),
      ...(sarif === undefined ? {} : { sarif }),
      ...(minConfidence === undefined ? {} : { minConfidence }),
    },
  };
}

/** `layout`/`columns` for `reporters/tty.ts` from real process state — the one place this file touches `process.stdout`. */
function resolveTtyInputs(noColorFlag: boolean): { layout: TtyLayout; columns: number } {
  const isTTY = process.stdout.isTTY === true;
  // biome-ignore lint/complexity/useLiteralKeys: noPropertyAccessFromIndexSignature requires bracket notation here.
  const noColorEnv = process.env["NO_COLOR"] !== undefined;
  const color = isTTY && !noColorFlag && !noColorEnv;
  const columns = process.stdout.columns ?? 80;
  const layout: TtyLayout = !color ? "plain" : columns < 80 ? "narrow" : "wide";
  return { layout, columns };
}

/** Whether `unused check`/`unused baseline` should render plain ASCII (cli-ux §5) — the same non-TTY/`NO_COLOR` signal as the default report, without the wide/narrow distinction those two commands don't need. */
function shouldUseAscii(): boolean {
  const isTTY = process.stdout.isTTY === true;
  // biome-ignore lint/complexity/useLiteralKeys: noPropertyAccessFromIndexSignature requires bracket notation here.
  const noColorEnv = process.env["NO_COLOR"] !== undefined;
  return !isTTY || noColorEnv;
}

// ---------------------------------------------------------------------------
// Shared: resolve --cwd, stat it, run analyzeProject, map every failure mode
// to the PRD §3 exit contract. Used by the default report and both
// subcommands so the three surfaces never drift on error wording/exit codes.
// ---------------------------------------------------------------------------

type AnalysisOutcome =
  | { readonly ok: true; readonly root: string; readonly result: AnalyzeResult }
  | { readonly ok: false; readonly exitCode: number };

async function runAnalysis(
  cwdArg: string | undefined,
  configArg: string | undefined,
): Promise<AnalysisOutcome> {
  const root = resolvePath(process.cwd(), cwdArg ?? ".");

  try {
    const stats = await stat(root);
    if (!stats.isDirectory()) {
      process.stderr.write(`unused: not a directory: ${root}\n`);
      return { ok: false, exitCode: EXIT_ANALYSIS_ERROR };
    }
  } catch {
    process.stderr.write(`unused: cannot read directory: ${root}\n`);
    return { ok: false, exitCode: EXIT_ANALYSIS_ERROR };
  }

  try {
    const result = await analyzeProject(
      root,
      configArg === undefined ? {} : { configPath: configArg },
    );
    return { ok: true, root, result };
  } catch (err) {
    // A config/usage problem (T4.3: missing --config target, malformed
    // JSON/JSONC, invalid field — cli-ux §6) is exit 3, never exit 2: the
    // tool didn't fail to analyze, the invocation itself is wrong.
    if (err instanceof ConfigError) {
      process.stderr.write(`unused: ${err.message}\n`);
      return { ok: false, exitCode: EXIT_USAGE_ERROR };
    }
    const message = err instanceof Error ? err.message : String(err);
    // A deliberate refusal (e.g. Yarn PnP, PRD §6) is not a failure — surface the
    // message plainly rather than as an "analysis failed" error, still exit 2.
    const prefix = err instanceof UnsupportedProjectError ? "unused:" : "unused: analysis failed:";
    process.stderr.write(`${prefix} ${message}\n`);
    return { ok: false, exitCode: EXIT_ANALYSIS_ERROR };
  }
}

// ---------------------------------------------------------------------------
// Subcommand argument parsing (`unused check` / `unused baseline`) — a
// deliberately small surface: `--cwd`/`--config`/`--help` only. `check`
// additionally rejects `--min-confidence` by name (see the module docstring)
// rather than accepting and ignoring it.
// ---------------------------------------------------------------------------

interface SubcommandArgs {
  readonly help: boolean;
  readonly cwd?: string;
  readonly config?: string;
}

type SubcommandParseResult =
  | { readonly ok: true; readonly args: SubcommandArgs }
  | { readonly ok: false; readonly message: string };

function parseSubcommandArgs(
  argv: readonly string[],
  commandName: "check" | "baseline" | "badge",
): SubcommandParseResult {
  if (argv.includes("--help") || argv.includes("-h")) {
    return { ok: true, args: { help: true } };
  }

  let cwd: string | undefined;
  let config: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    if (arg === "--cwd") {
      const value = argv[i + 1];
      if (value === undefined) return { ok: false, message: "--cwd requires a directory argument" };
      cwd = value;
      i += 1;
    } else if (arg === "--config") {
      const value = argv[i + 1];
      if (value === undefined) return { ok: false, message: "--config requires a path argument" };
      config = value;
      i += 1;
    } else if (commandName === "check" && arg === "--min-confidence") {
      return {
        ok: false,
        message:
          "unused check does not take --min-confidence — the gate compares against config " +
          '`gate.threshold` (default "high"), never a CLI flag (docs/prd.md §3/§6). ' +
          "Set gate.threshold in unused.config.jsonc to change it.",
      };
    } else {
      return { ok: false, message: `unknown argument: ${arg}` };
    }
  }

  return {
    ok: true,
    args: {
      help: false,
      ...(cwd === undefined ? {} : { cwd }),
      ...(config === undefined ? {} : { config }),
    },
  };
}

// ---------------------------------------------------------------------------
// `unused baseline` (T7.1)
// ---------------------------------------------------------------------------

async function runBaselineCommand(argv: readonly string[]): Promise<number> {
  const parsed = parseSubcommandArgs(argv, "baseline");
  if (!parsed.ok) {
    process.stderr.write(`unused: ${parsed.message}\n`);
    return EXIT_USAGE_ERROR;
  }
  if (parsed.args.help) {
    process.stdout.write(renderHelp());
    return EXIT_OK;
  }

  const outcome = await runAnalysis(parsed.args.cwd, parsed.args.config);
  if (!outcome.ok) return outcome.exitCode;
  const { root, result } = outcome;

  const header: BaselineHeader = {
    analyzerVersion: result.tool.version,
    idVersion: ID_VERSION,
    schemaVersion: result.schemaVersion,
    configHash: result.run.configHash,
    generatedAt: result.run.startedAt,
  };

  let written: Awaited<ReturnType<typeof writeBaselines>>;
  try {
    written = await writeBaselines(root, result.units, result.claims, header);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`unused: could not write baseline: ${message}\n`);
    return EXIT_ANALYSIS_ERROR;
  }

  const summaryUnits: BaselineUnitSummary[] = written.map((w) => ({
    label: w.unit.rootRelDir === "" ? "root" : w.unit.rootRelDir,
    path: baselineDisplayPath(w.unit),
    claims: w.claims,
  }));
  process.stdout.write(renderBlessSummary(summaryUnits, shouldUseAscii()));
  return EXIT_OK;
}

// ---------------------------------------------------------------------------
// `unused check` (T7.2)
// ---------------------------------------------------------------------------

async function runCheckCommand(argv: readonly string[]): Promise<number> {
  const parsed = parseSubcommandArgs(argv, "check");
  if (!parsed.ok) {
    process.stderr.write(`unused: ${parsed.message}\n`);
    return EXIT_USAGE_ERROR;
  }
  if (parsed.args.help) {
    process.stdout.write(renderHelp());
    return EXIT_OK;
  }

  const outcome = await runAnalysis(parsed.args.cwd, parsed.args.config);
  if (!outcome.ok) return outcome.exitCode;
  const { root, result } = outcome;

  let baselines: Awaited<ReturnType<typeof readAllBaselines>>;
  try {
    baselines = await readAllBaselines(root, result.units);
  } catch (err) {
    if (err instanceof BaselineError) {
      process.stderr.write(`unused: ${err.message}\n`);
      return EXIT_USAGE_ERROR;
    }
    throw err;
  }

  if (baselines.missingUnits.length > 0) {
    const where = baselines.missingUnits.map((u) => baselineDisplayPath(u)).join(", ");
    process.stderr.write(`unused: no baseline found (missing ${where}). Run: unused baseline\n`);
    return EXIT_USAGE_ERROR;
  }

  // Every unit was found (missingUnits is empty above), so the root unit
  // (always present in `result.units`) is always present here too.
  const rootBaseline = baselines.byUnit.get("");
  if (rootBaseline === undefined) {
    process.stderr.write("unused: internal error: root baseline missing after existence check\n");
    return EXIT_ANALYSIS_ERROR;
  }
  const header = rootBaseline.header;
  const baselineClaims = [...baselines.byUnit.values()].flatMap((b) => b.claims);

  const mismatch: CheckVersionMismatch = {
    analyzer:
      header.analyzerVersion === result.tool.version
        ? undefined
        : { baseline: header.analyzerVersion, current: result.tool.version },
    idVersion:
      header.idVersion === ID_VERSION
        ? undefined
        : { baseline: header.idVersion, current: ID_VERSION },
    schema:
      header.schemaVersion === result.schemaVersion
        ? undefined
        : { baseline: header.schemaVersion, current: result.schemaVersion },
    configHash: header.configHash !== result.run.configHash,
  };

  const baselineMeta = {
    generatedAt: header.generatedAt,
    analyzerVersion: header.analyzerVersion,
    claimCount: baselineClaims.length,
  };

  // Reviewer fix (T7.2): an idVersion mismatch, or a schemaVersion MAJOR
  // mismatch (ADR 0006 semver policy — MAJOR is the only tier that can
  // change claim shape/identity), means ids on the two sides were computed
  // under different recipes. Every current claim would then look "new"
  // against the baseline — a false avalanche, not a real signal — so PRD
  // §4's "an analyzer upgrade must never paint the whole repo as new dead
  // weight" requires skipping the comparison entirely here, not just
  // warning while still gating on a meaningless diff.
  const idsComparable = mismatch.idVersion === undefined && !isSchemaMajorMismatch(mismatch.schema);
  if (!idsComparable) {
    process.stdout.write(
      renderCheckReport({
        kind: "gate-not-evaluated",
        ascii: shouldUseAscii(),
        baseline: baselineMeta,
        mismatch,
      }),
    );
    return EXIT_OK;
  }

  const diff = diffAgainstBaseline(baselineClaims, result.claims, result.gateThreshold);

  process.stdout.write(
    renderCheckReport({
      kind: "evaluated",
      ascii: shouldUseAscii(),
      threshold: result.gateThreshold,
      baseline: baselineMeta,
      diff,
      mismatch,
    }),
  );

  return diff.newClaims.length > 0 ? EXIT_GATE_FAILURE : EXIT_OK;
}

/** Does `mismatch.schema` (if present) differ at the semver MAJOR component — the only tier that can change claim shape/identity (ADR 0006)? `undefined` (no schema mismatch at all) is never a MAJOR mismatch. */
function isSchemaMajorMismatch(schema: MismatchField<string> | undefined): boolean {
  if (schema === undefined) return false;
  return semverMajor(schema.baseline) !== semverMajor(schema.current);
}

function semverMajor(version: string): number {
  const match = /^(\d+)\./.exec(version);
  return match?.[1] === undefined ? Number.NaN : Number(match[1]);
}

// ---------------------------------------------------------------------------
// Shared: analyze and also return the graph + reachability (why/MCP need the
// live IR + predecessor maps). Same failure→exit mapping as `runAnalysis`.
// ---------------------------------------------------------------------------

type GraphAnalysisOutcome =
  | { readonly ok: true; readonly root: string; readonly analysis: AnalyzeWithGraph }
  | { readonly ok: false; readonly exitCode: number };

async function runAnalysisWithGraph(
  cwdArg: string | undefined,
  configArg: string | undefined,
): Promise<GraphAnalysisOutcome> {
  const root = resolvePath(process.cwd(), cwdArg ?? ".");
  try {
    const stats = await stat(root);
    if (!stats.isDirectory()) {
      process.stderr.write(`unused: not a directory: ${root}\n`);
      return { ok: false, exitCode: EXIT_ANALYSIS_ERROR };
    }
  } catch {
    process.stderr.write(`unused: cannot read directory: ${root}\n`);
    return { ok: false, exitCode: EXIT_ANALYSIS_ERROR };
  }
  try {
    const analysis = await analyzeProjectWithGraph(
      root,
      configArg === undefined ? {} : { configPath: configArg },
    );
    return { ok: true, root, analysis };
  } catch (err) {
    if (err instanceof ConfigError) {
      process.stderr.write(`unused: ${err.message}\n`);
      return { ok: false, exitCode: EXIT_USAGE_ERROR };
    }
    const message = err instanceof Error ? err.message : String(err);
    const prefix = err instanceof UnsupportedProjectError ? "unused:" : "unused: analysis failed:";
    process.stderr.write(`${prefix} ${message}\n`);
    return { ok: false, exitCode: EXIT_ANALYSIS_ERROR };
  }
}

// ---------------------------------------------------------------------------
// `unused why <symbol|file>` (T8.2, cli-ux §4)
// ---------------------------------------------------------------------------

interface WhyArgs {
  readonly help: boolean;
  readonly subject?: string;
  readonly cwd?: string;
  readonly config?: string;
}

type WhyParseResult =
  | { readonly ok: true; readonly args: WhyArgs }
  | { readonly ok: false; readonly message: string };

/** Parse `unused why` argv: one positional `<symbol|file>` plus `--cwd`/`--config`/`--help`. */
function parseWhyArgs(argv: readonly string[]): WhyParseResult {
  if (argv.includes("--help") || argv.includes("-h")) return { ok: true, args: { help: true } };

  let subject: string | undefined;
  let cwd: string | undefined;
  let config: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    if (arg === "--cwd") {
      const value = argv[i + 1];
      if (value === undefined) return { ok: false, message: "--cwd requires a directory argument" };
      cwd = value;
      i += 1;
    } else if (arg === "--config") {
      const value = argv[i + 1];
      if (value === undefined) return { ok: false, message: "--config requires a path argument" };
      config = value;
      i += 1;
    } else if (arg.startsWith("-")) {
      return { ok: false, message: `unknown argument: ${arg}` };
    } else if (subject === undefined) {
      subject = arg;
    } else {
      return {
        ok: false,
        message: `unexpected extra argument: ${arg} (why takes one symbol or file)`,
      };
    }
  }

  return {
    ok: true,
    args: {
      help: false,
      ...(subject === undefined ? {} : { subject }),
      ...(cwd === undefined ? {} : { cwd }),
      ...(config === undefined ? {} : { config }),
    },
  };
}

/**
 * `unused why <symbol|file>` (cli-ux §4). Exit codes:
 *   0 — the query resolved (alive, dead, or an ambiguity list printed).
 *   2 — analysis could not proceed.
 *   3 — usage error: no subject given, or the named subject/file matches
 *       nothing in the project (there is nothing to explain — the same
 *       "unusable input" family as a bad flag value, PRD §3).
 */
async function runWhyCommand(argv: readonly string[]): Promise<number> {
  const parsed = parseWhyArgs(argv);
  if (!parsed.ok) {
    process.stderr.write(`unused: ${parsed.message}\n`);
    return EXIT_USAGE_ERROR;
  }
  if (parsed.args.help) {
    process.stdout.write(renderHelp());
    return EXIT_OK;
  }
  if (parsed.args.subject === undefined) {
    process.stderr.write(
      "unused: why requires a symbol or file argument. Usage: unused why <symbol|file>\n",
    );
    return EXIT_USAGE_ERROR;
  }

  const outcome = await runAnalysisWithGraph(parsed.args.cwd, parsed.args.config);
  if (!outcome.ok) return outcome.exitCode;
  const { analysis } = outcome;

  const result = whyAlive({
    graph: analysis.graph,
    reachability: analysis.reachability,
    claims: analysis.result.claims,
    query: parsed.args.subject,
  });

  const ascii = shouldUseAscii();
  if (result.outcome === "not-found") {
    // Nothing in the project matches — a usage-level "unusable input" (exit 3),
    // not a successful answer. The message still teaches the fix (cli-ux §6).
    process.stderr.write(renderWhy(result, ascii));
    return EXIT_USAGE_ERROR;
  }
  process.stdout.write(renderWhy(result, ascii));
  return EXIT_OK;
}

// ---------------------------------------------------------------------------
// `unused mcp` (T8.3) — start the stdio MCP server over the same engine.
// ---------------------------------------------------------------------------

async function runMcpCommand(argv: readonly string[]): Promise<number> {
  const parsed = parseSubcommandArgs(argv, "baseline");
  if (!parsed.ok) {
    process.stderr.write(`unused: ${parsed.message}\n`);
    return EXIT_USAGE_ERROR;
  }
  if (parsed.args.help) {
    process.stdout.write(renderHelp());
    return EXIT_OK;
  }
  return runMcpServer({
    ...(parsed.args.cwd === undefined ? {} : { cwd: parsed.args.cwd }),
    ...(parsed.args.config === undefined ? {} : { config: parsed.args.config }),
  });
}

// ---------------------------------------------------------------------------
// `unused report [--md|--html]` (T9.3, docs/design/report-and-badge.md §1)
// ---------------------------------------------------------------------------

interface ReportArgs {
  readonly help: boolean;
  readonly format?: ReportFormat;
  readonly cwd?: string;
  readonly config?: string;
}

type ReportParseResult =
  | { readonly ok: true; readonly args: ReportArgs }
  | { readonly ok: false; readonly message: string };

/** Parse `unused report` argv: `--md`/`--html` (mutually exclusive, default `md`) plus `--cwd`/`--config`/`--help`. */
function parseReportArgs(argv: readonly string[]): ReportParseResult {
  if (argv.includes("--help") || argv.includes("-h")) return { ok: true, args: { help: true } };

  let format: ReportFormat | undefined;
  let cwd: string | undefined;
  let config: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    if (arg === "--md" || arg === "--html") {
      const next: ReportFormat = arg === "--md" ? "md" : "html";
      if (format !== undefined && format !== next) {
        return { ok: false, message: "--md and --html are mutually exclusive" };
      }
      format = next;
    } else if (arg === "--cwd") {
      const value = argv[i + 1];
      if (value === undefined) return { ok: false, message: "--cwd requires a directory argument" };
      cwd = value;
      i += 1;
    } else if (arg === "--config") {
      const value = argv[i + 1];
      if (value === undefined) return { ok: false, message: "--config requires a path argument" };
      config = value;
      i += 1;
    } else {
      return { ok: false, message: `unknown argument: ${arg}` };
    }
  }

  return {
    ok: true,
    args: {
      help: false,
      ...(format === undefined ? {} : { format }),
      ...(cwd === undefined ? {} : { cwd }),
      ...(config === undefined ? {} : { config }),
    },
  };
}

/**
 * `unused report [--md|--html]` (T9.3): always re-analyses (docs/phasing.md
 * M9's "keep simple: always analyze" — there is no cross-invocation cache to
 * be stale) and writes a self-contained artifact to `.unused/report.<ext>`,
 * mirroring `unused baseline`/`unused badge`'s `.unused/` convention. Format
 * defaults to `md` when neither flag is given (the simplest, most
 * paste-friendly artifact — HTML is the opt-in for "open this in a browser
 * and screenshot it").
 */
async function runReportCommand(argv: readonly string[]): Promise<number> {
  const parsed = parseReportArgs(argv);
  if (!parsed.ok) {
    process.stderr.write(`unused: ${parsed.message}\n`);
    return EXIT_USAGE_ERROR;
  }
  if (parsed.args.help) {
    process.stdout.write(renderHelp());
    return EXIT_OK;
  }

  const outcome = await runAnalysis(parsed.args.cwd, parsed.args.config);
  if (!outcome.ok) return outcome.exitCode;
  const { root, result } = outcome;

  const format: ReportFormat = parsed.args.format ?? "md";
  // Same six-field strip the default report/`--json` path uses (T2.5/T6.1) —
  // the report artifact renders from the schema-shaped `ClaimRun` plus the
  // three header fields `reporters/report.ts`'s `ReportContext` declares,
  // never the raw `AnalyzeResult`.
  const {
    productionEntrypointCount: _productionEntrypointCount,
    fileCount,
    workspaceCount,
    repoName,
    units: _units,
    gateThreshold: _gateThreshold,
    ...claimRun
  } = result;

  const content =
    format === "html"
      ? renderReportHtml({ run: claimRun, repoName, fileCount, workspaceCount })
      : renderReportMarkdown({ run: claimRun, repoName, fileCount, workspaceCount });
  const unusedDir = resolvePath(root, ".unused");
  const outPath = join(unusedDir, `report.${format}`);

  try {
    await mkdir(unusedDir, { recursive: true });
    await writeFile(outPath, content);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`unused: could not write report to ${outPath}: ${message}\n`);
    return EXIT_ANALYSIS_ERROR;
  }

  process.stdout.write(renderReportConfirmation(claimRun, outPath, shouldUseAscii()));
  return EXIT_OK;
}

// ---------------------------------------------------------------------------
// `unused badge` (T9.3, docs/design/report-and-badge.md §2)
// ---------------------------------------------------------------------------

/** `unused badge`: writes the shields.io endpoint JSON to `.unused/badge.json` (high-confidence claim count only — `reporters/badge.ts`). */
async function runBadgeCommand(argv: readonly string[]): Promise<number> {
  const parsed = parseSubcommandArgs(argv, "badge");
  if (!parsed.ok) {
    process.stderr.write(`unused: ${parsed.message}\n`);
    return EXIT_USAGE_ERROR;
  }
  if (parsed.args.help) {
    process.stdout.write(renderHelp());
    return EXIT_OK;
  }

  const outcome = await runAnalysis(parsed.args.cwd, parsed.args.config);
  if (!outcome.ok) return outcome.exitCode;
  const { root, result } = outcome;

  const unusedDir = resolvePath(root, ".unused");
  const outPath = join(unusedDir, "badge.json");

  try {
    await mkdir(unusedDir, { recursive: true });
    await writeFile(outPath, renderBadgeJson(result));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`unused: could not write badge to ${outPath}: ${message}\n`);
    return EXIT_ANALYSIS_ERROR;
  }

  process.stdout.write(renderBadgeConfirmation(computeBadge(result), outPath));
  return EXIT_OK;
}

// ---------------------------------------------------------------------------
// Default report
// ---------------------------------------------------------------------------

/**
 * Runs the CLI over `argv` and returns the process exit code. Split from
 * `main()` below so the exit-code logic is directly testable without an
 * actual `process.exit` — the spawn-based integration tests exercise the
 * built `dist/cli/index.js`, but keeping this pure makes intent legible.
 */
export async function run(argv: readonly string[]): Promise<number> {
  // Subcommand dispatch (T7.1/T7.2): recognised only as the very first
  // token, mirroring the git/npm convention — `unused --cwd check` is a
  // `--cwd` value, not the `check` subcommand, exactly as `unused --json`
  // (argv[0] === "--json") already falls through to the default report.
  const [first, ...rest] = argv;
  if (first === "check") return runCheckCommand(rest);
  if (first === "baseline") return runBaselineCommand(rest);
  if (first === "why") return runWhyCommand(rest);
  if (first === "mcp") return runMcpCommand(rest);
  if (first === "report") return runReportCommand(rest);
  if (first === "badge") return runBadgeCommand(rest);

  const parsed = parseArgs(argv);
  if (!parsed.ok) {
    process.stderr.write(`unused: ${parsed.message}\n`);
    return EXIT_USAGE_ERROR;
  }

  if (parsed.args.help) {
    process.stdout.write(renderHelp());
    return EXIT_OK;
  }

  const outcome = await runAnalysis(parsed.args.cwd, parsed.args.config);
  if (!outcome.ok) return outcome.exitCode;
  const { result } = outcome;

  // Strip the non-schema out-of-band fields before anything reaches
  // `--json`/SARIF — those two are the schema-valid claim-run contract,
  // byte for byte (`additionalProperties: false`). `repoName`/`fileCount`/
  // `workspaceCount`/`units`/`gateThreshold` feed the TTY header and the
  // M7 subcommands only.
  const {
    productionEntrypointCount,
    fileCount,
    workspaceCount,
    repoName,
    units: _units,
    gateThreshold: _gateThreshold,
    ...claimRun
  } = result;

  if (productionEntrypointCount === 0) {
    process.stderr.write(NO_ENTRYPOINTS_WARNING);
  }

  const filterOptions: ClaimFilterOptions = {
    ...(parsed.args.filterKinds.length > 0 ? { kinds: parsed.args.filterKinds } : {}),
    ...(parsed.args.minConfidence === undefined
      ? {}
      : { minConfidence: parsed.args.minConfidence }),
  };
  const filteredRun = applyClaimFilters(claimRun, filterOptions);

  if (parsed.args.sarif !== undefined) {
    const sarifPath = resolvePath(process.cwd(), parsed.args.sarif);
    try {
      await writeFile(sarifPath, renderSarif(filteredRun));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`unused: could not write SARIF log to ${sarifPath}: ${message}\n`);
      return EXIT_ANALYSIS_ERROR;
    }
  }

  if (parsed.args.json) {
    process.stdout.write(`${JSON.stringify(filteredRun)}\n`);
  } else {
    const { layout, columns } = resolveTtyInputs(parsed.args.noColor);
    process.stdout.write(
      renderTtyReport(
        { run: filteredRun, repoName, fileCount, workspaceCount },
        {
          layout,
          columns,
          showSuppressed: parsed.args.showSuppressed,
          all: parsed.args.all,
          explicitMinConfidence: parsed.args.minConfidence,
          filtersActive: hasActiveFilters(filterOptions),
          noProductionEntrypoints: productionEntrypointCount === 0,
        },
      ),
    );
  }

  return EXIT_OK;
}

async function main(): Promise<void> {
  // Engine check first, before any argv parsing or analysis — a clear,
  // immediate error rather than a confusing crash deeper in oxc/fs internals
  // on a Node version the analyzer was never tested against (ADR 0008).
  const engineError = checkNodeEngine();
  if (engineError !== undefined) {
    process.stderr.write(`unused: ${engineError}\n`);
    process.exitCode = EXIT_USAGE_ERROR;
    return;
  }
  try {
    process.exitCode = await run(process.argv.slice(2));
  } catch (err) {
    // Defense in depth: an uncaught error here must never fall through to
    // Node's default exit code 1, which the PRD §3 contract reserves
    // exclusively for `unused check`'s gate failure.
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`unused: unexpected error: ${message}\n`);
    process.exitCode = EXIT_ANALYSIS_ERROR;
  }
}

/**
 * Only auto-run `main()` when this file is the process entrypoint (the `bin`
 * invocation, `node dist/cli/index.js …`) — never merely on import. Without
 * this guard, importing this module from a unit test (e.g. to exercise
 * {@link checkNodeEngine} directly instead of via a spawned subprocess) would
 * trigger a real `main()` run as a side effect of the `import` statement
 * itself: argv parsing against the test runner's own argv, a real
 * `analyzeProject` call, and a real `process.exitCode` write.
 *
 * **`realpath`, not a raw string compare (T9.1 pack-verification finding).**
 * `npm`/`pnpm` install `bin: { unused: "./dist/cli/index.js" }` as a
 * *symlink* at `node_modules/.bin/unused`. Node's ESM loader resolves
 * `import.meta.url` through that symlink to the real target file, but
 * `process.argv[1]` stays exactly what was invoked — the symlink path
 * itself. A direct `fileURLToPath(import.meta.url) === resolvePath(argv[1])`
 * compare therefore NEVER matches for the actual installed-package
 * invocation (only for `node dist/cli/index.js` run directly from source),
 * so `main()` silently never ran: no output, no error, exit 0 — the exact
 * failure this file's own `main()` docstring says defense-in-depth exists to
 * prevent, just from the opposite direction. Caught by the `npm pack` →
 * install → cold-run verification transcript (T9.1 acceptance), not by the
 * spawn-based tests (which invoke `dist/cli/index.js` directly, never
 * through a symlink). `realpathSync` resolves both sides to the same
 * filesystem target before comparing.
 */
function isEntryPoint(): boolean {
  if (process.argv[1] === undefined) return false;
  try {
    return fileURLToPath(import.meta.url) === realpathSync(resolvePath(process.argv[1]));
  } catch {
    return false;
  }
}

if (isEntryPoint()) void main();
