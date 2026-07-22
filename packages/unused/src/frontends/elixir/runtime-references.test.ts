import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { FunctionRecord, ModuleRecord, TraceEvent, TraceResult } from "./events.js";
import {
  dynamicEventKey,
  extractElixirRuntimeConventions,
  extractElixirRuntimeReferences,
} from "./runtime-references.js";

const fixture = (name: string): string =>
  fileURLToPath(new URL(`../../../../../fixtures/elixir/${name}`, import.meta.url));
const testFixture = (name: string): string =>
  fileURLToPath(new URL(`./__testfixtures__/${name}`, import.meta.url));

function mod(mod: string, file: string): ModuleRecord {
  return {
    k: "module",
    mod,
    file,
    line: 1,
    behaviours: [],
    protocol: false,
    impl: false,
    partition: "prod",
  };
}

function fn(modName: string, name: string, arity: number, file: string): FunctionRecord {
  return { k: "function", mod: modName, name, arity, file, line: 2, partition: "prod" };
}

describe("extractElixirRuntimeReferences", () => {
  it("resolves a literal MFA name across every known arity when runtime adds arguments", () => {
    const trace: TraceResult = {
      appMod: "NeutralMfa.Application",
      deps: [],
      compileOk: true,
      testPartition: "complete",
      modules: [
        mod("NeutralMfa.RuntimeConfig", "lib/neutral_mfa/runtime_config.ex"),
        mod("NeutralMfa.Callback", "lib/neutral_mfa/callback.ex"),
      ],
      functions: [
        fn("NeutralMfa.RuntimeConfig", "callback", 0, "lib/neutral_mfa/runtime_config.ex"),
        fn("NeutralMfa.Callback", "callback_name", 0, "lib/neutral_mfa/callback.ex"),
        fn("NeutralMfa.Callback", "callback_name", 1, "lib/neutral_mfa/callback.ex"),
        fn("NeutralMfa.Callback", "genuinely_unused", 0, "lib/neutral_mfa/callback.ex"),
      ],
      events: [
        {
          k: "event",
          kind: "alias",
          file: "lib/neutral_mfa/runtime_config.ex",
          line: 4,
          from_mod: "NeutralMfa.RuntimeConfig",
          from_fun: "callback/0",
          to_mod: "NeutralMfa.Callback",
          dyn: false,
          partition: "prod",
        },
      ],
    };

    const references = extractElixirRuntimeReferences(fixture("runtime-mfa-callback"), trace);
    expect(references.map((reference) => `${reference.toName}/${reference.toArity}`)).toEqual([
      "callback_name/0",
      "callback_name/1",
    ]);
    expect(references.every((reference) => reference.fromFun === "callback/0")).toBe(true);
  });

  it("resolves only a literal selected helper in a conventional self-apply dispatcher", () => {
    const trace: TraceResult = {
      appMod: "NeutralUse.Application",
      deps: [],
      compileOk: true,
      testPartition: "complete",
      modules: [
        mod("NeutralUse.Web", "lib/neutral_use/web.ex"),
        mod("NeutralUse.Router", "lib/neutral_use/router.ex"),
      ],
      functions: [
        fn("NeutralUse.Web", "router", 0, "lib/neutral_use/web.ex"),
        fn("NeutralUse.Web", "controller", 0, "lib/neutral_use/web.ex"),
      ],
      events: [
        {
          k: "event",
          kind: "imported",
          file: "lib/neutral_use/web.ex",
          line: 4,
          from_mod: "NeutralUse.Web",
          to_mod: "Kernel",
          name: "defmacro",
          arity: 2,
          dyn: false,
          partition: "prod",
        },
        {
          k: "event",
          kind: "imported",
          file: "lib/neutral_use/web.ex",
          line: 5,
          from_mod: "NeutralUse.Web",
          from_fun: "__using__/1",
          to_mod: "Kernel",
          name: "apply",
          arity: 3,
          dyn: true,
          partition: "prod",
        },
        {
          k: "event",
          kind: "remote",
          file: "lib/neutral_use/router.ex",
          line: 2,
          from_mod: "NeutralUse.Router",
          to_mod: "NeutralUse.Web",
          name: "__using__",
          arity: 1,
          dyn: false,
          partition: "prod",
        },
      ],
    };

    expect(extractElixirRuntimeReferences(fixture("dynamic-use-helpers"), trace)).toEqual([
      {
        fromMod: "NeutralUse.Router",
        toMod: "NeutralUse.Web",
        toName: "router",
        toArity: 0,
        file: "lib/neutral_use/router.ex",
        line: 2,
        convention: "use-helper",
      },
    ]);
  });

  it("bounds a known-module apply and resolves a literal apply as an exact edge", () => {
    const trace: TraceResult = {
      appMod: "Dyn.Application",
      deps: [],
      compileOk: true,
      testPartition: "complete",
      modules: [
        mod("Dyn.Router", "lib/dyn/router.ex"),
        mod("Dyn.Handlers", "lib/dyn/handlers.ex"),
        mod("Dyn.Unrelated", "lib/dyn/unrelated.ex"),
      ],
      functions: [
        fn("Dyn.Router", "dispatch", 1, "lib/dyn/router.ex"),
        fn("Dyn.Router", "exact", 0, "lib/dyn/router.ex"),
        fn("Dyn.Handlers", "ping", 0, "lib/dyn/handlers.ex"),
        fn("Dyn.Handlers", "dead_handler", 0, "lib/dyn/handlers.ex"),
        fn("Dyn.Unrelated", "dead", 0, "lib/dyn/unrelated.ex"),
      ],
      events: [dynamicApplyEvent("dispatch/1", 4), dynamicApplyEvent("exact/0", 5)],
    };

    const extraction = extractElixirRuntimeConventions(fixture("dynamic-dispatch"), trace);
    expect(extraction.dynamicDispatches.map((dispatch) => dispatch.kind)).toEqual([
      "bounded",
      "exact",
    ]);
    expect(
      extraction.dynamicDispatches[0]?.targets.map((target) => `${target.mod}.${target.name}/0`),
    ).toEqual(["Dyn.Handlers.ping/0", "Dyn.Handlers.dead_handler/0"]);
    expect(
      extraction.dynamicDispatches[0]?.targets.some((target) => target.mod === "Dyn.Unrelated"),
    ).toBe(false);
    expect(extraction.references).toContainEqual(
      expect.objectContaining({
        fromMod: "Dyn.Router",
        fromFun: "exact/0",
        toMod: "Dyn.Handlers",
        toName: "ping",
        toArity: 0,
        convention: "dynamic-apply",
      }),
    );
  });

  it("retains an opaque fallback when source arguments cannot bound the tracer event", () => {
    const trace: TraceResult = {
      appMod: "Dyn.Application",
      deps: [],
      compileOk: true,
      testPartition: "complete",
      modules: [mod("Dyn.Router", "lib/dyn/router.ex")],
      functions: [fn("Dyn.Router", "dispatch", 1, "lib/dyn/router.ex")],
      events: [
        {
          ...dynamicApplyEvent("dispatch/1", 4),
          to_mod: "Module",
          name: "concat",
          arity: 2,
        },
      ],
    };

    expect(
      extractElixirRuntimeConventions(fixture("dynamic-dispatch"), trace).dynamicDispatches,
    ).toEqual([expect.objectContaining({ kind: "opaque", targets: [] })]);
  });

  it("keeps duplicate same-line use events conservative", () => {
    const useEvent: TraceEvent = {
      k: "event",
      kind: "remote",
      file: "lib/neutral_use/router.ex",
      line: 2,
      from_mod: "NeutralUse.Router",
      to_mod: "NeutralUse.Web",
      name: "__using__",
      arity: 1,
      dyn: false,
      partition: "prod",
    };
    const trace: TraceResult = {
      appMod: "NeutralUse.Application",
      deps: [],
      compileOk: true,
      testPartition: "complete",
      modules: [
        mod("NeutralUse.Web", "lib/neutral_use/web.ex"),
        mod("NeutralUse.Router", "lib/neutral_use/router.ex"),
      ],
      functions: [
        fn("NeutralUse.Web", "router", 0, "lib/neutral_use/web.ex"),
        fn("NeutralUse.Web", "unused", 0, "lib/neutral_use/web.ex"),
      ],
      events: [
        {
          k: "event",
          kind: "imported",
          file: "lib/neutral_use/web.ex",
          line: 4,
          from_mod: "NeutralUse.Web",
          to_mod: "Kernel",
          name: "defmacro",
          arity: 2,
          dyn: false,
          partition: "prod",
        },
        {
          k: "event",
          kind: "imported",
          file: "lib/neutral_use/web.ex",
          line: 5,
          from_mod: "NeutralUse.Web",
          from_fun: "__using__/1",
          to_mod: "Kernel",
          name: "apply",
          arity: 3,
          dyn: true,
          partition: "prod",
        },
        useEvent,
        { ...useEvent },
      ],
    };

    const extraction = extractElixirRuntimeConventions(fixture("dynamic-use-helpers"), trace);
    expect(extraction.references).toEqual([]);
    expect(extraction.dynamicDispatches).toEqual([expect.objectContaining({ kind: "bounded" })]);
  });

  it("includes the trace partition in dynamic event identity", () => {
    const production = dynamicApplyEvent("dispatch/1", 4);
    expect(dynamicEventKey(production)).not.toBe(
      dynamicEventKey({ ...production, partition: "test" }),
    );
  });

  it("requires a self-apply selector signature on the exact module carrier", () => {
    const file = "dispatchers.ex";
    const trace: TraceResult = {
      appMod: null,
      deps: [],
      compileOk: true,
      testPartition: "complete",
      modules: [
        mod("NeutralRole.SignatureOnly", file),
        mod("NeutralRole.Misdirected", file),
        mod("NeutralRole.Consumer", "consumer.ex"),
      ],
      functions: [
        fn("NeutralRole.Misdirected", "router", 0, file),
        fn("NeutralRole.Misdirected", "controller", 0, file),
      ],
      events: [
        definitionEvent(file, 2, "NeutralRole.SignatureOnly"),
        definitionEvent(file, 8, "NeutralRole.Misdirected"),
        {
          k: "event",
          kind: "imported",
          file,
          line: 11,
          from_mod: "NeutralRole.Misdirected",
          from_fun: "__using__/1",
          to_mod: "Kernel",
          name: "apply",
          arity: 3,
          dyn: true,
          partition: "prod",
        },
        {
          k: "event",
          kind: "remote",
          file: "consumer.ex",
          line: 2,
          from_mod: "NeutralRole.Consumer",
          to_mod: "NeutralRole.Misdirected",
          name: "__using__",
          arity: 1,
          dyn: false,
          partition: "prod",
        },
      ],
    };

    const extraction = extractElixirRuntimeConventions(testFixture("dynamic-role-carriers"), trace);
    expect(extraction.references).toEqual([]);
    expect(extraction.dynamicDispatches).toEqual([expect.objectContaining({ kind: "bounded" })]);
  });

  it("keeps same-line alias resolution isolated by function carrier", () => {
    const file = "alias_collision.ex";
    const trace: TraceResult = {
      appMod: null,
      deps: [],
      compileOk: true,
      testPartition: "complete",
      modules: [mod("NeutralAlias.Dispatch", file), mod("NeutralAlias.Target", file)],
      functions: [
        fn("NeutralAlias.Dispatch", "a", 0, file),
        fn("NeutralAlias.Dispatch", "b", 0, file),
        fn("NeutralAlias.Target", "run", 0, file),
      ],
      events: [
        {
          ...dynamicApplyEvent("a/0", 2),
          file,
          from_mod: "NeutralAlias.Dispatch",
        },
        aliasEvent(file, 2, "a/0", "ExternalAlias"),
        aliasEvent(file, 2, "b/0", "NeutralAlias.Target"),
      ],
    };

    const extraction = extractElixirRuntimeConventions(testFixture("dynamic-role-carriers"), trace);
    expect(extraction.references).toEqual([]);
    expect(extraction.dynamicDispatches).toEqual([
      expect.objectContaining({
        kind: "bounded",
        targets: [expect.objectContaining({ mod: "NeutralAlias.Target", name: "run" })],
      }),
    ]);
  });
});

function definitionEvent(file: string, line: number, fromMod: string): TraceEvent {
  return {
    k: "event",
    kind: "imported",
    file,
    line,
    from_mod: fromMod,
    to_mod: "Kernel",
    name: "defmacro",
    arity: 2,
    dyn: false,
    partition: "prod",
  };
}

function aliasEvent(file: string, line: number, fromFun: string, toMod: string): TraceEvent {
  return {
    k: "event",
    kind: "alias",
    file,
    line,
    from_mod: "NeutralAlias.Dispatch",
    from_fun: fromFun,
    to_mod: toMod,
    dyn: false,
    partition: "prod",
  };
}

function dynamicApplyEvent(fromFun: string, line: number): TraceEvent {
  return {
    k: "event",
    kind: "remote",
    file: "lib/dyn/router.ex",
    line,
    from_mod: "Dyn.Router",
    from_fun: fromFun,
    to_mod: "Kernel",
    name: "apply",
    arity: 3,
    dyn: true,
    partition: "prod",
  };
}
