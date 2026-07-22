/** Source ownership, compatibility filtering, and deterministic trace merging. */

import { isAbsolute } from "node:path";
import { ElixirCompileError } from "./errors.js";
import type {
  FunctionRecord,
  ModuleRecord,
  TestPartitionIncompleteReason,
  TestTraceResult,
  TraceEvent,
  TraceResult,
} from "./events.js";
import { pathWithin, type TestInventory } from "./mix-isolation.js";
import {
  bytewiseCompare,
  eventCompatibilityKey,
  functionIdentityKey,
  functionSemanticKey,
  moduleSemanticKey,
} from "./trace-protocol.js";

// Raw compiler-source provenance is needed only for production events whose
// source had to be normalized to their reflected owner. Keep it internal and
// weakly keyed by the validated trace: it is neither serialized nor retained
// after the analysis, and ordinary owner-sourced events allocate no entries.
const normalizedProductionEventSources = new WeakMap<TraceResult, ReadonlySet<string>>();

export function incompleteTestTrace(reason: TestPartitionIncompleteReason): TestTraceResult {
  return {
    events: [],
    modules: [],
    functions: [],
    testPartition: "incomplete",
    testPartitionReason: reason,
  };
}

export function validateProductionTraceOwnership(
  production: TraceResult,
  sourceRoots: readonly string[],
): TraceResult {
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

  const normalizedSources = new Set<string>();
  const events = production.events.map((event): TraceEvent => {
    if (safeRepoRelative(event.file)) {
      const sourceOwned = sourceRoots.some((root) => pathWithin(event.file, root));
      const moduleOwned = event.from_mod !== null && moduleOwners.has(event.from_mod);
      if (!sourceOwned && !moduleOwned) {
        throw new ElixirCompileError(
          "cannot analyze Elixir project: the production tracer emitted an unowned event source.",
        );
      }
      return event;
    }

    const owner = event.from_mod === null ? undefined : moduleOwners.get(event.from_mod);
    if (owner === undefined) {
      throw new ElixirCompileError(
        "cannot analyze Elixir project: the production tracer emitted an external unowned event source.",
      );
    }
    normalizedSources.add(normalizedSourceKey(event));
    return { ...event, file: owner };
  });

  const validated = { ...production, events };
  if (normalizedSources.size > 0)
    normalizedProductionEventSources.set(validated, normalizedSources);
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
): TestTraceResult {
  if (test.testPartition === "incomplete") return test;
  const productionFiles = new Set(inventory.productionFiles);
  const productionModules = new Map(production.modules.map((module) => [module.mod, module]));
  const productionFunctions = new Map(
    production.functions.map((fn) => [functionIdentityKey(fn), functionSemanticKey(fn)]),
  );
  const productionEvents = new Set(production.events.map(eventCompatibilityKey));
  const productionNormalizedSources = normalizedProductionEventSources.get(production);
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
    // deliberately excludes source location, so discarding first would let an
    // absolute, spoofed, or otherwise invalid source bypass this boundary.
    const owned = normalizeTestEventSource(event, combinedOwners, inventory);
    if (owned === null) {
      // Compiler/library macros can attribute a semantic duplicate to their own
      // absolute source. Accept no new fact: discard only when the already-
      // validated production phase normalized the exact same semantic event
      // from the exact same raw source. A mismatch or spoof still fails closed.
      const exactNormalizedProductionDuplicate =
        event.from_mod !== null &&
        productionModules.has(event.from_mod) &&
        productionEvents.has(eventCompatibilityKey(event)) &&
        productionNormalizedSources?.has(normalizedSourceKey(event)) === true;
      if (exactNormalizedProductionDuplicate) continue;
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
  return {
    events: acceptedEvents,
    modules: acceptedModules,
    functions: acceptedFunctions,
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

function normalizedSourceKey(event: TraceEvent): string {
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
    });
  }
  return {
    ...production,
    // Merge the large event streams directly into their stable-key maps. Avoid
    // materialising three concatenated arrays before deduplication; a complete
    // test trace can be hundreds of megabytes in a large application.
    events: stableUniqueGroups([production.events, test.events], eventStableKey),
    modules: stableUniqueGroups([production.modules, test.modules], moduleStableKey),
    functions: stableUniqueGroups([production.functions, test.functions], functionStableKey),
    testPartition: "complete",
  };
}

export function stableTraceResult(result: TraceResult): TraceResult {
  return {
    ...result,
    events: stableUniqueGroups([result.events], eventStableKey),
    modules: stableUniqueGroups([result.modules], moduleStableKey),
    functions: stableUniqueGroups([result.functions], functionStableKey),
  };
}

function eventStableKey(event: TraceEvent): string {
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

function moduleStableKey(module: ModuleRecord): string {
  return [module.partition, moduleSemanticKey(module)].join("\0");
}

function functionStableKey(fn: FunctionRecord): string {
  return [fn.partition, fn.file, fn.line, fn.mod, fn.name, fn.arity].join("\0");
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
