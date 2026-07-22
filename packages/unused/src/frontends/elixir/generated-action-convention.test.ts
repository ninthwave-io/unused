import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  computeDeletionPlan,
  computePartitionedReachability,
  emitClaims,
  evaluateHazards,
  whyAlive,
} from "../../core/analysis/index.js";
import { emitElixirIR } from "./emit.js";
import type { FunctionRecord, ModuleRecord, TraceEvent, TraceResult } from "./events.js";
import { extractElixirRuntimeConventions } from "./runtime-references.js";

const root = fileURLToPath(
  new URL("./__testfixtures__/generated-action-convention", import.meta.url),
);
const sourceApplyRoot = fileURLToPath(
  new URL("./__testfixtures__/generated-action-source-apply", import.meta.url),
);
const controllerFile = "controller.ex";

function mod(name: string, file: string): ModuleRecord {
  return {
    k: "module",
    mod: name,
    file,
    line: 1,
    behaviours: [],
    protocol: false,
    impl: false,
    partition: "prod",
  };
}

function fn(owner: string, name: string, arity: number, file: string): FunctionRecord {
  return { k: "function", mod: owner, name, arity, file, line: 2, partition: "prod" };
}

function event(
  fromMod: string,
  fromFun: string | undefined,
  toMod: string,
  name: string,
  arity: number,
  file: string,
  line: number,
  dyn = false,
): TraceEvent {
  return {
    k: "event",
    kind: "remote",
    file,
    line,
    from_mod: fromMod,
    ...(fromFun === undefined ? {} : { from_fun: fromFun }),
    to_mod: toMod,
    name,
    arity,
    dyn,
    partition: "prod",
  };
}

function generatedTrace(
  options: {
    readonly dependency?: boolean;
    readonly nestedModule?: string;
    readonly projectOwnsPhoenix?: boolean;
    readonly duplicateWitness?: boolean;
  } = {},
): TraceResult {
  const nestedModule = options.nestedModule ?? "Phoenix.Controller";
  const nestedUse = event(
    "NeutralGenerated.Controller",
    undefined,
    nestedModule,
    "__using__",
    1,
    controllerFile,
    2,
  );
  return {
    appMod: "NeutralGenerated.Application",
    deps: options.dependency === false ? [] : ["phoenix"],
    compileOk: true,
    testPartition: "complete",
    modules: [
      mod("NeutralGenerated.Application", "application.ex"),
      mod("NeutralGenerated.Web", "web.ex"),
      mod("NeutralGenerated.Controller", controllerFile),
      ...(options.projectOwnsPhoenix ? [mod("Phoenix.Controller", "project_phoenix.ex")] : []),
    ],
    functions: [
      fn("NeutralGenerated.Application", "start", 2, "application.ex"),
      fn("NeutralGenerated.Web", "controller", 0, "web.ex"),
      fn("NeutralGenerated.Controller", "kind", 0, controllerFile),
      fn("NeutralGenerated.Controller", "action", 2, controllerFile),
      fn("NeutralGenerated.Controller", "show", 2, controllerFile),
      fn("NeutralGenerated.Controller", "maybe_action", 2, controllerFile),
      fn("NeutralGenerated.Controller", "one_arg_unused", 1, controllerFile),
    ],
    events: [
      {
        ...event("NeutralGenerated.Web", undefined, "Kernel", "defmacro", 2, "web.ex", 2),
        kind: "imported",
      },
      {
        ...event("NeutralGenerated.Web", "__using__/1", "Kernel", "apply", 3, "web.ex", 3, true),
        kind: "imported",
      },
      event(
        "NeutralGenerated.Application",
        "start/2",
        "NeutralGenerated.Controller",
        "kind",
        0,
        "application.ex",
        2,
      ),
      event(
        "NeutralGenerated.Controller",
        undefined,
        "NeutralGenerated.Web",
        "__using__",
        1,
        controllerFile,
        2,
      ),
      nestedUse,
      ...(options.duplicateWitness ? [{ ...nestedUse }] : []),
      event(
        "NeutralGenerated.Controller",
        "action/2",
        "Kernel",
        "apply",
        3,
        controllerFile,
        2,
        true,
      ),
    ],
  };
}

describe("Phoenix.Controller generated action convention", () => {
  it("activates a carrier edge and bounds only owner-module arity-two actions", () => {
    const trace = generatedTrace();
    const conventions = extractElixirRuntimeConventions(root, trace);
    expect(conventions.references).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          convention: "use-helper",
          toMod: "NeutralGenerated.Web",
          toName: "controller",
        }),
        expect.objectContaining({
          convention: "dynamic-apply",
          fromMod: "NeutralGenerated.Controller",
          toMod: "NeutralGenerated.Controller",
          toName: "action",
          toArity: 2,
        }),
      ]),
    );
    expect(conventions.dynamicDispatches.map((dispatch) => dispatch.kind)).toEqual([
      "exact",
      "bounded",
    ]);
    expect(
      conventions.dynamicDispatches[1]?.targets.map(
        (target) => `${target.mod}.${target.name}/${target.arity}`,
      ),
    ).toEqual(["NeutralGenerated.Controller.show/2", "NeutralGenerated.Controller.maybe_action/2"]);

    const graph = emitElixirIR({
      traceResult: trace,
      configReferencedModules: new Set(),
      runtimeReferences: conventions.references,
      dynamicDispatches: conventions.dynamicDispatches,
    });
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
    const hazardEvaluation = evaluateHazards({ graph, reachability });

    expect(
      whyAlive({ graph, reachability, claims, query: "NeutralGenerated.Web.controller/0" }),
    ).toMatchObject({ outcome: "alive" });
    const actionCarrier = whyAlive({
      graph,
      reachability,
      claims,
      query: "NeutralGenerated.Controller.action/2",
    });
    expect(actionCarrier).toMatchObject({ outcome: "alive" });
    if (actionCarrier.outcome !== "alive") throw new Error("expected generated action carrier");
    expect(
      computeDeletionPlan({ graph, reachability, subject: actionCarrier.subject }),
    ).toMatchObject({ supported: false });

    for (const name of ["show", "maybe_action"]) {
      const why = whyAlive({
        graph,
        reachability,
        claims,
        query: `NeutralGenerated.Controller.${name}/2`,
        hazardEvaluations: [hazardEvaluation],
      });
      expect(why).toMatchObject({ outcome: "dead", confidence: "medium" });
      if (why.outcome !== "dead") throw new Error("expected bounded action candidate");
      expect(
        computeDeletionPlan({
          graph,
          reachability,
          subject: why.subject,
          hazardEvaluations: [hazardEvaluation],
        }),
      ).toMatchObject({ supported: false });
    }

    const unrelated = whyAlive({
      graph,
      reachability,
      claims,
      query: "NeutralGenerated.Controller.one_arg_unused/1",
      hazardEvaluations: [hazardEvaluation],
    });
    expect(unrelated).toMatchObject({ outcome: "dead", confidence: "high" });
    if (unrelated.outcome !== "dead") throw new Error("expected unrelated arity to be dead");
    expect(computeDeletionPlan({ graph, reachability, subject: unrelated.subject })).toMatchObject({
      supported: true,
    });
  });

  it.each([
    ["missing dependency", generatedTrace({ dependency: false })],
    ["project-owned Phoenix.Controller", generatedTrace({ projectOwnsPhoenix: true })],
    ["custom lookalike", generatedTrace({ nestedModule: "NeutralGenerated.CustomController" })],
    ["duplicate framework witness", generatedTrace({ duplicateWitness: true })],
  ])("keeps %s generated applies opaque", (_label, trace) => {
    const conventions = extractElixirRuntimeConventions(root, trace);
    expect(
      conventions.references.filter(
        (reference) => reference.convention === "dynamic-apply" && reference.toName === "action",
      ),
    ).toEqual([]);
    expect(conventions.dynamicDispatches.at(-1)).toMatchObject({ kind: "opaque", targets: [] });
  });

  it("keeps an unsupported same-site source apply override opaque", () => {
    const conventions = extractElixirRuntimeConventions(sourceApplyRoot, generatedTrace());
    expect(
      conventions.references.filter(
        (reference) => reference.convention === "dynamic-apply" && reference.toName === "action",
      ),
    ).toEqual([]);
    expect(conventions.dynamicDispatches.at(-1)).toMatchObject({ kind: "opaque", targets: [] });
  });
});
