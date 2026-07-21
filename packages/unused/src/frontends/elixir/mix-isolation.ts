/** Same-environment Mix discovery and read-only isolated build preparation. */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, symlinkSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { ElixirCompileError, ElixirToolchainError } from "./errors.js";
import { bytewiseCompare } from "./trace-protocol.js";

const MAX_BUFFER = 256 * 1024 * 1024;
const MAX_TRACE_BYTES = 256 * 1024 * 1024;
const LAYOUT_MARKER = "__UNUSED_MIX_LAYOUT__";

interface MixDependencyArtifact {
  readonly app: string;
  readonly buildPath: string;
  readonly appResource: string | null;
  readonly required: boolean;
}

export interface MixLayout {
  readonly app: string;
  readonly buildPath: string;
  readonly sourcePaths: readonly string[];
  readonly dependencyArtifacts: readonly MixDependencyArtifact[];
}

export interface TestInventory {
  readonly productionFiles: readonly string[];
  readonly testOnlyRoots: readonly string[];
  readonly testFiles: readonly string[];
}

export function discoverTestFiles(projectDir: string): readonly string[] {
  const testDir = join(projectDir, "test");
  if (!existsSync(testDir)) return [];
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      bytewiseCompare(a.name, b.name),
    )) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && entry.name.endsWith("_test.exs")) {
        found.push(projectRelativePath(projectDir, path));
      }
    }
  };
  walk(testDir);
  return found.sort(bytewiseCompare);
}

export function resolveTestOnlyRoots(
  productionRoots: readonly string[],
  testRoots: readonly string[],
): readonly string[] | null {
  const production = new Set(productionRoots);
  const delta = [...new Set(testRoots.filter((root) => !production.has(root)))].sort(
    bytewiseCompare,
  );
  for (const candidate of delta) {
    if (
      productionRoots.some((root) => pathWithin(candidate, root) || pathWithin(root, candidate))
    ) {
      return null;
    }
  }
  return delta;
}

export function pathWithin(path: string, root: string): boolean {
  if (root === ".") return path !== "";
  return path === root || path.startsWith(`${root}/`);
}

export function inspectMixLayout(
  command: string,
  projectDir: string,
  inspectionBuildPath: string,
  timeoutMs: number,
  mixEnv?: string,
): MixLayout {
  const expression =
    "config = Mix.Project.config(); " +
    "inspection_build_path = Mix.Project.build_path(); " +
    "deps = Mix.Dep.cached(); " +
    'case System.get_env("UNUSED_SOURCE_MIX_BUILD_PATH") do ' +
    'nil -> System.delete_env("MIX_BUILD_PATH"); path -> System.put_env("MIX_BUILD_PATH", path) end; ' +
    "source_build_path = config |> Keyword.delete(:deps_build_path) |> Mix.Project.build_path(); " +
    'System.put_env("MIX_BUILD_PATH", inspection_build_path); ' +
    'payload = %{app: to_string(Mix.Project.config()[:app] || ""), ' +
    "build_path: source_build_path, " +
    'elixirc_paths: Enum.map(Mix.Project.config()[:elixirc_paths] || ["lib"], &to_string/1), ' +
    "dependency_artifacts: Enum.map(deps, fn dep -> " +
    "inspection_dep_build = Path.expand(dep.opts[:build]); " +
    "relative_dep_build = Path.relative_to(inspection_dep_build, inspection_build_path); " +
    'source_dep_build = if relative_dep_build == ".." or String.starts_with?(relative_dep_build, "../"), ' +
    "do: inspection_dep_build, else: Path.expand(relative_dep_build, source_build_path); " +
    "app_opt = Keyword.get(dep.opts, :app, true); " +
    'app_resource = case app_opt do false -> :null; path when is_binary(path) -> Path.expand(path, source_dep_build); _ -> Path.join([source_dep_build, "ebin", "#{dep.app}.app"]) end; ' +
    "required = not Keyword.get(dep.opts, :optional, false) and " +
    "not (Keyword.get(dep.opts, :compile, true) == false and app_opt == false); " +
    "%{app: to_string(dep.app), buildPath: source_dep_build, " +
    "appResource: app_resource, required: required} end), " +
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
      env: mixInspectionEnvironment(mixEnv, inspectionBuildPath),
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
      build_path?: unknown;
      elixirc_paths?: unknown;
      dependency_artifacts?: unknown;
      mix_env?: unknown;
    };
    if (typeof parsed.app !== "string" || parsed.app === "") throw new Error("missing app");
    if (typeof parsed.build_path !== "string" || parsed.build_path === "") {
      throw new Error("invalid build path");
    }
    if (
      !Array.isArray(parsed.elixirc_paths) ||
      !parsed.elixirc_paths.every((path): path is string => typeof path === "string")
    ) {
      throw new Error("invalid elixirc paths");
    }
    if (
      !Array.isArray(parsed.dependency_artifacts) ||
      !parsed.dependency_artifacts.every(isMixDependencyArtifact)
    ) {
      throw new Error("invalid dependency artifacts");
    }
    if (typeof parsed.mix_env !== "string" || parsed.mix_env === "") throw new Error("missing env");

    return {
      app: parsed.app,
      buildPath: resolveFromProject(projectDir, parsed.build_path),
      sourcePaths: parsed.elixirc_paths.map((path) => projectRelativePath(projectDir, path)),
      dependencyArtifacts: [...parsed.dependency_artifacts].sort((a, b) => {
        const appOrder = bytewiseCompare(a.app, b.app);
        return appOrder === 0 ? bytewiseCompare(a.buildPath, b.buildPath) : appOrder;
      }),
    };
  } catch {
    throw new ElixirCompileError(
      "cannot analyze Elixir project: Mix reported an invalid build layout.",
    );
  }
}

function isMixDependencyArtifact(value: unknown): value is MixDependencyArtifact {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const candidate = value as {
    readonly app?: unknown;
    readonly appResource?: unknown;
    readonly buildPath?: unknown;
    readonly required?: unknown;
  };
  return (
    typeof candidate.app === "string" &&
    candidate.app !== "" &&
    (candidate.appResource === null || typeof candidate.appResource === "string") &&
    typeof candidate.buildPath === "string" &&
    candidate.buildPath !== "" &&
    typeof candidate.required === "boolean"
  );
}

function mixInspectionEnvironment(
  mixEnv: string | undefined,
  inspectionBuildPath: string,
): NodeJS.ProcessEnv {
  const {
    MIX_BUILD_PATH: sourceBuildPath,
    MIX_ENV: sourceMixEnv,
    UNUSED_SOURCE_MIX_BUILD_PATH: _sourceBuildPath,
    ...environment
  } = process.env;
  return {
    ...environment,
    ...(mixEnv === undefined
      ? sourceMixEnv === undefined
        ? {}
        : { MIX_ENV: sourceMixEnv }
      : { MIX_ENV: mixEnv }),
    ...(sourceBuildPath === undefined ? {} : { UNUSED_SOURCE_MIX_BUILD_PATH: sourceBuildPath }),
    MIX_BUILD_PATH: inspectionBuildPath,
    MIX_QUIET: "1",
  };
}

function projectRelativePath(projectDir: string, path: string): string {
  const rel = relative(projectDir, resolveFromProject(projectDir, path)).split(sep).join("/");
  if (rel === "" || rel === ".") return ".";
  if (rel === ".." || rel.startsWith("../") || isAbsolute(rel)) {
    throw new Error("source path is outside the Mix project");
  }
  return rel;
}

function resolveFromProject(projectDir: string, path: string): string {
  return isAbsolute(path) ? path : resolve(projectDir, path);
}

export function prepareIsolatedBuild(
  layout: MixLayout,
  isolatedBuildPath: string,
  projectDir: string,
): void {
  const isolatedLib = join(isolatedBuildPath, "lib");
  mkdirSync(isolatedLib, { recursive: true });

  const sourcePriv = join(projectDir, "priv");
  if (existsSync(sourcePriv)) {
    const isolatedApp = join(isolatedLib, layout.app);
    mkdirSync(isolatedApp, { recursive: true });
    symlinkSync(sourcePriv, join(isolatedApp, "priv"), "dir");
  }

  for (const dependency of layout.dependencyArtifacts) {
    if (!existsSync(dependency.buildPath)) {
      if (!dependency.required) continue;
      throw new Error(`missing dependency artifact for ${dependency.app}`);
    }
    if (dependency.appResource !== null && !existsSync(dependency.appResource)) {
      throw new Error(`missing dependency app resource for ${dependency.app}`);
    }
    symlinkSync(dependency.buildPath, join(isolatedLib, dependency.app), "dir");
  }
}

export function readBoundedTrace(path: string): string {
  if (statSync(path).size > MAX_TRACE_BYTES) {
    throw new Error("trace output exceeds the bounded read limit");
  }
  return readFileSync(path, "utf8");
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

function tailLines(text: string, n: number): string {
  const lines = text.trimEnd().split("\n");
  return lines.slice(-n).join("\n");
}
