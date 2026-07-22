/** Strict runtime decoding and canonical keys for the Elixir trace protocol. */

import type {
  FunctionRecord,
  ModuleOwnerRecord,
  ModuleRecord,
  TraceEvent,
  TraceRecord,
} from "./events.js";

interface JsonRecord extends Readonly<Record<string, unknown>> {
  readonly arity?: unknown;
  readonly behaviours?: unknown;
  readonly compile_ok?: unknown;
  readonly count?: unknown;
  readonly details?: unknown;
  readonly dyn?: unknown;
  readonly file?: unknown;
  readonly from_fun?: unknown;
  readonly from_mod?: unknown;
  readonly impl?: unknown;
  readonly k?: unknown;
  readonly kind?: unknown;
  readonly line?: unknown;
  readonly mod?: unknown;
  readonly name?: unknown;
  readonly names?: unknown;
  readonly partition?: unknown;
  readonly phase?: unknown;
  readonly protocol?: unknown;
  readonly status?: unknown;
  readonly to_mod?: unknown;
}

export function decodeTraceRecord(
  value: unknown,
  phase: "production" | "test",
): TraceRecord | null {
  if (!isRecord(value) || typeof value.k !== "string") return null;
  switch (value.k) {
    case "phase":
      return exactKeys(value, ["k", "phase", "status"]) &&
        value.phase === phase &&
        (value.status === "started" || value.status === "complete" || value.status === "incomplete")
        ? (value as unknown as TraceRecord)
        : null;
    case "event":
      return decodeEventRecord(value, phase);
    case "owner":
      return decodeOwnerRecord(value, phase);
    case "module":
      return decodeModuleRecord(value, phase);
    case "function":
      return decodeFunctionRecord(value, phase);
    case "app_mod":
      return phase === "production" && exactKeys(value, ["k", "mod"]) && nonEmptyString(value.mod)
        ? (value as unknown as TraceRecord)
        : null;
    case "deps":
      return phase === "production" && exactKeys(value, ["k", "names"]) && stringArray(value.names)
        ? (value as unknown as TraceRecord)
        : null;
    case "meta":
      return phase === "production" &&
        exactKeys(value, ["k", "compile_ok"]) &&
        typeof value.compile_ok === "boolean"
        ? (value as unknown as TraceRecord)
        : null;
    case "compile_error":
      return phase === "production" &&
        exactKeys(value, ["k", "count"], ["details"]) &&
        nonNegativeInteger(value.count) &&
        (value.details === undefined || stringArray(value.details))
        ? (value as unknown as TraceRecord)
        : null;
    case "test_compile_error":
      return phase === "test" && exactKeys(value, ["k"]) ? (value as unknown as TraceRecord) : null;
    default:
      return null;
  }
}

function decodeOwnerRecord(value: JsonRecord, phase: "production" | "test"): TraceRecord | null {
  const partition = phase === "production" ? "prod" : "test";
  return exactKeys(value, ["k", "mod", "file", "partition"]) &&
    nonEmptyString(value.mod) &&
    nonEmptyString(value.file) &&
    value.partition === partition
    ? (value as unknown as ModuleOwnerRecord)
    : null;
}

function decodeEventRecord(value: JsonRecord, phase: "production" | "test"): TraceRecord | null {
  const requiredKeys = ["k", "kind", "file", "line", "from_mod", "to_mod", "dyn", "partition"];
  const optionalKeys = ["from_fun", "name", "arity"];
  const partition = phase === "production" ? "prod" : "test";
  const callableKind =
    value.kind === "remote" || value.kind === "imported" || value.kind === "local";
  const targetShapeValid = callableKind
    ? nonEmptyString(value.name) && nonNegativeInteger(value.arity)
    : (value.kind === "alias" || value.kind === "struct") &&
      value.name === undefined &&
      value.arity === undefined;
  return exactKeys(value, requiredKeys, optionalKeys) &&
    ["remote", "imported", "local", "alias", "struct"].includes(String(value.kind)) &&
    typeof value.file === "string" &&
    nonNegativeInteger(value.line) &&
    (value.from_mod === null || nonEmptyString(value.from_mod)) &&
    nonEmptyString(value.to_mod) &&
    typeof value.dyn === "boolean" &&
    value.partition === partition &&
    (value.from_fun === undefined || nonEmptyString(value.from_fun)) &&
    targetShapeValid
    ? (value as unknown as TraceRecord)
    : null;
}

function decodeModuleRecord(value: JsonRecord, phase: "production" | "test"): TraceRecord | null {
  const partition = phase === "production" ? "prod" : "test";
  return exactKeys(value, [
    "k",
    "mod",
    "file",
    "line",
    "behaviours",
    "protocol",
    "impl",
    "partition",
  ]) &&
    nonEmptyString(value.mod) &&
    nonEmptyString(value.file) &&
    nonNegativeInteger(value.line) &&
    stringArray(value.behaviours) &&
    typeof value.protocol === "boolean" &&
    typeof value.impl === "boolean" &&
    value.partition === partition
    ? ({
        ...value,
        behaviours: canonicalBehaviours(value.behaviours as readonly string[]),
      } as unknown as ModuleRecord)
    : null;
}

function decodeFunctionRecord(value: JsonRecord, phase: "production" | "test"): TraceRecord | null {
  const partition = phase === "production" ? "prod" : "test";
  return exactKeys(value, ["k", "mod", "name", "arity", "file", "line", "partition"]) &&
    nonEmptyString(value.mod) &&
    nonEmptyString(value.name) &&
    nonNegativeInteger(value.arity) &&
    nonEmptyString(value.file) &&
    nonNegativeInteger(value.line) &&
    value.partition === partition
    ? (value as unknown as TraceRecord)
    : null;
}

function exactKeys(
  value: JsonRecord,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const keys = Object.keys(value);
  return (
    required.every((key) => Object.hasOwn(value, key)) &&
    keys.every((key) => required.includes(key) || optional.includes(key))
  );
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value !== "";
}

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function stringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

export function hasConflictingDefinitions(
  modules: readonly ModuleRecord[],
  functions: readonly FunctionRecord[],
): boolean {
  return (
    hasConflicts(modules, (module) => module.mod, moduleSemanticKey) ||
    hasConflicts(functions, functionIdentityKey, functionSemanticKey)
  );
}

/**
 * Require compiler-time ownership to equal reflected ownership exactly.
 * Repeated identical pairs are harmless; one module observed in two files is not.
 */
export function hasExactModuleOwnership(
  owners: readonly ModuleOwnerRecord[],
  modules: readonly ModuleRecord[],
): boolean {
  const ownerPairs = new Set<string>();
  const ownerFiles = new Map<string, string>();
  for (const owner of owners) {
    const prior = ownerFiles.get(owner.mod);
    if (prior !== undefined && prior !== owner.file) return false;
    ownerFiles.set(owner.mod, owner.file);
    ownerPairs.add(moduleOwnerKey(owner.mod, owner.file));
  }

  const reflectedPairs = new Set<string>();
  for (const module of modules) {
    reflectedPairs.add(moduleOwnerKey(module.mod, module.file));
  }
  if (ownerPairs.size !== reflectedPairs.size) return false;
  for (const pair of ownerPairs) {
    if (!reflectedPairs.has(pair)) return false;
  }
  return true;
}

function moduleOwnerKey(mod: string, file: string): string {
  return `${mod}\0${file}`;
}

export function hasValidPhase(
  records: readonly TraceRecord[],
  phase: "production" | "test",
  terminal: "complete" | "incomplete",
): boolean {
  const phases = records.filter((record) => record.k === "phase");
  const first = records[0];
  const last = records.at(-1);
  return (
    phases.length === 2 &&
    first?.k === "phase" &&
    first.phase === phase &&
    first.status === "started" &&
    last?.k === "phase" &&
    last.phase === phase &&
    last.status === terminal
  );
}

function hasConflicts<T>(
  values: readonly T[],
  identity: (value: T) => string,
  semantic: (value: T) => string,
): boolean {
  const seen = new Map<string, string>();
  for (const value of values) {
    const key = identity(value);
    const semantics = semantic(value);
    const prior = seen.get(key);
    if (prior !== undefined && prior !== semantics) return true;
    seen.set(key, semantics);
  }
  return false;
}

export function moduleSemanticKey(module: ModuleRecord): string {
  return [
    module.mod,
    module.file,
    module.line,
    canonicalBehaviours(module.behaviours).join("\x01"),
    module.protocol ? 1 : 0,
    module.impl ? 1 : 0,
  ].join("\0");
}

export function canonicalBehaviours(behaviours: readonly string[]): readonly string[] {
  return [...new Set(behaviours)].sort(bytewiseCompare);
}

export function functionIdentityKey(fn: FunctionRecord): string {
  return [fn.mod, fn.name, fn.arity].join("\0");
}

export function functionSemanticKey(fn: FunctionRecord): string {
  return [functionIdentityKey(fn), fn.file, fn.line].join("\0");
}

export function eventCompatibilityKey(event: TraceEvent): string {
  return [
    event.kind,
    event.from_mod ?? "",
    event.from_fun ?? "",
    event.to_mod,
    event.name ?? "",
    event.arity ?? -1,
    event.dyn ? 1 : 0,
  ].join("\0");
}

export function bytewiseCompare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
