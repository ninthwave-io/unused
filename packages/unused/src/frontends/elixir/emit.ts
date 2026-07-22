/**
 * Elixir IR emission (ADR 0011): turn a {@link TraceResult} + config references
 * into the language-agnostic reference-graph {@link IRGraph} core consumes.
 *
 * ## The model
 * Every `.ex`/`.exs` source file is a `file` node. Every compiled **module** is a
 * `symbol` named `Mod` (`inspect`-form); every public, non-generated **function**
 * is a `symbol` named `Mod.fun/arity`. Reflectively-generated helpers
 * (`__struct__`, `module_info`, `__impl__`, …) are excluded by the tracer script,
 * never modelled.
 *
 * Edges (all `references`/`static`, so they propagate through the reachability
 * walk's symbol→symbol rule, cross-file included):
 *  - **call/alias/struct events** → an edge from the *referencing* symbol (the
 *    `from_mod.from_fun/arity`, or the module when at module level) to the
 *    *referenced* symbol (the `to_mod.name/arity` function, or the module for an
 *    alias/struct or a call to a function we do not model). Deduped.
 *  - **function → its module** → so a used function keeps its module alive
 *    without keeping the module's *other* functions alive. Compiler-proven
 *    behaviour/protocol/impl carriers additionally get bounded module → public
 *    function runtime edges: reflective callbacks become live only when their
 *    carrier module is itself live.
 *
 * `exports`/`contains` edges tie each file to its symbols so an entrypoint file
 * (surface-live) roots its whole module + function surface.
 *
 * ## Entrypoints (roots)
 *  - **production**: the OTP application callback module's file; `Mix.Task`
 *    modules; Phoenix `Endpoint`/`Router` modules (when `phoenix` is a dep).
 *    Supervision-tree children need no special handling — they appear as ordinary
 *    alias/call references from the application callback and are reached
 *    transitively.
 *  - **config**: any file whose module is named in `config/*.exs`.
 *  - **test**: every ExUnit test file (under `test/`, a `_test.exs` basename).
 *    If that separate compiler pass is incomplete, a synthetic config safety
 *    root conservatively reaches every production public surface. This keeps
 *    potentially test-reachable code alive (including across bridge edges)
 *    and gives deletion planning an explicit inbound safety reference.
 *
 * ## Hazards (keep-alive / cap)
 *  - a module declaring a behaviour ⇒ `elixir-behaviour-callback` (its function
 *    claims suppressed); a Phoenix behaviour / protocol / `defimpl` ⇒
 *    `elixir-phoenix-runtime` (same suppression); a file with an
 *    `apply`/`Module.concat` dynamic-dispatch site ⇒ `elixir-dynamic-dispatch`.
 *    Literal calls become exact runtime edges, bounded calls cap only their
 *    compiler-confirmed candidates, and opaque calls retain the owning-unit cap.
 */

import {
  entrypointId,
  fileId,
  type HazardClass,
  IRGraph,
  type Site,
  symbolId,
} from "../../core/ir/index.js";
import type { FunctionRecord, ModuleRecord, TraceEvent, TraceResult } from "./events.js";
import type { ElixirDynamicDispatch, ElixirRuntimeReference } from "./runtime-references.js";

/** A resolved symbol identity (its owning file + its exported name). */
interface SymRef {
  readonly file: string;
  readonly exportedName: string;
}

export interface EmitElixirInput {
  readonly traceResult: TraceResult;
  /** Project module names referenced as tokens inside `config/*.exs` (config roots). */
  readonly configReferencedModules: ReadonlySet<string>;
  /** Literal runtime conventions independently extracted from project source. */
  readonly runtimeReferences?: readonly ElixirRuntimeReference[];
  /** Argument-aware facts for compiler-traced dynamic-dispatch sites. */
  readonly dynamicDispatches?: readonly ElixirDynamicDispatch[];
}

/** Phoenix behaviour names whose implementers are runtime-dispatch entrypoints. */
const PHOENIX_ENTRYPOINT_BEHAVIOURS = new Set(["Phoenix.Endpoint", "Phoenix.Router"]);

/** A zero-width provenance span at a given line. */
function siteAt(file: string, line: number): Site {
  const l = line >= 1 ? line : 1;
  return { file, span: { start: 0, end: 0, startLine: l, endLine: l } };
}

/** Build the reference-graph IR for an Elixir project. */
export function emitElixirIR(input: EmitElixirInput): IRGraph {
  const {
    traceResult,
    configReferencedModules,
    runtimeReferences = [],
    dynamicDispatches = [],
  } = input;
  const graph = new IRGraph();

  // --- index modules + functions --------------------------------------------
  // A module maps to exactly one file (its `defmodule`). Function keys are the
  // exported name `Mod.fun/arity`.
  const moduleByName = new Map<string, ModuleRecord>();
  for (const mod of traceResult.modules) {
    if (!moduleByName.has(mod.mod)) moduleByName.set(mod.mod, mod);
  }
  const fnByKey = new Map<string, FunctionRecord>();
  const functionsByModule = new Map<string, FunctionRecord[]>();
  for (const fn of traceResult.functions) {
    const key = `${fn.mod}.${fn.name}/${fn.arity}`;
    if (!fnByKey.has(key)) fnByKey.set(key, fn);
    const moduleFunctions = functionsByModule.get(fn.mod);
    if (moduleFunctions === undefined) functionsByModule.set(fn.mod, [fn]);
    else moduleFunctions.push(fn);
  }

  // --- file + symbol nodes ---------------------------------------------------
  const files = new Set<string>();
  const addFile = (rel: string): void => {
    if (files.has(rel)) return;
    files.add(rel);
    graph.addNode({ kind: "file", id: fileId(rel), path: rel });
  };

  const addSymbol = (file: string, exportedName: string, line: number): void => {
    addFile(file);
    graph.addNode({
      kind: "symbol",
      id: symbolId(file, exportedName),
      file,
      exportedName,
      isDefault: false,
      typeOnly: false,
      local: true,
      span: siteAt(file, line).span,
    });
    graph.addEdge({
      kind: "exports",
      from: fileId(file),
      to: symbolId(file, exportedName),
      site: siteAt(file, line),
      name: exportedName,
    });
    graph.addEdge({
      kind: "contains",
      from: fileId(file),
      to: symbolId(file, exportedName),
      site: siteAt(file, line),
      name: exportedName,
    });
  };

  for (const mod of traceResult.modules) addSymbol(mod.file, mod.mod, mod.line);
  for (const fn of traceResult.functions) {
    addSymbol(fn.file, `${fn.mod}.${fn.name}/${fn.arity}`, fn.line);
    // function → its module (a used function keeps its module alive).
    graph.addEdge({
      kind: "references",
      referenceKind: "static",
      from: symbolId(fn.file, `${fn.mod}.${fn.name}/${fn.arity}`),
      to: symbolId(fn.file, fn.mod),
      site: siteAt(fn.file, fn.line),
      name: fn.mod,
    });
  }

  // --- reference edges from events ------------------------------------------
  const resolveTarget = (ev: TraceEvent): SymRef | null => {
    const mod = moduleByName.get(ev.to_mod);
    if (mod === undefined) return null; // not a project module (stdlib/dep) — ignore
    if (ev.name !== undefined && ev.arity !== undefined) {
      const fn = fnByKey.get(`${ev.to_mod}.${ev.name}/${ev.arity}`);
      if (fn !== undefined)
        return { file: fn.file, exportedName: `${fn.mod}.${fn.name}/${fn.arity}` };
    }
    // alias/struct, or a call to a private/generated/macro function we do not
    // model as a symbol ⇒ keep the whole module alive.
    return { file: mod.file, exportedName: mod.mod };
  };

  const resolveSource = (ev: TraceEvent): SymRef | null => {
    if (ev.from_mod === null) return null;
    const mod = moduleByName.get(ev.from_mod);
    if (mod === undefined) return null;
    if (ev.from_fun !== undefined) {
      const fn = fnByKey.get(`${ev.from_mod}.${ev.from_fun}`);
      if (fn !== undefined)
        return { file: fn.file, exportedName: `${fn.mod}.${fn.name}/${fn.arity}` };
    }
    return { file: mod.file, exportedName: mod.mod };
  };

  const seenEdge = new Set<string>();
  for (const ev of traceResult.events) {
    const target = resolveTarget(ev);
    if (target === null) continue;
    const source = resolveSource(ev);
    if (source === null) continue;
    const fromId = symbolId(source.file, source.exportedName);
    const toId = symbolId(target.file, target.exportedName);
    if (fromId === toId) continue;
    const dedup = `${fromId}\0${toId}`;
    if (seenEdge.has(dedup)) continue;
    seenEdge.add(dedup);
    graph.addEdge({
      kind: "references",
      referenceKind: "static",
      from: fromId,
      to: toId,
      site: siteAt(ev.file, ev.line),
      name: target.exportedName,
      ...(ev.partition === "test" ? { partitions: ["test"] as const } : {}),
    });
  }

  // Compiler tracing cannot turn an MFA value or a literal `use` selector into
  // a call edge. Source extraction proves these narrow runtime references and
  // records their actual site so `why` remains auditable.
  for (const reference of runtimeReferences) {
    const sourceMod = moduleByName.get(reference.fromMod);
    const target = fnByKey.get(`${reference.toMod}.${reference.toName}/${reference.toArity}`);
    if (sourceMod === undefined || target === undefined) continue;
    const sourceFn =
      reference.fromFun === undefined
        ? undefined
        : fnByKey.get(`${reference.fromMod}.${reference.fromFun}`);
    const fromId =
      sourceFn === undefined
        ? symbolId(sourceMod.file, sourceMod.mod)
        : symbolId(sourceFn.file, `${sourceFn.mod}.${sourceFn.name}/${sourceFn.arity}`);
    const toName = `${target.mod}.${target.name}/${target.arity}`;
    const toId = symbolId(target.file, toName);
    if (fromId === toId) continue;
    const dedup = `${fromId}\0${toId}`;
    if (seenEdge.has(dedup)) continue;
    seenEdge.add(dedup);
    graph.addEdge({
      kind: "references",
      referenceKind: "runtime-resolved",
      from: fromId,
      to: toId,
      site: siteAt(reference.file, reference.line),
      name: toName,
    });
  }

  // --- hazards ---------------------------------------------------------------
  // A module defining `child_spec/1` is OTP-supervisable: the supervisor invokes
  // its `child_spec/1`/`start_link/*`/`init/1` reflectively, exactly like a
  // behaviour's callbacks, even when it declares no behaviour (a plain module
  // used as a supervised child). Treated as a behaviour-callback keep-alive so
  // those lifecycle functions are never false-flagged.
  const supervisableModules = new Set<string>();
  for (const fn of traceResult.functions) {
    if (fn.name === "child_spec" && fn.arity === 1) supervisableModules.add(fn.mod);
  }
  emitModuleHazards(graph, traceResult.modules, functionsByModule, supervisableModules);
  emitDynamicDispatchHazards(graph, traceResult, moduleByName, dynamicDispatches);

  // --- entrypoints -----------------------------------------------------------
  const seededProd = new Set<string>();
  const seedProd = (file: string, reason: string): void => {
    if (seededProd.has(file)) return;
    seededProd.add(file);
    graph.addNode({
      kind: "entrypoint",
      id: entrypointId("production", file),
      entryKind: "production",
      file,
      reason,
    });
  };

  // OTP application callback + its supervision tree (transitive via edges).
  if (traceResult.appMod !== null) {
    const appMod = moduleByName.get(traceResult.appMod);
    if (appMod !== undefined) seedProd(appMod.file, "application-callback");
  }
  const hasPhoenix = traceResult.deps.includes("phoenix");
  for (const mod of traceResult.modules) {
    if (mod.partition !== "prod") continue; // test modules are seeded as test roots below
    // Mix tasks: invoked by CLI name, never from application code.
    if (mod.mod.startsWith("Mix.Tasks.")) {
      seedProd(mod.file, "mix-task");
      continue;
    }
    // Phoenix `Endpoint`/`Router` are genuine request entrypoints (the endpoint
    // boots on app start; the router is the request dispatcher) — production
    // roots. Other runtime-dispatch modules (a GenServer, a LiveView, a
    // controller, a `defimpl`) are NOT rooted here: their CALLBACK functions are
    // kept alive by the behaviour/phoenix-runtime hazard, but only relative to a
    // module that is itself reachable (supervised, aliased, or config-named). A
    // behaviour module referenced by nothing stays claimable as a dead file (the
    // published hazard rationale) — capped to medium by the unit's
    // dynamic-dispatch hazard when one exists, never confidently dead while an
    // `apply` that could reach it lives in the same unit.
    if (hasPhoenix && isPhoenixEntrypoint(mod)) {
      seedProd(mod.file, "phoenix-endpoint-router");
    }
  }

  // Config roots: a module named in config/*.exs is kept alive.
  for (const mod of traceResult.modules) {
    if (mod.partition !== "prod") continue;
    if (!configReferencedModules.has(mod.mod)) continue;
    if (seededProd.has(mod.file)) continue;
    graph.addNode({
      kind: "entrypoint",
      id: entrypointId("config", mod.file),
      entryKind: "config",
      file: mod.file,
      reason: "config-referenced",
    });
  }

  // Test partition: every `test/**/*_test.exs` file.
  const seededTest = new Set<string>();
  for (const mod of traceResult.modules) {
    if (mod.partition !== "test") continue;
    if (seededTest.has(mod.file)) continue;
    seededTest.add(mod.file);
    graph.addNode({
      kind: "entrypoint",
      id: entrypointId("test", mod.file),
      entryKind: "test",
      file: mod.file,
      reason: "exunit-test",
    });
  }

  if (traceResult.testPartition === "incomplete") {
    const productionFiles = new Set(
      traceResult.modules.filter((mod) => mod.partition === "prod").map((mod) => mod.file),
    );
    addFile("mix.exs");
    graph.addNode({
      kind: "entrypoint",
      id: entrypointId("config", "mix.exs"),
      entryKind: "config",
      file: "mix.exs",
      reason: "incomplete-test-partition",
    });
    for (const file of [...productionFiles].sort()) {
      graph.addEdge({
        kind: "references",
        referenceKind: "safety-root",
        from: fileId("mix.exs"),
        to: fileId(file),
        site: siteAt("mix.exs", 1),
        name: "*",
      });
    }
    for (const node of graph.nodes()) {
      if (node.kind !== "symbol" || !productionFiles.has(node.file)) continue;
      graph.addEdge({
        kind: "references",
        referenceKind: "safety-root",
        from: fileId("mix.exs"),
        to: node.id,
        site: siteAt("mix.exs", 1),
        name: node.exportedName,
      });
    }
  }

  return graph;
}

/**
 * Behaviour / protocol / impl / OTP-supervisable keep-alive hazards, one per
 * carrier module. Each compiler-proven carrier gets bounded runtime edges to
 * its public functions. Those functions therefore become live only when the
 * carrier is live; this never roots an otherwise-unreferenced module. The
 * matching hazard remains narrowly scoped to that same public surface for
 * conservative claim confidence and NEVER suppresses its file claim.
 */
function emitModuleHazards(
  graph: IRGraph,
  modules: readonly ModuleRecord[],
  functionsByModule: ReadonlyMap<string, readonly FunctionRecord[]>,
  supervisableModules: ReadonlySet<string>,
): void {
  const seen = new Set<string>();
  for (const mod of modules) {
    const phoenix =
      mod.protocol || mod.impl || mod.behaviours.some((b) => b.startsWith("Phoenix."));
    const behaviour = mod.behaviours.length > 0;
    const supervisable = supervisableModules.has(mod.mod);
    let hazardClass: HazardClass | null = null;
    let detail = "";
    if (phoenix) {
      hazardClass = "elixir-phoenix-runtime";
      detail = mod.protocol
        ? `protocol \`${mod.mod}\` — dispatched by the runtime, never called by name`
        : mod.impl
          ? `protocol implementation \`${mod.mod}\` — dispatched by \`Protocol.impl_for/1\``
          : `Phoenix runtime module \`${mod.mod}\` — callbacks invoked by the framework`;
    } else if (behaviour) {
      hazardClass = "elixir-behaviour-callback";
      detail = `module \`${mod.mod}\` implements behaviour(s) ${mod.behaviours.join(", ")} — callbacks are dispatched reflectively`;
    } else if (supervisable) {
      hazardClass = "elixir-behaviour-callback";
      detail = `module \`${mod.mod}\` defines child_spec/1 — an OTP-supervisable module whose lifecycle callbacks (child_spec/start_link/init) the supervisor invokes reflectively`;
    }
    if (hazardClass === null) continue;
    const key = `${mod.mod} ${hazardClass}`;
    if (seen.has(key)) continue;
    seen.add(key);
    // A persisted behaviour/protocol/impl attribute proves that this module is
    // a reflective dispatch carrier. `child_spec/1` alone keeps its existing
    // confidence hazard, but is not promoted to a module-wide runtime relation.
    const reflectiveCarrier = phoenix || behaviour;
    const affectedFunctions = reflectiveCarrier ? (functionsByModule.get(mod.mod) ?? []) : [];
    const affectedSymbols = affectedFunctions.map((fn) =>
      symbolId(fn.file, `${fn.mod}.${fn.name}/${fn.arity}`),
    );
    graph.addHazard({
      file: fileId(mod.file),
      hazardClass,
      detail,
      site: siteAt(mod.file, mod.line),
      ...(reflectiveCarrier ? { affectedSymbols } : {}),
    });
    const carrierId = symbolId(mod.file, mod.mod);
    for (const fn of affectedFunctions) {
      const exportedName = `${fn.mod}.${fn.name}/${fn.arity}`;
      graph.addEdge({
        kind: "references",
        referenceKind: "runtime-resolved",
        from: carrierId,
        to: symbolId(fn.file, exportedName),
        site: siteAt(mod.file, mod.line),
        name: exportedName,
      });
    }
  }
}

/** Dynamic-dispatch hazard: one per file that calls `apply`/`Module.concat`/… */
function emitDynamicDispatchHazards(
  graph: IRGraph,
  traceResult: TraceResult,
  moduleByName: ReadonlyMap<string, ModuleRecord>,
  extracted: readonly ElixirDynamicDispatch[],
): void {
  const extractedBySite = new Map<string, ElixirDynamicDispatch[]>();
  for (const dispatch of extracted) {
    const key = `${dispatch.file}\0${dispatch.line}`;
    const bucket = extractedBySite.get(key);
    if (bucket === undefined) extractedBySite.set(key, [dispatch]);
    else bucket.push(dispatch);
  }
  const byFile = new Map<string, { mod: ModuleRecord; dispatches: ElixirDynamicDispatch[] }>();
  for (const ev of traceResult.events) {
    if (!ev.dyn) continue;
    if (ev.from_mod === null) continue;
    const mod = moduleByName.get(ev.from_mod);
    if (mod === undefined) continue; // the dispatch happened in a non-project module
    const dispatches = extractedBySite.get(`${ev.file}\0${ev.line}`) ?? [
      {
        fromMod: ev.from_mod,
        ...(ev.from_fun === undefined ? {} : { fromFun: ev.from_fun }),
        file: ev.file,
        line: ev.line,
        kind: "opaque" as const,
        targets: [],
      },
    ];
    const current = byFile.get(mod.file);
    if (current === undefined) byFile.set(mod.file, { mod, dispatches: [...dispatches] });
    else current.dispatches.push(...dispatches);
  }

  for (const [file, { mod, dispatches }] of byFile) {
    const opaque = dispatches.find((dispatch) => dispatch.kind === "opaque");
    const bounded = dispatches.filter((dispatch) => dispatch.kind === "bounded");
    if (opaque === undefined && bounded.length === 0) continue; // exact edges need no cap
    const affectedSymbols =
      opaque === undefined
        ? [
            ...new Set(
              bounded.flatMap((dispatch) =>
                dispatch.targets.map((target) =>
                  symbolId(target.file, `${target.mod}.${target.name}/${target.arity}`),
                ),
              ),
            ),
          ].sort()
        : undefined;
    if (opaque === undefined && affectedSymbols?.length === 0) continue;
    const source = opaque ?? bounded[0];
    if (source === undefined) continue;
    graph.addHazard({
      file: fileId(file),
      hazardClass: "elixir-dynamic-dispatch",
      detail:
        affectedSymbols === undefined
          ? `opaque dynamic dispatch (\`apply\`/\`Module.concat\`) in \`${mod.mod}\` — the runtime target is not statically resolvable`
          : `bounded dynamic dispatch in \`${mod.mod}\` may select ${affectedSymbols.length} compiler-confirmed public function(s)`,
      site: siteAt(source.file, source.line),
      ...(affectedSymbols === undefined ? {} : { affectedSymbols }),
    });
  }
}

function isPhoenixEntrypoint(mod: ModuleRecord): boolean {
  if (mod.behaviours.some((b) => PHOENIX_ENTRYPOINT_BEHAVIOURS.has(b))) return true;
  return mod.mod.endsWith(".Endpoint") || mod.mod.endsWith(".Router");
}
