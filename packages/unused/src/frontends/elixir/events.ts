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
  /** Phase-local wire identity used only by compiler-derived structural facts. */
  readonly eventId?: number;
  /** Tracer event family. */
  readonly kind: "remote" | "imported" | "local" | "alias" | "struct";
  /** Repo-relative POSIX path of the referencing site (may be a `.heex` file). */
  readonly file: string;
  readonly line: number;
  /** One-based compiler column, or zero when the compiler supplied none. */
  readonly column?: number;
  /** Exact compiler event class; references have no callable class. */
  readonly callKind?: "function" | "macro" | null;
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

export interface ElixirStructuralSpan {
  readonly sl: number;
  readonly sc: number;
  readonly el: number;
  readonly ec: number;
}

export type ElixirStructuralRole =
  | "branch-result"
  | "rescue-success"
  | "rescue-result"
  | "call-argument"
  | "pipeline-argument"
  | "carrier-result"
  | "runtime-mfa"
  | "use-dispatcher";

export interface ElixirStructuralCarrier {
  readonly id: number;
  readonly mod: string;
  readonly fun: string;
  readonly defLine: number;
  readonly body: ElixirStructuralSpan;
}

/** Source-minimized structural fact; no AST, literals, or local names cross the child boundary. */
export interface ElixirStructuralFact {
  readonly carrier: number;
  readonly role: ElixirStructuralRole;
  readonly from: ElixirStructuralSpan;
  readonly to: ElixirStructuralSpan | null;
  readonly eventId: number | null;
  readonly argument: number | null;
  readonly resolution: "exact" | "opaque" | null;
}

export type ElixirStructuralIncompleteReason = "read" | "size" | "parse" | "limit" | "ownership";

export interface ElixirStructuralFile {
  readonly k: "structure_file";
  readonly file: string;
  readonly partition: Partition;
  readonly digest: string;
  readonly bytes: number;
  readonly status: "complete" | "incomplete";
  readonly reason: ElixirStructuralIncompleteReason | null;
  readonly astNodes: number;
  readonly maxDepth: number;
  readonly carriers: readonly ElixirStructuralCarrier[];
  readonly facts: readonly ElixirStructuralFact[];
}

export interface ElixirStructuralSummary {
  readonly k: "structure_summary";
  readonly partition: Partition;
  /** Raw compiler events indexed and emitted by the child before semantic projection. */
  readonly rawEvents: number;
  readonly elapsedUs: number;
  readonly eventIndexUs: number;
  readonly fileExtractionUs: number;
  readonly emitUs: number;
  readonly files: number;
  readonly completeFiles: number;
  readonly incompleteFiles: number;
  readonly bytes: number;
  readonly astNodes: number;
  readonly maxDepth: number;
  readonly carriers: number;
  readonly facts: number;
  readonly exactFacts: number;
  readonly opaqueFacts: number;
  readonly roles: Readonly<Partial<Record<ElixirStructuralRole, number>>>;
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

/** Sanitized recursive compiler dependency ownership from Mix layout inspection. */
export interface DependencyApplication {
  /** Application identity used by Mix for the compiled dependency artifact. */
  readonly compilerApp: string;
  /** Identity declared by the artifact's `.app` resource, or `null` when unprovable. */
  readonly otpApp: string | null;
}

/** Exact Hex lock identity carried by the same Mix dependency as its compiled artifact. */
export interface HexDependencyApplication extends DependencyApplication {
  readonly lockKey: string;
  readonly hexPackage: string;
  readonly version: string;
  readonly innerChecksum: string;
  readonly repository: string;
  readonly outerChecksum: string;
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
  readonly protocol: 2;
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
  | ElixirStructuralFile
  | ElixirStructuralSummary
  | PhaseRecord;

/** The runner's structured result: every record, plus the compile-ok signal. */
export interface TraceResult {
  /**
   * Base-compatible semantic events consumed by the existing Elixir analysis.
   * Compiler columns, call classes, and wire identities are projected away.
   */
  readonly events: readonly TraceEvent[];
  /**
   * Exact protocol-v2 events referenced by structural facts, retained only to
   * validate those identities.
   * Analysis consumers must use {@link events} until a structural feature is enabled.
   */
  readonly structuralEvents?: readonly TraceEvent[];
  readonly modules: readonly ModuleRecord[];
  readonly functions: readonly FunctionRecord[];
  /** Optional precision facts. Incomplete files retain the conservative source fallback. */
  readonly structuralFiles?: readonly ElixirStructuralFile[];
  /** Bounded child-side extraction time and structural work for production only. */
  readonly structuralSummary?: ElixirStructuralSummary;
  /** Bounded child-side extraction time and structural work for the optional test overlay. */
  readonly structuralTestSummary?: ElixirStructuralSummary;
  /** Completeness of optional structural precision in the separately compiled test world. */
  readonly structuralTestPartition?: TestPartitionStatus;
  /** OTP application callback module (`inspect`-form), or `null` when the project declares none. */
  readonly appMod: string | null;
  /** Legacy direct dependency names from the compiler child; not provider evidence. */
  readonly deps: readonly string[];
  /** Recursive compiler/OTP ownership facts for framework convention detection. */
  readonly dependencyApplications?: readonly DependencyApplication[];
  /** Hex-SCM subset eligible to pair with exact provider lock evidence. */
  readonly hexDependencyApplications?: readonly HexDependencyApplication[];
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
  /** Exact protocol-v2 events retained only for structural fact identities. */
  readonly structuralEvents?: readonly TraceEvent[];
  readonly modules: readonly ModuleRecord[];
  readonly functions: readonly FunctionRecord[];
  readonly structuralFiles?: readonly ElixirStructuralFile[];
  readonly structuralSummary?: ElixirStructuralSummary;
  readonly structuralPartition?: TestPartitionStatus;
  readonly testPartition: TestPartitionStatus;
  readonly testPartitionReason?: TestPartitionIncompleteReason;
}
