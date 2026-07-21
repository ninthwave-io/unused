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
    return { ...event, file: owner };
  });

  return { ...production, events };
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
  const acceptedModules: ModuleRecord[] = [];
  const acceptedModuleOwners = new Map<string, string>();

  for (const module of test.modules) {
    const productionModule = productionModules.get(module.mod);
    if (productionModule !== undefined) {
      if (moduleSemanticKey(productionModule) !== moduleSemanticKey(module)) {
        return incompleteTestTrace("ownership");
      }
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
    if (event.from_mod !== null && productionModules.has(event.from_mod)) {
      if (!productionEvents.has(eventCompatibilityKey(event))) {
        return incompleteTestTrace("ownership");
      }
      continue;
    }
    if (productionFiles.has(event.file)) return incompleteTestTrace("ownership");
    if (!testFileAllowed(event.file, inventory)) return incompleteTestTrace("ownership");
    if (event.from_mod !== null && combinedOwners.get(event.from_mod) === undefined) {
      return incompleteTestTrace("ownership");
    }
    acceptedEvents.push(event);
  }
  return {
    events: acceptedEvents,
    modules: acceptedModules,
    functions: acceptedFunctions,
    testPartition: "complete",
  };
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
  return stableTraceResult({
    ...production,
    events: [...production.events, ...test.events],
    modules: [...production.modules, ...test.modules],
    functions: [...production.functions, ...test.functions],
    testPartition: "complete",
  });
}

export function stableTraceResult(result: TraceResult): TraceResult {
  return {
    ...result,
    events: stableUnique(result.events, (event) =>
      [
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
      ].join("\0"),
    ),
    modules: stableUnique(result.modules, (module) =>
      [module.partition, moduleSemanticKey(module)].join("\0"),
    ),
    functions: stableUnique(result.functions, (fn) =>
      [fn.partition, fn.file, fn.line, fn.mod, fn.name, fn.arity].join("\0"),
    ),
  };
}

function stableUnique<T>(values: readonly T[], key: (value: T) => string): readonly T[] {
  const byKey = new Map<string, T>();
  for (const value of values) byKey.set(key(value), value);
  return [...byKey].sort(([a], [b]) => bytewiseCompare(a, b)).map(([, value]) => value);
}
