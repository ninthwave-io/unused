/** Strict runtime decoding and canonical keys for the Elixir trace protocol. */

import type {
  ElixirStructuralCarrier,
  ElixirStructuralFact,
  ElixirStructuralFile,
  ElixirStructuralSpan,
  ElixirStructuralSummary,
  FunctionRecord,
  ModuleOwnerRecord,
  ModuleRecord,
  TraceEvent,
  TraceRecord,
} from "./events.js";

interface JsonRecord extends Readonly<Record<string, unknown>> {
  readonly arity?: unknown;
  readonly argument?: unknown;
  readonly ast_nodes?: unknown;
  readonly behaviours?: unknown;
  readonly body?: unknown;
  readonly bytes?: unknown;
  readonly call_kind?: unknown;
  readonly carrier?: unknown;
  readonly carriers?: unknown;
  readonly column?: unknown;
  readonly compile_ok?: unknown;
  readonly count?: unknown;
  readonly details?: unknown;
  readonly digest?: unknown;
  readonly dyn?: unknown;
  readonly file?: unknown;
  readonly files?: unknown;
  readonly facts?: unknown;
  readonly from_fun?: unknown;
  readonly from_mod?: unknown;
  readonly from?: unknown;
  readonly fun?: unknown;
  readonly impl?: unknown;
  readonly id?: unknown;
  readonly k?: unknown;
  readonly kind?: unknown;
  readonly line?: unknown;
  readonly mod?: unknown;
  readonly name?: unknown;
  readonly names?: unknown;
  readonly partition?: unknown;
  readonly phase?: unknown;
  readonly protocol?: unknown;
  readonly reason?: unknown;
  readonly resolution?: unknown;
  readonly role?: unknown;
  readonly sl?: unknown;
  readonly sc?: unknown;
  readonly status?: unknown;
  readonly max_depth?: unknown;
  readonly to_mod?: unknown;
  readonly to?: unknown;
  readonly el?: unknown;
  readonly ec?: unknown;
  readonly def_line?: unknown;
  readonly default_target_arity?: unknown;
  readonly event_id?: unknown;
  readonly events?: unknown;
  readonly elapsed_us?: unknown;
  readonly event_index_us?: unknown;
  readonly file_extraction_us?: unknown;
  readonly emit_us?: unknown;
  readonly complete_files?: unknown;
  readonly incomplete_files?: unknown;
  readonly exact_facts?: unknown;
  readonly opaque_facts?: unknown;
  readonly roles?: unknown;
}

export function decodeTraceRecord(
  value: unknown,
  phase: "production" | "test",
): TraceRecord | null {
  if (!isRecord(value) || typeof value.k !== "string") return null;
  switch (value.k) {
    case "phase":
      return exactKeys(value, ["k", "protocol", "phase", "status"]) &&
        value.protocol === 2 &&
        value.phase === phase &&
        (value.status === "started" || value.status === "complete" || value.status === "incomplete")
        ? (value as unknown as TraceRecord)
        : null;
    case "event":
      return decodeEventRecord(value, phase);
    case "structure_file":
      return decodeStructuralFile(value, phase);
    case "structure_summary":
      return decodeStructuralSummary(value, phase);
    case "owner":
      return decodeOwnerRecord(value, phase);
    case "module":
      return decodeModuleRecord(value, phase);
    case "function":
      return decodeFunctionRecord(value, phase);
    case "app_mod":
      return phase === "production" &&
        exactKeys(value, ["k", "mod"]) &&
        boundedString(value.mod, MAX_IDENTITY_LENGTH)
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
    boundedString(value.mod, MAX_IDENTITY_LENGTH) &&
    boundedString(value.file, MAX_PATH_LENGTH) &&
    value.partition === partition
    ? (value as unknown as ModuleOwnerRecord)
    : null;
}

function decodeEventRecord(value: JsonRecord, phase: "production" | "test"): TraceRecord | null {
  const requiredKeys = [
    "k",
    "id",
    "kind",
    "call_kind",
    "file",
    "line",
    "column",
    "from_mod",
    "to_mod",
    "dyn",
    "partition",
  ];
  const optionalKeys = ["from_fun", "name", "arity"];
  const partition = phase === "production" ? "prod" : "test";
  const callableKind =
    value.kind === "remote" || value.kind === "imported" || value.kind === "local";
  const targetShapeValid = callableKind
    ? boundedString(value.name, MAX_IDENTITY_LENGTH) && boundedInteger(value.arity, MAX_ARITY)
    : (value.kind === "alias" || value.kind === "struct") &&
      value.name === undefined &&
      value.arity === undefined;
  return exactKeys(value, requiredKeys, optionalKeys) &&
    nonNegativeInteger(value.id) &&
    ["remote", "imported", "local", "alias", "struct"].includes(String(value.kind)) &&
    boundedString(value.file, MAX_PATH_LENGTH) &&
    nonNegativeInteger(value.line) &&
    nonNegativeInteger(value.column) &&
    (callableKind
      ? value.call_kind === "function" || value.call_kind === "macro"
      : value.call_kind === null) &&
    (value.from_mod === null || boundedString(value.from_mod, MAX_IDENTITY_LENGTH)) &&
    boundedString(value.to_mod, MAX_IDENTITY_LENGTH) &&
    typeof value.dyn === "boolean" &&
    value.partition === partition &&
    (value.from_fun === undefined || boundedString(value.from_fun, MAX_IDENTITY_LENGTH)) &&
    targetShapeValid
    ? ({
        k: "event",
        eventId: value.id,
        kind: value.kind,
        callKind: value.call_kind,
        file: value.file,
        line: value.line,
        column: value.column,
        from_mod: value.from_mod,
        ...(value.from_fun === undefined ? {} : { from_fun: value.from_fun }),
        to_mod: value.to_mod,
        ...(value.name === undefined ? {} : { name: value.name }),
        ...(value.arity === undefined ? {} : { arity: value.arity }),
        dyn: value.dyn,
        partition: value.partition,
      } as TraceRecord)
    : null;
}

const STRUCTURAL_ROLES = [
  "branch-result",
  "rescue-success",
  "rescue-result",
  "call-argument",
  "pipeline-argument",
  "carrier-result",
  "runtime-mfa",
  "use-dispatcher",
] as const;
const STRUCTURAL_REASONS = ["read", "size", "parse", "limit", "ownership"] as const;
const MAX_SOURCE_BYTES = 8 * 1024 * 1024;
const MAX_AST_NODES = 500_000;
const MAX_DEPTH = 256;
const MAX_CARRIERS = 20_000;
const MAX_FACTS = 500_000;
// A trace is capped at 256 MiB before decoding; even a minimally shaped event
// record cannot approach this count within that byte boundary.
const MAX_RAW_EVENTS = 4_194_304;
const MAX_ARITY = 1_024;
const MAX_ARGUMENT = 1_024;
const MAX_IDENTITY_LENGTH = 1_024;
const MAX_PATH_LENGTH = 4_096;

function decodeStructuralSummary(
  value: JsonRecord,
  phase: "production" | "test",
): TraceRecord | null {
  const partition = phase === "production" ? "prod" : "test";
  const keys = [
    "k",
    "partition",
    "events",
    "elapsed_us",
    "event_index_us",
    "file_extraction_us",
    "emit_us",
    "files",
    "complete_files",
    "incomplete_files",
    "bytes",
    "ast_nodes",
    "max_depth",
    "carriers",
    "facts",
    "exact_facts",
    "opaque_facts",
    "roles",
  ];
  if (
    !exactKeys(value, keys) ||
    value.partition !== partition ||
    !boundedInteger(value.events, MAX_RAW_EVENTS) ||
    !nonNegativeInteger(value.elapsed_us) ||
    !nonNegativeInteger(value.event_index_us) ||
    !nonNegativeInteger(value.file_extraction_us) ||
    !nonNegativeInteger(value.emit_us) ||
    !nonNegativeInteger(value.files) ||
    !nonNegativeInteger(value.complete_files) ||
    !nonNegativeInteger(value.incomplete_files) ||
    !nonNegativeInteger(value.bytes) ||
    !nonNegativeInteger(value.ast_nodes) ||
    !boundedInteger(value.max_depth, MAX_DEPTH) ||
    !nonNegativeInteger(value.carriers) ||
    !nonNegativeInteger(value.facts) ||
    !nonNegativeInteger(value.exact_facts) ||
    !nonNegativeInteger(value.opaque_facts) ||
    !isRecord(value.roles)
  ) {
    return null;
  }
  const roles = value.roles;
  const roleKeys = Object.keys(roles);
  if (
    !roleKeys.every((role) => STRUCTURAL_ROLES.includes(role as never)) ||
    !roleKeys.every((role) => nonNegativeInteger(roles[role])) ||
    value.complete_files + value.incomplete_files !== value.files ||
    value.exact_facts + value.opaque_facts > value.facts ||
    roleKeys.reduce((total, role) => total + (roles[role] as number), 0) !== value.facts
  ) {
    return null;
  }
  return {
    k: "structure_summary",
    partition,
    rawEvents: value.events,
    elapsedUs: value.elapsed_us,
    eventIndexUs: value.event_index_us,
    fileExtractionUs: value.file_extraction_us,
    emitUs: value.emit_us,
    files: value.files,
    completeFiles: value.complete_files,
    incompleteFiles: value.incomplete_files,
    bytes: value.bytes,
    astNodes: value.ast_nodes,
    maxDepth: value.max_depth,
    carriers: value.carriers,
    facts: value.facts,
    exactFacts: value.exact_facts,
    opaqueFacts: value.opaque_facts,
    roles: roles as ElixirStructuralSummary["roles"],
  };
}

function decodeStructuralFile(value: JsonRecord, phase: "production" | "test"): TraceRecord | null {
  const partition = phase === "production" ? "prod" : "test";
  if (
    !exactKeys(value, [
      "k",
      "file",
      "partition",
      "digest",
      "bytes",
      "status",
      "reason",
      "ast_nodes",
      "max_depth",
      "carriers",
      "facts",
    ]) ||
    !boundedString(value.file, MAX_PATH_LENGTH) ||
    value.partition !== partition ||
    typeof value.digest !== "string" ||
    !/^[a-f0-9]{64}$/u.test(value.digest) ||
    !boundedInteger(value.bytes, MAX_SOURCE_BYTES) ||
    (value.status !== "complete" && value.status !== "incomplete") ||
    !boundedInteger(value.ast_nodes, MAX_AST_NODES) ||
    !boundedInteger(value.max_depth, MAX_DEPTH) ||
    !Array.isArray(value.carriers) ||
    value.carriers.length > MAX_CARRIERS ||
    !Array.isArray(value.facts) ||
    value.facts.length > MAX_FACTS
  ) {
    return null;
  }
  const reason = value.reason;
  if (
    (value.status === "complete" && reason !== null) ||
    (value.status === "incomplete" && !STRUCTURAL_REASONS.includes(reason as never))
  ) {
    return null;
  }
  if (
    value.status === "incomplete" &&
    (value.digest !== "0".repeat(64) ||
      value.bytes !== 0 ||
      value.ast_nodes !== 0 ||
      value.max_depth !== 0 ||
      value.carriers.length !== 0 ||
      value.facts.length !== 0)
  ) {
    return null;
  }
  const carriers = value.carriers.map(decodeStructuralCarrier);
  const facts = value.facts.map(decodeStructuralFact);
  if (carriers.some((entry) => entry === null) || facts.some((entry) => entry === null))
    return null;
  if ((carriers as ElixirStructuralCarrier[]).some((carrier, index) => carrier.id !== index))
    return null;
  if (value.status === "incomplete" && (carriers.length !== 0 || facts.length !== 0)) return null;
  return {
    k: "structure_file",
    file: value.file,
    partition,
    digest: value.digest,
    bytes: value.bytes,
    status: value.status,
    reason: reason as ElixirStructuralFile["reason"],
    astNodes: value.ast_nodes,
    maxDepth: value.max_depth,
    carriers: carriers as ElixirStructuralCarrier[],
    facts: facts as ElixirStructuralFact[],
  };
}

function decodeStructuralCarrier(value: unknown): ElixirStructuralCarrier | null {
  if (!isRecord(value) || !exactKeys(value, ["id", "mod", "fun", "def_line", "body"])) {
    return null;
  }
  const body = decodeSpan(value.body);
  return nonNegativeInteger(value.id) &&
    boundedString(value.mod, MAX_IDENTITY_LENGTH) &&
    boundedString(value.fun, MAX_IDENTITY_LENGTH) &&
    nonNegativeInteger(value.def_line) &&
    body !== null
    ? { id: value.id, mod: value.mod, fun: value.fun, defLine: value.def_line, body }
    : null;
}

function decodeStructuralFact(value: unknown): ElixirStructuralFact | null {
  if (
    !isRecord(value) ||
    !exactKeys(value, ["carrier", "role", "from", "to", "event_id", "argument", "resolution"]) ||
    !boundedInteger(value.carrier, MAX_CARRIERS - 1) ||
    !STRUCTURAL_ROLES.includes(value.role as never)
  ) {
    return null;
  }
  const from = decodeSpan(value.from);
  const to = value.to === null ? null : decodeSpan(value.to);
  if (from === null || (value.to !== null && to === null)) return null;
  const role = value.role as ElixirStructuralFact["role"];
  const callRole =
    role === "call-argument" || role === "pipeline-argument" || role === "use-dispatcher";
  const mfaRole = role === "runtime-mfa";
  const eventId = value.event_id;
  const argument = value.argument;
  const resolution = value.resolution;
  if (
    callRole
      ? !(
          (eventId === null || nonNegativeInteger(eventId)) &&
          boundedInteger(argument, MAX_ARGUMENT) &&
          (resolution === "exact" || resolution === "opaque") &&
          ((resolution === "exact" && eventId !== null) ||
            (resolution === "opaque" && eventId === null)) &&
          to !== null
        )
      : mfaRole
        ? !(
            nonNegativeInteger(eventId) &&
            argument === null &&
            resolution === "exact" &&
            to !== null
          )
        : eventId !== null || argument !== null || resolution !== null
  ) {
    return null;
  }
  if (role === "use-dispatcher" && (eventId === null || argument !== 1 || resolution !== "exact")) {
    return null;
  }
  if (role === "carrier-result" ? to !== null : to === null) return null;
  return {
    carrier: value.carrier,
    role,
    from,
    to,
    eventId: eventId as number | null,
    argument: argument as number | null,
    resolution: resolution as "exact" | "opaque" | null,
  };
}

function decodeSpan(value: unknown): ElixirStructuralSpan | null {
  if (!isRecord(value) || !exactKeys(value, ["sl", "sc", "el", "ec"])) return null;
  if (
    !positiveInteger(value.sl) ||
    !positiveInteger(value.sc) ||
    !positiveInteger(value.el) ||
    !positiveInteger(value.ec) ||
    value.el < value.sl ||
    (value.el === value.sl && value.ec <= value.sc)
  ) {
    return null;
  }
  return { sl: value.sl, sc: value.sc, el: value.el, ec: value.ec };
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
    boundedString(value.mod, MAX_IDENTITY_LENGTH) &&
    boundedString(value.file, MAX_PATH_LENGTH) &&
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
  return exactKeys(value, [
    "k",
    "mod",
    "name",
    "arity",
    "file",
    "line",
    "default_target_arity",
    "partition",
  ]) &&
    boundedString(value.mod, MAX_IDENTITY_LENGTH) &&
    boundedString(value.name, MAX_IDENTITY_LENGTH) &&
    boundedInteger(value.arity, MAX_ARITY) &&
    boundedString(value.file, MAX_PATH_LENGTH) &&
    nonNegativeInteger(value.line) &&
    (value.default_target_arity === null ||
      (boundedInteger(value.default_target_arity, MAX_ARITY) &&
        value.default_target_arity > value.arity)) &&
    value.partition === partition
    ? ({
        k: "function",
        mod: value.mod,
        name: value.name,
        arity: value.arity,
        file: value.file,
        line: value.line,
        defaultTargetArity: value.default_target_arity,
        partition: value.partition,
      } as TraceRecord)
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
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
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
 * Validate the complete compiler-generated default-wrapper topology in one
 * phase. Every wrapper must target an ordinary declared body in the same
 * module, file, partition, and source definition, and a multi-default family
 * must contain the full contiguous arity range.
 */
export function hasValidDefaultArgumentTargets(functions: readonly FunctionRecord[]): boolean {
  const byIdentity = new Map<string, FunctionRecord>();
  for (const fn of functions) {
    const key = defaultFunctionKey(fn.mod, fn.file, fn.partition, fn.name, fn.arity);
    const prior = byIdentity.get(key);
    if (prior !== undefined && functionSemanticKey(prior) !== functionSemanticKey(fn)) return false;
    byIdentity.set(key, fn);
  }

  const wrappersByTarget = new Map<string, Set<number>>();
  for (const wrapper of byIdentity.values()) {
    if (wrapper.defaultTargetArity === null) continue;
    const targetKey = defaultFunctionKey(
      wrapper.mod,
      wrapper.file,
      wrapper.partition,
      wrapper.name,
      wrapper.defaultTargetArity,
    );
    const target = byIdentity.get(targetKey);
    if (
      target === undefined ||
      target.defaultTargetArity !== null ||
      target.line !== wrapper.line
    ) {
      return false;
    }
    const arities = wrappersByTarget.get(targetKey);
    if (arities === undefined) wrappersByTarget.set(targetKey, new Set([wrapper.arity]));
    else arities.add(wrapper.arity);
  }

  for (const [targetKey, arities] of wrappersByTarget) {
    const target = byIdentity.get(targetKey);
    if (target === undefined || arities.size === 0) return false;
    const minimum = Math.min(...arities);
    if (arities.size !== target.arity - minimum) return false;
    for (let arity = minimum; arity < target.arity; arity += 1) {
      const wrapper = byIdentity.get(
        defaultFunctionKey(target.mod, target.file, target.partition, target.name, arity),
      );
      if (wrapper?.defaultTargetArity !== target.arity) return false;
    }
  }
  return true;
}

function defaultFunctionKey(
  mod: string,
  file: string,
  partition: FunctionRecord["partition"],
  name: string,
  arity: number,
): string {
  return [mod, file, partition, name, arity].join("\0");
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
  return [functionIdentityKey(fn), fn.file, fn.line, fn.defaultTargetArity ?? -1].join("\0");
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

function boundedInteger(value: unknown, maximum: number): value is number {
  return nonNegativeInteger(value) && value <= maximum;
}

function boundedString(value: unknown, maximum: number): value is string {
  return nonEmptyString(value) && value.length <= maximum;
}

export function bytewiseCompare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
