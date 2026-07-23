/** Source ownership, compatibility filtering, and deterministic trace merging. */

import { createHash } from "node:crypto";
import { closeSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { ElixirCompileError } from "./errors.js";
import type {
  DependencyApplication,
  ElixirStructuralFact,
  ElixirStructuralFile,
  ElixirStructuralSpan,
  FunctionRecord,
  HexDependencyApplication,
  ModuleRecord,
  TestPartitionIncompleteReason,
  TestTraceResult,
  TraceEvent,
  TraceResult,
} from "./events.js";
import {
  openRegularFileNoFollow,
  pathWithin,
  readExactBoundedFile,
  type TestInventory,
} from "./mix-isolation.js";
import {
  bytewiseCompare,
  eventCompatibilityKey,
  functionIdentityKey,
  functionSemanticKey,
  moduleSemanticKey,
} from "./trace-protocol.js";

// Raw compiler-source provenance is needed only for production events whose
// source differs from their validated reflected owner. Keep it internal and
// weakly keyed by the validated trace: it is neither serialized nor retained
// after the analysis, and ordinary owner-sourced events allocate no set.
const nonOwnerProductionEventSources = new WeakMap<TraceResult, ReadonlySet<string>>();
const MAX_STRUCTURAL_SOURCE_BYTES = 8 * 1024 * 1024;

/** Attach sanitized layout facts without dropping validated non-owner provenance. */
export function withDependencyApplications(
  production: TraceResult,
  dependencyApplications: readonly DependencyApplication[],
  hexDependencyApplications: readonly HexDependencyApplication[],
): TraceResult {
  const enriched = { ...production, dependencyApplications, hexDependencyApplications };
  const nonOwnerSources = nonOwnerProductionEventSources.get(production);
  if (nonOwnerSources !== undefined) {
    nonOwnerProductionEventSources.set(enriched, nonOwnerSources);
  }
  return enriched;
}

export function incompleteTestTrace(reason: TestPartitionIncompleteReason): TestTraceResult {
  return {
    events: [],
    modules: [],
    functions: [],
    structuralFiles: [],
    structuralPartition: "incomplete",
    testPartition: "incomplete",
    testPartitionReason: reason,
  };
}

export function validateProductionTraceOwnership(
  production: TraceResult,
  sourceRoots: readonly string[],
  projectDir?: string,
): TraceResult {
  if (production.structuralEvents !== undefined) {
    throw new ElixirCompileError(
      "cannot analyze Elixir project: invalid pre-canonical structural event state.",
    );
  }
  const moduleOwners = new Map<string, string>();
  for (const module of production.modules) {
    if (
      !safeRepoRelative(module.file) ||
      !sourceRoots.some((root) => pathWithin(module.file, root))
    ) {
      throw new ElixirCompileError(
        "cannot analyze Elixir project: the production tracer emitted an invalid module owner.",
      );
    }
    moduleOwners.set(module.mod, module.file);
  }

  for (const fn of production.functions) {
    if (!safeRepoRelative(fn.file) || moduleOwners.get(fn.mod) !== fn.file) {
      throw new ElixirCompileError(
        "cannot analyze Elixir project: the production tracer emitted an invalid function owner.",
      );
    }
  }

  let nonOwnerSources: Set<string> | undefined;
  const recordNonOwnerSource = (event: TraceEvent): void => {
    nonOwnerSources ??= new Set<string>();
    nonOwnerSources.add(rawSourceKey(event));
  };
  const events = production.events.map((event): TraceEvent => {
    const owner = event.from_mod === null ? undefined : moduleOwners.get(event.from_mod);
    if (safeRepoRelative(event.file)) {
      const sourceOwned = sourceRoots.some((root) => pathWithin(event.file, root));
      if (!sourceOwned && owner === undefined) {
        throw new ElixirCompileError(
          "cannot analyze Elixir project: the production tracer emitted an unowned event source.",
        );
      }
      if (owner !== undefined && event.file !== owner) recordNonOwnerSource(event);
      return event;
    }

    if (owner === undefined) {
      throw new ElixirCompileError(
        "cannot analyze Elixir project: the production tracer emitted an external unowned event source.",
      );
    }
    recordNonOwnerSource(event);
    return { ...event, file: owner };
  });

  const structuralFiles = validateStructuralFiles(
    production.structuralFiles ?? [],
    production.modules,
    production.functions,
    production.structuralEvents === undefined ? events : production.structuralEvents,
    projectDir,
  );
  const validated = { ...production, events, structuralFiles };
  if (nonOwnerSources !== undefined) nonOwnerProductionEventSources.set(validated, nonOwnerSources);
  return validated;
}

function safeRepoRelative(path: string): boolean {
  if (path === "" || path === "." || path.includes("\\") || isAbsolute(path)) return false;
  const segments = path.split("/");
  return !segments.includes("..") && !segments.includes(".") && !segments.includes("");
}

export function validateTestTraceOwnership(
  production: TraceResult,
  test: TestTraceResult,
  inventory: TestInventory,
  projectDir?: string,
): TestTraceResult {
  if (test.testPartition === "incomplete") return test;
  const productionFiles = new Set(inventory.productionFiles);
  const productionModules = new Map(production.modules.map((module) => [module.mod, module]));
  const productionFunctions = new Map(
    production.functions.map((fn) => [functionIdentityKey(fn), functionSemanticKey(fn)]),
  );
  const productionEvents = new Set(production.events.map(eventCompatibilityKey));
  const productionNonOwnerSources = nonOwnerProductionEventSources.get(production);
  const acceptedModules: ModuleRecord[] = [];
  const acceptedModuleOwners = new Map<string, string>();
  const compatibleProductionModules = new Set<string>();

  for (const module of test.modules) {
    const productionModule = productionModules.get(module.mod);
    if (productionModule !== undefined) {
      if (moduleSemanticKey(productionModule) !== moduleSemanticKey(module)) {
        return incompleteTestTrace("ownership");
      }
      compatibleProductionModules.add(module.mod);
      continue;
    }
    if (!testFileAllowed(module.file, inventory)) return incompleteTestTrace("ownership");
    const priorOwner = acceptedModuleOwners.get(module.mod);
    if (priorOwner !== undefined && priorOwner !== module.file) {
      return incompleteTestTrace("ownership");
    }
    acceptedModuleOwners.set(module.mod, module.file);
    acceptedModules.push(module);
  }

  const combinedOwners = new Map(production.modules.map((module) => [module.mod, module.file]));
  for (const module of acceptedModules) combinedOwners.set(module.mod, module.file);
  const acceptedFunctions: FunctionRecord[] = [];
  for (const fn of test.functions) {
    if (productionModules.has(fn.mod) || productionFiles.has(fn.file)) {
      if (productionFunctions.get(functionIdentityKey(fn)) !== functionSemanticKey(fn)) {
        return incompleteTestTrace("ownership");
      }
      continue;
    }
    if (!testFileAllowed(fn.file, inventory) || combinedOwners.get(fn.mod) !== fn.file) {
      return incompleteTestTrace("ownership");
    }
    acceptedFunctions.push(fn);
  }

  const acceptedEvents: TraceEvent[] = [];
  for (const event of test.events) {
    // Ownership is authoritative even for a semantic duplicate. Compatibility
    // deliberately excludes source location, so discarding first would let a
    // non-owner, spoofed, or otherwise invalid source bypass this boundary.
    const owned = normalizeTestEventSource(event, combinedOwners, inventory);
    if (owned === null) {
      // Compiler/library macros and tracked templates can attribute a semantic
      // duplicate to a safe or unsafe source other than the reflected owner.
      // Accept no new fact: discard only when production validation recorded
      // the exact semantic event and raw source as non-owner provenance. A
      // mismatch or spoof still fails closed.
      const exactNonOwnerProductionDuplicate =
        event.from_mod !== null &&
        productionModules.has(event.from_mod) &&
        productionEvents.has(eventCompatibilityKey(event)) &&
        productionNonOwnerSources?.has(rawSourceKey(event)) === true;
      if (exactNonOwnerProductionDuplicate) continue;
      return incompleteTestTrace("ownership");
    }
    if (event.from_mod !== null && productionModules.has(event.from_mod)) {
      // An exact re-emission is already represented by the production edge.
      // A novel event is legitimate when MIX_ENV=test conditionally expands
      // code in an otherwise semantically identical production-owned module;
      // retain it as a test-scoped edge after source ownership validation.
      if (productionEvents.has(eventCompatibilityKey(owned))) continue;
      if (!compatibleProductionModules.has(event.from_mod)) {
        return incompleteTestTrace("ownership");
      }
    }
    acceptedEvents.push(owned);
  }
  let structuralPartition = test.structuralPartition ?? "complete";
  let validatedStructuralFiles: readonly ElixirStructuralFile[] = [];
  if (structuralPartition === "complete") {
    try {
      validatedStructuralFiles = validateStructuralFiles(
        test.structuralFiles ?? [],
        test.modules,
        test.functions,
        structuralEventStream(test),
        projectDir,
      );
    } catch (error: unknown) {
      if (!(error instanceof ElixirCompileError)) throw error;
      structuralPartition = "incomplete";
    }
  }
  const productionStructuralByFile = new Map(
    (production.structuralFiles ?? []).map((file) => [file.file, file] as const),
  );
  const acceptedStructuralFiles: ElixirStructuralFile[] = [];
  for (const file of validatedStructuralFiles) {
    if (productionFiles.has(file.file)) {
      const existing = productionStructuralByFile.get(file.file);
      if (
        existing === undefined ||
        structuralFileSemanticDigest(existing, structuralEventStream(production)) !==
          structuralFileSemanticDigest(file, structuralEventStream(test))
      ) {
        structuralPartition = "incomplete";
        acceptedStructuralFiles.length = 0;
        break;
      }
      continue;
    }
    if (!testFileAllowed(file.file, inventory)) {
      structuralPartition = "incomplete";
      acceptedStructuralFiles.length = 0;
      break;
    }
    acceptedStructuralFiles.push(file);
  }
  return {
    events: acceptedEvents,
    modules: acceptedModules,
    functions: acceptedFunctions,
    structuralFiles: acceptedStructuralFiles,
    ...(structuralPartition === "complete" && test.structuralSummary !== undefined
      ? { structuralSummary: test.structuralSummary }
      : {}),
    structuralPartition,
    testPartition: "complete",
  };
}

function normalizeTestEventSource(
  event: TraceEvent,
  combinedOwners: ReadonlyMap<string, string>,
  inventory: TestInventory,
): TraceEvent | null {
  const owner = event.from_mod === null ? undefined : combinedOwners.get(event.from_mod);
  if (event.from_mod === null) return testFileAllowed(event.file, inventory) ? event : null;
  if (owner === undefined) return null;
  if (event.file === owner) return event;
  // Elixir occasionally attributes compiler-generated test expansions to a
  // single extensionless pseudo-source (for example `nofile`). It is safe to
  // normalize only when the event names one uniquely reflected project module;
  // ownerless labels, paths, extensions, and non-canonical strings still fail.
  if (owner !== undefined && syntheticSourceLabel(event.file)) {
    return { ...event, file: owner };
  }
  return null;
}

function rawSourceKey(event: TraceEvent): string {
  return `${eventCompatibilityKey(event)}\0${event.file}`;
}

function syntheticSourceLabel(file: string): boolean {
  return safeRepoRelative(file) && !file.includes("/") && !file.includes(".");
}

function testFileAllowed(file: string, inventory: TestInventory): boolean {
  if (!safeRepoRelative(file)) return false;
  return (
    inventory.testFiles.includes(file) ||
    inventory.testOnlyRoots.some((root) => pathWithin(file, root))
  );
}

export function mergeTraceResults(production: TraceResult, test: TestTraceResult): TraceResult {
  if (test.testPartition === "incomplete") {
    return stableTraceResult({
      ...production,
      testPartition: "incomplete",
      ...(test.testPartitionReason === undefined
        ? {}
        : { testPartitionReason: test.testPartitionReason }),
      structuralTestPartition: "incomplete",
    });
  }
  const canonical = canonicalizeStructuralEventIds(
    [...structuralEventGroups(production), ...structuralEventGroups(test)],
    [production.structuralFiles ?? [], test.structuralFiles ?? []],
  );
  return {
    ...production,
    // Merge the large event streams directly into their stable-key maps. Avoid
    // materialising three concatenated arrays before deduplication; a complete
    // test trace can be hundreds of megabytes in a large application.
    events: canonical.semanticEvents,
    structuralEvents: canonical.structuralEvents,
    modules: stableUniqueGroups([production.modules, test.modules], moduleStableKey),
    functions: stableUniqueGroups([production.functions, test.functions], functionStableKey),
    structuralFiles: canonical.structuralFiles,
    ...(test.structuralPartition === "complete" && test.structuralSummary !== undefined
      ? { structuralTestSummary: test.structuralSummary }
      : {}),
    structuralTestPartition: test.structuralPartition ?? "complete",
    testPartition: "complete",
  };
}

export function stableTraceResult(result: TraceResult): TraceResult {
  const canonical = canonicalizeStructuralEventIds(structuralEventGroups(result), [
    result.structuralFiles ?? [],
  ]);
  return {
    ...result,
    events: canonical.semanticEvents,
    structuralEvents: canonical.structuralEvents,
    modules: stableUniqueGroups([result.modules], moduleStableKey),
    functions: stableUniqueGroups([result.functions], functionStableKey),
    structuralFiles: canonical.structuralFiles,
  };
}

function canonicalizeStructuralEventIds(
  eventGroups: readonly (readonly TraceEvent[])[],
  structuralGroups: readonly (readonly ElixirStructuralFile[])[],
): {
  readonly semanticEvents: readonly TraceEvent[];
  readonly structuralEvents: readonly TraceEvent[];
  readonly structuralFiles: readonly ElixirStructuralFile[];
} {
  const canonicalByKey = new Map<string, TraceEvent>();
  const wireToKey = new Map<string, string>();
  for (const events of eventGroups) {
    for (const event of events) {
      const stableKey = eventStableKey(event);
      canonicalByKey.set(stableKey, event);
      if (event.eventId !== undefined) {
        const wireKey = `${event.partition}\0${event.eventId}`;
        const prior = wireToKey.get(wireKey);
        if (prior !== undefined && prior !== stableKey) {
          throw new ElixirCompileError(
            "cannot analyze Elixir project: conflicting structural event identity.",
          );
        }
        wireToKey.set(wireKey, stableKey);
      }
    }
  }
  const stableKeys = [...canonicalByKey.keys()].sort(bytewiseCompare);
  const structurallyReferencedKeys = new Set<string>();
  for (const files of structuralGroups) {
    for (const file of files) {
      for (const fact of file.facts) {
        if (fact.eventId === null) continue;
        const stableKey = wireToKey.get(`${file.partition}\0${fact.eventId}`);
        if (stableKey !== undefined) structurallyReferencedKeys.add(stableKey);
      }
    }
  }
  const semanticByKey = new Map<string, TraceEvent>();
  const canonicalIdByKey = new Map<string, number>();
  const structuralEvents: TraceEvent[] = [];
  for (const stableKey of stableKeys) {
    const event = canonicalByKey.get(stableKey) as TraceEvent;
    const semanticEvent = projectLegacySemanticEvent(event);
    semanticByKey.set(legacyEventStableKey(semanticEvent), semanticEvent);
    if (!structurallyReferencedKeys.has(stableKey)) continue;
    const eventId = structuralEvents.length;
    canonicalIdByKey.set(stableKey, eventId);
    structuralEvents.push({ ...event, eventId });
  }
  const structuralFiles = stableUniqueGroups(
    [
      structuralGroups.flatMap((files) =>
        files.map(
          (file): ElixirStructuralFile => ({
            ...file,
            facts: stableUniqueGroups(
              [
                file.facts.map((fact): ElixirStructuralFact => {
                  if (fact.eventId === null) return fact;
                  const stableKey = wireToKey.get(`${file.partition}\0${fact.eventId}`);
                  const eventId =
                    stableKey === undefined ? undefined : canonicalIdByKey.get(stableKey);
                  if (eventId === undefined) {
                    throw new ElixirCompileError(
                      "cannot analyze Elixir project: invalid structural event identity.",
                    );
                  }
                  return { ...fact, eventId };
                }),
              ],
              structuralFactStableKey,
            ),
          }),
        ),
      ),
    ],
    structuralFileStableKey,
  );
  const canonicalEvents = new Map(structuralEvents.map((event) => [event.eventId, event] as const));
  for (const file of structuralFiles) {
    const carrierById = new Map(file.carriers.map((carrier) => [carrier.id, carrier] as const));
    for (const fact of file.facts) {
      const carrier = carrierById.get(fact.carrier);
      const event = fact.eventId === null ? undefined : canonicalEvents.get(fact.eventId);
      if (
        carrier === undefined ||
        (fact.eventId !== null &&
          (event === undefined ||
            !validExactEventFact(event, fact) ||
            event.partition !== file.partition ||
            event.file !== file.file ||
            event.from_mod !== carrier.mod ||
            event.from_fun !== carrier.fun))
      ) {
        throw new ElixirCompileError(
          "cannot analyze Elixir project: invalid structural event identity.",
        );
      }
    }
  }
  const semanticEvents = [...semanticByKey.keys()]
    .sort(bytewiseCompare)
    .map((stableKey) => semanticByKey.get(stableKey) as TraceEvent);
  return { semanticEvents, structuralEvents, structuralFiles };
}

function structuralEventStream(
  result: Pick<TraceResult, "events" | "structuralEvents">,
): readonly TraceEvent[] {
  return result.structuralEvents === undefined
    ? result.events
    : [...result.events, ...result.structuralEvents];
}

function structuralEventGroups(
  result: Pick<TraceResult, "events" | "structuralEvents">,
): readonly (readonly TraceEvent[])[] {
  return result.structuralEvents === undefined
    ? [result.events]
    : [result.events, result.structuralEvents];
}

/** Protocol v2 is a semantic no-op until a structural analysis explicitly consumes its facts. */
function projectLegacySemanticEvent(event: TraceEvent): TraceEvent {
  const { eventId: _eventId, column: _column, callKind: _callKind, ...legacyEvent } = event;
  return legacyEvent;
}

function legacyEventStableKey(event: TraceEvent): string {
  return [
    event.partition,
    event.file,
    event.line,
    event.kind,
    event.from_mod ?? "",
    event.from_fun ?? "",
    event.to_mod,
    event.name ?? "",
    event.arity ?? -1,
    event.dyn ? 1 : 0,
  ].join("\0");
}

function structuralFactStableKey(fact: ElixirStructuralFact): string {
  return [
    fact.carrier,
    fact.role,
    spanKey(fact.from),
    fact.to === null ? "" : spanKey(fact.to),
    fact.eventId ?? "",
    fact.argument ?? "",
    fact.resolution ?? "",
  ].join("\0");
}

function eventStableKey(event: TraceEvent): string {
  return [
    event.partition,
    event.file,
    event.line,
    event.column ?? 0,
    event.kind,
    event.callKind ?? "",
    event.from_mod ?? "",
    event.from_fun ?? "",
    event.to_mod,
    event.name ?? "",
    event.arity ?? -1,
    event.dyn ? 1 : 0,
  ].join("\0");
}

function moduleStableKey(module: ModuleRecord): string {
  return [module.partition, moduleSemanticKey(module)].join("\0");
}

function functionStableKey(fn: FunctionRecord): string {
  return [fn.partition, fn.file, fn.line, fn.mod, fn.name, fn.arity].join("\0");
}

function structuralFileStableKey(file: ElixirStructuralFile): string {
  return `${file.partition}\0${file.file}`;
}

function structuralFileSemanticDigest(
  file: ElixirStructuralFile,
  events: readonly TraceEvent[],
): string {
  const eventById = new Map(events.map((event) => [event.eventId, event] as const));
  const hash = createHash("sha256");
  const add = (value: string | number | null): void => {
    const text = value === null ? "<null>" : String(value);
    hash.update(String(Buffer.byteLength(text)));
    hash.update(":");
    hash.update(text);
    hash.update(";");
  };
  for (const value of [
    file.file,
    file.digest,
    file.bytes,
    file.status,
    file.reason,
    file.astNodes,
    file.maxDepth,
  ])
    add(value);
  for (const carrier of file.carriers) {
    add("carrier");
    for (const value of [carrier.id, carrier.mod, carrier.fun, carrier.defLine]) add(value);
    addSpan(hash, carrier.body);
  }
  for (const fact of file.facts) {
    add("fact");
    for (const value of [fact.carrier, fact.role]) add(value);
    addSpan(hash, fact.from);
    if (fact.to === null) add(null);
    else addSpan(hash, fact.to);
    add(fact.argument);
    add(fact.resolution);
    const event = fact.eventId === null ? undefined : eventById.get(fact.eventId);
    if (event === undefined) add(null);
    else {
      for (const value of [
        event.kind,
        event.callKind ?? null,
        event.file,
        event.line,
        event.column ?? 0,
        event.from_mod,
        event.from_fun ?? null,
        event.to_mod,
        event.name ?? null,
        event.arity ?? null,
        event.dyn ? 1 : 0,
      ])
        add(value);
    }
  }
  return hash.digest("hex");
}

function addSpan(hash: ReturnType<typeof createHash>, span: ElixirStructuralFact["from"]): void {
  hash.update(`${span.sl}:${span.sc}:${span.el}:${span.ec};`);
}

function validateStructuralFiles(
  files: readonly ElixirStructuralFile[],
  modules: readonly ModuleRecord[],
  functions: readonly FunctionRecord[],
  events: readonly TraceEvent[],
  projectDir?: string,
): readonly ElixirStructuralFile[] {
  const expectedFiles = new Set(modules.map((module) => `${module.partition}\0${module.file}`));
  const actualFiles = new Set<string>();
  const moduleOwners = new Set(
    modules.map((module) => `${module.partition}\0${module.file}\0${module.mod}`),
  );
  const functionOwners = new Set(
    functions.map((fn) => `${fn.partition}\0${fn.file}\0${fn.mod}\0${fn.name}/${fn.arity}`),
  );
  const eventById = new Map(events.map((event) => [event.eventId, event] as const));
  const eventCarriers = new Set(
    events.map(
      (event) =>
        `${event.partition}\0${event.file}\0${event.from_mod ?? ""}\0${event.from_fun ?? ""}`,
    ),
  );
  const result: ElixirStructuralFile[] = [];
  for (const file of files) {
    const fileIdentity = `${file.partition}\0${file.file}`;
    if (
      !safeRepoRelative(file.file) ||
      !expectedFiles.has(fileIdentity) ||
      actualFiles.has(fileIdentity)
    ) {
      throw new ElixirCompileError(
        "cannot analyze Elixir project: invalid structural source ownership.",
      );
    }
    actualFiles.add(fileIdentity);
    if (file.status === "complete" && projectDir === undefined) {
      throw new ElixirCompileError(
        "cannot analyze Elixir project: structural source validation is unavailable.",
      );
    }
    if (file.status === "complete" && projectDir !== undefined) {
      let opened: ReturnType<typeof openRegularFileNoFollow> | undefined;
      try {
        const projectRoot = resolve(projectDir);
        const path = resolve(projectRoot, file.file);
        const rel = relative(projectRoot, path);
        if (rel === ".." || rel.startsWith(`..${sep}`)) {
          throw new Error("invalid structural source");
        }
        const realRoot = realpathSync(projectRoot);
        opened = openRegularFileNoFollow(path);
        const realRel = relative(realRoot, opened.canonicalPath);
        if (realRel === ".." || realRel.startsWith(`..${sep}`))
          throw new Error("invalid real path");
      } catch {
        if (opened !== undefined) closeSync(opened.descriptor);
        throw new ElixirCompileError(
          "cannot analyze Elixir project: structural source validation failed.",
        );
      }
      if (opened === undefined) {
        throw new ElixirCompileError(
          "cannot analyze Elixir project: structural source validation failed.",
        );
      }
      try {
        if (opened.size !== file.bytes || opened.size > MAX_STRUCTURAL_SOURCE_BYTES) {
          throw new Error("structural source size changed");
        }
        const content = readExactBoundedFile(
          opened.descriptor,
          file.bytes,
          MAX_STRUCTURAL_SOURCE_BYTES,
        );
        if (createHash("sha256").update(content).digest("hex") !== file.digest) {
          throw new Error("structural source digest changed");
        }
        validateSpans(file, content.toString("utf8"));
      } catch (error) {
        if (error instanceof ElixirCompileError) throw error;
        throw new ElixirCompileError(
          "cannot analyze Elixir project: structural source changed after compilation.",
        );
      } finally {
        closeSync(opened.descriptor);
      }
    }
    const carrierById = new Map<number, (typeof file.carriers)[number]>();
    const carrierIdentities = new Set<string>();
    for (const [index, carrier] of file.carriers.entries()) {
      if (
        carrier.id !== index ||
        carrierById.has(carrier.id) ||
        carrier.defLine !== carrier.body.sl
      ) {
        throw new ElixirCompileError(
          "cannot analyze Elixir project: invalid structural carrier identity.",
        );
      }
      carrierById.set(carrier.id, carrier);
      const carrierIdentity = `${carrier.mod}\0${carrier.fun}\0${carrier.defLine}\0${spanKey(carrier.body)}`;
      if (carrierIdentities.has(carrierIdentity)) {
        throw new ElixirCompileError(
          "cannot analyze Elixir project: invalid structural carrier identity.",
        );
      }
      carrierIdentities.add(carrierIdentity);
      const ownerKey = `${file.partition}\0${file.file}\0${carrier.mod}`;
      const exactFunction = `${ownerKey}\0${carrier.fun}`;
      const eventOwned = eventCarriers.has(`${ownerKey}\0${carrier.fun}`);
      if (!moduleOwners.has(ownerKey) || (!functionOwners.has(exactFunction) && !eventOwned)) {
        throw new ElixirCompileError(
          "cannot analyze Elixir project: invalid structural carrier ownership.",
        );
      }
    }
    const factIdentities = new Set<string>();
    for (const fact of file.facts) {
      const carrier = carrierById.get(fact.carrier);
      if (carrier === undefined)
        throw new ElixirCompileError(
          "cannot analyze Elixir project: invalid structural fact ownership.",
        );
      if (
        !spanWithin(fact.from, carrier.body) ||
        (fact.to !== null && !spanWithin(fact.to, carrier.body))
      ) {
        throw new ElixirCompileError(
          "cannot analyze Elixir project: invalid structural fact span.",
        );
      }
      const factIdentity = [
        fact.carrier,
        fact.role,
        spanKey(fact.from),
        fact.to === null ? "" : spanKey(fact.to),
        fact.eventId ?? "",
        fact.argument ?? "",
        fact.resolution ?? "",
      ].join("\0");
      if (factIdentities.has(factIdentity)) {
        throw new ElixirCompileError("cannot analyze Elixir project: duplicate structural fact.");
      }
      factIdentities.add(factIdentity);
      if (fact.eventId !== null) {
        const event = eventById.get(fact.eventId);
        if (
          event === undefined ||
          !validExactEventFact(event, fact) ||
          event.partition !== file.partition ||
          event.file !== file.file ||
          event.from_mod !== carrier.mod ||
          event.from_fun !== carrier.fun
        ) {
          throw new ElixirCompileError(
            "cannot analyze Elixir project: invalid structural event ownership.",
          );
        }
      }
    }
    result.push(file);
  }
  if (actualFiles.size !== expectedFiles.size) {
    throw new ElixirCompileError(
      "cannot analyze Elixir project: incomplete structural source inventory.",
    );
  }
  return result;
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

function validExactEventFact(event: TraceEvent, fact: ElixirStructuralFact): boolean {
  if (
    fact.role === "runtime-mfa" &&
    fact.to !== null &&
    event.kind === "alias" &&
    event.callKind === null &&
    event.name === undefined &&
    event.arity === undefined &&
    event.line > 0 &&
    (event.column ?? 0) > 0 &&
    fact.argument === null &&
    fact.resolution === "exact"
  ) {
    return event.line === fact.to.sl && (event.column ?? 0) === fact.to.sc;
  }
  return (
    (event.kind === "remote" || event.kind === "imported" || event.kind === "local") &&
    event.callKind !== null &&
    event.callKind !== undefined &&
    event.line > 0 &&
    (event.column ?? 0) > 0 &&
    event.name !== undefined &&
    event.arity !== undefined &&
    fact.argument !== null &&
    fact.argument < event.arity &&
    fact.to !== null &&
    (fact.role !== "use-dispatcher" ||
      (event.name === "apply" &&
        event.arity === 3 &&
        event.dyn &&
        (event.to_mod === "Kernel" || event.to_mod === ":erlang"))) &&
    (fact.role === "pipeline-argument"
      ? validPipelineEventPoint(event.line, event.column ?? 0, fact.from, fact.to)
      : event.line === fact.to.sl && (event.column ?? 0) === fact.to.sc)
  );
}

function validateSpans(file: ElixirStructuralFile, content: string): void {
  const lines = content.split("\n");
  const segmenter = new Intl.Segmenter("en", { granularity: "grapheme" });
  const lineEnds = lines.map((line) => {
    let column = 1;
    for (const _segment of segmenter.segment(line)) column += 1;
    return column;
  });
  const valid = (span: ElixirStructuralFact["from"]): boolean => {
    const start = lineEnds[span.sl - 1] ?? 0;
    const end = lineEnds[span.el - 1] ?? 0;
    return span.sl <= lines.length && span.el <= lines.length && span.sc <= start && span.ec <= end;
  };
  for (const carrier of file.carriers)
    if (!valid(carrier.body))
      throw new ElixirCompileError("cannot analyze Elixir project: invalid structural span.");
  for (const fact of file.facts) {
    if (!valid(fact.from) || (fact.to !== null && !valid(fact.to))) {
      throw new ElixirCompileError("cannot analyze Elixir project: invalid structural span.");
    }
  }
}

function spanKey(span: ElixirStructuralFact["from"]): string {
  return `${span.sl}:${span.sc}:${span.el}:${span.ec}`;
}

function spanWithin(
  inner: ElixirStructuralFact["from"],
  outer: ElixirStructuralFact["from"],
): boolean {
  const startsInside = inner.sl > outer.sl || (inner.sl === outer.sl && inner.sc >= outer.sc);
  const endsInside = inner.el < outer.el || (inner.el === outer.el && inner.ec <= outer.ec);
  return startsInside && endsInside;
}

function stableUniqueGroups<T>(
  groups: readonly (readonly T[])[],
  key: (value: T) => string,
): readonly T[] {
  const byKey = new Map<string, T>();
  for (const values of groups) {
    for (const value of values) byKey.set(key(value), value);
  }
  const keys = [...byKey.keys()].sort(bytewiseCompare);
  return keys.map((stableKey) => byKey.get(stableKey) as T);
}
