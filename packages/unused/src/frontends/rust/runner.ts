/** Explicit Cargo execution/refusal contract for the Rust frontend. */

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const MAX_CARGO_OUTPUT = 64 * 1024 * 1024;
const cargoExecutionContextBrand: unique symbol = Symbol("CargoExecutionContext");

export class RustFrontendError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RustFrontendError";
  }
}

export class CargoToolchainError extends RustFrontendError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CargoToolchainError";
  }
}

export class CargoMetadataError extends RustFrontendError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CargoMetadataError";
  }
}

export class CargoCompileError extends RustFrontendError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CargoCompileError";
  }
}

export interface CargoCommandResult {
  readonly stdout: string;
  readonly stderr: string;
}

export interface CargoExecutionContext {
  /** Nominal brand: only {@link createCargoExecutionContext} can construct this value. */
  readonly [cargoExecutionContextBrand]: true;
  /** Absolute, analyzer-owned Cargo target directory outside the consumer tree. */
  readonly targetDir: string;
  /** Canonical project root this context is bound to. */
  readonly projectRoot: string;
  /** Canonical effective Cargo home, proven outside the consumer tree. */
  readonly cargoHome: string;
  /** Idempotent removal for success and every refusal path. */
  readonly dispose: () => void;
}

interface CargoProcessEnvironment extends NodeJS.ProcessEnv {
  CARGO_HOME?: string;
  HOME?: string;
}

/**
 * Dispose analyzer-owned Cargo output without replacing the error that caused
 * the cleanup path. A cleanup failure on an otherwise successful run remains
 * a hard failure because the analyzer cannot claim that it left no artifacts.
 */
export function disposeCargoExecutionContext(
  context: CargoExecutionContext,
  primaryFailure?: unknown,
  operation: "metadata" | "compile" = "compile",
): void {
  try {
    context.dispose();
  } catch (cleanupFailure) {
    const detail = "Cargo analysis also failed to remove its temporary build output";
    if (primaryFailure instanceof Error) {
      try {
        primaryFailure.message = `${primaryFailure.message}; ${detail}`;
      } catch {
        // Preserve even an immutable/non-standard primary error unchanged.
      }
      return;
    }
    if (primaryFailure !== undefined) return;
    const ErrorClass = operation === "metadata" ? CargoMetadataError : CargoCompileError;
    throw new ErrorClass(detail, { cause: cleanupFailure });
  }
}

/** Create one analyzer-owned Cargo target and reject a test/user temp root inside the project. */
export function createCargoExecutionContext(
  projectDir: string,
  parentDir = tmpdir(),
  operation: "metadata" | "compile" = "compile",
): CargoExecutionContext {
  const projectRoot = realpathSync(projectDir);
  const environment = process.env as CargoProcessEnvironment;
  const inheritedUserHome = process.platform === "win32" ? undefined : environment.HOME;
  const effectiveUserHome =
    inheritedUserHome === undefined || inheritedUserHome === "" ? homedir() : inheritedUserHome;
  const cargoHome = canonicalPotentialPath(
    resolve(projectRoot, environment.CARGO_HOME ?? join(effectiveUserHome, ".cargo")),
  );
  const ErrorClass = operation === "metadata" ? CargoMetadataError : CargoCompileError;
  if (pathWithin(cargoHome, projectRoot)) {
    throw new ErrorClass(
      "Cargo analysis refused an effective Cargo home inside the consumer project; " +
        "configure CARGO_HOME outside the project and retry",
    );
  }
  const temporaryParent = realpathSync(parentDir);
  // Check before creating anything: even create+remove would change a consumer
  // directory's mtime and violate the read-only contract on the refusal path.
  if (pathWithin(temporaryParent, projectRoot)) {
    throw new ErrorClass(
      "Cargo analysis refused to place its temporary target inside the consumer project; " +
        "configure the system temporary directory outside the project and retry",
    );
  }
  const targetDir = mkdtempSync(join(temporaryParent, "unused-cargo-target-"));
  let disposed = false;
  return {
    [cargoExecutionContextBrand]: true as const,
    cargoHome,
    projectRoot,
    targetDir,
    dispose() {
      if (disposed) return;
      rmSync(targetDir, { recursive: true, force: true });
      disposed = true;
    },
  };
}

/** Run Cargo without a shell so project paths/arguments cannot be reinterpreted. */
export function runCargo(
  projectDir: string,
  args: readonly string[],
  execution: CargoExecutionContext,
  cargoCommand = "cargo",
  operation: "metadata" | "compile" = "metadata",
): CargoCommandResult {
  const paths = validateCargoExecutionContext(projectDir, execution, operation);
  const environment = cargoEnvironment(paths);
  const result = spawnSync(cargoCommand, [...args], {
    cwd: projectDir,
    encoding: "utf8",
    maxBuffer: MAX_CARGO_OUTPUT,
    stdio: ["ignore", "pipe", "pipe"],
    env: environment,
  });
  if (result.error !== undefined) {
    const code = "code" in result.error ? String(result.error.code) : "unknown";
    if (code === "ENOENT") {
      throw new CargoToolchainError(
        `unable to execute the configured Cargo command (${code}); install a working Rust toolchain`,
        { cause: result.error },
      );
    }
    const ErrorClass = operation === "compile" ? CargoCompileError : CargoMetadataError;
    throw new ErrorClass(
      code === "ENOBUFS"
        ? `Cargo ${operation} exceeded the bounded ${MAX_CARGO_OUTPUT / (1024 * 1024)} MiB output limit`
        : `Cargo ${operation} could not complete (${code})`,
      { cause: result.error },
    );
  }
  if (result.status !== 0) {
    const detail = cargoFailureDetail(`${result.stderr}\n${result.stdout}`, operation);
    const ErrorClass = operation === "compile" ? CargoCompileError : CargoMetadataError;
    throw new ErrorClass(
      `Cargo ${operation} failed (exit ${result.status ?? "unknown"}): ${detail}`,
    );
  }
  return { stdout: result.stdout, stderr: result.stderr };
}

interface ValidatedCargoExecutionPaths {
  readonly cargoHome: string;
  readonly targetDir: string;
}

function cargoEnvironment(paths: ValidatedCargoExecutionPaths): NodeJS.ProcessEnv {
  const {
    CARGO_HOME: _inheritedCargoHome,
    CARGO_TARGET_DIR: _inheritedTarget,
    CARGO_BUILD_TARGET_DIR: _inheritedBuildTarget,
    CARGO_BUILD_BUILD_DIR: _inheritedBuildDir,
    CARGO_NET_OFFLINE: _inheritedOffline,
    ...environment
  } = process.env;
  return {
    ...environment,
    CARGO_HOME: paths.cargoHome,
    // Set every Cargo target/build config surface so inherited environment and
    // `.cargo/config.toml` cannot redirect managed output into the consumer.
    CARGO_TARGET_DIR: paths.targetDir,
    CARGO_BUILD_TARGET_DIR: paths.targetDir,
    CARGO_BUILD_BUILD_DIR: join(paths.targetDir, "build"),
    // `--frozen` is authoritative. The environment makes the no-network intent
    // explicit to Cargo subprocesses and build tooling too.
    CARGO_NET_OFFLINE: "true",
  };
}

function cargoFailureDetail(output: string, operation: "metadata" | "compile"): string {
  const normalized = output.replace(/\s+/gu, " ").trim();
  if (
    /lock file .*needs to be updated|Cargo\.lock needs to be updated|cannot (?:create|update) the lock file|lock file .*because --frozen/iu.test(
      normalized,
    )
  ) {
    return (
      "Cargo.lock is missing or stale; update it explicitly before analysis " +
      "(read-only analysis will not change it)"
    );
  }
  if (
    /attempting to make an HTTP request|failed to download|offline mode|no matching package named/iu.test(
      normalized,
    )
  ) {
    return (
      "required dependency sources are unavailable locally; fetch them explicitly before analysis " +
      "(read-only analysis does not access the network)"
    );
  }
  return operation === "metadata"
    ? "Cargo reported an error; run `cargo metadata --frozen --format-version 1 --no-deps` directly for local diagnostics"
    : "Cargo reported an error; run `cargo check --frozen --workspace --all-targets` and its `--all-features` pass directly for local diagnostics";
}

function pathWithin(path: string, root: string): boolean {
  const value = relative(root, path);
  return value === "" || (!value.startsWith(`..${sep}`) && value !== ".." && !isAbsolute(value));
}

/** Validate a branded context before any Cargo command can use it. */
export function validateCargoExecutionContext(
  projectDir: string,
  context: CargoExecutionContext,
  operation: "metadata" | "compile" = "compile",
): ValidatedCargoExecutionPaths {
  const ErrorClass = operation === "metadata" ? CargoMetadataError : CargoCompileError;
  if (context[cargoExecutionContextBrand] !== true) {
    throw new ErrorClass("Cargo analysis received an invalid execution context");
  }
  const projectRoot = realpathSync(projectDir);
  if (context.projectRoot !== projectRoot) {
    throw new ErrorClass("Cargo analysis execution context belongs to a different project");
  }
  const cargoHome = canonicalPotentialPath(context.cargoHome);
  if (pathWithin(cargoHome, projectRoot)) {
    throw new ErrorClass("Cargo analysis refused a Cargo home inside the consumer project");
  }
  const targetRoot = realpathSync(context.targetDir);
  if (pathWithin(targetRoot, projectRoot)) {
    throw new ErrorClass("Cargo analysis refused a target directory inside the consumer project");
  }
  return { cargoHome, targetDir: targetRoot };
}

/** Resolve existing symlink ancestors without creating a missing Cargo home. */
function canonicalPotentialPath(path: string): string {
  let cursor = resolve(path);
  const missing: string[] = [];
  while (!existsSync(cursor)) {
    const parent = dirname(cursor);
    if (parent === cursor) return resolve(path);
    missing.unshift(basename(cursor));
    cursor = parent;
  }
  return resolve(realpathSync(cursor), ...missing);
}
