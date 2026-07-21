/**
 * Runs the generated compiler-tracer script against an Elixir project (ADR 0011).
 *
 * The one place `unused` executes user code (disclosed in the assumption set).
 * The flow: inspect Mix without compiling, prepare an isolated temporary build
 * path that reuses the project's already-compiled dependency artifacts, write
 * {@link TRACER_SCRIPT} + an output path there, run the script with Mix's
 * `--no-compile` option and `UNUSED_OUT` pointing at the output file, then parse the
 * JSON-lines it wrote back. The analyzed application's own `_build` artifacts
 * are never rewritten; its tracked `priv` tree is linked into the temporary app
 * layout so compiler-time `Application.app_dir/2` reads keep working.
 *
 * ## Refusal, never a silently-wrong answer (ADR 0011)
 * Every way the run can fail to produce a trustworthy graph is a *refusal* — a
 * thrown {@link ElixirFrontendError} the CLI maps to a non-zero (exit-2 family)
 * with a clear message, never a partial/empty result mistaken for "nothing is
 * dead":
 *  - `mix`/`elixir` not on PATH (spawn `ENOENT`) ⇒ {@link ElixirToolchainError}.
 *  - `mix run` exits non-zero, or the tracer reported a compile error, or the
 *    project's deps are not fetched or not already compiled ⇒ {@link ElixirCompileError}.
 *  - the output file is missing/empty/unparseable ⇒ {@link ElixirCompileError}.
 */

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
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
const LAYOUT_MARKER = "__UNUSED_MIX_LAYOUT__";

interface MixLayout {
  readonly app: string;
  readonly buildPath: string;
}

/**
 * Run the tracer against the Elixir project rooted at `projectDir` (the
 * directory holding `mix.exs`) and return the parsed {@link TraceResult}.
 * Throws an {@link ElixirFrontendError} on any refusal path.
 */
export function runTracer(projectDir: string, options: RunTracerOptions = {}): TraceResult {
  const workDir = mkdtempSync(join(tmpdir(), "unused-ex-"));
  const scriptPath = join(workDir, "unused_tracer.exs");
  const outPath = join(workDir, "trace.jsonl");
  const isolatedBuildPath = join(workDir, "build");
  writeFileSync(scriptPath, TRACER_SCRIPT, "utf8");

  try {
    const command = options.command ?? "mix";
    const layout = inspectMixLayout(
      command,
      projectDir,
      join(workDir, "layout-build"),
      options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    );
    prepareIsolatedBuild(layout, isolatedBuildPath, projectDir);

    const result = spawnSync(
      command,
      ["run", "--no-start", "--no-compile", "--no-deps-check", scriptPath],
      {
        cwd: projectDir,
        encoding: "utf8",
        timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        maxBuffer: MAX_BUFFER,
        env: {
          ...process.env,
          UNUSED_OUT: outPath,
          MIX_BUILD_PATH: isolatedBuildPath,
          MIX_QUIET: "1",
        },
      },
    );

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
          "Ensure dependencies are fetched (`mix deps.get`), their build artifacts exist from a " +
          "clean project compile, and the project compiles cleanly, then retry.\n" +
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

/**
 * Ask Mix for the effective build path and application name without compiling
 * the project. Loading `mix.exs` still executes the project's Mix configuration
 * (already part of ADR 0011's disclosed trust boundary), but `--no-compile`
 * guarantees this discovery step does not update compiler manifests.
 */
function inspectMixLayout(
  command: string,
  projectDir: string,
  inspectionBuildPath: string,
  timeoutMs: number,
): MixLayout {
  const expression =
    'payload = %{app: to_string(Mix.Project.config()[:app] || ""), ' +
    'build_root: to_string(Mix.Project.config()[:build_path] || ""), ' +
    "mix_env: to_string(Mix.env())}; " +
    `IO.puts("${LAYOUT_MARKER}" <> IO.iodata_to_binary(:json.encode(payload)))`;
  const result = spawnSync(
    command,
    ["run", "--no-start", "--no-compile", "--no-deps-check", "-e", expression],
    {
      cwd: projectDir,
      encoding: "utf8",
      timeout: timeoutMs,
      maxBuffer: MAX_BUFFER,
      env: { ...process.env, MIX_BUILD_PATH: inspectionBuildPath, MIX_QUIET: "1" },
    },
  );

  if (result.error !== undefined) throwSpawnError(result.error, projectDir, timeoutMs);
  if (result.status !== 0) {
    const tail = tailLines(result.stderr ?? result.stdout ?? "", 12);
    throw new ElixirCompileError(
      `cannot analyze Elixir project: failed to inspect the Mix build in ${projectDir} (exit ${result.status}). ` +
        "Ensure dependencies are fetched and their build artifacts exist from a clean project compile.\n" +
        tail,
    );
  }

  const markerLine = (result.stdout ?? "")
    .split("\n")
    .find((line) => line.startsWith(LAYOUT_MARKER));
  if (markerLine === undefined) {
    throw new ElixirCompileError(
      "cannot analyze Elixir project: Mix did not report its build layout.",
    );
  }

  try {
    const parsed = JSON.parse(markerLine.slice(LAYOUT_MARKER.length)) as {
      app?: unknown;
      build_root?: unknown;
      mix_env?: unknown;
    };
    if (typeof parsed.app !== "string" || parsed.app === "") throw new Error("missing app");
    if (typeof parsed.build_root !== "string") throw new Error("invalid build root");
    if (typeof parsed.mix_env !== "string" || parsed.mix_env === "") throw new Error("missing env");

    const { MIX_BUILD_PATH: configuredPath } = process.env;
    const buildPath = configuredPath
      ? resolveFromProject(projectDir, configuredPath)
      : join(resolveFromProject(projectDir, parsed.build_root || "_build"), parsed.mix_env);
    return { app: parsed.app, buildPath };
  } catch {
    throw new ElixirCompileError(
      "cannot analyze Elixir project: Mix reported an invalid build layout.",
    );
  }
}

function resolveFromProject(projectDir: string, path: string): string {
  return isAbsolute(path) ? path : resolve(projectDir, path);
}

/**
 * Give the application a fresh build tree while reusing dependency artifacts
 * read-only and exposing its tracked `priv` resources. `compile.elixir` only
 * compiles the current application, so dependency links are loaded but never
 * passed to a compiler task.
 */
function prepareIsolatedBuild(
  layout: MixLayout,
  isolatedBuildPath: string,
  projectDir: string,
): void {
  const sourceLib = join(layout.buildPath, "lib");
  const isolatedLib = join(isolatedBuildPath, "lib");
  mkdirSync(isolatedLib, { recursive: true });

  // Mix resolves Application.app_dir(app, "priv/...") to this location even
  // while the application's modules are still being compiled. Mirror Mix's
  // ordinary priv link in the isolated app layout before compile.elixir runs.
  // The link exposes tracked resources for reads without copying or writing
  // anything into the consumer's build tree.
  const sourcePriv = join(projectDir, "priv");
  if (existsSync(sourcePriv)) {
    const isolatedApp = join(isolatedLib, layout.app);
    mkdirSync(isolatedApp, { recursive: true });
    symlinkSync(sourcePriv, join(isolatedApp, "priv"), "dir");
  }

  if (!existsSync(sourceLib)) return;

  for (const entry of readdirSync(sourceLib, { withFileTypes: true })) {
    if (entry.name === layout.app) continue;
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    symlinkSync(join(sourceLib, entry.name), join(isolatedLib, entry.name), "dir");
  }
}

function throwSpawnError(error: Error, projectDir: string, timeoutMs: number): never {
  const err = error as NodeJS.ErrnoException;
  if (err.code === "ENOENT") {
    throw new ElixirToolchainError(
      "cannot analyze Elixir project: `mix` was not found on PATH. Install Elixir/OTP " +
        "(https://elixir-lang.org/install.html) and ensure `mix` is runnable, then retry.",
    );
  }
  if (err.code === "ETIMEDOUT") {
    throw new ElixirCompileError(
      `cannot analyze Elixir project: \`mix compile\` timed out after ${timeoutMs / 1000}s in ${projectDir}.`,
    );
  }
  throw new ElixirCompileError(
    `cannot analyze Elixir project: failed to run \`mix\` in ${projectDir}: ${err.message}`,
  );
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
  let testPartition: TraceResult["testPartition"] = "complete";
  const compileErrorDetails: string[] = [];

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
        if ("details" in record && Array.isArray(record.details)) {
          compileErrorDetails.push(
            ...record.details.filter((detail): detail is string => typeof detail === "string"),
          );
        }
        break;
      case "test_compile_error":
        testPartition = "incomplete";
        break;
      default:
        break;
    }
  }

  if (sawCompileError || !compileOk) {
    const details = compileErrorDetails.length > 0 ? `\n${compileErrorDetails.join("\n")}` : "";
    throw new ElixirCompileError(
      "cannot analyze Elixir project: `mix compile` reported errors. Fix the compile errors " +
        "and ensure dependency build artifacts exist from a clean project compile, then retry." +
        details,
    );
  }
  if (modules.length === 0) {
    throw new ElixirCompileError(
      "cannot analyze Elixir project: the tracer found no compiled modules. Confirm the project " +
        "compiles (`mix compile`) and defines modules under `lib/`.",
    );
  }

  return { events, modules, functions, appMod, deps, compileOk, testPartition };
}

function tailLines(text: string, n: number): string {
  const lines = text.trimEnd().split("\n");
  return lines.slice(-n).join("\n");
}
