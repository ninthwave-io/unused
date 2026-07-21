/** Public refusal types for the Elixir frontend. */

/** Base class for every Elixir-frontend refusal. */
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
