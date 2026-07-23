/**
 * Runs the generated compiler-tracer script against an Elixir project (ADR 0011).
 *
 * The one place `unused` executes user code (disclosed in the assumption set).
 * The flow has two phase-selected child invocations. Production is inspected
 * and compiled first in the caller's Mix environment. When ExUnit sources
 * exist, a second child inspects and compiles the effective `MIX_ENV=test`
 * roots. Each uses a separate temporary build, exact dependency artifact links,
 * the same generated {@link TRACER_SCRIPT}, and its own phase-delimited output.
 * The analyzed application's own build artifacts are never rewritten; its
 * tracked `priv` tree is linked into each temporary app layout so compile-time
 * `Application.app_dir/2` reads keep working.
 *
 * ## Refusal, never a silently-wrong answer (ADR 0011)
 * Production must be complete: a production failure is a *refusal* — a thrown
 * {@link ElixirFrontendError} the CLI maps to a non-zero (exit-2 family), never
 * an empty result mistaken for "nothing is dead":
 *  - `mix`/`elixir` not on PATH (spawn `ENOENT`) ⇒ {@link ElixirToolchainError}.
 *  - `mix run` exits non-zero, or the tracer reported a compile error, or the
 *    project's deps are not fetched or not already compiled ⇒ {@link ElixirCompileError}.
 *  - the output file is missing/empty/unparseable ⇒ {@link ElixirCompileError}.
 *
 * Test tracing is additive. Discovery, layout, artifact, timeout, execution,
 * output, compile, or ownership failures discard every test fact and return an
 * explicit incomplete test partition while preserving verified production
 * facts. The analyzer then installs conservative completeness roots.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type CargoExecutionContext,
  cargoExecutionEnvironment,
  createCargoExecutionContext,
  disposeCargoExecutionContext,
} from "../rust/runner.js";
import { ElixirCompileError, ElixirToolchainError } from "./errors.js";
import type {
  AppModRecord,
  DepsRecord,
  ElixirStructuralFile,
  ElixirStructuralSpan,
  ElixirStructuralSummary,
  FunctionRecord,
  ModuleOwnerRecord,
  ModuleRecord,
  TestPartitionIncompleteReason,
  TestTraceResult,
  TraceEvent,
  TraceRecord,
  TraceResult,
} from "./events.js";
import {
  type BoundedTraceLines,
  discoverRustlerLoaders,
  discoverTestFiles,
  inspectMixLayout,
  type MixLayout,
  prepareIsolatedBuild,
  readBoundedTraceLines,
  resolveTestOnlyRoots,
  type TestInventory,
} from "./mix-isolation.js";
import {
  incompleteTestTrace,
  mergeTraceResults,
  stableTraceResult,
  validateProductionTraceOwnership,
  validateTestTraceOwnership,
  withDependencyApplications,
} from "./trace-merge.js";
import {
  decodeTraceRecord,
  hasConflictingDefinitions,
  hasExactModuleOwnership,
  hasValidPhase,
} from "./trace-protocol.js";
import { TRACER_SCRIPT } from "./tracer-script.js";

export { ElixirCompileError, ElixirFrontendError, ElixirToolchainError } from "./errors.js";
export { mergeTraceResults } from "./trace-merge.js";

export interface RunTracerOptions {
  /** Milliseconds before the child `mix` process is killed (default 300_000). */
  readonly timeoutMs?: number;
  /**
   * The build tool executable to invoke (default `mix`). Overridable for a
   * custom toolchain wrapper or, in tests, to force the toolchain-absent
   * (`ENOENT`) refusal path deterministically without touching `PATH`.
   */
  readonly command?: string;
  /** Test-only parent for the analyzer-owned Cargo target used by Mix children. */
  readonly cargoTargetParentDir?: string;
}

const DEFAULT_TIMEOUT_MS = 300_000;
/** The tracer output of a large app can be many MB of JSON-lines. */
const MAX_BUFFER = 256 * 1024 * 1024;

/**
 * Run the tracer against the Elixir project rooted at `projectDir` (the
 * directory holding `mix.exs`) and return the parsed {@link TraceResult}.
 * Throws an {@link ElixirFrontendError} on a production refusal path; returns
 * an incomplete test partition for a bounded test-phase failure.
 */
export function runTracer(projectDir: string, options: RunTracerOptions = {}): TraceResult {
  const workDir = mkdtempSync(join(tmpdir(), "unused-ex-"));
  const scriptPath = join(workDir, "unused_tracer.exs");
  const productionOutPath = join(workDir, "production-trace.jsonl");
  const productionBuildPath = join(workDir, "production-build");
  writeFileSync(scriptPath, TRACER_SCRIPT, "utf8");

  let cargo: CargoExecutionContext | undefined;
  let primaryFailure: unknown;
  let trace: TraceResult | undefined;
  try {
    cargo = createMixCargoExecutionContext(projectDir, options.cargoTargetParentDir ?? workDir);
    const cargoEnvironment = cargoExecutionEnvironment(projectDir, cargo);
    const command = options.command ?? "mix";
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const productionLayout = inspectMixLayout(
      command,
      projectDir,
      join(workDir, "production-layout-build"),
      timeoutMs,
      undefined,
      cargoEnvironment,
    );
    const productionRustlerPath = join(workDir, "production-rustler-loaders.json");
    writeFileSync(
      productionRustlerPath,
      JSON.stringify(discoverRustlerLoaders(projectDir, productionLayout.sourcePaths)),
      "utf8",
    );
    try {
      prepareIsolatedBuild(productionLayout, productionBuildPath, projectDir);
    } catch {
      throw new ElixirCompileError(
        "cannot analyze Elixir project: required dependency build artifacts do not exist for " +
          "this Mix environment. Ensure dependency build artifacts exist from a clean project " +
          "compile, then retry.",
      );
    }

    const result = spawnSync(
      command,
      ["run", "--no-start", "--no-compile", "--no-deps-check", scriptPath],
      {
        cwd: projectDir,
        encoding: "utf8",
        timeout: timeoutMs,
        maxBuffer: MAX_BUFFER,
        env: {
          ...cargoEnvironment,
          UNUSED_OUT: productionOutPath,
          UNUSED_PHASE: "production",
          UNUSED_RUSTLER_LOADERS: productionRustlerPath,
          MIX_BUILD_PATH: productionBuildPath,
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
            timeoutMs / 1000
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

    let productionLines: BoundedTraceLines;
    try {
      productionLines = readBoundedTraceLines(productionOutPath);
    } catch {
      throw new ElixirCompileError(
        "cannot analyze Elixir project: the tracer produced no output (the compile may have " +
          "failed before the tracer ran). Check that the project compiles with `mix compile`.",
      );
    }

    let production: TraceResult;
    try {
      production = validateProductionTraceOwnership(
        parseProductionTraceLines(productionLines),
        productionLayout.sourcePaths,
        projectDir,
      );
    } catch (error) {
      if (error instanceof ElixirCompileError) throw error;
      throw new ElixirCompileError(
        "cannot analyze Elixir project: the tracer output could not be read safely.",
      );
    } finally {
      productionLines.close();
    }
    const productionWithDependencies = withDependencyApplications(
      production,
      productionLayout.dependencyArtifacts.map((dependency) => ({
        compilerApp: dependency.app,
        otpApp: dependency.otpApp,
      })),
      productionLayout.dependencyArtifacts
        .filter(
          (
            dependency,
          ): dependency is typeof dependency & {
            readonly lockedRelease: NonNullable<typeof dependency.lockedRelease>;
          } => dependency.hex && dependency.lockedRelease !== null,
        )
        .map((dependency) => ({
          compilerApp: dependency.app,
          otpApp: dependency.otpApp,
          ...dependency.lockedRelease,
        })),
    );
    let testFiles: readonly string[];
    try {
      testFiles = discoverTestFiles(projectDir);
    } catch {
      trace = mergeTraceResults(productionWithDependencies, incompleteTestTrace("layout"));
      testFiles = [];
    }
    if (trace === undefined) {
      if (testFiles.length === 0) {
        trace = stableTraceResult(productionWithDependencies);
      } else {
        const test = runTestTrace({
          command,
          projectDir,
          workDir,
          scriptPath,
          timeoutMs,
          production: productionWithDependencies,
          productionLayout,
          testFiles,
          cargoEnvironment,
        });
        trace = mergeTraceResults(productionWithDependencies, test);
      }
    }
  } catch (error) {
    primaryFailure = error;
  }

  let cleanupFailure: unknown;
  try {
    if (cargo !== undefined) disposeCargoExecutionContext(cargo, primaryFailure);
  } catch (error) {
    cleanupFailure = error;
  }
  try {
    rmSync(workDir, { recursive: true, force: true });
  } catch (error) {
    cleanupFailure ??= error;
  }

  if (primaryFailure !== undefined) throw primaryFailure;
  if (cleanupFailure !== undefined) {
    throw new ElixirCompileError(
      "cannot analyze Elixir project: failed to remove isolated build output.",
    );
  }
  if (trace === undefined) {
    throw new ElixirCompileError("cannot analyze Elixir project: analysis did not complete.");
  }
  return trace;
}

function runTestTrace(input: {
  readonly command: string;
  readonly projectDir: string;
  readonly workDir: string;
  readonly scriptPath: string;
  readonly timeoutMs: number;
  readonly production: TraceResult;
  readonly productionLayout: MixLayout;
  readonly testFiles: readonly string[];
  readonly cargoEnvironment: NodeJS.ProcessEnv;
}): TestTraceResult {
  let testLayout: MixLayout;
  try {
    testLayout = inspectMixLayout(
      input.command,
      input.projectDir,
      join(input.workDir, "test-layout-build"),
      input.timeoutMs,
      "test",
      input.cargoEnvironment,
    );
  } catch {
    return incompleteTestTrace("layout");
  }

  const testOnlyRoots = resolveTestOnlyRoots(
    input.productionLayout.sourcePaths,
    testLayout.sourcePaths,
  );
  if (testOnlyRoots === null) return incompleteTestTrace("ownership");

  const testBuildPath = join(input.workDir, "test-build");
  const rustlerInventoryPath = join(input.workDir, "test-rustler-loaders.json");
  try {
    writeFileSync(
      rustlerInventoryPath,
      JSON.stringify(
        discoverRustlerLoaders(input.projectDir, testLayout.sourcePaths, input.testFiles),
      ),
      "utf8",
    );
    prepareIsolatedBuild(testLayout, testBuildPath, input.projectDir);
  } catch {
    return incompleteTestTrace("artifacts");
  }

  let inventory: TestInventory;
  let inventoryPath: string;
  let outPath: string;
  try {
    inventory = {
      productionFiles: [...new Set(input.production.modules.map((module) => module.file))].sort(),
      testOnlyRoots,
      testFiles: [...input.testFiles].sort(),
    };
    inventoryPath = join(input.workDir, "test-inventory.json");
    outPath = join(input.workDir, "test-trace.jsonl");
    writeFileSync(inventoryPath, JSON.stringify(inventory), "utf8");
  } catch {
    return incompleteTestTrace("output");
  }

  const result = spawnSync(
    input.command,
    ["run", "--no-start", "--no-compile", "--no-deps-check", input.scriptPath],
    {
      cwd: input.projectDir,
      encoding: "utf8",
      timeout: input.timeoutMs,
      maxBuffer: MAX_BUFFER,
      env: {
        ...input.cargoEnvironment,
        MIX_ENV: "test",
        MIX_BUILD_PATH: testBuildPath,
        MIX_QUIET: "1",
        UNUSED_OUT: outPath,
        UNUSED_PHASE: "test",
        UNUSED_INVENTORY: inventoryPath,
        UNUSED_RUSTLER_LOADERS: rustlerInventoryPath,
      },
    },
  );
  if (result.error !== undefined) {
    const reason: TestPartitionIncompleteReason =
      (result.error as NodeJS.ErrnoException).code === "ETIMEDOUT" ? "timeout" : "execution";
    return incompleteTestTrace(reason);
  }
  if (result.status !== 0) return incompleteTestTrace("execution");

  let testLines: BoundedTraceLines | undefined;
  try {
    testLines = readBoundedTraceLines(outPath);
    return validateTestTraceOwnership(
      input.production,
      parseTestTraceLines(testLines),
      inventory,
      input.projectDir,
    );
  } catch {
    return incompleteTestTrace("output");
  } finally {
    testLines?.close();
  }
}

function createMixCargoExecutionContext(
  projectDir: string,
  targetParentDir: string,
): CargoExecutionContext {
  try {
    return createCargoExecutionContext(projectDir, targetParentDir);
  } catch {
    throw new ElixirCompileError(
      "cannot analyze Elixir project: Cargo isolation requires an external temporary target and Cargo home.",
    );
  }
}

export function parseTraceOutput(raw: string): TraceResult {
  return parseProductionTraceLines(traceLines(raw));
}

function parseProductionTraceLines(lines: Iterable<string>): TraceResult {
  const events: TraceEvent[] = [];
  const owners: ModuleOwnerRecord[] = [];
  const modules: ModuleRecord[] = [];
  const functions: FunctionRecord[] = [];
  const structuralFiles: ElixirStructuralFile[] = [];
  let structuralSummary: ElixirStructuralSummary | undefined;
  let structuralSummaryCount = 0;
  const records: TraceRecord[] = [];
  let appMod: string | null = null;
  let deps: readonly string[] = [];
  let compileOk = true;
  let sawCompileError = false;
  const testPartition: TraceResult["testPartition"] = "complete";
  const compileErrorDetails: string[] = [];
  let malformed = false;
  let metaCount = 0;
  let depsCount = 0;
  let appModCount = 0;
  let compileErrorCount = 0;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    let record: TraceRecord | null;
    try {
      record = decodeTraceRecord(JSON.parse(trimmed), "production");
    } catch {
      malformed = true;
      continue;
    }
    if (record === null) {
      malformed = true;
      continue;
    }
    records.push(record);
    switch (record.k) {
      case "owner":
        owners.push(record);
        break;
      case "event":
        events.push(record);
        break;
      case "module":
        modules.push(record);
        break;
      case "function":
        functions.push(record);
        break;
      case "structure_file":
        structuralFiles.push(record);
        break;
      case "structure_summary":
        structuralSummary = record;
        structuralSummaryCount += 1;
        break;
      case "app_mod":
        appModCount += 1;
        appMod = (record as AppModRecord).mod;
        break;
      case "deps":
        depsCount += 1;
        deps = (record as DepsRecord).names;
        break;
      case "meta":
        metaCount += 1;
        compileOk = record.compile_ok;
        break;
      case "compile_error":
        compileErrorCount += 1;
        sawCompileError = true;
        if ("details" in record && Array.isArray(record.details)) {
          compileErrorDetails.push(
            ...record.details.filter((detail): detail is string => typeof detail === "string"),
          );
        }
        break;
      default:
        break;
    }
  }

  const productionComplete = hasValidPhase(records, "production", "complete");
  const productionIncomplete = hasValidPhase(records, "production", "incomplete");
  if (
    malformed ||
    (!productionComplete && !productionIncomplete) ||
    metaCount !== 1 ||
    depsCount !== 1 ||
    appModCount > 1 ||
    compileErrorCount > 1 ||
    structuralSummaryCount !== 1 ||
    hasConflictingDefinitions(modules, functions)
  ) {
    throw new ElixirCompileError(
      "cannot analyze Elixir project: the production tracer emitted an incomplete or malformed phase protocol.",
    );
  }
  if (sawCompileError || !compileOk) {
    const details = compileErrorDetails.length > 0 ? `\n${compileErrorDetails.join("\n")}` : "";
    throw new ElixirCompileError(
      "cannot analyze Elixir project: `mix compile` reported errors. Fix the compile errors " +
        "and ensure dependency build artifacts exist from a clean project compile, then retry." +
        details,
    );
  }
  if (!productionComplete) {
    throw new ElixirCompileError(
      "cannot analyze Elixir project: the production tracer did not complete.",
    );
  }
  if (!hasExactModuleOwnership(owners, modules)) {
    throw new ElixirCompileError(
      "cannot analyze Elixir project: the production tracer emitted conflicting or incomplete module ownership.",
    );
  }
  if (modules.length === 0) {
    throw new ElixirCompileError(
      "cannot analyze Elixir project: the tracer found no compiled modules. Confirm the project " +
        "compiles (`mix compile`) and defines modules under `lib/`.",
    );
  }

  if (!hasValidStructuralEventReferences(events, structuralFiles)) {
    throw new ElixirCompileError(
      "cannot analyze Elixir project: the production tracer emitted invalid structural facts.",
    );
  }
  if (
    structuralSummary === undefined ||
    !structuralSummaryMatches(structuralSummary, structuralFiles, events.length)
  ) {
    throw new ElixirCompileError(
      "cannot analyze Elixir project: the production tracer emitted inconsistent structural counters.",
    );
  }
  return {
    events,
    modules,
    functions,
    structuralFiles,
    structuralSummary,
    appMod,
    deps,
    compileOk,
    testPartition,
  };
}

/** Parse one isolated test child. Invalid/partial output is bounded, never thrown. */
export function parseTestTraceOutput(raw: string): TestTraceResult {
  return parseTestTraceLines(traceLines(raw));
}

function parseTestTraceLines(lines: Iterable<string>): TestTraceResult {
  const events: TraceEvent[] = [];
  const owners: ModuleOwnerRecord[] = [];
  const modules: ModuleRecord[] = [];
  const functions: FunctionRecord[] = [];
  const structuralFiles: ElixirStructuralFile[] = [];
  let structuralSummary: ElixirStructuralSummary | undefined;
  let structuralSummaryCount = 0;
  const records: TraceRecord[] = [];
  let malformed = false;
  let sawCompileError = false;
  let structuralMalformed = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    let record: TraceRecord | null;
    try {
      const value = JSON.parse(trimmed) as unknown;
      record = decodeTraceRecord(value, "test");
      const structuralKind =
        typeof value === "object" &&
        value !== null &&
        "k" in value &&
        ((value as { readonly k?: unknown }).k === "structure_file" ||
          (value as { readonly k?: unknown }).k === "structure_summary");
      if (record === null && structuralKind) {
        structuralMalformed = true;
        continue;
      }
    } catch {
      malformed = true;
      continue;
    }
    if (record === null) {
      malformed = true;
      continue;
    }
    records.push(record);
    switch (record.k) {
      case "owner":
        if (record.partition === "test") owners.push(record);
        break;
      case "event":
        if (record.partition === "test") events.push(record);
        break;
      case "module":
        if (record.partition === "test") modules.push(record);
        break;
      case "function":
        if (record.partition === "test") functions.push(record);
        break;
      case "structure_file":
        if (record.partition === "test") structuralFiles.push(record);
        break;
      case "structure_summary":
        if (record.partition === "test") {
          structuralSummary = record;
          structuralSummaryCount += 1;
        }
        break;
      case "test_compile_error":
        sawCompileError = true;
        break;
      default:
        break;
    }
  }

  if (
    malformed ||
    !hasValidPhase(records, "test", "complete") ||
    hasConflictingDefinitions(modules, functions)
  ) {
    return incompleteTestTrace(sawCompileError ? "compile" : "output");
  }
  if (sawCompileError) return incompleteTestTrace("compile");
  if (!hasExactModuleOwnership(owners, modules)) return incompleteTestTrace("ownership");
  if (!hasValidStructuralEventReferences(events, structuralFiles)) structuralMalformed = true;
  if (
    !structuralMalformed &&
    (structuralSummaryCount !== 1 ||
      structuralSummary === undefined ||
      !structuralSummaryMatches(structuralSummary, structuralFiles, events.length))
  ) {
    structuralMalformed = true;
  }
  return {
    events,
    modules,
    functions,
    structuralFiles: structuralMalformed ? [] : structuralFiles,
    ...(structuralSummary === undefined || structuralMalformed ? {} : { structuralSummary }),
    structuralPartition: structuralMalformed ? "incomplete" : "complete",
    testPartition: "complete",
  };
}

/** Iterate one JSONL record at a time without retaining a second whole-trace line array. */
function* traceLines(raw: string): Generator<string> {
  let start = 0;
  for (let index = 0; index <= raw.length; index += 1) {
    if (index !== raw.length && raw.charCodeAt(index) !== 10) continue;
    yield raw.slice(start, index);
    start = index + 1;
  }
}

function structuralSummaryMatches(
  summary: ElixirStructuralSummary,
  files: readonly ElixirStructuralFile[],
  rawEvents: number,
): boolean {
  let completeFiles = 0;
  let bytes = 0;
  let astNodes = 0;
  let maxDepth = 0;
  let carriers = 0;
  let facts = 0;
  let exactFacts = 0;
  let opaqueFacts = 0;
  const roles = new Map<string, number>();
  for (const file of files) {
    if (file.status === "complete") completeFiles += 1;
    bytes += file.bytes;
    astNodes += file.astNodes;
    maxDepth = Math.max(maxDepth, file.maxDepth);
    carriers += file.carriers.length;
    facts += file.facts.length;
    for (const fact of file.facts) {
      if (fact.resolution === "exact") exactFacts += 1;
      if (fact.resolution === "opaque") opaqueFacts += 1;
      roles.set(fact.role, (roles.get(fact.role) ?? 0) + 1);
    }
  }
  const summaryRoles = Object.entries(summary.roles).filter(([, count]) => count !== 0);
  const actualRoles = [...roles.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  summaryRoles.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return (
    summary.rawEvents === rawEvents &&
    summary.files === files.length &&
    summary.completeFiles === completeFiles &&
    summary.incompleteFiles === files.length - completeFiles &&
    summary.bytes === bytes &&
    summary.astNodes === astNodes &&
    summary.maxDepth === maxDepth &&
    summary.carriers === carriers &&
    summary.facts === facts &&
    summary.exactFacts === exactFacts &&
    summary.opaqueFacts === opaqueFacts &&
    JSON.stringify(summaryRoles) === JSON.stringify(actualRoles)
  );
}

function hasValidStructuralEventReferences(
  events: readonly TraceEvent[],
  files: readonly ElixirStructuralFile[],
): boolean {
  const ids = new Set<number>();
  const eventsById = new Map<number, TraceEvent>();
  for (const event of events) {
    if (event.eventId === undefined || ids.has(event.eventId)) return false;
    ids.add(event.eventId);
    eventsById.set(event.eventId, event);
  }
  const fileKeys = new Set<string>();
  for (const file of files) {
    const key = `${file.partition}\0${file.file}`;
    if (fileKeys.has(key)) return false;
    fileKeys.add(key);
    const carriers = new Set<number>();
    for (const [index, carrier] of file.carriers.entries()) {
      if (carrier.id !== index || carriers.has(carrier.id)) return false;
      carriers.add(carrier.id);
    }
    for (const fact of file.facts) {
      if (!carriers.has(fact.carrier)) return false;
      if (fact.eventId !== null) {
        if (!ids.has(fact.eventId)) return false;
        const event = eventsById.get(fact.eventId);
        if (
          event === undefined ||
          event.line <= 0 ||
          (event.column ?? 0) <= 0 ||
          event.name === undefined ||
          event.arity === undefined ||
          fact.argument === null ||
          fact.argument >= event.arity ||
          fact.to === null ||
          (fact.role === "pipeline-argument"
            ? !validPipelineEventPoint(event.line, event.column ?? 0, fact.from, fact.to)
            : event.line !== fact.to.sl || (event.column ?? 0) !== fact.to.sc)
        )
          return false;
      }
    }
  }
  return true;
}

function validPipelineEventPoint(
  line: number,
  column: number,
  from: ElixirStructuralSpan,
  pipeline: ElixirStructuralSpan,
): boolean {
  const afterPipelineStart = line > pipeline.sl || (line === pipeline.sl && column > pipeline.sc);
  const atOrAfterArgumentEnd = line > from.el || (line === from.el && column >= from.ec);
  const beforeEnd = line < pipeline.el || (line === pipeline.el && column < pipeline.ec);
  return afterPipelineStart && atOrAfterArgumentEnd && beforeEnd;
}

function tailLines(text: string, n: number): string {
  const lines = text.trimEnd().split("\n");
  return lines.slice(-n).join("\n");
}
