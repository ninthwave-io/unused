import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

  it("recovers list arity only for unambiguous proper lists and enforces source cardinality", () => {
    const root = mkdtempSync(join(tmpdir(), "unused-apply-arity-"));
    const file = "apply_shapes.ex";
    const lines = [
      "defmodule NeutralApply.Shapes do",
      "  def empty, do: apply(__MODULE__, :target, [])",
      "  def whitespace, do: apply(__MODULE__, :target, [   ])",
      "  def commented, do: apply(__MODULE__, :target, [ # inert, text",
      "  ])",
      "  def nested(value, other, third), do: apply(__MODULE__, :target, [value, {:ok, other}, [third]])",
      "  def tail(head, rest), do: apply(__MODULE__, :target, [head | rest])",
      "  def bitstring, do: apply(__MODULE__, :target, [<<1, 2>>])",
      "  def anonymous(fun), do: apply(__MODULE__, :target, [fn a, b -> fun.(a, b) end])",
      "  def trailing(value), do: apply(__MODULE__, :target, [value,])",
      "  def collision(selected, value), do: (apply(__MODULE__, selected, [value]); apply(runtime_module(), :target, arguments(value)))",
      "  def target, do: :zero",
      "  def target(value), do: value",
      "  def target(a, b, c), do: {a, b, c}",
      "end",
    ];
    const lineOf = (needle: string): number => lines.findIndex((line) => line.includes(needle)) + 1;
    const applyEvent = (fromFun: string, needle: string): TraceEvent => ({
      ...dynamicApplyEvent(fromFun, lineOf(needle)),
      file,
      from_mod: "NeutralApply.Shapes",
    });
    const trace: TraceResult = {
      appMod: null,
      deps: [],
      compileOk: true,
      testPartition: "complete",
      modules: [mod("NeutralApply.Shapes", file)],
      functions: [
        fn("NeutralApply.Shapes", "target", 0, file),
        fn("NeutralApply.Shapes", "target", 1, file),
        fn("NeutralApply.Shapes", "target", 3, file),
      ],
      events: [
        applyEvent("empty/0", "def empty"),
        applyEvent("whitespace/0", "def whitespace"),
        applyEvent("commented/0", "def commented"),
        applyEvent("nested/3", "def nested"),
        applyEvent("tail/2", "def tail"),
        applyEvent("bitstring/0", "def bitstring"),
        applyEvent("anonymous/1", "def anonymous"),
        applyEvent("trailing/1", "def trailing"),
        applyEvent("collision/2", "def collision"),
      ],
    };

    try {
      writeFileSync(join(root, file), `${lines.join("\n")}\n`);
      const dispatches = extractElixirRuntimeConventions(root, trace).dynamicDispatches;
      expect(dispatches.map((dispatch) => dispatch.kind)).toEqual([
        "exact",
        "exact",
        "bounded",
        "exact",
        "bounded",
        "bounded",
        "bounded",
        "bounded",
        "opaque",
      ]);
      expect(dispatches[0]?.targets.map((target) => target.arity)).toEqual([0]);
      expect(dispatches[1]?.targets.map((target) => target.arity)).toEqual([0]);
      expect(dispatches[3]?.targets.map((target) => target.arity)).toEqual([3]);
      for (const index of [2, 4, 5, 6, 7]) {
        expect(dispatches[index]?.targets.map((target) => target.arity)).toEqual([0, 1, 3]);
      }
      expect(dispatches[8]?.targets).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("proves only guarded rescued assignments whose complete uses stay Enum map values", () => {
    const root = mkdtempSync(join(tmpdir(), "unused-atom-assignment-roles-"));
    const file = "assigned_atom_roles.ex";
    const lines = [
      "defmodule NeutralAssigned.Roles do",
      "  def safe(entries, raw) when is_binary(raw) do",
      "    kind = String.to_existing_atom(raw)",
      "    Enum.map(entries, fn entry -> %{entry: entry, kind: kind} end)",
      "  rescue",
      "    ArgumentError -> []",
      "  end",
      "  def negated(entries, raw) when not is_binary(raw) do",
      "    kind = String.to_existing_atom(raw)",
      "    Enum.map(entries, fn entry -> %{entry: entry, kind: kind} end)",
      "  rescue",
      "    ArgumentError -> []",
      "  end",
      "  def disjunctive(entries, raw) when is_binary(raw) or is_list(raw) do",
      "    kind = String.to_existing_atom(raw)",
      "    Enum.map(entries, fn entry -> %{entry: entry, kind: kind} end)",
      "  rescue",
      "    ArgumentError -> []",
      "  end",
      "  def rebound(entries, raw) when is_binary(raw) do",
      "    raw = runtime_value()",
      "    kind = String.to_existing_atom(raw)",
      "    Enum.map(entries, fn entry -> %{entry: entry, kind: kind} end)",
      "  rescue",
      "    ArgumentError -> []",
      "  end",
      "  def reassigned(entries, raw) when is_binary(raw) do",
      "    kind = String.to_existing_atom(raw)",
      "    _ = Enum.map(entries, fn entry -> %{entry: entry, kind: kind} end)",
      "    kind = :other",
      "  rescue",
      "    ArgumentError -> []",
      "  end",
      "  def same_line(entries, raw) when is_binary(raw) do",
      "    kind = String.to_existing_atom(raw); other = String.to_existing_atom(raw)",
      "    Enum.map(entries, fn entry -> %{entry: entry, kind: kind} end)",
      "  rescue",
      "    ArgumentError -> []",
      "  end",
      "  def no_guard(entries, raw) do",
      "    kind = String.to_existing_atom(raw)",
      "    Enum.map(entries, fn entry -> %{entry: entry, kind: kind} end)",
      "  rescue",
      "    ArgumentError -> []",
      "  end",
      "  def no_rescue(entries, raw) when is_binary(raw) do",
      "    kind = String.to_existing_atom(raw)",
      "    Enum.map(entries, fn entry -> %{entry: entry, kind: kind} end)",
      "  end",
      "  def mixed(entries, raw) when is_binary(raw) do",
      "    kind = String.to_existing_atom(raw)",
      "    _ = Enum.map(entries, fn entry -> %{entry: entry, kind: kind} end)",
      "    apply(__MODULE__, kind, [])",
      "  rescue",
      "    ArgumentError -> []",
      "  end",
      "  def map_key(entries, raw) when is_binary(raw) do",
      "    kind = String.to_existing_atom(raw)",
      "    Enum.map(entries, fn entry -> %{kind => entry} end)",
      "  rescue",
      "    ArgumentError -> []",
      "  end",
      "  def receiver(entries, raw) when is_binary(raw) do",
      "    kind = String.to_existing_atom(raw)",
      "    _ = Enum.map(entries, fn entry -> %{entry: entry, kind: kind} end)",
      "    kind.run()",
      "  rescue",
      "    ArgumentError -> []",
      "  end",
      "  def bang_receiver(entries, raw) when is_binary(raw) do",
      "    kind = String.to_existing_atom(raw)",
      "    _ = Enum.map(entries, fn entry -> %{entry: entry, kind: kind} end)",
      "    !kind.run()",
      "  rescue",
      "    ArgumentError -> []",
      "  end",
      "  def interpolation(entries, raw) when is_binary(raw) do",
      "    kind = String.to_existing_atom(raw)",
      "    _ = Enum.map(entries, fn entry -> %{entry: entry, kind: kind} end)",
      '    _ = "#{kind.run()}"',
      "  rescue",
      "    ArgumentError -> []",
      "  end",
      "  def capture(entries, raw) when is_binary(raw) do",
      "    kind = String.to_existing_atom(raw)",
      "    _ = Enum.map(entries, fn entry -> %{entry: entry, kind: kind} end)",
      "    Function.capture(kind, :run, 0)",
      "  rescue",
      "    ArgumentError -> []",
      "  end",
      "  def mfa(entries, raw) when is_binary(raw) do",
      "    kind = String.to_existing_atom(raw)",
      "    _ = Enum.map(entries, fn entry -> %{entry: entry, kind: kind} end)",
      "    {kind, :run, []}",
      "  rescue",
      "    ArgumentError -> []",
      "  end",
      "  def nested_try(entries, raw) when is_binary(raw) do",
      "    try do",
      "      kind = String.to_existing_atom(raw)",
      "      Enum.map(entries, fn entry -> %{entry: entry, kind: kind} end)",
      "  rescue",
      "      ArgumentError -> []",
      "    end",
      "  end",
      "  def macro_borrow(entries, raw) when is_binary(raw) do",
      "    kind = String.to_existing_atom(raw)",
      "    Enum.map(entries, fn entry -> %{entry: entry, kind: kind} end)",
      "    _metadata = %{fn: :data}",
      "  end",
      "  defmacro rescue_decoy do",
      "  rescue",
      "    ArgumentError -> []",
      "  end",
      "end",
    ];
    const lineOf = (needle: string, from = 0): number =>
      lines.findIndex((line, index) => index >= from && line.includes(needle)) + 1;
    const functionStart = (name: string): number => lineOf(`def ${name}`);
    const atomLine = (start: number): number => lineOf("String.to_existing_atom", start - 1);
    const mapLine = (start: number): number => lineOf("Enum.map", start - 1);
    const atomEvent = (fromFun: string, line: number): TraceEvent => ({
      k: "event",
      kind: "remote",
      file,
      line,
      from_mod: "NeutralAssigned.Roles",
      from_fun: fromFun,
      to_mod: "String",
      name: "to_existing_atom",
      arity: 1,
      dyn: true,
      partition: "prod",
    });
    const compilerEvent = (
      fromFun: string,
      line: number,
      toMod: string,
      name: string,
      arity: number,
    ): TraceEvent => ({
      k: "event",
      kind: "remote",
      file,
      line,
      from_mod: "NeutralAssigned.Roles",
      from_fun: fromFun,
      to_mod: toMod,
      name,
      arity,
      dyn: false,
      partition: "prod",
    });
    const starts = {
      safe: functionStart("safe"),
      noGuard: functionStart("no_guard"),
      noRescue: functionStart("no_rescue"),
      mixed: functionStart("mixed"),
      mapKey: functionStart("map_key"),
      nestedTry: functionStart("nested_try"),
      negated: functionStart("negated"),
      disjunctive: functionStart("disjunctive"),
      rebound: functionStart("rebound"),
      reassigned: functionStart("reassigned"),
      sameLine: functionStart("same_line"),
      receiver: functionStart("receiver"),
      bangReceiver: functionStart("bang_receiver"),
      interpolation: functionStart("interpolation"),
      capture: functionStart("capture"),
      mfa: functionStart("mfa"),
      macroBorrow: functionStart("macro_borrow"),
    };
    const events: TraceEvent[] = [];
    const addRoleEvents = (fromFun: string, start: number, guarded: boolean): void => {
      events.push(atomEvent(fromFun, atomLine(start)));
      if (guarded) events.push(compilerEvent(fromFun, start, "Kernel", "is_binary", 1));
      events.push(compilerEvent(fromFun, mapLine(start), "Enum", "map", 2));
    };
    addRoleEvents("safe/2", starts.safe, true);
    addRoleEvents("negated/2", starts.negated, true);
    addRoleEvents("disjunctive/2", starts.disjunctive, true);
    addRoleEvents("rebound/2", starts.rebound, true);
    addRoleEvents("reassigned/2", starts.reassigned, true);
    addRoleEvents("same_line/2", starts.sameLine, true);
    addRoleEvents("no_guard/2", starts.noGuard, false);
    addRoleEvents("no_rescue/2", starts.noRescue, true);
    addRoleEvents("mixed/2", starts.mixed, true);
    addRoleEvents("map_key/2", starts.mapKey, true);
    addRoleEvents("receiver/2", starts.receiver, true);
    addRoleEvents("bang_receiver/2", starts.bangReceiver, true);
    addRoleEvents("interpolation/2", starts.interpolation, true);
    addRoleEvents("capture/2", starts.capture, true);
    addRoleEvents("mfa/2", starts.mfa, true);
    addRoleEvents("nested_try/2", starts.nestedTry, true);
    addRoleEvents("macro_borrow/2", starts.macroBorrow, true);
    const trace: TraceResult = {
      appMod: null,
      deps: [],
      compileOk: true,
      testPartition: "complete",
      modules: [mod("NeutralAssigned.Roles", file)],
      functions: [],
      events,
    };

    try {
      writeFileSync(join(root, file), `${lines.join("\n")}\n`);
      expect(
        extractElixirRuntimeConventions(root, trace).dynamicDispatches.map((dispatch) => ({
          fromFun: dispatch.fromFun,
          kind: dispatch.kind,
        })),
      ).toEqual([
        { fromFun: "safe/2", kind: "exact" },
        { fromFun: "negated/2", kind: "opaque" },
        { fromFun: "disjunctive/2", kind: "opaque" },
        { fromFun: "rebound/2", kind: "opaque" },
        { fromFun: "reassigned/2", kind: "opaque" },
        { fromFun: "same_line/2", kind: "opaque" },
        { fromFun: "no_guard/2", kind: "opaque" },
        { fromFun: "no_rescue/2", kind: "opaque" },
        { fromFun: "mixed/2", kind: "opaque" },
        { fromFun: "map_key/2", kind: "opaque" },
        { fromFun: "receiver/2", kind: "opaque" },
        { fromFun: "bang_receiver/2", kind: "opaque" },
        { fromFun: "interpolation/2", kind: "opaque" },
        { fromFun: "capture/2", kind: "opaque" },
        { fromFun: "mfa/2", kind: "opaque" },
        { fromFun: "nested_try/2", kind: "opaque" },
        { fromFun: "macro_borrow/2", kind: "opaque" },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
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

  it("prefers a carrier-confirmed alias when its token shadows a project module", () => {
    const file = "alias_collision.ex";
    const trace: TraceResult = {
      appMod: null,
      deps: [],
      compileOk: true,
      testPartition: "complete",
      modules: [
        mod("Direct", file),
        mod("NeutralAlias.Other", file),
        mod("NeutralAlias.ShadowDispatch", file),
      ],
      functions: [
        fn("Direct", "run", 0, file),
        fn("NeutralAlias.Other", "run", 0, file),
        fn("NeutralAlias.ShadowDispatch", "execute", 0, file),
      ],
      events: [
        {
          ...dynamicApplyEvent("execute/0", 18),
          file,
          from_mod: "NeutralAlias.ShadowDispatch",
        },
        {
          ...aliasEvent(file, 18, "execute/0", "NeutralAlias.Other"),
          from_mod: "NeutralAlias.ShadowDispatch",
        },
      ],
    };

    const extraction = extractElixirRuntimeConventions(testFixture("dynamic-role-carriers"), trace);
    expect(extraction.references).toContainEqual(
      expect.objectContaining({
        toMod: "NeutralAlias.Other",
        toName: "run",
        toArity: 0,
        convention: "dynamic-apply",
      }),
    );
    expect(extraction.references).not.toContainEqual(
      expect.objectContaining({ toMod: "Direct", toName: "run" }),
    );
    expect(extraction.dynamicDispatches).toEqual([expect.objectContaining({ kind: "exact" })]);
  });

  it("does not fall back to a project module when a compiler alias targets externally", () => {
    const file = "alias_collision.ex";
    const trace: TraceResult = {
      appMod: null,
      deps: [],
      compileOk: true,
      testPartition: "complete",
      modules: [mod("Direct", file), mod("NeutralAlias.ShadowDispatch", file)],
      functions: [
        fn("Direct", "run", 0, file),
        fn("NeutralAlias.ShadowDispatch", "external_execute", 0, file),
      ],
      events: [
        {
          ...dynamicApplyEvent("external_execute/0", 19),
          file,
          from_mod: "NeutralAlias.ShadowDispatch",
        },
        {
          ...aliasEvent(file, 19, "external_execute/0", "External.Library"),
          from_mod: "NeutralAlias.ShadowDispatch",
        },
      ],
    };

    const extraction = extractElixirRuntimeConventions(testFixture("dynamic-role-carriers"), trace);
    expect(extraction.references).toEqual([]);
    expect(extraction.dynamicDispatches).toEqual([
      expect.objectContaining({
        kind: "bounded",
        targets: [expect.objectContaining({ mod: "Direct", name: "run" })],
      }),
    ]);
  });

  it("indexes deeply nested recognized apply sites near-linearly", () => {
    const root = mkdtempSync(join(tmpdir(), "unused-nested-apply-scaling-"));
    const file = "nested_applies.ex";
    const trace: TraceResult = {
      appMod: null,
      deps: [],
      compileOk: true,
      testPartition: "complete",
      modules: [mod("NeutralScale.NestedApplies", file)],
      functions: [],
      events: [],
    };
    const measure = (depth: number): number => {
      const expression = [
        "apply(__MODULE__, :target, [".repeat(depth),
        ":value",
        "])".repeat(depth),
      ].join("");
      writeFileSync(
        join(root, file),
        `defmodule NeutralScale.NestedApplies do\n  def run, do: ${expression}\nend\n`,
      );
      const started = performance.now();
      extractElixirRuntimeConventions(root, trace);
      return performance.now() - started;
    };
    const median = (values: readonly number[]): number =>
      [...values].sort((left, right) => left - right)[Math.floor(values.length / 2)] ?? 0;

    try {
      measure(100);
      const small = median([measure(500), measure(500), measure(500)]);
      const large = median([measure(2_000), measure(2_000), measure(2_000)]);
      expect(large).toBeLessThan(small * 8 + 30);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 10_000);

  it("indexes repeated assigned-atom data roles near-linearly", () => {
    const root = mkdtempSync(join(tmpdir(), "unused-assigned-atom-scaling-"));
    const file = "many_assigned_atoms.ex";
    const trace: TraceResult = {
      appMod: null,
      deps: [],
      compileOk: true,
      testPartition: "complete",
      modules: [mod("NeutralScale.AssignedAtoms", file)],
      functions: [],
      events: [],
    };
    const measure = (count: number): number => {
      const functions = Array.from({ length: count }, (_, index) =>
        [
          `  def normalize_${index}(entries, raw_${index}) when is_binary(raw_${index}) do\n`,
          `    kind = String.to_existing_atom(raw_${index})\n`,
          "    Enum.map(entries, fn entry -> %{entry: entry, kind: kind} end)\n",
          "  rescue\n",
          "    ArgumentError -> []\n",
          "  end\n",
        ].join(""),
      ).join("");
      writeFileSync(
        join(root, file),
        ["defmodule NeutralScale.AssignedAtoms do\n", functions, "end\n"].join(""),
      );
      const started = performance.now();
      extractElixirRuntimeConventions(root, trace);
      return performance.now() - started;
    };
    const median = (values: readonly number[]): number =>
      [...values].sort((left, right) => left - right)[Math.floor(values.length / 2)] ?? 0;

    try {
      measure(50);
      const small = median([measure(250), measure(250), measure(250)]);
      const large = median([measure(1_000), measure(1_000), measure(1_000)]);
      expect(large).toBeLessThan(small * 8 + 30);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 10_000);

  it("indexes many assigned-atom fields in one Enum map near-linearly", () => {
    const root = mkdtempSync(join(tmpdir(), "unused-assigned-atom-fields-scaling-"));
    const file = "many_atom_fields.ex";
    const trace: TraceResult = {
      appMod: null,
      deps: [],
      compileOk: true,
      testPartition: "complete",
      modules: [mod("NeutralScale.AtomFields", file)],
      functions: [],
      events: [],
    };
    const measure = (count: number): number => {
      const fields = Array.from({ length: count }, (_, index) => `field_${index}: kind`).join(", ");
      writeFileSync(
        join(root, file),
        [
          "defmodule NeutralScale.AtomFields do\n",
          "  def normalize(entries, raw) when is_binary(raw) do\n",
          "    kind = String.to_existing_atom(raw)\n",
          `    Enum.map(entries, fn _entry -> %{${fields}} end)\n`,
          "  rescue\n",
          "    ArgumentError -> []\n",
          "  end\n",
          "end\n",
        ].join(""),
      );
      const started = performance.now();
      extractElixirRuntimeConventions(root, trace);
      return performance.now() - started;
    };
    const median = (values: readonly number[]): number =>
      [...values].sort((left, right) => left - right)[Math.floor(values.length / 2)] ?? 0;

    try {
      measure(50);
      const small = median([measure(250), measure(250), measure(250)]);
      const large = median([measure(1_000), measure(1_000), measure(1_000)]);
      expect(large).toBeLessThan(small * 8 + 30);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 10_000);

  it("indexes adversarial Enum.map sites and tuple producers near-linearly", () => {
    const root = mkdtempSync(join(tmpdir(), "unused-enum-map-scaling-"));
    const file = "many_maps.ex";
    const trace: TraceResult = {
      appMod: null,
      deps: [],
      compileOk: true,
      testPartition: "complete",
      modules: [mod("NeutralScale.ManyMaps", file)],
      functions: [],
      events: [],
    };
    const measure = (count: number): number => {
      const functions = Array.from(
        { length: count },
        (_, index) => `  def map_${index}(data), do: Enum.map(data, fn value -> value end)\n`,
      ).join("");
      writeFileSync(
        join(root, file),
        ["defmodule NeutralScale.ManyMaps do\n", functions, "end\n"].join(""),
      );
      const started = performance.now();
      extractElixirRuntimeConventions(root, trace);
      return performance.now() - started;
    };
    const measureSequenced = (count: number): number => {
      const tuples = Array.from(
        { length: count },
        (_, index) => `{String.to_atom(key_${index}), value}`,
      ).join("; ");
      writeFileSync(
        join(root, file),
        [
          "defmodule NeutralScale.ManyMaps do\n",
          `  def rebuild(data), do: data |> Enum.map(fn {key, value} -> ${tuples}; {key, value} end) |> Enum.into(%{})\n`,
          "end\n",
        ].join(""),
      );
      const started = performance.now();
      extractElixirRuntimeConventions(root, trace);
      return performance.now() - started;
    };
    const median = (values: readonly number[]): number =>
      [...values].sort((left, right) => left - right)[Math.floor(values.length / 2)] ?? 0;

    try {
      measure(100);
      const small = median([measure(4_000), measure(4_000), measure(4_000)]);
      const large = median([measure(16_000), measure(16_000), measure(16_000)]);
      expect(large).toBeLessThan(small * 8 + 20);
      const tupleSmall = median([
        measureSequenced(4_000),
        measureSequenced(4_000),
        measureSequenced(4_000),
      ]);
      const tupleLarge = median([
        measureSequenced(16_000),
        measureSequenced(16_000),
        measureSequenced(16_000),
      ]);
      expect(tupleLarge).toBeLessThan(tupleSmall * 8 + 20);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 10_000);
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
