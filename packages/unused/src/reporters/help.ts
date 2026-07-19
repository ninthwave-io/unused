/**
 * `--help` / `-h` text (T6.1/T7.1/T7.2, docs/phasing.md M6/M7), in the
 * cli-ux voice: scannable, action-first, evidence-first. Documents exactly
 * the command/flag surface this build implements (`unused [options]`,
 * `unused check`, `unused baseline`) — `why` / `mcp` / `report` / `badge`
 * are named on the PRD §3 command table but ship in later milestones
 * (M8/M9), so they are deliberately absent here rather than documented as
 * if they already work: "zero-config first run is the pitch ... it gets one
 * chance" (cli-ux §1) — a `--help` example that fails when tried is the
 * same trust break as a wrong claim.
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
      "List /* unused:ignore */ claims too (always counted either",
      "way, never silently dropped).",
    ],
  },
  {
    flag: "--no-color",
    lines: [
      "Disable ANSI output. Also implied by a non-TTY stdout or",
      "the NO_COLOR environment variable.",
    ],
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
"why". Local-first, zero network calls, zero telemetry. Never modifies code.

USAGE
  unused [options]
  unused check [--cwd <dir>] [--config <path>]
  unused baseline [--cwd <dir>] [--config <path>]

COMMANDS
  unused              Analyse the repo, print the terminal report (default).
  unused check        CI gate: compare this run's claims against the
                       committed baseline, fail only on claims new since it
                       (PRD §3). Gated at config gate.threshold (default
                       high) — --min-confidence has no effect on the gate.
  unused baseline     Write/update .unused/baseline.jsonl (one per
                       workspace) and print what it blessed. Regenerate on
                       main only — never on a feature branch.

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

  unused --all --json
      Every claim, not just the top 10 per section, as JSON.

  unused baseline
      Bless the current claims as the committed baseline (run on main).

  unused check
      Fail the build if any high-confidence claim is new since baseline.

EXIT CODES
  0   success — report printed, or the gate/baseline passed.
  1   gate failure — \`unused check\` found new dead weight at or above
      gate.threshold.
  2   analysis error — the tool could not complete (bad tsconfig, unsupported
      project layout).
  3   usage error — a bad flag or an invalid flag value (e.g.
      --min-confidence), or \`unused check\` with no baseline (run
      \`unused baseline\` first).

docs: unused.dev
`;
}
