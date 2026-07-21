import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { FunctionRecord, ModuleRecord, TraceResult } from "./events.js";
import { extractElixirRuntimeReferences } from "./runtime-references.js";

const fixture = (name: string): string =>
  fileURLToPath(new URL(`../../../../../fixtures/elixir/${name}`, import.meta.url));

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
      modules: [
        mod("NeutralUse.Web", "lib/neutral_use/web.ex"),
        mod("NeutralUse.Router", "lib/neutral_use/router.ex"),
      ],
      functions: [
        fn("NeutralUse.Web", "router", 0, "lib/neutral_use/web.ex"),
        fn("NeutralUse.Web", "controller", 0, "lib/neutral_use/web.ex"),
      ],
      events: [],
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
});
