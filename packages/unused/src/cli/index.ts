#!/usr/bin/env node
/**
 * `unused` — CLI entrypoint (T2.5, docs/phasing.md M2).
 *
 * M2 surface ONLY: `unused [--json] [--cwd <dir>]`. No subcommands yet
 * (`check` / `baseline` / `why` / `mcp` / `report` / `badge` — PRD §3), no
 * config file (M4), no `--filter` / `--min-confidence` / `--sarif` /
 * `--no-color` (M6/M7/M8), no network, no telemetry.
 *
 * The default (non-`--json`) listing in {@link formatPlainListing} is a
 * deliberately minimal placeholder — one claim per line, no colors, no
 * layout, no badges, no truncation. It is explicitly NOT the product's
 * face: the real TTY report (docs/design/cli-ux.md) ships at M6. This
 * exists only so the CLI has *some* human-readable mode before then.
 *
 * Packaging note (ADR 0008): this ships as plain `tsc` output
 * (`dist/cli/index.js`), one file among many that `node` runs directly via
 * the `bin` shebang below. The single-file bundle decision is deferred to
 * M9 — nothing here should assume or require a bundler.
 *
 * Exit codes (PRD §3 — a stable contract CI scripts are written against):
 *   0 — successful analysis (findings or none; report mode is informational,
 *       never a gate).
 *   2 — analysis could not proceed (nonexistent/unreadable `--cwd`,
 *       `analyzeProject` threw).
 *   3 — usage error (unknown flag, `--cwd` missing its argument).
 * Exit 1 is reserved for `unused check`'s gate failure (PRD §3, M7) and is
 * never emitted by this file.
 */

import { stat } from "node:fs/promises";
import { resolve as resolvePath } from "node:path";
import type { Claim, ClaimRun } from "../core/claims/index.js";
import { analyzeProject } from "../frontends/ts/analyze.js";
import { UnsupportedProjectError } from "../frontends/ts/workspaces.js";

const EXIT_OK = 0;
const EXIT_ANALYSIS_ERROR = 2;
const EXIT_USAGE_ERROR = 3;

const NO_ENTRYPOINTS_WARNING =
  "unused: no production entrypoints detected — nothing can be proven unused; " +
  "see docs/prd.md §6 (zero-config entrypoint detection).\n";

interface ParsedArgs {
  readonly json: boolean;
  readonly cwd?: string;
}

type ParseResult =
  | { readonly ok: true; readonly args: ParsedArgs }
  | { readonly ok: false; readonly message: string };

/** Parses argv into flags. Any unrecognised token is a usage error — flags are never silently ignored. */
function parseArgs(argv: readonly string[]): ParseResult {
  let json = false;
  let cwd: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    if (arg === "--json") {
      json = true;
    } else if (arg === "--cwd") {
      const value = argv[i + 1];
      if (value === undefined) {
        return { ok: false, message: "--cwd requires a directory argument" };
      }
      cwd = value;
      i += 1;
    } else {
      return { ok: false, message: `unknown argument: ${arg}` };
    }
  }
  return { ok: true, args: cwd === undefined ? { json } : { json, cwd } };
}

/** One line per claim: verdict, kind, name, file:line, confidence. Placeholder until the M6 TTY report. */
function formatPlainListing(claims: readonly Claim[]): string[] {
  return claims.map((claim) => {
    const loc = `${claim.subject.loc.file}:${claim.subject.loc.span[0]}`;
    return `${claim.verdict}  ${claim.subject.kind}  ${claim.subject.name}  ${loc}  ${claim.confidence}`;
  });
}

function formatSummaryLine(run: ClaimRun): string {
  const total = run.claims.length;
  const { high, medium, low } = run.summary.byConfidence;
  if (total === 0) return "0 claims.";
  return `${total} claim${total === 1 ? "" : "s"} (high: ${high}, medium: ${medium}, low: ${low}).`;
}

/**
 * Runs the M2 CLI over `argv` and returns the process exit code. Split from
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
    result = await analyzeProject(root);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // A deliberate refusal (e.g. Yarn PnP, PRD §6) is not a failure — surface the
    // message plainly rather than as an "analysis failed" error, still exit 2.
    const prefix = err instanceof UnsupportedProjectError ? "unused:" : "unused: analysis failed:";
    process.stderr.write(`${prefix} ${message}\n`);
    return EXIT_ANALYSIS_ERROR;
  }

  // Strip the non-schema `productionEntrypointCount` field before it ever
  // reaches stdout — `--json` output must validate against the shipped
  // JSON Schema (additionalProperties: false), byte for byte.
  const { productionEntrypointCount, ...claimRun } = result;

  if (productionEntrypointCount === 0) {
    process.stderr.write(NO_ENTRYPOINTS_WARNING);
  }

  if (parsed.args.json) {
    process.stdout.write(`${JSON.stringify(claimRun)}\n`);
  } else {
    for (const line of formatPlainListing(claimRun.claims)) process.stdout.write(`${line}\n`);
    process.stdout.write(`${formatSummaryLine(claimRun)}\n`);
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
