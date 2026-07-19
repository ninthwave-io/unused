#!/usr/bin/env node
/**
 * `unused` — CLI entrypoint. M2 (T2.5) shipped `[--json] [--cwd] [--config]`;
 * this file is the M6 (T6.1/T6.2/T6.3, docs/phasing.md) full report + flag
 * surface: the TTY report (docs/design/cli-ux.md §2, via `reporters/tty.ts`)
 * replaces the M2 placeholder listing, plus `--filter`, `--min-confidence`,
 * `--all`, `--show-suppressed`, `--no-color`, `--sarif <file>`, `--help`.
 *
 * Still no subcommands (`check` / `baseline` / `why` / `mcp` / `report` /
 * `badge` — PRD §3 — land in M7/M8/M9); `--help` says so rather than
 * documenting a command that doesn't run yet.
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
 * Exit codes (PRD §3 — a stable contract CI scripts are written against):
 *   0 — successful analysis (findings or none; report mode is informational,
 *       never a gate) or `--help`.
 *   2 — analysis could not proceed (nonexistent/unreadable `--cwd`,
 *       `analyzeProject` threw an analysis error e.g. Yarn PnP refusal, or
 *       the requested `--sarif` path could not be written).
 *   3 — usage error (unknown flag, a value-taking flag missing its
 *       argument, an invalid `--filter`/`--min-confidence` value naming the
 *       flag, or `analyzeProject` threw `ConfigError` — cli-ux §6).
 * Exit 1 is reserved for `unused check`'s gate failure (PRD §3, M7) and is
 * never emitted by this file.
 */

import { stat, writeFile } from "node:fs/promises";
import { resolve as resolvePath } from "node:path";
import type { Confidence, SubjectKind } from "../core/claims/index.js";
import { analyzeProject } from "../frontends/ts/analyze.js";
import { ConfigError } from "../frontends/ts/config.js";
import { UnsupportedProjectError } from "../frontends/ts/workspaces.js";
import {
  applyClaimFilters,
  type ClaimFilterOptions,
  hasActiveFilters,
  renderHelp,
  renderSarif,
  renderTtyReport,
  type TtyLayout,
} from "../reporters/index.js";

const EXIT_OK = 0;
const EXIT_ANALYSIS_ERROR = 2;
const EXIT_USAGE_ERROR = 3;

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

/**
 * Runs the CLI over `argv` and returns the process exit code. Split from
 * `main()` below so the exit-code logic is directly testable without an
 * actual `process.exit` — the spawn-based integration tests exercise the
 * built `dist/cli/index.js`, but keeping this pure makes intent legible.
 */
export async function run(argv: readonly string[]): Promise<number> {
  const parsed = parseArgs(argv);
  if (!parsed.ok) {
    process.stderr.write(`unused: ${parsed.message}\n`);
    return EXIT_USAGE_ERROR;
  }

  if (parsed.args.help) {
    process.stdout.write(renderHelp());
    return EXIT_OK;
  }

  const root = resolvePath(process.cwd(), parsed.args.cwd ?? ".");

  try {
    const stats = await stat(root);
    if (!stats.isDirectory()) {
      process.stderr.write(`unused: not a directory: ${root}\n`);
      return EXIT_ANALYSIS_ERROR;
    }
  } catch {
    process.stderr.write(`unused: cannot read directory: ${root}\n`);
    return EXIT_ANALYSIS_ERROR;
  }

  let result: Awaited<ReturnType<typeof analyzeProject>>;
  try {
    result = await analyzeProject(
      root,
      parsed.args.config === undefined ? {} : { configPath: parsed.args.config },
    );
  } catch (err) {
    // A config/usage problem (T4.3: missing --config target, malformed
    // JSON/JSONC, invalid field — cli-ux §6) is exit 3, never exit 2: the
    // tool didn't fail to analyze, the invocation itself is wrong.
    if (err instanceof ConfigError) {
      process.stderr.write(`unused: ${err.message}\n`);
      return EXIT_USAGE_ERROR;
    }
    const message = err instanceof Error ? err.message : String(err);
    // A deliberate refusal (e.g. Yarn PnP, PRD §6) is not a failure — surface the
    // message plainly rather than as an "analysis failed" error, still exit 2.
    const prefix = err instanceof UnsupportedProjectError ? "unused:" : "unused: analysis failed:";
    process.stderr.write(`${prefix} ${message}\n`);
    return EXIT_ANALYSIS_ERROR;
  }

  // Strip the non-schema out-of-band fields before anything reaches
  // `--json`/SARIF — those two are the schema-valid claim-run contract,
  // byte for byte (`additionalProperties: false`). `repoName`/`fileCount`/
  // `workspaceCount` feed the TTY header only.
  const { productionEntrypointCount, fileCount, workspaceCount, repoName, ...claimRun } = result;

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

void main();
