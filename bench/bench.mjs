#!/usr/bin/env node
/**
 * unused — bench harness (T2.6, docs/phasing.md M2).
 *
 * Timed cold runs of the reference tool (knip, pinned exactly in
 * bench/package.json) and `unused` (pending until T2.5 ships the CLI
 * build) against the bench/targets.json target list.
 *
 * Every run — warm-up and timed — is a fresh child process. "Cold" here
 * means a new process per run, not a cleared OS file cache; a warm OS
 * cache between runs is expected and is not something this harness tries
 * to defeat.
 *
 * Usage:
 *   node bench/bench.mjs                                   # print JSON to stdout
 *   node bench/bench.mjs --out docs/bench/2026-07-18-fixtures.json
 *   node bench/bench.mjs --runs 5 --out /path/to/file.json
 *
 * See bench/README.md for the full contract.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { arch, cpus, platform, release } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const BENCH_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(BENCH_DIR, "..");
const WARMUP_RUNS = 1;
const DEFAULT_TIMED_RUNS = 3;
const SNIPPET_MAX_CHARS = 400;

const CAVEAT =
  "Fixture-scale numbers are dominated by process startup (each run is a fresh " +
  "Node process paying module-load cost against a mini-repo of a handful of " +
  "files), not by analysis time. They are not a proxy for real-repo performance " +
  "and should not be compared against the PRD §8 budget (5,000-module repo, " +
  "<60s cold / <10s warm). Real numbers arrive with the M3 smoke repos " +
  "(docs/phasing.md).";

function parseArgs(argv) {
  const args = { runs: DEFAULT_TIMED_RUNS, out: null, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--out") {
      args.out = argv[i + 1];
      i += 1;
    } else if (arg === "--runs") {
      args.runs = Number.parseInt(argv[i + 1], 10);
      i += 1;
    } else if (arg === "--help" || arg === "-h") {
      args.help = true;
    }
  }
  return args;
}

function printHelp() {
  process.stdout.write(
    [
      "Usage: node bench/bench.mjs [--runs N] [--out <path>]",
      "",
      "  --runs N     Timed runs per target/tool after 1 warm-up (default 3).",
      "  --out PATH   Write JSON results to PATH instead of stdout.",
      "               PATH is resolved relative to the current working directory.",
      "",
    ].join("\n"),
  );
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1] + sorted[mid]) / 2;
  }
  return sorted[mid];
}

function truncate(text, max) {
  if (!text) return "";
  const trimmed = text.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max)}… (truncated)`;
}

/** Run `command args` once in `cwd`, timing wall-clock via performance.now(). */
function timedRun(command, args, cwd) {
  const start = performance.now();
  const result = spawnSync(command, args, { cwd, encoding: "utf8" });
  const ms = performance.now() - start;
  return {
    ms,
    exitCode: result.status,
    signal: result.signal ?? null,
    stderrSnippet: truncate(result.stderr, SNIPPET_MAX_CHARS),
    spawnError: result.error ? result.error.message : null,
  };
}

/**
 * Run 1 warm-up + N timed fresh-process runs of `command args` in `cwd`.
 * Never throws: a tool that fails to spawn or exits non-zero is still a
 * fully-timed, fully-reported result.
 */
function benchOne(command, args, cwd, runs) {
  const warmup = timedRun(command, args, cwd);
  const timed = [];
  for (let i = 0; i < runs; i += 1) {
    timed.push(timedRun(command, args, cwd));
  }
  const times = timed.map((r) => r.ms);
  const last = timed[timed.length - 1];
  return {
    status: timed.some((r) => r.spawnError) ? "error" : "ok",
    runs: timed.length,
    exitCodes: timed.map((r) => r.exitCode),
    minMs: Math.min(...times),
    medianMs: median(times),
    warmupMs: warmup.ms,
    stderrSnippet: last.stderrSnippet,
    spawnError: last.spawnError,
  };
}

function pendingResult(note) {
  return {
    status: "pending",
    runs: 0,
    exitCodes: [],
    minMs: null,
    medianMs: null,
    warmupMs: null,
    stderrSnippet: "",
    spawnError: null,
    note,
  };
}

function resolveToolBin(tool) {
  const root = tool.binRoot === "bench" ? BENCH_DIR : REPO_ROOT;
  return join(root, tool.bin);
}

function knipVersion() {
  try {
    const pkg = JSON.parse(readFileSync(join(BENCH_DIR, "node_modules/knip/package.json"), "utf8"));
    return pkg.version;
  } catch {
    return null;
  }
}

function machineMetadata() {
  const cpuList = cpus();
  return {
    os: {
      platform: platform(),
      release: release(),
      arch: arch(),
    },
    cpu: {
      model: cpuList[0]?.model ?? "unknown",
      cores: cpuList.length,
    },
    node: process.version,
  };
}

/**
 * Time every tool against one target directory, appending to `results`.
 * Shared by the fixture-corpus loop (`config.targets`, relative to
 * `fixturesRoot`) and the M3 smoke-repo loop (`config.smokeTargets`,
 * machine-local absolute paths, T3.5) so both go through identical
 * warm-up/timed-run/pending-result handling.
 */
function benchTarget(config, targetName, targetDir, targetRelPath, runs, results) {
  if (!existsSync(targetDir)) {
    results.push({
      target: targetName,
      path: targetRelPath,
      tool: "knip",
      ...pendingResult(`target directory not found: ${targetRelPath}`),
    });
    return;
  }

  for (const toolName of ["knip", "unused"]) {
    const tool = config.tools[toolName];
    const binAbs = resolveToolBin(tool);
    if (tool.kind === "repo-cli" && !existsSync(binAbs)) {
      results.push({
        target: targetName,
        path: targetRelPath,
        tool: toolName,
        ...pendingResult(
          `${tool.bin} not built yet — T2.5 wires the unused CLI; this hook activates automatically once it exists`,
        ),
      });
      continue;
    }
    const outcome = benchOne(process.execPath, [binAbs, ...tool.args], targetDir, runs);
    results.push({ target: targetName, path: targetRelPath, tool: toolName, ...outcome });
  }
}

function runBench(runs) {
  const config = JSON.parse(readFileSync(join(BENCH_DIR, "targets.json"), "utf8"));
  const pinnedKnip = JSON.parse(readFileSync(join(BENCH_DIR, "package.json"), "utf8"))
    .devDependencies.knip;

  const results = [];
  for (const targetName of config.targets) {
    const targetDir = join(REPO_ROOT, config.fixturesRoot, targetName);
    const targetRelPath = `${config.fixturesRoot}/${targetName}`;
    benchTarget(config, targetName, targetDir, targetRelPath, runs, results);
  }

  // M3 smoke repos (T3.5): machine-local scratch clones, absolute paths,
  // not relative to fixturesRoot. Optional key — absent on a fresh clone
  // of this repo, so this loop is a no-op until targets.json#smokeTargets
  // is populated (never committed with real paths; see targets.json's
  // smokeTargetsNote).
  for (const smokeTarget of config.smokeTargets ?? []) {
    benchTarget(config, smokeTarget.name, smokeTarget.path, smokeTarget.path, runs, results);
  }

  return {
    generatedAt: new Date().toISOString(),
    harness: {
      warmupRuns: WARMUP_RUNS,
      timedRuns: runs,
      coldRunDefinition:
        "cold = fresh child process per run; a warm OS file cache across runs is expected and acceptable",
    },
    machine: machineMetadata(),
    tools: {
      knip: {
        pinnedVersion: pinnedKnip,
        installedVersion: knipVersion(),
        invocation: "bench/node_modules/.bin/knip --no-config-hints",
      },
      unused: {
        status: existsSync(resolveToolBin(config.tools.unused)) ? "available" : "pending",
        note: "reads bench/targets.json#tools.unused; wired since T2.5 shipped packages/unused/dist/cli/index.js — status flips to 'pending' automatically if dist/ isn't built.",
      },
    },
    caveat: CAVEAT,
    results,
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }
  if (!Number.isInteger(args.runs) || args.runs < 1) {
    process.stderr.write(`--runs must be a positive integer, got: ${process.argv}\n`);
    process.exitCode = 1;
    return;
  }

  const report = runBench(args.runs);
  const json = `${JSON.stringify(report, null, 2)}\n`;

  if (args.out) {
    const outPath = resolve(process.cwd(), args.out);
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, json);
    formatWithRepoBiome(outPath);
    process.stderr.write(`bench: wrote ${report.results.length} results to ${args.out}\n`);
  } else {
    process.stdout.write(json);
  }
}

/**
 * Results files land under docs/, which the repo's `pnpm run lint` (biome
 * check .) formats/lints like any other tracked file. Node's own
 * JSON.stringify pretty-printing doesn't match biome's JSON style (short
 * primitive arrays collapse to one line), so a raw bench.mjs run would
 * fail the root lint gate on the file it just wrote. Best-effort only:
 * this is a repo-monorepo convenience, not something bench/ depends on —
 * if the repo's biome binary isn't present (e.g. bench/ copied elsewhere),
 * this silently no-ops and leaves plain JSON.stringify output in place.
 */
function formatWithRepoBiome(outPath) {
  if (!outPath.startsWith(REPO_ROOT)) return;
  const biomeBin = join(REPO_ROOT, "node_modules/.bin/biome");
  if (!existsSync(biomeBin)) return;
  spawnSync(biomeBin, ["format", "--write", outPath], { cwd: REPO_ROOT });
}

main();
