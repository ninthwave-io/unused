/**
 * `--help` / `-h` text (T6.1/T7.1/T7.2/T8.2/T8.3/T9.3, docs/phasing.md
 * M6/M7/M8/M9), in the cli-ux voice: scannable, action-first,
 * evidence-first. Documents exactly the command surface this build
 * implements (`unused [options]`, `unused check`, `unused baseline`,
 * `unused why`, `unused mcp`, `unused report`, `unused badge`) — "zero-config
 * first run is the pitch ... it gets one chance" (cli-ux §1) — a `--help`
 * example that fails when tried is the same trust break as a wrong claim.
 */

const OPTIONS: ReadonlyArray<{ flag: string; lines: readonly string[] }> = [
  { flag: "--json", lines: ["Emit the claim-schema JSON instead of the terminal report."] },
  { flag: "--sarif <file>", lines: ["Write a SARIF 2.1.0 log to <file> (composes with --json)."] },
  {
    flag: "--filter <kind>",
    lines: [
      "Restrict to one or more subject kinds: export, file,",
      "dependency, endpoint, test. Repeatable or comma-separated.",
    ],
  },
  {
    flag: "--min-confidence <level>",
    lines: ["Drop claims below this confidence: high, medium, low."],
  },
  { flag: "--all", lines: ["Show every claim per section instead of the top 10."] },
  {
    flag: "--show-suppressed",
    lines: [
      "List inline/config-suppressed claims too (always counted either",
      "way, never silently dropped).",
    ],
  },
  {
    flag: "--fix",
    lines: ["Apply reviewable high-confidence export/dependency fixes to the working tree."],
  },
  {
    flag: "--fix-type <types>",
    lines: ["Restrict fixes to exports, dependencies, or files (comma-separated)."],
  },
  {
    flag: "--allow-remove-files",
    lines: ["Second opt-in required with --fix-type files before deleting files."],
  },
  {
    flag: "--no-color",
    lines: [
      "Disable ANSI output. Also implied by a non-TTY stdout or",
      "the NO_COLOR environment variable.",
    ],
  },
  {
    flag: "--no-gitignore",
    lines: ["Analyse files matched by .gitignore rules too."],
  },
  {
    flag: "--performance",
    lines: ["Default/why/report: write structured phase timings and counters to stderr."],
  },
  {
    flag: "--config <path>",
    lines: [
      "Load config from <path> instead of auto-discovering",
      "unused.config.jsonc / unused.config.json.",
    ],
  },
  { flag: "--cwd <dir>", lines: ["Analyse <dir> instead of the current directory."] },
  { flag: "--help, -h", lines: ["Show this help and exit."] },
];

const FLAG_COLUMN = 28;

function renderOptions(): string {
  return OPTIONS.map(({ flag, lines }) =>
    lines
      .map((line, i) =>
        i === 0 ? `  ${flag.padEnd(FLAG_COLUMN)}${line}` : `${" ".repeat(2 + FLAG_COLUMN)}${line}`,
      )
      .join("\n"),
  ).join("\n");
}

export function renderHelp(): string {
  return `unused — liveness oracle for TS/JS. Finds unused exports, files, and
dependencies, each with a confidence grade and a one-line reference-graph
"why". Local-first, zero network calls, zero telemetry. Read-only unless
--fix is explicitly supplied; never commits for you.

USAGE
  unused [options]
  unused check [--cwd <dir>] [--config <path>]
  unused baseline [--cwd <dir>] [--config <path>]
  unused why [--delete] [--performance] <symbol|file|dependency> [--cwd <dir>] [--config <path>]
  unused mcp [--cwd <dir>] [--config <path>]
  unused report [--md|--html] [--performance] [--cwd <dir>] [--config <path>]
  unused badge [--cwd <dir>] [--config <path>]

COMMANDS
  unused              Analyse the repo, print the terminal report (default).
                       With --fix, mutate only unsuppressed high-confidence
                       unused exports/dependencies selected by the initial
                       analysis, then re-analyse. Never commits or installs.
  unused check        CI gate: compare this run's claims against the
                       committed baseline, fail only on claims new since it
                       (PRD §3). Gated at config gate.threshold (default
                       high) — --min-confidence has no effect on the gate.
  unused baseline     Write/update .unused/baseline.jsonl (one per
                       workspace) and print what it blessed. Regenerate on
                       main only — never on a feature branch.
  unused why          Explain why a symbol, file, or dependency is alive/dead
                       (the shortest
                       reference path, entrypoint kind labelled) or, if dead,
                       its verdict, confidence, and evidence. Answers for any
                       symbol — a bare name, file.ts:name, or a file path.
                       --delete returns a read-only counterfactual consequence
                       plan; add --json for its schema-1.4 machine form.
  unused mcp          Start the MCP server (stdio) over the same engine, for
                       coding agents: find_unused, why_alive, usage_evidence.
                       Read-only, zero network.
  unused report       Write a self-contained, shareable deletion report to
                       .unused/report.md (default) or .unused/report.html
                       (--html): headline totals, top-10 deletions by LOC,
                       confidence breakdown. Contains file paths and symbol
                       names — review before sharing outside your team.
  unused badge        Write .unused/badge.json (a shields.io endpoint badge):
                       "clean" when zero high-confidence claims, otherwise
                       "N claims" — medium/low candidates never count.

OPTIONS (default report + check/baseline)
${renderOptions()}

EXAMPLES
  unused
      Analyse the repo, print the terminal report.

  unused --json > report.json
      Machine-readable output for CI or a script.

  unused --sarif unused.sarif
      Write a SARIF log (e.g. for GitHub code scanning upload).

  unused --filter export --min-confidence high
      Only the high-confidence unused exports.

  unused --fix --fix-type exports,dependencies
      Remove eligible export surfaces and dependency declarations, then
      re-analyse. Review the working-tree diff; no commit is created.

  unused --fix --fix-type files --allow-remove-files
      Delete eligible unused files. Both file-removal flags are required.

  unused why --delete src/legacy.ts
      Show required re-export edits and staged newly-dead consequences without
      changing the working tree.

  unused --all --json
      Every claim, not just the top 10 per section, as JSON.

  unused baseline
      Bless the current claims as the committed baseline (run on main).

  unused check
      Fail the build if any high-confidence claim is new since baseline.

  unused report --html
      Write .unused/report.html — open it in a browser or screenshot it.

  unused badge
      Write .unused/badge.json for a README badge (links to unused.dev).

EXIT CODES
  0   success — report printed, or the gate/baseline/report/badge succeeded.
  1   gate failure — \`unused check\` found new dead weight at or above
      gate.threshold.
  2   analysis error — the tool could not complete (bad tsconfig, unsupported
      project layout), or an artifact (--sarif, report, badge) could not be
      written.
  3   usage error — a bad flag or an invalid flag value (e.g.
      --min-confidence, or --md/--html together), \`unused check\` with no
      baseline (run \`unused baseline\` first), or a Node version below the
      supported floor (>=22).

docs: unused.dev
`;
}
