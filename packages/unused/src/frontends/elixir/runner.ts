/**
 * Runs the generated compiler-tracer script against an Elixir project (ADR 0011).
 *
 * The one place `unused` executes user code (disclosed in the assumption set).
 * The flow: write {@link TRACER_SCRIPT} + an output path into a temp dir, run
 * `mix run <script>` in the project directory with `UNUSED_OUT` pointing at the
 * output file, then parse the JSON-lines it wrote back.
 *
 * ## Refusal, never a silently-wrong answer (ADR 0011)
 * Every way the run can fail to produce a trustworthy graph is a *refusal* — a
 * thrown {@link ElixirFrontendError} the CLI maps to a non-zero (exit-2 family)
 * with a clear message, never a partial/empty result mistaken for "nothing is
 * dead":
 *  - `mix`/`elixir` not on PATH (spawn `ENOENT`) ⇒ {@link ElixirToolchainError}.
 *  - `mix run` exits non-zero, or the tracer reported a compile error, or the
 *    project's deps are not fetched (compile fails) ⇒ {@link ElixirCompileError}.
 *  - the output file is missing/empty/unparseable ⇒ {@link ElixirCompileError}.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AppModRecord,
  DepsRecord,
  FunctionRecord,
  ModuleRecord,
  TraceEvent,
  TraceRecord,
  TraceResult,
} from "./events.js";
import { TRACER_SCRIPT } from "./tracer-script.js";

/** Base class for every Elixir-frontend refusal — the CLI prints these plainly (exit 2). */
export class ElixirFrontendError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ElixirFrontendError";
  }
}

/** `elixir`/`mix` is not installed or not on PATH. */
export class ElixirToolchainError extends ElixirFrontendError {
  constructor(message: string) {
    super(message);
    this.name = "ElixirToolchainError";
  }
}

/** The project could not be compiled (deps unfetched, syntax error, tracer failure). */
export class ElixirCompileError extends ElixirFrontendError {
  constructor(message: string) {
    super(message);
    this.name = "ElixirCompileError";
  }
}

export interface RunTracerOptions {
  /** Milliseconds before the child `mix` process is killed (default 300_000). */
  readonly timeoutMs?: number;
  /**
   * The build tool executable to invoke (default `mix`). Overridable for a
   * custom toolchain wrapper or, in tests, to force the toolchain-absent
   * (`ENOENT`) refusal path deterministically without touching `PATH`.
   */
  readonly command?: string;
}

const DEFAULT_TIMEOUT_MS = 300_000;
/** The tracer output of a large app can be many MB of JSON-lines. */
const MAX_BUFFER = 256 * 1024 * 1024;

/**
 * Run the tracer against the Elixir project rooted at `projectDir` (the
 * directory holding `mix.exs`) and return the parsed {@link TraceResult}.
 * Throws an {@link ElixirFrontendError} on any refusal path.
 */
export function runTracer(projectDir: string, options: RunTracerOptions = {}): TraceResult {
  const workDir = mkdtempSync(join(tmpdir(), "unused-ex-"));
  const scriptPath = join(workDir, "unused_tracer.exs");
  const outPath = join(workDir, "trace.jsonl");
  writeFileSync(scriptPath, TRACER_SCRIPT, "utf8");

  try {
    const result = spawnSync(options.command ?? "mix", ["run", "--no-start", scriptPath], {
      cwd: projectDir,
      encoding: "utf8",
      timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxBuffer: MAX_BUFFER,
      env: { ...process.env, UNUSED_OUT: outPath, MIX_QUIET: "1" },
    });

    if (result.error !== undefined) {
      const err = result.error as NodeJS.ErrnoException;
      if (err.code === "ENOENT") {
        throw new ElixirToolchainError(
          "cannot analyze Elixir project: `mix` was not found on PATH. Install Elixir/OTP " +
            "(https://elixir-lang.org/install.html) and ensure `mix` is runnable, then retry.",
        );
      }
      if (err.code === "ETIMEDOUT") {
        throw new ElixirCompileError(
          `cannot analyze Elixir project: \`mix compile\` timed out after ${
            (options.timeoutMs ?? DEFAULT_TIMEOUT_MS) / 1000
          }s in ${projectDir}.`,
        );
      }
      throw new ElixirCompileError(
        `cannot analyze Elixir project: failed to run \`mix\` in ${projectDir}: ${err.message}`,
      );
    }

    if (result.status !== 0) {
      const tail = tailLines(result.stderr ?? result.stdout ?? "", 12);
      throw new ElixirCompileError(
        `cannot analyze Elixir project: \`mix compile\` failed in ${projectDir} (exit ${result.status}). ` +
          "Ensure dependencies are fetched (`mix deps.get`) and the project compiles cleanly, then retry.\n" +
          tail,
      );
    }

    let raw: string;
    try {
      raw = readFileSync(outPath, "utf8");
    } catch {
      throw new ElixirCompileError(
        "cannot analyze Elixir project: the tracer produced no output (the compile may have " +
          "failed before the tracer ran). Check that the project compiles with `mix compile`.",
      );
    }

    return parseTraceOutput(raw);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

/** Parse the JSON-lines the tracer wrote into a structured {@link TraceResult}. */
export function parseTraceOutput(raw: string): TraceResult {
  const events: TraceEvent[] = [];
  const modules: ModuleRecord[] = [];
  const functions: FunctionRecord[] = [];
  let appMod: string | null = null;
  let deps: readonly string[] = [];
  let compileOk = true;
  let sawCompileError = false;

  const lines = raw.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    let record: TraceRecord;
    try {
      record = JSON.parse(trimmed) as TraceRecord;
    } catch {
      // A stray non-JSON line (a warning leaked into the file) is ignored — the
      // tracer writes only JSON, but degrade rather than abort on noise.
      continue;
    }
    switch (record.k) {
      case "event":
        events.push(record);
        break;
      case "module":
        modules.push(record);
        break;
      case "function":
        functions.push(record);
        break;
      case "app_mod":
        appMod = (record as AppModRecord).mod;
        break;
      case "deps":
        deps = (record as DepsRecord).names;
        break;
      case "meta":
        compileOk = record.compile_ok;
        break;
      case "compile_error":
        sawCompileError = true;
        break;
      default:
        break;
    }
  }

  if (sawCompileError || !compileOk) {
    throw new ElixirCompileError(
      "cannot analyze Elixir project: `mix compile` reported errors. Fix the compile errors " +
        "(the project must compile cleanly) and retry.",
    );
  }
  if (modules.length === 0) {
    throw new ElixirCompileError(
      "cannot analyze Elixir project: the tracer found no compiled modules. Confirm the project " +
        "compiles (`mix compile`) and defines modules under `lib/`.",
    );
  }

  return { events, modules, functions, appMod, deps, compileOk };
}

function tailLines(text: string, n: number): string {
  const lines = text.trimEnd().split("\n");
  return lines.slice(-n).join("\n");
}
