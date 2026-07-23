/**
 * Unit tests for Elixir IR emission + the core claim pipeline (ADR 0011),
 * driven by synthetic {@link TraceResult}s so they run WITHOUT an Elixir
 * toolchain (TS-only CI coverage). They assert the end-to-end contract: emit IR
 * → partitioned reachability → claims, including every hazard keep-alive/cap.
 */

import { describe, expect, it } from "vitest";
import {
  computeDeletionPlan,
  computePartitionedReachability,
  emitClaims,
  whyAlive,
} from "../../core/analysis/index.js";
import type { Claim } from "../../core/claims/types.js";
import { fileId, symbolId } from "../../core/ir/index.js";
import { emitElixirIR } from "./emit.js";
import type { FunctionRecord, ModuleRecord, TraceEvent, TraceResult } from "./events.js";
import {
  dynamicEventKey,
  type ElixirDynamicDispatch,
  type ElixirRuntimeReference,
} from "./runtime-references.js";

// --- builders --------------------------------------------------------------

function mod(name: string, file: string, extra: Partial<ModuleRecord> = {}): ModuleRecord {
  return {
    k: "module",
    mod: name,
    file,
    line: 1,
    behaviours: [],
    protocol: false,
    impl: false,
    partition: "prod",
    ...extra,
  };
}

function fn(name: string, arity: number, ownerFile: string, ownerMod: string): FunctionRecord {
  return {
    k: "function",
    mod: ownerMod,
    name,
    arity,
    file: ownerFile,
    line: 2,
    defaultTargetArity: null,
    partition: "prod",
  };
}

function callEvent(
  fromMod: string,
  fromFun: string | undefined,
  toMod: string,
  name: string | undefined,
  arity: number | undefined,
  extra: Partial<TraceEvent> = {},
): TraceEvent {
  return {
    k: "event",
    kind: name === undefined ? "alias" : "remote",
    file: "lib/app/application.ex",
    line: 5,
    from_mod: fromMod,
    ...(fromFun !== undefined ? { from_fun: fromFun } : {}),
    to_mod: toMod,
    ...(name !== undefined ? { name } : {}),
    ...(arity !== undefined ? { arity } : {}),
    dyn: false,
    partition: "prod",
    ...extra,
  };
}

/** Run the full frontend-core pipeline over a synthetic trace and return claims. */
function claimsFor(
  traceResult: TraceResult,
  configReferencedModules: ReadonlySet<string> = new Set(),
  conventions: {
    readonly runtimeReferences?: readonly ElixirRuntimeReference[];
    readonly dynamicDispatches?: readonly ElixirDynamicDispatch[];
  } = {},
): Claim[] {
  const graph = emitElixirIR({ traceResult, configReferencedModules, ...conventions });
  const reachability = computePartitionedReachability(graph);
  return emitClaims({
    graph,
    reachability,
    provenance: {
      analyzer: "elixir-reference-graph",
      version: "0.1.0",
      generatedAt: "1970-01-01T00:00:00.000Z",
    },
    language: "ex",
  });
}

function claim(claims: readonly Claim[], name: string): Claim | undefined {
  return claims.find((c) => c.subject.name === name);
}

// --- scenario 1: clean (no dynamic dispatch) -------------------------------

const CLEAN: TraceResult = {
  appMod: "App.Application",
  deps: [],
  compileOk: true,
  testPartition: "complete",
  modules: [
    mod("App.Application", "lib/app/application.ex"),
    mod("App.Core", "lib/app/core.ex"),
    mod("App.Worker", "lib/app/worker.ex", { behaviours: ["GenServer"] }),
    mod("App.Orphan", "lib/app/orphan.ex"),
    mod("App.Repo", "lib/app/repo.ex"),
  ],
  functions: [
    fn("start", 2, "lib/app/application.ex", "App.Application"),
    fn("greet", 1, "lib/app/core.ex", "App.Core"),
    fn("dead", 1, "lib/app/core.ex", "App.Core"),
    fn("handle_call", 3, "lib/app/worker.ex", "App.Worker"),
    fn("start_link", 1, "lib/app/worker.ex", "App.Worker"),
    fn("thing", 0, "lib/app/orphan.ex", "App.Orphan"),
    fn("query", 1, "lib/app/repo.ex", "App.Repo"),
  ],
  events: [
    callEvent("App.Application", "start/2", "App.Core", "greet", 1),
    callEvent("App.Application", "start/2", "App.Core", undefined, undefined), // alias
    callEvent("App.Application", "start/2", "App.Worker", undefined, undefined), // supervision child
  ],
};

describe("emitElixirIR — clean scenario", () => {
  const claims = claimsFor(CLEAN, new Set(["App.Repo"]));

  it("flags a clean dead public function at high confidence", () => {
    const c = claim(claims, "App.Core.dead/1");
    expect(c?.verdict).toBe("unused");
    expect(c?.confidence).toBe("high");
    expect(c?.subject.kind).toBe("export");
  });

  it("flags an unreferenced module as a dead file at high confidence", () => {
    const c = claim(claims, "lib/app/orphan.ex");
    expect(c?.subject.kind).toBe("file");
    expect(c?.verdict).toBe("unused");
    expect(c?.confidence).toBe("high");
  });

  it("keeps a reached public function alive (no claim)", () => {
    expect(claim(claims, "App.Core.greet/1")).toBeUndefined();
  });

  it("keeps behaviour callbacks alive (elixir-behaviour-callback suppresses them)", () => {
    expect(claim(claims, "App.Worker.handle_call/3")).toBeUndefined();
    expect(claim(claims, "App.Worker.start_link/1")).toBeUndefined();
  });

  it("explains a reachable behaviour callback and refuses its deletion", () => {
    const graph = emitElixirIR({ traceResult: CLEAN, configReferencedModules: new Set() });
    const reachability = computePartitionedReachability(graph);
    const callbackId = symbolId("lib/app/worker.ex", "App.Worker.handle_call/3");
    expect(reachability.production.reachableSymbols.has(callbackId)).toBe(true);
    const why = whyAlive({
      graph,
      reachability,
      claims,
      query: "lib/app/worker.ex:App.Worker.handle_call/3",
    });
    expect(why).toMatchObject({ outcome: "alive", testOnly: false });
    if (why.outcome !== "alive") throw new Error("expected behaviour callback liveness");
    expect(why.paths[0]?.hops.at(-1)).toMatchObject({
      file: "lib/app/worker.ex",
      symbol: "App.Worker.handle_call/3",
    });
    expect(computeDeletionPlan({ graph, reachability, subject: why.subject })).toMatchObject({
      supported: false,
      stages: [],
    });
  });

  it("keeps a supervision-tree child module alive (aliased in the children list)", () => {
    expect(claim(claims, "App.Worker")).toBeUndefined();
    expect(claims.some((c) => c.subject.loc.file === "lib/app/worker.ex")).toBe(false);
  });

  it("keeps a config-referenced module alive (config root)", () => {
    expect(claims.some((c) => c.subject.loc.file === "lib/app/repo.ex")).toBe(false);
  });

  it('stamps the Elixir language slot into claim ids (kind prefix + "ex" slot)', () => {
    const c = claim(claims, "App.Core.dead/1");
    // ids are `exp_<hash>`; the hash includes the "ex" language slot, so an
    // Elixir export claim can never collide with a TS one for the same name.
    expect(c?.id.startsWith("exp_")).toBe(true);
  });
});

describe("emitElixirIR — compiler-generated default wrappers", () => {
  const file = "lib/app/actions.ex";
  const lower = {
    ...fn("from_short", 1, file, "App.Actions"),
    line: 4,
    defaultTargetArity: 2,
  };
  const body = { ...fn("from_short", 2, file, "App.Actions"), line: 4 };
  const unusedWrapper = {
    ...fn("direct", 1, file, "App.Actions"),
    line: 7,
    defaultTargetArity: 2,
  };
  const directBody = { ...fn("direct", 2, file, "App.Actions"), line: 7 };
  const trace: TraceResult = {
    appMod: "App.Application",
    deps: [],
    compileOk: true,
    testPartition: "complete",
    modules: [mod("App.Application", "lib/app/application.ex"), mod("App.Actions", file)],
    functions: [
      fn("start", 2, "lib/app/application.ex", "App.Application"),
      lower,
      body,
      unusedWrapper,
      directBody,
    ],
    events: [
      callEvent("App.Application", "start/2", "App.Actions", "from_short", 1),
      callEvent("App.Application", "start/2", "App.Actions", "direct", 2),
    ],
  };
  const graph = emitElixirIR({ traceResult: trace, configReferencedModules: new Set() });
  const reachability = computePartitionedReachability(graph);
  const claims = claimsFor(trace);

  it("retains the declared body from a reachable lower-arity wrapper", () => {
    const bodyId = symbolId(file, "App.Actions.from_short/2");
    expect(reachability.production.reachableSymbols.has(bodyId)).toBe(true);
    expect(
      graph
        .edges()
        .find(
          (edge) =>
            edge.kind === "references" &&
            edge.from === symbolId(file, "App.Actions.from_short/1") &&
            edge.to === bodyId,
        ),
    ).toMatchObject({
      kind: "references",
      referenceKind: "static",
      name: "App.Actions.from_short/2",
      site: { file, span: { startLine: 4, endLine: 4 } },
    });
    const why = whyAlive({ graph, reachability, claims, query: "App.Actions.from_short/2" });
    expect(why).toMatchObject({ outcome: "alive", entrypointKind: "production" });
    if (why.outcome !== "alive") throw new Error("expected default body liveness");
    expect(why.paths[0]?.hops.map((hop) => hop.symbol)).toEqual([
      "App.Application.start/2",
      "App.Actions.from_short/1",
      "App.Actions.from_short/2",
    ]);
    expect(computeDeletionPlan({ graph, reachability, subject: why.subject })).toMatchObject({
      supported: false,
      unsupportedReason:
        "non-re-export inbound reference remains at lib/app/actions.ex:4; coordinated caller edits or deletion cohort are not modeled",
      stages: [],
    });
  });

  it("does not retain a lower-arity wrapper from a direct declared-body call", () => {
    const wrapperId = symbolId(file, "App.Actions.direct/1");
    expect(reachability.production.reachableSymbols.has(wrapperId)).toBe(false);
    expect(claim(claims, "App.Actions.direct/1")).toMatchObject({
      verdict: "unused",
      confidence: "high",
    });
  });

  it("scopes a test wrapper edge to the test partition", () => {
    const testFile = "test/support/actions.ex";
    const testTrace: TraceResult = {
      appMod: null,
      deps: [],
      compileOk: true,
      testPartition: "complete",
      modules: [mod("App.TestActions", testFile, { partition: "test" })],
      functions: [
        {
          ...fn("format", 0, testFile, "App.TestActions"),
          partition: "test",
          defaultTargetArity: 1,
        },
        { ...fn("format", 1, testFile, "App.TestActions"), partition: "test" },
      ],
      events: [],
    };
    expect(
      emitElixirIR({ traceResult: testTrace, configReferencedModules: new Set() })
        .edges()
        .find(
          (edge) =>
            edge.kind === "references" &&
            edge.from === symbolId(testFile, "App.TestActions.format/0") &&
            edge.to === symbolId(testFile, "App.TestActions.format/1"),
        )?.partitions,
    ).toEqual(["test"]);
  });
});

describe("emitElixirIR — incomplete test partition", () => {
  const trace: TraceResult = {
    ...CLEAN,
    testPartition: "incomplete",
    modules: [...CLEAN.modules, mod("App.Empty", "lib/app/empty.ex")],
  };
  const graph = emitElixirIR({ traceResult: trace, configReferencedModules: new Set() });
  const reachability = computePartitionedReachability(graph);
  const claims = emitClaims({
    graph,
    reachability,
    provenance: {
      analyzer: "elixir-reference-graph",
      version: "0.1.0",
      generatedAt: "1970-01-01T00:00:00.000Z",
    },
    language: "ex",
  });

  it("keeps every compiler-known production file, module, and function alive", () => {
    const productionFiles = new Set(
      trace.modules.filter((record) => record.partition === "prod").map((record) => record.file),
    );
    const productionSymbols = graph
      .nodes()
      .filter((node) => node.kind === "symbol" && productionFiles.has(node.file));

    expect(
      [...productionFiles].every((file) => reachability.config.reachableFiles.has(fileId(file))),
    ).toBe(true);
    expect(
      productionSymbols.every((node) => reachability.config.reachableSymbols.has(node.id)),
    ).toBe(true);
    expect(
      reachability.config.reachableSymbols.has(symbolId("lib/app/empty.ex", "App.Empty")),
    ).toBe(true);
    expect(claims).toEqual([]);
  });

  it("explains the conservative same-graph path and refuses export and file deletion", () => {
    const why = whyAlive({
      graph,
      reachability,
      claims,
      query: "App.Core.dead/1",
    });
    expect(why).toMatchObject({
      outcome: "alive",
      entrypointKind: "config",
      testOnly: false,
      paths: [
        {
          entrypointReason: "incomplete-test-partition",
          hops: [{ file: "mix.exs" }, { file: "lib/app/core.ex", symbol: "App.Core.dead/1" }],
        },
      ],
    });
    if (why.outcome !== "alive") throw new Error("expected safety-root liveness");
    expect(computeDeletionPlan({ graph, reachability, subject: why.subject })).toMatchObject({
      supported: false,
      unsupportedReason:
        "non-re-export inbound reference remains at mix.exs:1; coordinated caller edits or deletion cohort are not modeled",
      stages: [],
    });
    expect(
      computeDeletionPlan({
        graph,
        reachability,
        subject: { kind: "file", file: "lib/app/empty.ex" },
      }),
    ).toMatchObject({
      supported: false,
      unsupportedReason:
        "non-re-export inbound reference remains at mix.exs:1; coordinated caller edits or deletion cohort are not modeled",
      stages: [],
    });
  });
});

describe("emitElixirIR — unreachable behaviour carrier", () => {
  const trace: TraceResult = {
    appMod: "App.Application",
    deps: [],
    compileOk: true,
    testPartition: "complete",
    modules: [
      mod("App.Application", "lib/app/application.ex"),
      mod("App.OrphanServer", "lib/app/orphan_server.ex", { behaviours: ["GenServer"] }),
    ],
    functions: [
      fn("start", 2, "lib/app/application.ex", "App.Application"),
      fn("handle_call", 3, "lib/app/orphan_server.ex", "App.OrphanServer"),
    ],
    events: [],
  };
  const graph = emitElixirIR({ traceResult: trace, configReferencedModules: new Set() });
  const reachability = computePartitionedReachability(graph);
  const claims = claimsFor(trace);

  it("does not root the carrier or its callback", () => {
    expect(
      reachability.production.reachableSymbols.has(
        symbolId("lib/app/orphan_server.ex", "App.OrphanServer"),
      ),
    ).toBe(false);
    expect(
      reachability.production.reachableSymbols.has(
        symbolId("lib/app/orphan_server.ex", "App.OrphanServer.handle_call/3"),
      ),
    ).toBe(false);
    // The callback hazard protects only the bounded public surface; it neither
    // creates false reachability nor suppresses the carrier's dead-file claim.
    expect(claim(claims, "lib/app/orphan_server.ex")).toMatchObject({
      verdict: "unused",
      confidence: "high",
      subject: { kind: "file" },
    });
    expect(claim(claims, "App.OrphanServer.handle_call/3")).toBeUndefined();
    expect(graph.hazards()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          hazardClass: "elixir-behaviour-callback",
          effect: {
            scope: {
              kind: "symbols",
              ids: [symbolId("lib/app/orphan_server.ex", "App.OrphanServer.handle_call/3")],
            },
            worlds: ["production"],
          },
        }),
      ]),
    );
  });
});

describe("emitElixirIR — test-environment edge from a production carrier", () => {
  const trace: TraceResult = {
    appMod: "App.Application",
    deps: [],
    compileOk: true,
    testPartition: "complete",
    modules: [
      mod("App.Application", "lib/app/application.ex"),
      mod("App.TestTarget", "lib/app/test_target.ex"),
      mod("App.ConditionalTest", "test/conditional_test.exs", { partition: "test" }),
    ],
    functions: [
      fn("start", 2, "lib/app/application.ex", "App.Application"),
      fn("callback", 0, "lib/app/test_target.ex", "App.TestTarget"),
    ],
    events: [
      callEvent("App.Application", "start/2", "App.TestTarget", "callback", 0, {
        file: "lib/app/application.ex",
        partition: "test",
      }),
    ],
  };
  const graph = emitElixirIR({ traceResult: trace, configReferencedModules: new Set() });
  const reachability = computePartitionedReachability(graph);
  const callbackId = symbolId("lib/app/test_target.ex", "App.TestTarget.callback/0");

  it("emits a test-scoped edge without promoting its target into production", () => {
    expect(
      graph.edges().find((edge) => edge.kind === "references" && edge.to === callbackId)
        ?.partitions,
    ).toEqual(["test"]);
    expect(reachability.production.reachableSymbols.has(callbackId)).toBe(false);
    expect(reachability.config.reachableSymbols.has(callbackId)).toBe(false);
    expect(reachability.test.reachableSymbols.has(callbackId)).toBe(true);
  });

  it("reports truthful test-environment why evidence", () => {
    const why = whyAlive({
      graph,
      reachability,
      claims: claimsFor(trace),
      query: "App.TestTarget.callback/0",
    });
    expect(why).toMatchObject({
      outcome: "alive",
      entrypointKind: "test",
      testOnly: true,
      paths: [
        {
          entrypointKind: "production",
          entrypointReason: "application-callback",
        },
      ],
    });
  });
});

// --- scenario 2: dynamic dispatch caps the unit to medium ------------------

const DYNAMIC: TraceResult = {
  appMod: "App.Application",
  deps: [],
  compileOk: true,
  testPartition: "complete",
  modules: [
    mod("App.Application", "lib/app/application.ex"),
    mod("App.Handlers", "lib/app/handlers.ex"),
    mod("App.Router", "lib/app/router.ex"),
    mod("App.Unrelated", "lib/app/unrelated.ex"),
  ],
  functions: [
    fn("start", 2, "lib/app/application.ex", "App.Application"),
    fn("ping", 0, "lib/app/handlers.ex", "App.Handlers"),
    fn("dead_handler", 0, "lib/app/handlers.ex", "App.Handlers"),
    fn("dispatch", 1, "lib/app/router.ex", "App.Router"),
    fn("dead", 0, "lib/app/unrelated.ex", "App.Unrelated"),
  ],
  events: [
    callEvent("App.Application", "start/2", "App.Handlers", "ping", 0),
    callEvent("App.Application", "start/2", "App.Router", "dispatch", 1),
    // the apply/3 site — target module is Kernel (not a project module), so no
    // edge, but the `dyn` flag raises the elixir-dynamic-dispatch hazard.
    callEvent("App.Router", "dispatch/1", "Kernel", "apply", 3, {
      dyn: true,
      file: "lib/app/router.ex",
    }),
  ],
};

describe("emitElixirIR — dynamic dispatch", () => {
  const claims = claimsFor(DYNAMIC);

  it("attributes a traced dispatch to its exact reflected public-function carrier", () => {
    const graph = emitElixirIR({ traceResult: DYNAMIC, configReferencedModules: new Set() });
    expect(
      graph.hazards().find((hazard) => hazard.hazardClass === "elixir-dynamic-dispatch"),
    ).toMatchObject({
      file: fileId("lib/app/router.ex"),
      carrierSymbol: symbolId("lib/app/router.ex", "App.Router.dispatch/1"),
    });
  });

  it("emits an unproved atom flow as an explicit unit-scoped escape", () => {
    const events = DYNAMIC.events.map((event) =>
      event.dyn ? { ...event, to_mod: "String", name: "to_atom", arity: 1 } : event,
    );
    const trace = { ...DYNAMIC, events };
    const atomEvent = events.find((event) => event.dyn);
    expect(atomEvent).toBeDefined();
    if (atomEvent === undefined) throw new Error("expected atom event");
    const graph = emitElixirIR({
      traceResult: trace,
      configReferencedModules: new Set(),
      dynamicDispatches: [
        {
          fromMod: "App.Router",
          fromFun: "dispatch/1",
          file: "lib/app/router.ex",
          line: atomEvent.line,
          factKind: "computed-atom",
          flow: "escape",
          kind: "opaque",
          world: "production",
          eventKey: dynamicEventKey(atomEvent),
          targets: [],
        },
      ],
    });

    expect(
      graph.hazards().find((hazard) => hazard.hazardClass === "elixir-computed-atom-escape"),
    ).toMatchObject({
      carrierSymbol: symbolId("lib/app/router.ex", "App.Router.dispatch/1"),
      detail: expect.stringContaining("escapes before its consumer can be classified"),
      effect: { scope: { kind: "unit" }, worlds: ["production"] },
    });
  });

  it("explains a private-summary degree refusal as an explicit precision bound", () => {
    const events = DYNAMIC.events.map((event) =>
      event.dyn ? { ...event, to_mod: "String", name: "to_atom", arity: 1 } : event,
    );
    const trace = { ...DYNAMIC, events };
    const atomEvent = events.find((event) => event.dyn);
    if (atomEvent === undefined) throw new Error("expected atom event");
    const graph = emitElixirIR({
      traceResult: trace,
      configReferencedModules: new Set(),
      dynamicDispatches: [
        {
          fromMod: "App.Router",
          fromFun: "dispatch/1",
          file: "lib/app/router.ex",
          line: atomEvent.line,
          factKind: "computed-atom",
          flow: "escape",
          escapeReason: "function-summary-bound",
          kind: "opaque",
          world: "production",
          eventKey: dynamicEventKey(atomEvent),
          targets: [],
        },
      ],
    });

    expect(
      graph.hazards().find((hazard) => hazard.hazardClass === "elixir-computed-atom-escape"),
    ).toMatchObject({ detail: expect.stringContaining("call degree exceeds the reviewed bound") });
  });

  it("preserves mixed escape/invocation scopes and worlds on one carrier", () => {
    const productionEvent = DYNAMIC.events.find((event) => event.dyn);
    const target = DYNAMIC.functions.find((candidate) => candidate.name === "dead_handler");
    expect(productionEvent).toBeDefined();
    expect(target).toBeDefined();
    if (productionEvent === undefined || target === undefined) {
      throw new Error("expected dynamic event and bounded target");
    }
    const testEvent = { ...productionEvent, partition: "test" as const };
    const trace = { ...DYNAMIC, events: [...DYNAMIC.events, testEvent] };
    const common = {
      fromMod: "App.Router",
      fromFun: "dispatch/1",
      file: "lib/app/router.ex",
      line: productionEvent.line,
      targets: [],
    };
    const graph = emitElixirIR({
      traceResult: trace,
      configReferencedModules: new Set(),
      dynamicDispatches: [
        {
          ...common,
          factKind: "computed-atom",
          flow: "escape",
          kind: "opaque",
          world: "production",
          eventKey: dynamicEventKey(productionEvent),
        },
        {
          ...common,
          factKind: "dynamic-invocation",
          kind: "bounded",
          world: "production",
          eventKey: dynamicEventKey(productionEvent),
          targets: [target],
        },
        {
          ...common,
          factKind: "computed-atom",
          flow: "escape",
          kind: "opaque",
          world: "test",
          eventKey: dynamicEventKey(testEvent),
        },
        {
          ...common,
          factKind: "dynamic-invocation",
          kind: "opaque",
          world: "test",
          eventKey: dynamicEventKey(testEvent),
        },
      ],
    });

    expect(
      graph
        .hazards()
        .filter(
          (hazard) =>
            hazard.hazardClass === "elixir-computed-atom-escape" ||
            hazard.hazardClass === "elixir-dynamic-dispatch",
        )
        .map((hazard) => ({
          hazardClass: hazard.hazardClass,
          scope: hazard.effect?.scope.kind,
          worlds: hazard.effect?.worlds,
        })),
    ).toEqual([
      {
        hazardClass: "elixir-computed-atom-escape",
        scope: "unit",
        worlds: ["production"],
      },
      { hazardClass: "elixir-dynamic-dispatch", scope: "symbols", worlds: ["production"] },
      { hazardClass: "elixir-computed-atom-escape", scope: "unit", worlds: ["test"] },
      { hazardClass: "elixir-dynamic-dispatch", scope: "unit", worlds: ["test"] },
    ]);
  });

  it("caps a dead function to medium when the unit performs apply/3", () => {
    const c = claim(claims, "App.Handlers.dead_handler/0");
    expect(c?.verdict).toBe("unused");
    expect(c?.confidence).toBe("medium");
  });

  it("still keeps a statically-called function alive", () => {
    expect(claim(claims, "App.Handlers.ping/0")).toBeUndefined();
  });

  it("does not cap the unit when the dispatch carrier is unreachable", () => {
    const unreachableCarrier: TraceResult = {
      ...DYNAMIC,
      events: DYNAMIC.events.filter(
        (event) => !(event.from_mod === "App.Application" && event.to_mod === "App.Router"),
      ),
    };
    const c = claim(claimsFor(unreachableCarrier), "App.Handlers.dead_handler/0");
    expect(c?.verdict).toBe("unused");
    expect(c?.confidence).toBe("high");
  });

  it("caps only compiler-confirmed targets for a bounded apply", () => {
    const target = DYNAMIC.functions.find(
      (candidate) => candidate.mod === "App.Handlers" && candidate.name === "dead_handler",
    );
    expect(target).toBeDefined();
    const bounded = claimsFor(DYNAMIC, new Set(), {
      dynamicDispatches: [
        {
          fromMod: "App.Router",
          fromFun: "dispatch/1",
          file: "lib/app/router.ex",
          line: 5,
          factKind: "dynamic-invocation",
          kind: "bounded",
          world: "production",
          eventKey: dynamicEventKey(DYNAMIC.events.find((event) => event.dyn) as TraceEvent),
          targets: target === undefined ? [] : [target],
        },
      ],
    });

    expect(claim(bounded, "App.Handlers.dead_handler/0")?.confidence).toBe("medium");
    expect(claim(bounded, "lib/app/unrelated.ex")?.confidence).toBe("high");
  });
});

// --- scenario 3: no production entrypoint => no claims ---------------------

describe("emitElixirIR — no production entrypoint", () => {
  it("proves nothing when there is no application callback / mix task / phoenix root", () => {
    const noRoot: TraceResult = {
      appMod: null,
      deps: [],
      compileOk: true,
      testPartition: "complete",
      modules: [mod("Lib.Thing", "lib/lib/thing.ex")],
      functions: [fn("do_it", 0, "lib/lib/thing.ex", "Lib.Thing")],
      events: [],
    };
    expect(claimsFor(noRoot)).toHaveLength(0);
  });
});
