/** Explicit Cargo execution/refusal contract for the Rust frontend. */

import { spawnSync } from "node:child_process";

const MAX_CARGO_OUTPUT = 64 * 1024 * 1024;

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

/** Run Cargo without a shell so project paths/arguments cannot be reinterpreted. */
export function runCargo(
  projectDir: string,
  args: readonly string[],
  cargoCommand = "cargo",
  operation: "metadata" | "compile" = "metadata",
): CargoCommandResult {
  const result = spawnSync(cargoCommand, [...args], {
    cwd: projectDir,
    encoding: "utf8",
    maxBuffer: MAX_CARGO_OUTPUT,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error !== undefined) {
    const code = "code" in result.error ? String(result.error.code) : "unknown";
    throw new CargoToolchainError(
      `unable to execute Cargo (${cargoCommand}, ${code}); install a working Rust toolchain`,
      { cause: result.error },
    );
  }
  if (result.status !== 0) {
    const detail = firstMeaningfulLine(result.stderr || result.stdout);
    const ErrorClass = operation === "compile" ? CargoCompileError : CargoMetadataError;
    throw new ErrorClass(
      `Cargo ${operation} failed (${cargoCommand} ${args.join(" ")}, exit ${result.status ?? "unknown"})${detail === "" ? "" : `: ${detail}`}`,
    );
  }
  return { stdout: result.stdout, stderr: result.stderr };
}

function firstMeaningfulLine(output: string): string {
  return (
    output
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .find((line) => line !== "") ?? ""
  );
}
