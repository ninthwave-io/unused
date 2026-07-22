/**
 * Parsed record shapes for the tracer script's JSON-lines output (ADR 0011).
 *
 * `runner.ts` reads the temp `UNUSED_OUT` file line by line and narrows each
 * `{ "k": … }` object into one of these; `emit.ts` turns them into IR.
 */

/** `partition` is which root set an event/definition belongs to. */
export type Partition = "prod" | "test";

/** A single reference event captured by the compiler tracer. */
export interface TraceEvent {
  readonly k: "event";
  /** Tracer event family. */
  readonly kind: "remote" | "imported" | "local" | "alias" | "struct";
  /** Repo-relative POSIX path of the referencing site (may be a `.heex` file). */
  readonly file: string;
  readonly line: number;
  /** Referencing module (`inspect`-form, e.g. `MyApp.Foo`), or `null` at top level. */
  readonly from_mod: string | null;
  /** Referencing function `name/arity` when inside one; absent for module-level code. */
  readonly from_fun?: string;
  /** Referenced module (`inspect`-form). */
  readonly to_mod: string;
  /** Referenced function name (absent for `alias`/`struct` events). */
  readonly name?: string;
  readonly arity?: number;
  /** `true` iff this call site is a dynamic-dispatch primitive (`apply`, `Module.concat`, …). */
  readonly dyn: boolean;
  readonly partition: Partition;
}

/** A compiled module's reflection record. */
export interface ModuleRecord {
  readonly k: "module";
  /** `inspect`-form module name (`MyApp.Foo`). */
  readonly mod: string;
  /** Repo-relative POSIX `.ex`/`.exs` source path. */
  readonly file: string;
  readonly line: number;
  /** `inspect`-form behaviour module names the module declares. */
  readonly behaviours: readonly string[];
  /** `true` iff the module defines an Elixir protocol (`defprotocol`). */
  readonly protocol: boolean;
  /** `true` iff the module is a protocol implementation (`defimpl`). */
  readonly impl: boolean;
  readonly partition: Partition;
}

/** A public function's reflection record. */
export interface FunctionRecord {
  readonly k: "function";
  /** `inspect`-form owning module name. */
  readonly mod: string;
  readonly name: string;
  readonly arity: number;
  readonly file: string;
  readonly line: number;
  readonly partition: Partition;
}

/** Compiler-time ownership captured before later definitions can replace a BEAM. */
export interface ModuleOwnerRecord {
  readonly k: "owner";
  /** `inspect`-form module name. */
  readonly mod: string;
  /** Repo-relative source file reported by the compiler's `:on_module` event. */
  readonly file: string;
  readonly partition: Partition;
}

export interface AppModRecord {
  readonly k: "app_mod";
  /** `inspect`-form OTP application callback module. */
  readonly mod: string;
}

export interface DepsRecord {
  readonly k: "deps";
  readonly names: readonly string[];
}

export interface MetaRecord {
  readonly k: "meta";
  readonly compile_ok: boolean;
}

export interface CompileErrorRecord {
  readonly k: "compile_error";
  readonly count: number;
  readonly details?: readonly string[];
}

export interface TestCompileErrorRecord {
  readonly k: "test_compile_error";
}

/** Delimits one child trace so truncated/cross-phase output is never merged. */
export interface PhaseRecord {
  readonly k: "phase";
  readonly phase: "production" | "test";
  readonly status: "started" | "complete" | "incomplete";
}

/** Completeness of the separately compiled ExUnit source partition. */
export type TestPartitionStatus = "complete" | "incomplete";

export type TraceRecord =
  | TraceEvent
  | ModuleOwnerRecord
  | ModuleRecord
  | FunctionRecord
  | AppModRecord
  | DepsRecord
  | MetaRecord
  | CompileErrorRecord
  | TestCompileErrorRecord
  | PhaseRecord;

/** The runner's structured result: every record, plus the compile-ok signal. */
export interface TraceResult {
  readonly events: readonly TraceEvent[];
  readonly modules: readonly ModuleRecord[];
  readonly functions: readonly FunctionRecord[];
  /** OTP application callback module (`inspect`-form), or `null` when the project declares none. */
  readonly appMod: string | null;
  /** Declared dependency app names (for Phoenix detection). */
  readonly deps: readonly string[];
  /** `false` when the production compile reported errors — the caller refuses. */
  readonly compileOk: boolean;
  /**
   * Whether every discovered ExUnit test source compiled under the
   * analyzer's isolated `--no-start` process. Production compilation can be
   * complete while this partition is incomplete.
   */
  readonly testPartition: TestPartitionStatus;
  /** Sanitized internal reason for an incomplete test partition. */
  readonly testPartitionReason?: TestPartitionIncompleteReason;
}

export type TestPartitionIncompleteReason =
  | "layout"
  | "artifacts"
  | "timeout"
  | "execution"
  | "output"
  | "compile"
  | "ownership";

/** Structured facts accepted from the isolated test-phase child. */
export interface TestTraceResult {
  readonly events: readonly TraceEvent[];
  readonly modules: readonly ModuleRecord[];
  readonly functions: readonly FunctionRecord[];
  readonly testPartition: TestPartitionStatus;
  readonly testPartitionReason?: TestPartitionIncompleteReason;
}
