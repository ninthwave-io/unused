import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ectoElixirAtomRoleSummaryProvider } from "../plugins/elixir-conventions.js";
import type { FunctionRecord, ModuleRecord, TraceEvent, TraceResult } from "./events.js";
import {
  dynamicEventKey,
  extractElixirRuntimeConventions,
  extractElixirRuntimeReferences,
} from "./runtime-references.js";
import { mergeTraceResults, validateTestTraceOwnership } from "./trace-merge.js";

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
      extraction.dynamicDispatches.map((dispatch) => ({
        factKind: dispatch.factKind,
        world: dispatch.world,
      })),
    ).toEqual([
      { factKind: "dynamic-invocation", world: "production" },
      { factKind: "dynamic-invocation", world: "production" },
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

  it("separates computed-atom escape from direct invocation roles", () => {
    const root = mkdtempSync(join(tmpdir(), "unused-computed-atom-facts-"));
    const file = "computed_atom_facts.ex";
    const lines = [
      "defmodule NeutralFacts.Dispatch do",
      "  def produce(name), do: String.to_atom(name)",
      "  def receive(name), do: String.to_atom(name).run()",
      "  def capture_module(name), do: Function.capture(String.to_atom(name), :run, 0)",
      "  def capture_function(name), do: Function.capture(NeutralFacts.Target, String.to_atom(name), 0)",
      "  def mfa_module(name), do: {String.to_atom(name), :run, []}",
      "  def mfa_function(name), do: {NeutralFacts.Target, String.to_atom(name), []}",
      "  def four_tuple(name), do: {String.to_atom(name), :run, [], :metadata}",
      "end",
    ];
    const atomEvent = (fromFun: string, line: number): TraceEvent => ({
      k: "event",
      kind: "remote",
      file,
      line,
      from_mod: "NeutralFacts.Dispatch",
      from_fun: fromFun,
      to_mod: "String",
      name: "to_atom",
      arity: 1,
      dyn: true,
      partition: "prod",
    });
    const trace: TraceResult = {
      appMod: null,
      deps: [],
      compileOk: true,
      testPartition: "complete",
      modules: [mod("NeutralFacts.Dispatch", file)],
      functions: [],
      events: [
        atomEvent("produce/1", 2),
        atomEvent("receive/1", 3),
        atomEvent("capture_module/1", 4),
        atomEvent("capture_function/1", 5),
        atomEvent("mfa_module/1", 6),
        atomEvent("mfa_function/1", 7),
        atomEvent("four_tuple/1", 8),
      ],
    };

    try {
      writeFileSync(join(root, file), `${lines.join("\n")}\n`);
      expect(
        extractElixirRuntimeConventions(root, trace).dynamicDispatches.map((fact) => ({
          fromFun: fact.fromFun,
          factKind: fact.factKind,
          flow: fact.factKind === "computed-atom" ? fact.flow : undefined,
          kind: fact.kind,
          world: fact.world,
        })),
      ).toEqual([
        {
          fromFun: "produce/1",
          factKind: "computed-atom",
          flow: "escape",
          kind: "opaque",
          world: "production",
        },
        {
          fromFun: "receive/1",
          factKind: "dynamic-invocation",
          flow: undefined,
          kind: "opaque",
          world: "production",
        },
        {
          fromFun: "capture_module/1",
          factKind: "dynamic-invocation",
          flow: undefined,
          kind: "opaque",
          world: "production",
        },
        {
          fromFun: "capture_function/1",
          factKind: "dynamic-invocation",
          flow: undefined,
          kind: "opaque",
          world: "production",
        },
        {
          fromFun: "mfa_module/1",
          factKind: "dynamic-invocation",
          flow: undefined,
          kind: "opaque",
          world: "production",
        },
        {
          fromFun: "mfa_function/1",
          factKind: "dynamic-invocation",
          flow: undefined,
          kind: "opaque",
          world: "production",
        },
        {
          fromFun: "four_tuple/1",
          factKind: "computed-atom",
          flow: "escape",
          kind: "opaque",
          world: "production",
        },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("classifies indexed local data, propagation, callback, and escape roles", () => {
    const root = mkdtempSync(join(tmpdir(), "unused-indexed-atom-roles-"));
    const file = "indexed_atom_roles.ex";
    const summaryProviders = [ectoElixirAtomRoleSummaryProvider];
    const lines = [
      "defmodule NeutralIndexed.Box do",
      "  defstruct [:kind]",
      "end",
      "defmodule NeutralIndexed.Roles do",
      "  alias Ecto.Type",
      "  alias Ecto.Changeset",
      "  import Ecto.Changeset, only: [get_change: 2]",
      "  def map_key(map, raw), do: Map.has_key?(map, String.to_atom(raw))",
      "  def keyword_pipe(options, raw), do: options |> Keyword.has_key?(String.to_atom(raw))",
      "  def member(set, raw), do: MapSet.member?(set, String.to_atom(raw))",
      "  def stringify(raw), do: Atom.to_string(String.to_atom(raw))",
      "  def allowlist(raw), do: String.to_atom(raw) in [:first, :second]",
      "  def assigned(map, raw) do",
      "    box = %{kind: String.to_atom(raw)}",
      "    Map.has_key?(box, :kind)",
      "  end",
      "  def with_assignment(map, raw) do",
      "    with kind = String.to_atom(raw) do",
      "      Map.has_key?(map, kind)",
      "    end",
      "  end",
      "  def assigned_list(raw) do",
      "    values = [String.to_atom(raw)]",
      "    Enum.member?(values, :known)",
      "  end",
      "  def assigned_keyword(raw) do",
      "    options = [kind: String.to_atom(raw)]",
      "    Keyword.has_key?(options, :kind)",
      "  end",
      "  def assigned_struct(raw) do",
      "    box = %NeutralIndexed.Box{kind: String.to_atom(raw)}",
      "    Map.has_key?(box, :kind)",
      "  end",
      "  def assigned_tuple(raw) do",
      "    box = {String.to_atom(raw), :known}",
      "    box",
      "  end",
      "  def returned_store(map, raw), do: Map.put(map, :kind, String.to_atom(raw))",
      "  def returned_replace(map, raw), do: Map.replace(map, String.to_atom(raw), :known)",
      "  def returned_keyword_replace(options, raw), do: Keyword.replace(options, String.to_atom(raw), :known)",
      "  def returned_tuple(raw), do: {:ok, String.to_atom(raw)}",
      "  def unknown(raw), do: NeutralIndexed.Unknown.keep(String.to_atom(raw))",
      "  def rebound(map, raw) do",
      "    kind = String.to_atom(raw)",
      "    kind = :known",
      "    Map.has_key?(map, kind)",
      "  end",
      "  def callback(values, raw) do",
      "    Map.new(values, fn key -> {key, String.to_atom(raw)} end)",
      "    |> Map.has_key?(:known)",
      "  end",
      "  def callback_multiclause(values, raw) do",
      "    Map.new(values, fn",
      "      :first -> {:first, String.to_atom(raw)}",
      "      _other -> {:other, :known}",
      "    end)",
      "    |> Map.has_key?(:known)",
      "  end",
      "  def callback_intermediate(values, raw) do",
      "    Map.new(values, fn _ -> String.to_atom(raw); {:known, :known} end)",
      "    |> Map.has_key?(:known)",
      "  end",
      "  def callback_argument(values, raw), do: Enum.map(values, String.to_atom(raw))",
      "  def lazy_map(raw), do: Map.get_lazy(%{}, :kind, fn -> String.to_atom(raw) end) |> Atom.to_string()",
      "  def lazy_keyword(raw), do: Keyword.get_lazy([], :kind, fn -> String.to_atom(raw) end) |> Atom.to_string()",
      "  def map_callback_input(raw), do: Map.update(%{kind: String.to_atom(raw)}, :kind, :known, fn selector -> {NeutralIndexed.Target, selector, []} end)",
      "  def keyword_callback_input(raw), do: [kind: String.to_atom(raw)] |> Keyword.update(:kind, :known, fn selector -> {NeutralIndexed.Target, selector, []} end)",
      "  def enum_callback_input(raw), do: Enum.map([String.to_atom(raw)], fn selector -> {NeutralIndexed.Target, selector, []} end)",
      "  def ambiguous_calls(map, raw) do",
      "    kind = String.to_atom(raw)",
      "    {Map.has_key?(map, kind), Map.has_key?(map, kind)}",
      "  end",
      "  def ecto_alias(raw), do: Type.equal?(:atom, String.to_atom(raw), :known)",
      "  def ecto_change(raw) do",
      "    Changeset.change(%{__struct__: String.to_atom(raw)})",
      "    |> Changeset.get_field(:known)",
      "    |> Atom.to_string()",
      "  end",
      "  def ecto_changeset(changeset, raw) do",
      "    Changeset.put_change(changeset, :kind, String.to_atom(raw))",
      "    |> Changeset.get_change(:kind)",
      "    |> Atom.to_string()",
      "  end",
      "  def ecto_imported(changeset, raw) do",
      "    changeset |> get_change(String.to_atom(raw)) |> Atom.to_string()",
      "  end",
      "  def ecto_selector(value, raw), do: Type.cast(String.to_atom(raw), value)",
      "end",
    ];
    const cases = [
      ["map_key/2", "def map_key", "data"],
      ["keyword_pipe/2", "def keyword_pipe", "data"],
      ["member/2", "def member", "data"],
      ["stringify/1", "def stringify", "data"],
      ["allowlist/1", "def allowlist", "data"],
      ["assigned/2", "box =", "data"],
      ["with_assignment/2", "with kind", "data"],
      ["assigned_list/1", "values = [String", "escape"],
      ["assigned_keyword/1", "options = [kind: String", "data"],
      ["assigned_struct/1", "%NeutralIndexed.Box{kind: String", "data"],
      ["assigned_tuple/1", "box = {String", "escape"],
      ["returned_store/2", "def returned_store", "escape"],
      ["returned_replace/2", "def returned_replace", "escape"],
      ["returned_keyword_replace/2", "def returned_keyword_replace", "escape"],
      ["returned_tuple/1", "def returned_tuple", "escape"],
      ["unknown/1", "def unknown", "escape"],
      ["rebound/2", "    kind = String.to_atom", "escape"],
      ["callback/2", "Map.new(values, fn key", "data"],
      ["callback_multiclause/2", ":first -> {:first, String", "data"],
      ["callback_intermediate/2", "Map.new(values, fn _ -> String", "escape"],
      ["callback_argument/2", "def callback_argument", "invocation"],
      ["lazy_map/1", "def lazy_map", "data"],
      ["lazy_keyword/1", "def lazy_keyword", "data"],
      ["map_callback_input/1", "def map_callback_input", "escape"],
      ["keyword_callback_input/1", "def keyword_callback_input", "escape"],
      ["enum_callback_input/1", "def enum_callback_input", "escape"],
      ["ambiguous_calls/2", "kind = String.to_atom", "escape"],
      ["ecto_alias/1", "def ecto_alias", "escape"],
      ["ecto_change/1", "Changeset.change(%{__struct__", "escape"],
      ["ecto_changeset/2", "Changeset.put_change", "escape"],
      ["ecto_imported/2", "get_change(String", "data"],
      ["ecto_selector/2", "def ecto_selector", "invocation"],
    ] as const;
    const lineOf = (needle: string, from = 0): number => {
      const index = lines.findIndex(
        (line, lineIndex) => lineIndex >= from && line.includes(needle),
      );
      if (index < 0) throw new Error(`missing line: ${needle}`);
      return index + 1;
    };
    const producerEvents = cases.map(([fromFun, needle]) => ({
      k: "event" as const,
      kind: "remote" as const,
      file,
      line: lineOf(
        needle,
        fromFun === "callback_intermediate/2" ? lineOf("def callback_intermediate") - 1 : 0,
      ),
      from_mod: "NeutralIndexed.Roles",
      from_fun: fromFun,
      to_mod: "String",
      name: "to_atom",
      arity: 1,
      dyn: true,
      partition: "prod" as const,
    }));
    const call = (
      fromFun: string,
      needle: string,
      toMod: string,
      name: string,
      arity: number,
      fromLine = 0,
    ): TraceEvent => ({
      k: "event",
      kind: "remote",
      file,
      line: lineOf(needle, fromLine),
      from_mod: "NeutralIndexed.Roles",
      from_fun: fromFun,
      to_mod: toMod,
      name,
      arity,
      dyn: false,
      partition: "prod",
    });
    const trace: TraceResult = {
      appMod: null,
      deps: ["ecto"],
      compileOk: true,
      testPartition: "complete",
      modules: [mod("NeutralIndexed.Roles", file)],
      functions: [],
      events: [
        ...producerEvents,
        call("map_key/2", "def map_key", "Map", "has_key?", 2),
        call("keyword_pipe/2", "def keyword_pipe", "Keyword", "has_key?", 2),
        call("member/2", "def member", "MapSet", "member?", 2),
        call("stringify/1", "def stringify", "Atom", "to_string", 1),
        call("assigned/2", "Map.has_key?(box", "Map", "has_key?", 2),
        call("with_assignment/2", "Map.has_key?(map, kind", "Map", "has_key?", 2),
        call("assigned_list/1", "Enum.member?(values", "Enum", "member?", 2),
        call("assigned_keyword/1", "Keyword.has_key?(options", "Keyword", "has_key?", 2),
        call(
          "assigned_struct/1",
          "Map.has_key?(box",
          "Map",
          "has_key?",
          2,
          lineOf("def assigned_struct") - 1,
        ),
        call("returned_store/2", "def returned_store", "Map", "put", 3),
        call("returned_replace/2", "def returned_replace", "Map", "replace", 3),
        call("returned_keyword_replace/2", "def returned_keyword_replace", "Keyword", "replace", 3),
        call("unknown/1", "def unknown", "NeutralIndexed.Unknown", "keep", 1),
        call(
          "rebound/2",
          "Map.has_key?(map, kind",
          "Map",
          "has_key?",
          2,
          lineOf("def rebound") - 1,
        ),
        call("callback/2", "Map.new(values, fn key", "Map", "new", 2),
        call("callback/2", "|> Map.has_key", "Map", "has_key?", 2),
        call(
          "callback_multiclause/2",
          "Map.new(values, fn",
          "Map",
          "new",
          2,
          lineOf("def callback_multiclause") - 1,
        ),
        call(
          "callback_multiclause/2",
          "|> Map.has_key",
          "Map",
          "has_key?",
          2,
          lineOf("def callback_multiclause") - 1,
        ),
        call(
          "callback_intermediate/2",
          "Map.new(values, fn _ -> String",
          "Map",
          "new",
          2,
          lineOf("def callback_intermediate") - 1,
        ),
        call(
          "callback_intermediate/2",
          "|> Map.has_key",
          "Map",
          "has_key?",
          2,
          lineOf("def callback_intermediate") - 1,
        ),
        call("callback_argument/2", "def callback_argument", "Enum", "map", 2),
        call("lazy_map/1", "def lazy_map", "Map", "get_lazy", 3),
        call("lazy_map/1", "def lazy_map", "Atom", "to_string", 1),
        call("lazy_keyword/1", "def lazy_keyword", "Keyword", "get_lazy", 3),
        call(
          "lazy_keyword/1",
          "Atom.to_string()",
          "Atom",
          "to_string",
          1,
          lineOf("def lazy_keyword") - 1,
        ),
        call("map_callback_input/1", "def map_callback_input", "Map", "update", 4),
        call("keyword_callback_input/1", "def keyword_callback_input", "Keyword", "update", 4),
        call("enum_callback_input/1", "def enum_callback_input", "Enum", "map", 2),
        call("ambiguous_calls/2", "{Map.has_key?", "Map", "has_key?", 2),
        call("ecto_alias/1", "def ecto_alias", "Ecto.Type", "equal?", 3),
        call("ecto_change/1", "Changeset.change", "Ecto.Changeset", "change", 1),
        call("ecto_change/1", "Changeset.get_field", "Ecto.Changeset", "get_field", 2),
        call("ecto_change/1", "Atom.to_string()", "Atom", "to_string", 1),
        call("ecto_changeset/2", "Changeset.put_change", "Ecto.Changeset", "put_change", 3),
        call("ecto_changeset/2", "Changeset.get_change", "Ecto.Changeset", "get_change", 2),
        call(
          "ecto_changeset/2",
          "Atom.to_string()",
          "Atom",
          "to_string",
          1,
          lineOf("def ecto_changeset") - 1,
        ),
        call("ecto_imported/2", "get_change(String", "Ecto.Changeset", "get_change", 2),
        call(
          "ecto_imported/2",
          "Atom.to_string()",
          "Atom",
          "to_string",
          1,
          lineOf("def ecto_imported") - 1,
        ),
        call("ecto_selector/2", "def ecto_selector", "Ecto.Type", "cast", 2),
      ],
    };

    try {
      writeFileSync(join(root, file), `${lines.join("\n")}\n`);
      writeFileSync(join(root, "mix.lock"), ectoHexLock("3.14.1"));
      expect(
        extractElixirRuntimeConventions(root, trace, summaryProviders).dynamicDispatches.map(
          (fact) => ({
            fromFun: fact.fromFun,
            result:
              fact.factKind === "computed-atom" && fact.flow === "data"
                ? "data"
                : fact.factKind === "dynamic-invocation"
                  ? "invocation"
                  : "escape",
          }),
        ),
      ).toEqual(cases.map(([fromFun, , result]) => ({ fromFun, result })));

      const ectoCall = trace.events.find(
        (event) => event.from_fun === "ecto_imported/2" && event.to_mod === "Ecto.Changeset",
      );
      if (ectoCall === undefined) throw new Error("missing Ecto role event");
      for (const variant of [
        { ...trace, deps: [] },
        { ...trace, modules: [...trace.modules, mod("Ecto.Changeset", file)] },
        { ...trace, events: [...trace.events, ectoCall] },
      ]) {
        expect(
          extractElixirRuntimeConventions(root, variant, summaryProviders).dynamicDispatches.find(
            (fact) => fact.fromFun === "ecto_imported/2",
          ),
        ).toMatchObject({ factKind: "computed-atom", flow: "escape", kind: "opaque" });
      }

      for (const lock of [
        undefined,
        ectoHexLock("3.13.4"),
        `%{\n  "ecto": {:path, "deps/ecto"}\n}\n`,
        `%{\n  "ecto": {:git, "https://example.invalid/ecto.git", "neutral-ref", []}\n}\n`,
        `%{\n  "ecto": {:hex, :ecto, "3.14.1"\n}\n`,
        `malformed\n${ectoHexLock("3.14.1")}`,
        ectoHexLock("3.14.1").replace("[:mix]", "[(:mix]"),
        `%{\n  "ecto": ${ectoHexTuple("3.14.1")},\n  invalid\n}\n`,
        `%{\n  "ecto": ${ectoHexTuple("3.14.1")},\n  "ecto": ${ectoHexTuple("3.14.1")}\n}\n`,
        `${ectoHexLock("3.14.1")}\n${ectoHexLock("3.14.1")}`,
      ]) {
        if (lock === undefined) rmSync(join(root, "mix.lock"));
        else writeFileSync(join(root, "mix.lock"), lock);
        const facts = extractElixirRuntimeConventions(
          root,
          trace,
          summaryProviders,
        ).dynamicDispatches;
        expect(facts.find((fact) => fact.fromFun === "ecto_imported/2")).toMatchObject({
          factKind: "computed-atom",
          flow: "escape",
          kind: "opaque",
        });
        expect(facts.find((fact) => fact.fromFun === "ecto_selector/2")).toMatchObject({
          factKind: "computed-atom",
          flow: "escape",
          kind: "opaque",
        });
      }

      expect(
        extractElixirRuntimeConventions(
          root,
          {
            ...trace,
            modules: [...trace.modules, mod("Map", file)],
          },
          summaryProviders,
        ).dynamicDispatches.find((fact) => fact.fromFun === "map_key/2"),
      ).toMatchObject({ factKind: "computed-atom", flow: "escape", kind: "opaque" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("executes the remaining callback-result shapes through representative sinks", () => {
    const root = mkdtempSync(join(tmpdir(), "unused-callback-result-contracts-"));
    const file = "callback_results.ex";
    const lines = [
      "defmodule NeutralIndexed.CallbackResults do",
      "  def map_get_and_update(raw), do: Map.get_and_update(%{}, :known, fn _value -> {String.to_atom(raw), :stored} end) |> elem(0) |> Atom.to_string()",
      "  def map_new(entries, raw), do: Map.new(entries, fn key -> {key, String.to_atom(raw)} end) |> Map.has_key?(:known)",
      "  def keyword_new(entries, raw), do: Keyword.new(entries, fn key -> {key, String.to_atom(raw)} end) |> Keyword.has_key?(:known)",
      "  def mapset_new(entries, raw), do: MapSet.new(entries, fn _entry -> String.to_atom(raw) end) |> MapSet.member?(:known)",
      "  def map_merge(raw), do: Map.merge(%{}, %{}, fn _key, _left, _right -> String.to_atom(raw) end) |> Map.has_key?(:known)",
      "  def keyword_merge(raw), do: Keyword.merge([], [], fn _key, _left, _right -> String.to_atom(raw) end) |> Keyword.has_key?(:known)",
      "  def enum_into(entries, raw), do: Enum.into(entries, %{}, fn key -> {key, String.to_atom(raw)} end) |> Map.has_key?(:known)",
      "end",
      "",
    ];
    const shapes = [
      [
        "map_get_and_update/1",
        "Map",
        "get_and_update",
        3,
        ["Kernel", "elem", 2, "Atom", "to_string", 1],
        "data",
      ],
      ["map_new/2", "Map", "new", 2, ["Map", "has_key?", 2], "data"],
      ["keyword_new/2", "Keyword", "new", 2, ["Keyword", "has_key?", 2], "data"],
      ["mapset_new/2", "MapSet", "new", 2, ["MapSet", "member?", 2], "data"],
      ["map_merge/1", "Map", "merge", 3, ["Map", "has_key?", 2], "data"],
      ["keyword_merge/1", "Keyword", "merge", 3, ["Keyword", "has_key?", 2], "data"],
      ["enum_into/2", "Enum", "into", 3, ["Map", "has_key?", 2], "escape"],
    ] as const;
    const events: TraceEvent[] = [];
    for (const [fromFun, module, name, arity, sink] of shapes) {
      const line = lines.findIndex((source) => source.includes(`def ${fromFun.split("/")[0]}`)) + 1;
      const base = {
        k: "event" as const,
        kind: "remote" as const,
        file,
        line,
        from_mod: "NeutralIndexed.CallbackResults",
        from_fun: fromFun,
        partition: "prod" as const,
      };
      events.push(
        { ...base, to_mod: "String", name: "to_atom", arity: 1, dyn: true },
        { ...base, to_mod: module, name, arity, dyn: false },
      );
      if (sink !== undefined) {
        events.push({ ...base, to_mod: sink[0], name: sink[1], arity: sink[2], dyn: false });
        if (sink.length === 6) {
          const [, , , nextModule, nextName, nextArity] = sink;
          events.push({
            ...base,
            to_mod: nextModule,
            name: nextName,
            arity: nextArity,
            dyn: false,
          });
        }
      }
    }
    const trace: TraceResult = {
      appMod: null,
      deps: [],
      compileOk: true,
      testPartition: "complete",
      modules: [mod("NeutralIndexed.CallbackResults", file)],
      functions: [],
      events,
    };

    try {
      writeFileSync(join(root, file), lines.join("\n"));
      const extraction = extractElixirRuntimeConventions(root, trace);
      expect(
        extraction.dynamicDispatches.map((fact) => ({
          fromFun: fact.fromFun,
          result: fact.factKind === "computed-atom" && fact.flow === "data" ? "data" : "escape",
        })),
      ).toEqual(shapes.map(([fromFun, , , , , result]) => ({ fromFun, result })));
      expect(extraction.atomFlowStats).toMatchObject({
        producers: 7,
        joinedProducerOutcomes: 7,
        unjoinedOpaqueFallbacks: 0,
        dataSinks: 6,
        escapes: 1,
        summaryMatches: 14,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("summarizes exact same-module private parameters and returned producers", () => {
    const root = mkdtempSync(join(tmpdir(), "unused-private-atom-flow-"));
    const file = "private_atom_flow.ex";
    const lines = [
      "defmodule NeutralPrivate.Flow do",
      "  def safe(map, raw), do: safe_key(map, make(raw))",
      "  def invoke(raw), do: invoke_key(String.to_atom(raw))",
      "  def public_escape(raw), do: public_identity(String.to_atom(raw))",
      "  def public_identity(value), do: value",
      "  defp make(raw), do: String.to_atom(raw)",
      "  defp safe_key(map, key), do: Map.has_key?(map, key)",
      "  defp invoke_key(key), do: apply(NeutralPrivate.Target, key, [])",
      "end",
      "",
    ];
    const event = (
      line: number,
      fromFun: string,
      toMod: string,
      name: string,
      arity: number,
      options: { readonly dyn?: boolean; readonly kind?: "local" | "remote" } = {},
    ): TraceEvent => ({
      k: "event",
      kind: options.kind ?? "remote",
      file,
      line,
      from_mod: "NeutralPrivate.Flow",
      from_fun: fromFun,
      to_mod: toMod,
      name,
      arity,
      dyn: options.dyn ?? false,
      partition: "prod",
    });
    const trace: TraceResult = {
      appMod: null,
      deps: [],
      compileOk: true,
      testPartition: "complete",
      modules: [mod("NeutralPrivate.Flow", file)],
      functions: [],
      events: [
        event(2, "safe/2", "NeutralPrivate.Flow", "safe_key", 2, { kind: "local" }),
        event(2, "safe/2", "NeutralPrivate.Flow", "make", 1, { kind: "local" }),
        event(3, "invoke/1", "String", "to_atom", 1, { dyn: true }),
        event(3, "invoke/1", "NeutralPrivate.Flow", "invoke_key", 1, { kind: "local" }),
        event(4, "public_escape/1", "String", "to_atom", 1, { dyn: true }),
        event(4, "public_escape/1", "NeutralPrivate.Flow", "public_identity", 1, {
          kind: "local",
        }),
        event(6, "make/1", "String", "to_atom", 1, { dyn: true }),
        event(7, "safe_key/2", "Map", "has_key?", 2),
        event(8, "invoke_key/1", "Kernel", "apply", 3, { dyn: true }),
      ],
    };

    try {
      writeFileSync(join(root, file), lines.join("\n"));
      const extraction = extractElixirRuntimeConventions(root, trace);
      expect(
        extraction.dynamicDispatches
          .filter(
            (fact) =>
              fact.factKind === "computed-atom" ||
              (fact.factKind === "dynamic-invocation" && fact.fromFun !== "invoke_key/1"),
          )
          .map((fact) => ({
            fromFun: fact.fromFun,
            result:
              fact.factKind === "computed-atom"
                ? fact.flow === "data"
                  ? "data"
                  : fact.flow === "delegated-invocation"
                    ? "invocation"
                    : "escape"
                : "invocation",
          })),
      ).toEqual([
        { fromFun: "invoke/1", result: "invocation" },
        { fromFun: "public_escape/1", result: "escape" },
        { fromFun: "make/1", result: "data" },
      ]);
      expect(extraction.atomFlowStats).toMatchObject({
        privateFunctions: 3,
        privateSummaries: 4,
        privateCallEdges: 3,
        joinedProducerOutcomes: 3,
        dataSinks: 1,
        invocationSinks: 1,
        escapes: 1,
      });
      expect(extraction.atomFlowStats.privateSccIterations).toBeGreaterThan(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps private summaries argument-sensitive and fails closed at unsafe boundaries", () => {
    const root = mkdtempSync(join(tmpdir(), "unused-private-atom-boundaries-"));
    const file = "private_atom_boundaries.ex";
    const lines = [
      "defmodule NeutralPrivate.Boundaries do",
      "  def direct(map, raw), do: consume(map, String.to_atom(raw))",
      "  def field(map, raw), do: Map.has_key?(map, elem(wrap(String.to_atom(raw)), 1))",
      "  def mixed_safe(map, raw), do: Map.has_key?(map, mixed_make(raw))",
      "  def mixed_escape(raw), do: public_identity(mixed_make(raw))",
      "  def unknown(raw), do: missing_event(String.to_atom(raw))",
      "  def public(raw), do: public_identity(String.to_atom(raw))",
      "  def defaulted(raw), do: default_helper(String.to_atom(raw))",
      "  def ambiguous(raw), do: multi(String.to_atom(raw))",
      "  def recursive(raw), do: loop_left(String.to_atom(raw))",
      "  def public_identity(value), do: value",
      "  defp consume(map, key), do: Map.has_key?(map, key)",
      "  defp wrap(value), do: {:ok, value}",
      "  defp mixed_make(raw), do: String.to_atom(raw)",
      "  defp missing_event(value), do: Map.has_key?(%{}, value)",
      "  defp default_helper(value \\\\ :fallback), do: Map.has_key?(%{}, value)",
      "  defp multi(value), do: Map.has_key?(%{}, value)",
      "  defp multi(value), do: Map.has_key?(%{fallback: true}, value)",
      "  defp loop_left(value), do: loop_right(value)",
      "  defp loop_right(value), do: loop_left(value)",
      "  def split_data(map, raw), do: split_helper(:run, String.to_atom(raw), map)",
      "  defp split_helper(selector, key, map), do: {apply(NeutralPrivate.Target, selector, []), Map.has_key?(map, key)}",
      "end",
      "",
    ];
    const event = (
      line: number,
      fromFun: string,
      toMod: string,
      name: string,
      arity: number,
      options: { readonly dyn?: boolean; readonly kind?: "local" | "remote" } = {},
    ): TraceEvent => ({
      k: "event",
      kind: options.kind ?? "remote",
      file,
      line,
      from_mod: "NeutralPrivate.Boundaries",
      from_fun: fromFun,
      to_mod: toMod,
      name,
      arity,
      dyn: options.dyn ?? false,
      partition: "prod",
    });
    const local = (line: number, fromFun: string, name: string, arity: number): TraceEvent =>
      event(line, fromFun, "NeutralPrivate.Boundaries", name, arity, { kind: "local" });
    const atom = (line: number, fromFun: string): TraceEvent =>
      event(line, fromFun, "String", "to_atom", 1, { dyn: true });
    const map = (line: number, fromFun: string): TraceEvent =>
      event(line, fromFun, "Map", "has_key?", 2);
    const trace: TraceResult = {
      appMod: null,
      deps: [],
      compileOk: true,
      testPartition: "complete",
      modules: [mod("NeutralPrivate.Boundaries", file)],
      functions: [],
      events: [
        atom(2, "direct/2"),
        local(2, "direct/2", "consume", 2),
        atom(3, "field/2"),
        local(3, "field/2", "wrap", 1),
        event(3, "field/2", "Kernel", "elem", 2),
        map(3, "field/2"),
        local(4, "mixed_safe/2", "mixed_make", 1),
        map(4, "mixed_safe/2"),
        local(5, "mixed_escape/1", "mixed_make", 1),
        local(5, "mixed_escape/1", "public_identity", 1),
        atom(6, "unknown/1"),
        atom(7, "public/1"),
        local(7, "public/1", "public_identity", 1),
        atom(8, "defaulted/1"),
        local(8, "defaulted/1", "default_helper", 1),
        atom(9, "ambiguous/1"),
        local(9, "ambiguous/1", "multi", 1),
        atom(10, "recursive/1"),
        local(10, "recursive/1", "loop_left", 1),
        atom(21, "split_data/2"),
        local(21, "split_data/2", "split_helper", 3),
        map(12, "consume/2"),
        atom(14, "mixed_make/1"),
        map(15, "missing_event/1"),
        map(16, "default_helper/1"),
        map(17, "multi/1"),
        map(18, "multi/1"),
        local(19, "loop_left/1", "loop_right", 1),
        local(20, "loop_right/1", "loop_left", 1),
        event(22, "split_helper/3", "Kernel", "apply", 3, { dyn: true }),
        map(22, "split_helper/3"),
      ],
    };

    try {
      writeFileSync(join(root, file), lines.join("\n"));
      const extraction = extractElixirRuntimeConventions(root, trace);
      expect(
        extraction.dynamicDispatches
          .filter((fact) => fact.factKind === "computed-atom")
          .map((fact) => ({ fromFun: fact.fromFun, flow: fact.flow })),
      ).toEqual([
        { fromFun: "direct/2", flow: "data" },
        { fromFun: "field/2", flow: "data" },
        { fromFun: "unknown/1", flow: "escape" },
        { fromFun: "public/1", flow: "escape" },
        { fromFun: "defaulted/1", flow: "escape" },
        { fromFun: "ambiguous/1", flow: "escape" },
        { fromFun: "recursive/1", flow: "escape" },
        { fromFun: "split_data/2", flow: "data" },
        { fromFun: "mixed_make/1", flow: "escape" },
      ]);
      expect(extraction.atomFlowStats).toMatchObject({
        joinedProducerOutcomes: 9,
        dataSinks: 3,
        escapes: 6,
      });
      expect(extraction.atomFlowStats.privateSccIterations).toBeLessThanOrEqual(40);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects guarded sibling clauses and quoted private-definition decoys", () => {
    const root = mkdtempSync(join(tmpdir(), "unused-private-atom-definition-boundaries-"));
    const file = "private_atom_definition_boundaries.ex";
    const moduleName = "NeutralPrivate.Definitions";
    const lines = [
      `defmodule ${moduleName} do`,
      "  def guarded(raw), do: helper(String.to_atom(raw))",
      "  def generated(raw), do: quoted_helper(String.to_atom(raw))",
      "  defp helper(value) when is_atom(value), do: value.run()",
      "  defp helper(value), do: Atom.to_string(value)",
      "  quote do",
      "    defp quoted_helper(value), do: Atom.to_string(value)",
      "  end",
      "end",
      "",
    ];
    const event = (
      line: number,
      fromFun: string,
      toMod: string,
      name: string,
      arity: number,
      dyn = false,
      kind: "local" | "remote" = "remote",
    ): TraceEvent => ({
      k: "event",
      kind,
      file,
      line,
      from_mod: moduleName,
      from_fun: fromFun,
      to_mod: toMod,
      name,
      arity,
      dyn,
      partition: "prod",
    });
    const trace: TraceResult = {
      appMod: null,
      deps: [],
      compileOk: true,
      testPartition: "complete",
      modules: [mod(moduleName, file)],
      functions: [],
      events: [
        event(2, "guarded/1", "String", "to_atom", 1, true),
        event(2, "guarded/1", moduleName, "helper", 1, false, "local"),
        event(3, "generated/1", "String", "to_atom", 1, true),
        event(3, "generated/1", moduleName, "quoted_helper", 1, false, "local"),
        event(4, "helper/1", "Kernel", "is_atom", 1),
        event(5, "helper/1", "Atom", "to_string", 1),
      ],
    };
    try {
      writeFileSync(join(root, file), lines.join("\n"));
      expect(
        extractElixirRuntimeConventions(root, trace)
          .dynamicDispatches.filter((fact) => fact.factKind === "computed-atom")
          .map((fact) => ({ fromFun: fact.fromFun, flow: fact.flow })),
      ).toEqual([
        { fromFun: "guarded/1", flow: "escape" },
        { fromFun: "generated/1", flow: "escape" },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects modules with an unreviewed module-level definition expansion", () => {
    const root = mkdtempSync(join(tmpdir(), "unused-private-atom-generated-clause-"));
    const file = "private_atom_generated_clause.ex";
    const moduleName = "NeutralPrivate.GeneratedClause";
    const trace: TraceResult = {
      appMod: null,
      deps: [],
      compileOk: true,
      testPartition: "complete",
      modules: [mod(moduleName, file)],
      functions: [],
      events: [
        {
          k: "event",
          kind: "remote",
          file: "generated_clause_source.ex",
          line: 2,
          from_mod: moduleName,
          to_mod: "NeutralPrivate.Generator",
          name: "add_runtime_clause",
          arity: 0,
          dyn: false,
          partition: "prod",
        },
        {
          k: "event",
          kind: "remote",
          file,
          line: 3,
          from_mod: moduleName,
          from_fun: "run/1",
          to_mod: "String",
          name: "to_atom",
          arity: 1,
          dyn: true,
          partition: "prod",
        },
        {
          k: "event",
          kind: "local",
          file,
          line: 3,
          from_mod: moduleName,
          from_fun: "run/1",
          to_mod: moduleName,
          name: "helper",
          arity: 1,
          dyn: false,
          partition: "prod",
        },
        {
          k: "event",
          kind: "remote",
          file,
          line: 4,
          from_mod: moduleName,
          from_fun: "helper/1",
          to_mod: "Atom",
          name: "to_string",
          arity: 1,
          dyn: false,
          partition: "prod",
        },
      ],
    };
    try {
      writeFileSync(
        join(root, file),
        [
          `defmodule ${moduleName} do`,
          "  NeutralPrivate.Generator.add_runtime_clause()",
          "  def run(raw), do: helper(String.to_atom(raw))",
          "  defp helper(value), do: Atom.to_string(value)",
          "end",
          "",
        ].join("\n"),
      );
      writeFileSync(
        join(root, "generated_clause_source.ex"),
        "defmodule NeutralPrivate.Generator do\nend\n",
      );
      const extraction = extractElixirRuntimeConventions(root, trace);
      expect(
        extraction.dynamicDispatches.find((fact) => fact.factKind === "computed-atom"),
      ).toMatchObject({ fromFun: "run/1", flow: "escape" });
      expect(extraction.atomFlowStats.privateFunctions).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps private call-chain summary work linear from 250 through 1,000 functions", () => {
    const run = (count: number) => {
      const root = mkdtempSync(join(tmpdir(), `unused-private-atom-scale-${count}-`));
      const file = "private_atom_scale.ex";
      const moduleName = "NeutralPrivate.Scale";
      const lines = [
        `defmodule ${moduleName} do`,
        "  def safe(map, raw), do: Map.has_key?(map, step_0(String.to_atom(raw)))",
      ];
      const events: TraceEvent[] = [
        {
          k: "event",
          kind: "remote",
          file,
          line: 2,
          from_mod: moduleName,
          from_fun: "safe/2",
          to_mod: "String",
          name: "to_atom",
          arity: 1,
          dyn: true,
          partition: "prod",
        },
        {
          k: "event",
          kind: "local",
          file,
          line: 2,
          from_mod: moduleName,
          from_fun: "safe/2",
          to_mod: moduleName,
          name: "step_0",
          arity: 1,
          dyn: false,
          partition: "prod",
        },
        {
          k: "event",
          kind: "remote",
          file,
          line: 2,
          from_mod: moduleName,
          from_fun: "safe/2",
          to_mod: "Map",
          name: "has_key?",
          arity: 2,
          dyn: false,
          partition: "prod",
        },
      ];
      for (let index = 0; index < count; index += 1) {
        const line = index + 3;
        const name = `step_${index}`;
        if (index + 1 === count) {
          lines.push(`  defp ${name}(value), do: value`);
          continue;
        }
        const target = `step_${index + 1}`;
        lines.push(`  defp ${name}(value), do: ${target}(value)`);
        events.push({
          k: "event",
          kind: "local",
          file,
          line,
          from_mod: moduleName,
          from_fun: `${name}/1`,
          to_mod: moduleName,
          name: target,
          arity: 1,
          dyn: false,
          partition: "prod",
        });
      }
      lines.push("end", "");
      const trace: TraceResult = {
        appMod: null,
        deps: [],
        compileOk: true,
        testPartition: "complete",
        modules: [mod(moduleName, file)],
        functions: [],
        events,
      };
      try {
        writeFileSync(join(root, file), lines.join("\n"));
        return extractElixirRuntimeConventions(root, trace);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    };

    for (const count of [250, 500, 1_000]) {
      const extraction = run(count);
      expect(
        extraction.dynamicDispatches.find((fact) => fact.factKind === "computed-atom"),
      ).toMatchObject({ fromFun: "safe/2", flow: "data" });
      expect(extraction.atomFlowStats).toMatchObject({
        privateFunctions: count,
        privateSummaries: count,
        privateCallEdges: count,
        joinedProducerOutcomes: 1,
        dataSinks: 1,
        escapes: 0,
      });
      expect(extraction.atomFlowStats.privateSccIterations).toBeLessThanOrEqual(count * 4);
      expect(extraction.atomFlowStats.roleEdges).toBeLessThanOrEqual(count * 7 + 10);
      expect(extraction.atomFlowStats.queueVisits).toBeLessThanOrEqual(count * 18 + 20);
    }
  });

  it("uses delta summary work for cyclic SCCs from 250 through 1,000 functions", () => {
    const run = (count: number) => {
      const root = mkdtempSync(join(tmpdir(), `unused-private-atom-cycle-${count}-`));
      const file = "private_atom_cycle.ex";
      const moduleName = "NeutralPrivate.Cycle";
      const lines = [
        `defmodule ${moduleName} do`,
        "  def safe(raw), do: step_0(String.to_atom(raw))",
      ];
      const events: TraceEvent[] = [
        {
          k: "event",
          kind: "remote",
          file,
          line: 2,
          from_mod: moduleName,
          from_fun: "safe/1",
          to_mod: "String",
          name: "to_atom",
          arity: 1,
          dyn: true,
          partition: "prod",
        },
        {
          k: "event",
          kind: "local",
          file,
          line: 2,
          from_mod: moduleName,
          from_fun: "safe/1",
          to_mod: moduleName,
          name: "step_0",
          arity: 1,
          dyn: false,
          partition: "prod",
        },
      ];
      for (let index = 0; index < count; index += 1) {
        const name = `step_${index}`;
        const target = `step_${(index + 1) % count}`;
        const line = index + 3;
        lines.push(
          index === 0
            ? `  defp ${name}(value), do: {${target}(value), Map.has_key?(%{}, value)}`
            : `  defp ${name}(value), do: ${target}(value)`,
        );
        events.push({
          k: "event",
          kind: "local",
          file,
          line,
          from_mod: moduleName,
          from_fun: `${name}/1`,
          to_mod: moduleName,
          name: target,
          arity: 1,
          dyn: false,
          partition: "prod",
        });
        if (index === 0) {
          events.push({
            k: "event",
            kind: "remote",
            file,
            line,
            from_mod: moduleName,
            from_fun: `${name}/1`,
            to_mod: "Map",
            name: "has_key?",
            arity: 2,
            dyn: false,
            partition: "prod",
          });
        }
      }
      lines.push("end", "");
      try {
        writeFileSync(join(root, file), lines.join("\n"));
        return extractElixirRuntimeConventions(root, {
          appMod: null,
          deps: [],
          compileOk: true,
          testPartition: "complete",
          modules: [mod(moduleName, file)],
          functions: [],
          events,
        });
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    };

    for (const count of [250, 500, 1_000]) {
      const extraction = run(count);
      expect(
        extraction.dynamicDispatches.find((fact) => fact.factKind === "computed-atom"),
      ).toMatchObject({ fromFun: "safe/1", flow: "data" });
      expect(extraction.atomFlowStats).toMatchObject({
        privateFunctions: count,
        privateSummaries: count,
        privateCallEdges: count + 1,
        privateSummaryUpdates: count * 2,
      });
      expect(extraction.atomFlowStats.privateSccIterations).toBeLessThanOrEqual(count * 5);
      expect(extraction.atomFlowStats.roleEdges).toBeLessThanOrEqual(count * 12 + 10);
      expect(extraction.atomFlowStats.queueVisits).toBeLessThanOrEqual(count * 25 + 20);
    }
  });

  it("fails dense private hubs closed before repeated graph work", () => {
    const run = (count: number) => {
      const root = mkdtempSync(join(tmpdir(), `unused-private-atom-hub-${count}-`));
      const file = "private_atom_hub.ex";
      const moduleName = "NeutralPrivate.Hub";
      const calls = Array.from({ length: count }, (_, index) => `leaf_${index}(value)`);
      const lines = [
        `defmodule ${moduleName} do`,
        "  def run(raw), do: hub(String.to_atom(raw))",
        `  defp hub(value), do: {${calls.join(", ")}}`,
      ];
      const events: TraceEvent[] = [
        {
          k: "event",
          kind: "remote",
          file,
          line: 2,
          from_mod: moduleName,
          from_fun: "run/1",
          to_mod: "String",
          name: "to_atom",
          arity: 1,
          dyn: true,
          partition: "prod",
        },
        {
          k: "event",
          kind: "local",
          file,
          line: 2,
          from_mod: moduleName,
          from_fun: "run/1",
          to_mod: moduleName,
          name: "hub",
          arity: 1,
          dyn: false,
          partition: "prod",
        },
      ];
      for (let index = 0; index < count; index += 1) {
        const name = `leaf_${index}`;
        const line = index + 4;
        lines.push(`  defp ${name}(value), do: Atom.to_string(value)`);
        events.push(
          {
            k: "event",
            kind: "local",
            file,
            line: 3,
            from_mod: moduleName,
            from_fun: "hub/1",
            to_mod: moduleName,
            name,
            arity: 1,
            dyn: false,
            partition: "prod",
          },
          {
            k: "event",
            kind: "remote",
            file,
            line,
            from_mod: moduleName,
            from_fun: `${name}/1`,
            to_mod: "Atom",
            name: "to_string",
            arity: 1,
            dyn: false,
            partition: "prod",
          },
        );
      }
      lines.push("end", "");
      try {
        writeFileSync(join(root, file), lines.join("\n"));
        return extractElixirRuntimeConventions(root, {
          appMod: null,
          deps: [],
          compileOk: true,
          testPartition: "complete",
          modules: [mod(moduleName, file)],
          functions: [],
          events,
        });
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    };

    for (const count of [250, 500, 1_000]) {
      const extraction = run(count);
      expect(
        extraction.dynamicDispatches.find((fact) => fact.factKind === "computed-atom"),
      ).toMatchObject({
        fromFun: "run/1",
        flow: "escape",
        escapeReason: "private-summary-bound",
      });
      expect(extraction.atomFlowStats).toMatchObject({
        privateFunctions: count + 1,
        privateCallEdges: count + 1,
        privateOpaqueFunctions: 1,
      });
      expect(extraction.atomFlowStats.privateSccIterations).toBeLessThanOrEqual((count + 1) * 4);
      expect(extraction.atomFlowStats.roleEdges).toBeLessThanOrEqual(count * 8 + 10);
      expect(extraction.atomFlowStats.queueVisits).toBeLessThanOrEqual(count * 18 + 20);
    }
  });

  it("solves private summaries independently in production and test worlds", () => {
    const root = mkdtempSync(join(tmpdir(), "unused-private-atom-worlds-"));
    const file = "private_atom_worlds.ex";
    const moduleName = "NeutralPrivate.Worlds";
    const event = (
      partition: "prod" | "test",
      line: number,
      fromFun: string,
      toMod: string,
      name: string,
      arity: number,
      kind: "local" | "remote" = "remote",
    ): TraceEvent => ({
      k: "event",
      kind,
      file,
      line,
      from_mod: moduleName,
      from_fun: fromFun,
      to_mod: toMod,
      name,
      arity,
      dyn: toMod === "String",
      partition,
    });
    const production: TraceResult = {
      appMod: null,
      deps: [],
      compileOk: true,
      testPartition: "complete",
      modules: [mod(moduleName, file)],
      functions: [],
      events: [
        event("prod", 2, "safe_prod/2", "String", "to_atom", 1),
        event("prod", 2, "safe_prod/2", moduleName, "consume", 2, "local"),
        event("prod", 4, "consume/2", "Map", "has_key?", 2),
      ],
    };
    const test = validateTestTraceOwnership(
      production,
      {
        testPartition: "complete",
        modules: [{ ...mod(moduleName, file), partition: "test" }],
        functions: [],
        events: [
          event("test", 3, "safe_test/2", "String", "to_atom", 1),
          event("test", 3, "safe_test/2", moduleName, "consume", 2, "local"),
          event("test", 4, "consume/2", "Map", "has_key?", 2),
        ],
      },
      { productionFiles: [file], testFiles: [], testOnlyRoots: [] },
    );
    const trace = mergeTraceResults(production, test);
    try {
      writeFileSync(
        join(root, file),
        [
          `defmodule ${moduleName} do`,
          "  def safe_prod(map, raw), do: consume(map, String.to_atom(raw))",
          "  def safe_test(map, raw), do: consume(map, String.to_atom(raw))",
          "  defp consume(map, key), do: Map.has_key?(map, key)",
          "end",
          "",
        ].join("\n"),
      );
      const extraction = extractElixirRuntimeConventions(root, trace);
      expect(
        extraction.dynamicDispatches
          .filter((fact) => fact.factKind === "computed-atom")
          .map((fact) => ({ flow: fact.flow, world: fact.world })),
      ).toEqual([
        { flow: "data", world: "production" },
        { flow: "data", world: "test" },
      ]);
      expect(extraction.atomFlowStats).toMatchObject({
        privateFunctions: 1,
        privateSummaries: 4,
        privateCallEdges: 2,
        joinedProducerOutcomes: 2,
        dataSinks: 2,
        escapes: 0,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects private producer returns without one exact compiler call join", () => {
    for (const copies of [0, 2]) {
      const root = mkdtempSync(join(tmpdir(), `unused-private-atom-join-${copies}-`));
      const file = "private_atom_join.ex";
      const moduleName = "NeutralPrivate.Join";
      const localCall: TraceEvent = {
        k: "event",
        kind: "local",
        file,
        line: 2,
        from_mod: moduleName,
        from_fun: "safe/2",
        to_mod: moduleName,
        name: "make",
        arity: 1,
        dyn: false,
        partition: "prod",
      };
      const trace: TraceResult = {
        appMod: null,
        deps: [],
        compileOk: true,
        testPartition: "complete",
        modules: [mod(moduleName, file)],
        functions: [],
        events: [
          ...Array.from({ length: copies }, () => ({ ...localCall })),
          {
            k: "event",
            kind: "remote",
            file,
            line: 2,
            from_mod: moduleName,
            from_fun: "safe/2",
            to_mod: "Map",
            name: "has_key?",
            arity: 2,
            dyn: false,
            partition: "prod",
          },
          {
            k: "event",
            kind: "remote",
            file,
            line: 3,
            from_mod: moduleName,
            from_fun: "make/1",
            to_mod: "String",
            name: "to_atom",
            arity: 1,
            dyn: true,
            partition: "prod",
          },
        ],
      };
      try {
        writeFileSync(
          join(root, file),
          [
            `defmodule ${moduleName} do`,
            "  def safe(map, raw), do: Map.has_key?(map, make(raw))",
            "  defp make(raw), do: String.to_atom(raw)",
            "end",
            "",
          ].join("\n"),
        );
        expect(
          extractElixirRuntimeConventions(root, trace).dynamicDispatches.find(
            (fact) => fact.factKind === "computed-atom",
          ),
        ).toMatchObject({ fromFun: "make/1", flow: "escape" });
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  it("joins one source producer independently by exact carrier and partition", () => {
    const root = mkdtempSync(join(tmpdir(), "unused-indexed-atom-partitions-"));
    const file = "partitioned_atom_role.ex";
    writeFileSync(
      join(root, file),
      [
        "defmodule NeutralIndexed.Partitioned do",
        "  def key?(map, raw), do: Map.has_key?(map, String.to_atom(raw))",
        "end",
        "",
      ].join("\n"),
    );
    const event = (partition: "prod" | "test", target: "String" | "Map"): TraceEvent => ({
      k: "event",
      kind: "remote",
      file,
      line: 2,
      from_mod: "NeutralIndexed.Partitioned",
      from_fun: "key?/2",
      to_mod: target,
      name: target === "String" ? "to_atom" : "has_key?",
      arity: target === "String" ? 1 : 2,
      dyn: target === "String",
      partition,
    });
    const trace: TraceResult = {
      appMod: null,
      deps: [],
      compileOk: true,
      testPartition: "complete",
      modules: [mod("NeutralIndexed.Partitioned", file)],
      functions: [],
      events: [
        event("prod", "String"),
        event("prod", "Map"),
        event("test", "String"),
        event("test", "Map"),
      ],
    };

    try {
      const extraction = extractElixirRuntimeConventions(root, trace);
      expect(extraction.dynamicDispatches).toEqual([
        expect.objectContaining({ factKind: "computed-atom", flow: "data", world: "production" }),
        expect.objectContaining({ factKind: "computed-atom", flow: "data", world: "test" }),
      ]);
      expect(extraction.atomFlowStats).toMatchObject({ dataSinks: 2, escapes: 0 });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("indexes callback commas without inflating explicit or piped logical arity", () => {
    const root = mkdtempSync(join(tmpdir(), "unused-indexed-callback-arities-"));
    const file = "callback_arities.ex";
    const lines = [
      "defmodule NeutralIndexed.CallbackArities do",
      "  def explicit(entries, raw) do",
      "    Enum.reduce(entries, %{}, fn entry, acc ->",
      "      pair = fn left, right -> {left, right} end",
      "      _ = pair.(entry, acc)",
      "      Map.put(acc, entry, String.to_atom(raw))",
      "    end)",
      "    |> Map.has_key?(:known) # explicit result",
      "  end",
      "  def piped(entries, raw) do",
      "    entries",
      "    |> Enum.reduce(%{}, fn",
      "      {key, value}, acc -> Map.put(acc, key, String.to_atom(raw))",
      "      _other, acc -> Map.put(acc, :fallback, :known)",
      "    end)",
      "    |> Map.has_key?(:known) # piped result",
      "  end",
      "  def keyword_fn(map, raw), do: Map.get(map, fn: String.to_atom(raw))",
      "  def nested_result(entries, raw), do: Enum.reduce(entries, %{}, fn _entry, _acc -> fn _value -> String.to_atom(raw) end end) |> Map.has_key?(:known)",
      "  def collection_input(entries, raw), do: Enum.reduce([String.to_atom(raw) | entries], [], fn selector, acc -> [{NeutralIndexed.Target, selector, []} | acc] end)",
      "  def accumulator_input(entries, raw), do: Enum.reduce(entries, String.to_atom(raw), fn _entry, selector -> _runtime_data = {NeutralIndexed.Target, selector, []}; selector end)",
      "  def wrong(entries, raw), do: Enum.reduce(entries, %{}, fn entry, acc -> Map.put(acc, entry, String.to_atom(raw)) end)",
      "  def ambiguous(entries, raw), do: {Enum.reduce(entries, %{}, fn entry, acc -> Map.put(acc, entry, String.to_atom(raw)) end), Enum.reduce(entries, %{}, fn entry, acc -> Map.put(acc, entry, :known) end)}",
      "  def producer_ambiguous(map, left, right), do: {Map.has_key?(map, String.to_atom(left)), Map.has_key?(map, String.to_atom(right))}",
      "end",
    ];
    const lineOf = (needle: string): number => lines.findIndex((line) => line.includes(needle)) + 1;
    const event = (
      fromFun: string,
      needle: string,
      toMod: string,
      name: string,
      arity: number,
      dyn = false,
    ): TraceEvent => ({
      k: "event",
      kind: "remote",
      file,
      line: lineOf(needle),
      from_mod: "NeutralIndexed.CallbackArities",
      from_fun: fromFun,
      to_mod: toMod,
      name,
      arity,
      dyn,
      partition: "prod",
    });
    const producer = (fromFun: string, needle: string): TraceEvent =>
      event(fromFun, needle, "String", "to_atom", 1, true);
    const events: TraceEvent[] = [
      producer("explicit/2", "Map.put(acc, entry, String"),
      event("explicit/2", "Enum.reduce(entries", "Enum", "reduce", 3),
      event("explicit/2", "Map.put(acc, entry, String", "Map", "put", 3),
      event("explicit/2", "# explicit result", "Map", "has_key?", 2),
      producer("piped/2", "{key, value}, acc"),
      event("piped/2", "|> Enum.reduce", "Enum", "reduce", 3),
      event("piped/2", "{key, value}, acc", "Map", "put", 3),
      event("piped/2", "# piped result", "Map", "has_key?", 2),
      producer("keyword_fn/2", "def keyword_fn"),
      event("keyword_fn/2", "def keyword_fn", "Map", "get", 2),
      producer("nested_result/2", "def nested_result"),
      event("nested_result/2", "def nested_result", "Enum", "reduce", 3),
      event("nested_result/2", "def nested_result", "Map", "has_key?", 2),
      producer("collection_input/2", "def collection_input"),
      event("collection_input/2", "def collection_input", "Enum", "reduce", 3),
      producer("accumulator_input/2", "def accumulator_input"),
      event("accumulator_input/2", "def accumulator_input", "Enum", "reduce", 3),
      producer("wrong/2", "def wrong"),
      event("wrong/2", "def wrong", "Enum", "reduce", 4),
      event("wrong/2", "def wrong", "Map", "put", 3),
      producer("ambiguous/2", "def ambiguous"),
      event("ambiguous/2", "def ambiguous", "Enum", "reduce", 3),
      event("ambiguous/2", "def ambiguous", "Enum", "reduce", 3),
      event("ambiguous/2", "def ambiguous", "Map", "put", 3),
      producer("producer_ambiguous/3", "def producer_ambiguous"),
      producer("producer_ambiguous/3", "def producer_ambiguous"),
      event("producer_ambiguous/3", "def producer_ambiguous", "Map", "has_key?", 2),
      event("producer_ambiguous/3", "def producer_ambiguous", "Map", "has_key?", 2),
    ];
    const trace: TraceResult = {
      appMod: null,
      deps: [],
      compileOk: true,
      testPartition: "complete",
      modules: [mod("NeutralIndexed.CallbackArities", file)],
      functions: [],
      events,
    };

    try {
      writeFileSync(join(root, file), `${lines.join("\n")}\n`);
      const extraction = extractElixirRuntimeConventions(root, trace);
      const outcomes = extraction.dynamicDispatches.map((fact) => ({
        fromFun: fact.fromFun,
        flow: fact.factKind === "computed-atom" ? fact.flow : "invocation",
      }));
      expect(outcomes).toEqual([
        { fromFun: "explicit/2", flow: "escape" },
        { fromFun: "piped/2", flow: "escape" },
        { fromFun: "keyword_fn/2", flow: "data" },
        { fromFun: "nested_result/2", flow: "escape" },
        { fromFun: "collection_input/2", flow: "escape" },
        { fromFun: "accumulator_input/2", flow: "escape" },
        { fromFun: "wrong/2", flow: "escape" },
        { fromFun: "ambiguous/2", flow: "escape" },
        { fromFun: "producer_ambiguous/3", flow: "escape" },
        { fromFun: "producer_ambiguous/3", flow: "escape" },
      ]);
      expect(extraction.atomFlowStats).toMatchObject({
        producers: 10,
        joinedProducerOutcomes: 8,
        unjoinedOpaqueFallbacks: 2,
        legacyIndexedDisagreements: 1,
        dataSinks: 1,
        escapes: 7,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps mixed legacy and indexed producer outcomes isolated on one carrier", () => {
    const root = mkdtempSync(join(tmpdir(), "unused-mixed-atom-role-contexts-"));
    const file = "mixed_atom_role_contexts.ex";
    const lines = [
      "defmodule NeutralIndexed.MixedContexts do",
      "  def rebuild(entries, left, right) do",
      "    entries",
      "    |> Enum.map(fn {_key, value} ->",
      "      {",
      "        String.to_atom(left),",
      "        String.to_atom(right)",
      "      }",
      "    end)",
      "    |> Enum.into(%{})",
      "  end",
      "end",
    ];
    const roleEvent = (
      line: number,
      toMod: string,
      name: string,
      arity: number,
      dyn = false,
    ): TraceEvent => ({
      k: "event",
      kind: "remote",
      file,
      line,
      from_mod: "NeutralIndexed.MixedContexts",
      from_fun: "rebuild/3",
      to_mod: toMod,
      name,
      arity,
      dyn,
      partition: "prod",
    });
    const trace: TraceResult = {
      appMod: null,
      deps: [],
      compileOk: true,
      testPartition: "complete",
      modules: [mod("NeutralIndexed.MixedContexts", file)],
      functions: [],
      events: [
        roleEvent(6, "String", "to_atom", 1, true),
        roleEvent(7, "String", "to_atom", 1, true),
        roleEvent(4, "Enum", "map", 2),
        roleEvent(10, "Enum", "into", 2),
      ],
    };

    try {
      writeFileSync(join(root, file), `${lines.join("\n")}\n`);
      const extraction = extractElixirRuntimeConventions(root, trace);
      expect(
        extraction.dynamicDispatches.map((fact) =>
          fact.factKind === "computed-atom" ? fact.flow : "invocation",
        ),
      ).toEqual(["data", "escape"]);
      expect(extraction.atomFlowStats).toMatchObject({
        producers: 2,
        joinedProducerOutcomes: 2,
        unjoinedOpaqueFallbacks: 0,
        legacyIndexedDisagreements: 1,
        dataSinks: 1,
        escapes: 1,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
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

  it("proves only clause-guarded inline atoms in exact rescued Map.put values", () => {
    const root = mkdtempSync(join(tmpdir(), "unused-inline-map-put-roles-"));
    const file = "inline_map_put_roles.ex";
    const roles = [
      {
        name: "safe",
        clause: "raw when is_binary(raw)",
        body: ["{:ok, Map.put(params, :kind, String.to_existing_atom(raw))}"],
        expected: "exact",
      },
      {
        name: "safe_conjunctive",
        clause: "raw when (is_binary(raw)) and byte_size(raw) > 0",
        body: ["{:ok, Map.put(params, :kind, String.to_existing_atom(raw))}"],
        expected: "exact",
      },
      {
        name: "safe_with",
        container: "with {:error, reason} <- value do",
        clause: "raw when is_binary(raw)",
        body: ["{:ok, Map.put(params, :kind, String.to_existing_atom(raw))}"],
        expected: "exact",
      },
      {
        name: "safe_ok_tuple",
        clause: "{:ok, raw} when is_binary(raw)",
        body: ["{:ok, Map.put(params, :kind, String.to_existing_atom(raw))}"],
        expected: "exact",
      },
      {
        name: "tuple_wrong_status",
        clause: "{:error, params} when is_binary(params)",
        body: ["{:ok, Map.put(value, :kind, String.to_existing_atom(params))}"],
        expected: "opaque",
      },
      {
        name: "tuple_extra_element",
        clause: "{:ok, params, metadata} when is_binary(params)",
        body: ["{:ok, Map.put(value, :kind, String.to_existing_atom(params))}"],
        expected: "opaque",
      },
      {
        name: "tuple_nested_binder",
        clause: "{:ok, {:wrapped, params}} when is_binary(params)",
        body: ["{:ok, Map.put(value, :kind, String.to_existing_atom(params))}"],
        expected: "opaque",
      },
      {
        name: "tuple_wildcard",
        clause: "{:ok, _} when is_binary(params)",
        body: ["{:ok, Map.put(value, :kind, String.to_existing_atom(params))}"],
        expected: "opaque",
      },
      {
        name: "tuple_alias_binder",
        clause: "{:ok, alias_value = params} when is_binary(params)",
        body: ["{:ok, Map.put(value, :kind, String.to_existing_atom(params))}"],
        expected: "opaque",
      },
      {
        name: "tuple_pinned_binder",
        clause: "{:ok, ^params} when is_binary(params)",
        body: ["{:ok, Map.put(value, :kind, String.to_existing_atom(params))}"],
        expected: "opaque",
      },
      {
        name: "tuple_multiple_binders",
        clause: "{:ok, {left, params}} when is_binary(params)",
        body: ["{:ok, Map.put(value, :kind, String.to_existing_atom(params))}"],
        expected: "opaque",
      },
      {
        name: "tuple_unguarded",
        clause: "{:ok, params}",
        body: ["{:ok, Map.put(value, :kind, String.to_existing_atom(params))}"],
        expected: "opaque",
      },
      {
        name: "tuple_mismatched_guard",
        clause: "{:ok, raw} when is_binary(params)",
        body: ["{:ok, Map.put(value, :kind, String.to_existing_atom(raw))}"],
        expected: "opaque",
      },
      {
        name: "tuple_duplicate_atom_event",
        clause: "{:ok, raw} when is_binary(raw)",
        body: ["{:ok, Map.put(params, :kind, String.to_existing_atom(raw))}"],
        atomEventCopies: 2,
        expected: "opaque",
      },
      {
        name: "tuple_duplicate_guard_event",
        clause: "{:ok, raw} when is_binary(raw)",
        body: ["{:ok, Map.put(params, :kind, String.to_existing_atom(raw))}"],
        guardEvents: 2,
        expected: "opaque",
      },
      {
        name: "tuple_duplicate_map_event",
        clause: "{:ok, raw} when is_binary(raw)",
        body: ["{:ok, Map.put(params, :kind, String.to_existing_atom(raw))}"],
        mapEvents: 2,
        expected: "opaque",
      },
      {
        name: "missing_guard_event",
        clause: "raw when is_binary(raw)",
        body: ["{:ok, Map.put(params, :kind, String.to_existing_atom(raw))}"],
        guardEvents: 0,
        expected: "opaque",
      },
      {
        name: "duplicate_guard_event",
        clause: "raw when is_binary(raw)",
        body: ["{:ok, Map.put(params, :kind, String.to_existing_atom(raw))}"],
        guardEvents: 2,
        expected: "opaque",
      },
      {
        name: "missing_map_event",
        clause: "raw when is_binary(raw)",
        body: ["{:ok, Map.put(params, :kind, String.to_existing_atom(raw))}"],
        mapEvents: 0,
        expected: "opaque",
      },
      {
        name: "duplicate_map_event",
        clause: "raw when is_binary(raw)",
        body: ["{:ok, Map.put(params, :kind, String.to_existing_atom(raw))}"],
        mapEvents: 2,
        expected: "opaque",
      },
      {
        name: "missing_guard",
        clause: "raw",
        body: ["{:ok, Map.put(params, :kind, String.to_existing_atom(raw))}"],
        expected: "opaque",
      },
      {
        name: "negated_guard",
        clause: "raw when not is_binary(raw)",
        body: ["{:ok, Map.put(params, :kind, String.to_existing_atom(raw))}"],
        expected: "opaque",
      },
      {
        name: "disjunctive_guard",
        clause: "raw when is_binary(raw) or is_atom(raw)",
        body: ["{:ok, Map.put(params, :kind, String.to_existing_atom(raw))}"],
        expected: "opaque",
      },
      {
        name: "binder_mismatch",
        clause: "other when is_binary(raw)",
        body: ["{:ok, Map.put(params, :kind, String.to_existing_atom(raw))}"],
        expected: "opaque",
      },
      {
        name: "rebound",
        clause: "raw when is_binary(raw)",
        beforeTry: ["raw = runtime_value()"],
        body: ["{:ok, Map.put(params, :kind, String.to_existing_atom(raw))}"],
        expected: "opaque",
      },
      {
        name: "map_arg_rebind",
        clause: "raw when is_binary(raw)",
        body: ["{:ok, Map.put((raw = params), :kind, String.to_existing_atom(raw))}"],
        expected: "opaque",
      },
      {
        name: "missing_rescue",
        clause: "raw when is_binary(raw)",
        body: ["{:ok, Map.put(params, :kind, String.to_existing_atom(raw))}"],
        rescue: false,
        expected: "opaque",
      },
      {
        name: "dynamic_module",
        clause: "raw when is_binary(raw)",
        body: ["{:ok, map_module.put(params, :kind, String.to_existing_atom(raw))}"],
        expected: "opaque",
      },
      {
        name: "qualified_module",
        clause: "raw when is_binary(raw)",
        body: ["{:ok, Other.Map.put(params, :kind, String.to_existing_atom(raw))}"],
        expected: "opaque",
      },
      {
        name: "dynamic_function",
        clause: "raw when is_binary(raw)",
        body: ["{:ok, Map.replace(params, :kind, String.to_existing_atom(raw))}"],
        expected: "opaque",
      },
      {
        name: "dynamic_key",
        clause: "raw when is_binary(raw)",
        body: ["{:ok, Map.put(params, key, String.to_existing_atom(raw))}"],
        expected: "opaque",
      },
      {
        name: "first_argument",
        clause: "raw when is_binary(raw)",
        body: ["{:ok, Map.put(String.to_existing_atom(raw), :kind, :known)}"],
        expected: "opaque",
      },
      {
        name: "key_receiver",
        clause: "raw when is_binary(raw)",
        body: ["{:ok, Map.put(params, String.to_existing_atom(raw).run(), :known)}"],
        expected: "opaque",
      },
      {
        name: "value_receiver",
        clause: "raw when is_binary(raw)",
        body: ["{:ok, Map.put(params, :kind, String.to_existing_atom(raw).run())}"],
        expected: "opaque",
      },
      {
        name: "value_apply",
        clause: "raw when is_binary(raw)",
        body: ["{:ok, Map.put(params, :kind, apply(String.to_existing_atom(raw), :run, []))}"],
        expected: "opaque",
      },
      {
        name: "value_capture",
        clause: "raw when is_binary(raw)",
        body: [
          "{:ok, Map.put(params, :kind, Function.capture(String.to_existing_atom(raw), :run, 0))}",
        ],
        expected: "opaque",
      },
      {
        name: "value_mfa",
        clause: "raw when is_binary(raw)",
        body: ["{:ok, Map.put(params, :kind, {String.to_existing_atom(raw), :run, []})}"],
        expected: "opaque",
      },
      {
        name: "not_success_tuple",
        clause: "raw when is_binary(raw)",
        body: ["Map.put(params, :kind, String.to_existing_atom(raw))"],
        expected: "opaque",
      },
      {
        name: "wrong_status",
        clause: "raw when is_binary(raw)",
        body: ["{:error, Map.put(params, :kind, String.to_existing_atom(raw))}"],
        expected: "opaque",
      },
      {
        name: "nested_payload",
        clause: "raw when is_binary(raw)",
        body: ["{:ok, {:wrapped, Map.put(params, :kind, String.to_existing_atom(raw))}}"],
        expected: "opaque",
      },
      {
        name: "nested_try",
        clause: "raw when is_binary(raw)",
        body: [
          "try do",
          "  {:ok, Map.put(params, :kind, String.to_existing_atom(raw))}",
          "rescue",
          "  ArgumentError -> {:error, :nested}",
          "end",
        ],
        expected: "opaque",
      },
      {
        name: "borrowed_rescue",
        clause: "raw when is_binary(raw)",
        body: ["try do", "  {:ok, Map.put(params, :kind, String.to_existing_atom(raw))}", "end"],
        expected: "opaque",
      },
      {
        name: "masked_producer",
        clause: "raw when is_binary(raw)",
        body: ['{:ok, Map.put(params, :kind, "#{String.to_existing_atom(raw)}")}'],
        expected: "opaque",
      },
      {
        name: "earlier_interpolation",
        clause: "raw when is_binary(raw)",
        body: ['{:ok, Map.put(%{note: "#{params}"}, :kind, String.to_existing_atom(raw))}'],
        expected: "opaque",
      },
      {
        name: "nested_first_producer",
        clause: "raw when is_binary(raw)",
        body: [
          "{:ok,",
          " Map.put(",
          "   %{other: String.to_existing_atom(params)},",
          "   :kind,",
          "   String.to_existing_atom(raw)",
          " )}",
        ],
        expected: "opaque",
      },
      {
        name: "second_event",
        clause: "raw when is_binary(raw)",
        body: [
          "{:ok, Map.put(params, :kind, String.to_existing_atom(raw))}; String.to_existing_atom(raw)",
        ],
        expected: "opaque",
      },
    ] as const;
    const lines = ["defmodule NeutralInline.Roles do"];
    const metadata: Array<{
      readonly name: string;
      readonly atomLines: readonly number[];
      readonly guardLine: number;
      readonly mapLine?: number;
      readonly atomEventCopies: number;
      readonly guardEvents: number;
      readonly mapEvents: number;
      readonly expected: string;
    }> = [];
    for (const role of roles) {
      lines.push(`  def ${role.name}(value, params) do`);
      lines.push(`    ${"container" in role ? role.container : "case value do"}`);
      if (role.name === "safe_with") lines.push("      :ok", "    else");
      const guardLine = lines.length + 1;
      lines.push(`      ${role.clause} ->`);
      for (const before of "beforeTry" in role ? role.beforeTry : [])
        lines.push(`        ${before}`);
      lines.push("        try do");
      const bodyStart = lines.length + 1;
      for (const bodyLine of role.body) lines.push(`          ${bodyLine}`);
      if (!("rescue" in role) || role.rescue !== false) {
        lines.push("        rescue", "          ArgumentError -> {:error, :invalid}");
      }
      lines.push("        end");
      if (role.name !== "safe_with") {
        lines.push("", "      _other ->", "        {:error, :unmatched}");
      }
      lines.push("    end", "  end");
      const atomLines = role.body.flatMap((line, index) =>
        Array.from(line.matchAll(/String\.to_existing_atom/gu), () => bodyStart + index),
      );
      const relativeMap = role.body.findIndex((line) => line.includes("Map.put("));
      metadata.push({
        name: role.name,
        atomLines,
        guardLine,
        ...(relativeMap < 0 ? {} : { mapLine: bodyStart + relativeMap }),
        atomEventCopies: "atomEventCopies" in role ? role.atomEventCopies : 1,
        guardEvents:
          "guardEvents" in role ? role.guardEvents : role.clause.includes("is_binary") ? 1 : 0,
        mapEvents:
          "mapEvents" in role
            ? role.mapEvents
            : role.body.some((line) => line.includes("Map.put("))
              ? 1
              : 0,
        expected: role.expected,
      });
    }
    lines.push("end");
    const events: TraceEvent[] = [];
    for (const role of metadata) {
      for (const atomLine of role.atomLines) {
        for (let copy = 0; copy < role.atomEventCopies; copy += 1) {
          events.push({
            k: "event",
            kind: "remote",
            file,
            line: atomLine,
            from_mod: "NeutralInline.Roles",
            from_fun: `${role.name}/2`,
            to_mod: "String",
            name: "to_existing_atom",
            arity: 1,
            dyn: true,
            partition: "prod",
          });
        }
      }
      for (let index = 0; index < role.guardEvents; index += 1) {
        events.push({
          k: "event",
          kind: "imported",
          file,
          line: role.guardLine,
          from_mod: "NeutralInline.Roles",
          from_fun: `${role.name}/2`,
          to_mod: "Kernel",
          name: "is_binary",
          arity: 1,
          dyn: false,
          partition: "prod",
        });
      }
      for (let index = 0; index < role.mapEvents && role.mapLine !== undefined; index += 1) {
        events.push({
          k: "event",
          kind: "remote",
          file,
          line: role.mapLine,
          from_mod: "NeutralInline.Roles",
          from_fun: `${role.name}/2`,
          to_mod: "Map",
          name: "put",
          arity: 3,
          dyn: false,
          partition: "prod",
        });
      }
    }
    const trace: TraceResult = {
      appMod: null,
      deps: [],
      compileOk: true,
      testPartition: "complete",
      modules: [mod("NeutralInline.Roles", file)],
      functions: [],
      events,
    };

    try {
      writeFileSync(join(root, file), `${lines.join("\n")}\n`);
      const actual = extractElixirRuntimeConventions(root, trace).dynamicDispatches.map(
        (dispatch) => ({ fromFun: dispatch.fromFun, kind: dispatch.kind }),
      );
      const expected = metadata.flatMap((role) =>
        role.atomLines.flatMap(() =>
          Array.from({ length: role.atomEventCopies }, () => ({
            fromFun: `${role.name}/2`,
            kind: role.expected,
          })),
        ),
      );
      expect(actual).toEqual(expected);
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
    ).toEqual([
      expect.objectContaining({
        factKind: "dynamic-invocation",
        kind: "opaque",
        targets: [],
        world: "production",
      }),
    ]);
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

  it("indexes repeated inline Map.put atom-data clauses near-linearly", () => {
    const root = mkdtempSync(join(tmpdir(), "unused-inline-map-put-scaling-"));
    const file = "many_inline_map_puts.ex";
    const trace: TraceResult = {
      appMod: null,
      deps: [],
      compileOk: true,
      testPartition: "complete",
      modules: [mod("NeutralScale.InlineMapPuts", file)],
      functions: [],
      events: [],
    };
    const measure = (count: number): number => {
      const functions = Array.from({ length: count }, (_, index) =>
        [
          `  def normalize_${index}(value_${index}, params) do\n`,
          `    case value_${index} do\n`,
          `      {:ok, raw_${index}} when is_binary(raw_${index}) ->\n`,
          "        try do\n",
          `          {:ok, Map.put(params, :kind, String.to_existing_atom(raw_${index}))}\n`,
          "        rescue\n",
          "          ArgumentError -> {:error, :invalid}\n",
          "        end\n",
          "\n",
          "      _other ->\n",
          "        {:error, :unmatched}\n",
          "    end\n",
          "  end\n",
        ].join(""),
      ).join("");
      writeFileSync(
        join(root, file),
        ["defmodule NeutralScale.InlineMapPuts do\n", functions, "end\n"].join(""),
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

  it("joins event-populated local role graphs near-linearly with deterministic counters", () => {
    const root = mkdtempSync(join(tmpdir(), "unused-atom-role-event-scaling-"));
    const file = "many_atom_roles.ex";
    const measure = (count: number) => {
      const functions = Array.from(
        { length: count },
        (_, index) =>
          `  def classify_${index}(map, raw), do: Map.has_key?(map, String.to_atom(raw))\n`,
      ).join("");
      writeFileSync(
        join(root, file),
        ["defmodule NeutralScale.AtomRoles do\n", functions, "end\n"].join(""),
      );
      const events: TraceEvent[] = Array.from({ length: count }, (_, index) => {
        const base = {
          k: "event" as const,
          kind: "remote" as const,
          file,
          line: index + 2,
          from_mod: "NeutralScale.AtomRoles",
          from_fun: `classify_${index}/2`,
          partition: "prod" as const,
        };
        return [
          {
            ...base,
            to_mod: "String",
            name: "to_atom",
            arity: 1,
            dyn: true,
          },
          {
            ...base,
            to_mod: "Map",
            name: "has_key?",
            arity: 2,
            dyn: false,
          },
        ];
      }).flat();
      const trace: TraceResult = {
        appMod: null,
        deps: [],
        compileOk: true,
        testPartition: "complete",
        modules: [mod("NeutralScale.AtomRoles", file)],
        functions: [],
        events,
      };
      const started = performance.now();
      const extraction = extractElixirRuntimeConventions(root, trace);
      return { elapsed: performance.now() - started, extraction };
    };
    const median = (values: readonly number[]): number =>
      [...values].sort((left, right) => left - right)[Math.floor(values.length / 2)] ?? 0;

    try {
      measure(50);
      const smallRuns = [measure(250), measure(250), measure(250)];
      const largeRuns = [measure(1_000), measure(1_000), measure(1_000)];
      const representative = largeRuns[0]?.extraction;
      if (representative === undefined) throw new Error("missing scaling result");
      expect(representative.dynamicDispatches).toHaveLength(1_000);
      expect(representative.atomFlowStats).toMatchObject({
        sources: 1,
        producers: 1_000,
        dataSinks: 1_000,
        invocationSinks: 0,
        escapes: 0,
        summaryMatches: 1_000,
      });
      expect(representative.atomFlowStats.roleEdges).toBeGreaterThanOrEqual(1_000);
      expect(representative.atomFlowStats.queueVisits).toBeGreaterThanOrEqual(1_000);
      const small = median(smallRuns.map((run) => run.elapsed));
      const large = median(largeRuns.map((run) => run.elapsed));
      expect(large).toBeLessThan(small * 8 + 30);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 10_000);

  it("joins callback-heavy compiler events near-linearly with deterministic outcomes", () => {
    const root = mkdtempSync(join(tmpdir(), "unused-atom-role-callback-scaling-"));
    const file = "many_atom_callbacks.ex";
    const measure = (count: number) => {
      const lines = ["defmodule NeutralScale.AtomCallbacks do"];
      const events: TraceEvent[] = [];
      for (let index = 0; index < count; index += 1) {
        const piped = index % 2 === 1;
        const headerLine = lines.length + 1;
        lines.push(`  def classify_${index}(entries, raw) do`);
        const reduceLine = lines.length + 1;
        lines.push(
          piped
            ? "    entries |> Enum.reduce(%{}, fn {key, value}, acc ->"
            : "    Enum.reduce(entries, %{}, fn {key, value}, acc ->",
        );
        const putLine = lines.length + 1;
        lines.push("      nested = fn left, right -> {left, right} end");
        lines.push("      _ = nested.(key, value)");
        lines.push("      Map.put(acc, key, String.to_atom(raw))");
        const producerLine = lines.length;
        lines.push("    end) |> Map.has_key?(:known)", "  end");
        const base = {
          k: "event" as const,
          kind: "remote" as const,
          file,
          from_mod: "NeutralScale.AtomCallbacks",
          from_fun: `classify_${index}/2`,
          partition: "prod" as const,
        };
        events.push(
          {
            ...base,
            line: producerLine,
            to_mod: "String",
            name: "to_atom",
            arity: 1,
            dyn: true,
          },
          {
            ...base,
            line: reduceLine,
            to_mod: "Enum",
            name: "reduce",
            arity: 3,
            dyn: false,
          },
          {
            ...base,
            line: producerLine,
            to_mod: "Map",
            name: "put",
            arity: 3,
            dyn: false,
          },
          {
            ...base,
            line: producerLine + 1,
            to_mod: "Map",
            name: "has_key?",
            arity: 2,
            dyn: false,
          },
        );
        expect(headerLine).toBeLessThan(reduceLine);
        expect(putLine).toBeLessThan(producerLine);
      }
      lines.push("end", "");
      writeFileSync(join(root, file), lines.join("\n"));
      const trace: TraceResult = {
        appMod: null,
        deps: [],
        compileOk: true,
        testPartition: "complete",
        modules: [mod("NeutralScale.AtomCallbacks", file)],
        functions: [],
        events,
      };
      const started = performance.now();
      const extraction = extractElixirRuntimeConventions(root, trace);
      return { elapsed: performance.now() - started, extraction };
    };
    const median = (values: readonly number[]): number =>
      [...values].sort((left, right) => left - right)[Math.floor(values.length / 2)] ?? 0;

    try {
      measure(25);
      const smallRuns = [measure(250), measure(250), measure(250)];
      const largeRuns = [measure(1_000), measure(1_000), measure(1_000)];
      const representative = largeRuns[0]?.extraction;
      if (representative === undefined) throw new Error("missing callback scaling result");
      expect(representative.dynamicDispatches).toHaveLength(1_000);
      expect(representative.atomFlowStats).toMatchObject({
        producers: 1_000,
        joinedProducerOutcomes: 1_000,
        unjoinedOpaqueFallbacks: 0,
        legacyIndexedDisagreements: 0,
        dataSinks: 0,
        escapes: 1_000,
        summaryMatches: 2_000,
      });
      const small = median(smallRuns.map((run) => run.elapsed));
      const large = median(largeRuns.map((run) => run.elapsed));
      expect(large).toBeLessThan(small * 8 + 30);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 10_000);

  it("indexes dense multi-clause callback results without repeated arrow scans", () => {
    const root = mkdtempSync(join(tmpdir(), "unused-atom-role-dense-callback-scaling-"));
    const file = "dense_atom_callback.ex";
    const measure = (count: number) => {
      const lines = [
        "defmodule NeutralScale.DenseAtomCallback do",
        "  def classify(entries, raw) do",
        "    Enum.reduce(entries, %{}, fn",
      ];
      const clauseLines: number[] = [];
      for (let index = 0; index < count; index += 1) {
        clauseLines.push(lines.length + 1);
        lines.push(`      {:tag_${index}, value}, acc -> Map.put(acc, value, String.to_atom(raw))`);
      }
      lines.push("    end) |> Map.has_key?(:known)", "  end", "end", "");
      writeFileSync(join(root, file), lines.join("\n"));
      const base = {
        k: "event" as const,
        kind: "remote" as const,
        file,
        from_mod: "NeutralScale.DenseAtomCallback",
        from_fun: "classify/2",
        partition: "prod" as const,
      };
      const events: TraceEvent[] = [
        ...clauseLines.flatMap((line) => [
          {
            ...base,
            line,
            to_mod: "String",
            name: "to_atom",
            arity: 1,
            dyn: true,
          },
          {
            ...base,
            line,
            to_mod: "Map",
            name: "put",
            arity: 3,
            dyn: false,
          },
        ]),
        {
          ...base,
          line: 3,
          to_mod: "Enum",
          name: "reduce",
          arity: 3,
          dyn: false,
        },
        {
          ...base,
          line: count + 4,
          to_mod: "Map",
          name: "has_key?",
          arity: 2,
          dyn: false,
        },
      ];
      const trace: TraceResult = {
        appMod: null,
        deps: [],
        compileOk: true,
        testPartition: "complete",
        modules: [mod("NeutralScale.DenseAtomCallback", file)],
        functions: [],
        events,
      };
      const started = performance.now();
      const extraction = extractElixirRuntimeConventions(root, trace);
      return { elapsed: performance.now() - started, extraction };
    };
    const median = (values: readonly number[]): number =>
      [...values].sort((left, right) => left - right)[Math.floor(values.length / 2)] ?? 0;

    try {
      measure(25);
      const smallRuns = [measure(250), measure(250), measure(250)];
      const largeRuns = [measure(1_000), measure(1_000), measure(1_000)];
      const representative = largeRuns[0]?.extraction;
      if (representative === undefined) throw new Error("missing dense callback scaling result");
      expect(representative.dynamicDispatches).toHaveLength(1_000);
      expect(representative.atomFlowStats).toMatchObject({
        producers: 1_000,
        joinedProducerOutcomes: 1_000,
        unjoinedOpaqueFallbacks: 0,
        legacyIndexedDisagreements: 0,
        dataSinks: 0,
        escapes: 1_000,
        summaryMatches: 2_000,
      });
      const small = median(smallRuns.map((run) => run.elapsed));
      const large = median(largeRuns.map((run) => run.elapsed));
      expect(large).toBeLessThan(small * 8 + 30);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 10_000);

  it("joins callback-fed input escapes near-linearly with constant semantic density", () => {
    const root = mkdtempSync(join(tmpdir(), "unused-atom-callback-input-scaling-"));
    const file = "many_callback_inputs.ex";
    const measure = (count: number) => {
      const lines = ["defmodule NeutralScale.CallbackInputs do"];
      const events: TraceEvent[] = [];
      for (let index = 0; index < count; index += 1) {
        const line = lines.length + 1;
        const variant = index % 3;
        const source =
          variant === 0
            ? `  def classify_${index}(raw), do: Map.update(%{selected: String.to_atom(raw)}, :selected, :known, fn selector -> selector end)`
            : variant === 1
              ? `  def classify_${index}(raw), do: [selected: String.to_atom(raw)] |> Keyword.update(:selected, :known, fn selector -> selector end)`
              : `  def classify_${index}(raw), do: Enum.map([String.to_atom(raw)], fn selector -> selector end)`;
        lines.push(source);
        const base = {
          k: "event" as const,
          kind: "remote" as const,
          file,
          line,
          from_mod: "NeutralScale.CallbackInputs",
          from_fun: `classify_${index}/1`,
          partition: "prod" as const,
        };
        events.push(
          {
            ...base,
            to_mod: "String",
            name: "to_atom",
            arity: 1,
            dyn: true,
          },
          {
            ...base,
            to_mod: variant === 0 ? "Map" : variant === 1 ? "Keyword" : "Enum",
            name: variant === 2 ? "map" : "update",
            arity: variant === 2 ? 2 : 4,
            dyn: false,
          },
        );
      }
      lines.push("end", "");
      writeFileSync(join(root, file), lines.join("\n"));
      const trace: TraceResult = {
        appMod: null,
        deps: [],
        compileOk: true,
        testPartition: "complete",
        modules: [mod("NeutralScale.CallbackInputs", file)],
        functions: [],
        events,
      };
      const started = performance.now();
      const extraction = extractElixirRuntimeConventions(root, trace);
      return { elapsed: performance.now() - started, extraction };
    };
    const median = (values: readonly number[]): number =>
      [...values].sort((left, right) => left - right)[Math.floor(values.length / 2)] ?? 0;

    try {
      measure(25);
      const series = [250, 500, 1_000, 2_000].map((count) => ({
        count,
        run: measure(count),
      }));
      for (const { count, run } of series) {
        expect(run.extraction.dynamicDispatches).toHaveLength(count);
        expect(run.extraction.atomFlowStats).toMatchObject({
          producers: count,
          joinedProducerOutcomes: count,
          unjoinedOpaqueFallbacks: 0,
          legacyIndexedDisagreements: 0,
          dataSinks: 0,
          invocationSinks: 0,
          escapes: count,
          summaryMatches: count,
        });
        expect(run.extraction.atomFlowStats.roleEdges).toBeLessThanOrEqual(count * 8);
        expect(run.extraction.atomFlowStats.queueVisits).toBeLessThanOrEqual(count * 8);
      }
      const smallRuns = [measure(250), measure(250), measure(250)];
      const largeRuns = [measure(2_000), measure(2_000), measure(2_000)];
      const small = median(smallRuns.map((run) => run.elapsed));
      const large = median(largeRuns.map((run) => run.elapsed));
      expect(large).toBeLessThan(small * 16 + 10);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 15_000);

  it("solves shared many-producer and many-use role graphs once", () => {
    const root = mkdtempSync(join(tmpdir(), "unused-atom-role-shared-scaling-"));
    const file = "shared_atom_roles.ex";
    const measure = (count: number) => {
      const lines = [
        "defmodule NeutralScale.SharedAtomRoles do",
        "  def classify(values, raw) do",
        "    computed = %{",
      ];
      const producerLines: number[] = [];
      for (let index = 0; index < count; index += 1) {
        producerLines.push(lines.length + 1);
        lines.push(`      key_${index}: String.to_atom(raw), # producer ${index}`);
      }
      lines.push("    }");
      const consumerLines: number[] = [];
      for (let index = 0; index < count; index += 1) {
        consumerLines.push(lines.length + 1);
        lines.push(`    _ = Map.has_key?(computed, :known) # consumer ${index}`);
      }
      lines.push("    values", "  end", "end", "");
      writeFileSync(join(root, file), lines.join("\n"));
      const base = {
        k: "event" as const,
        kind: "remote" as const,
        file,
        from_mod: "NeutralScale.SharedAtomRoles",
        from_fun: "classify/2",
        partition: "prod" as const,
      };
      const events: TraceEvent[] = [
        ...producerLines.map((line) => ({
          ...base,
          line,
          to_mod: "String",
          name: "to_atom",
          arity: 1,
          dyn: true,
        })),
        ...consumerLines.map((line) => ({
          ...base,
          line,
          to_mod: "Map",
          name: "has_key?",
          arity: 2,
          dyn: false,
        })),
      ];
      const trace: TraceResult = {
        appMod: null,
        deps: [],
        compileOk: true,
        testPartition: "complete",
        modules: [mod("NeutralScale.SharedAtomRoles", file)],
        functions: [],
        events,
      };
      const started = performance.now();
      const extraction = extractElixirRuntimeConventions(root, trace);
      return { elapsed: performance.now() - started, extraction };
    };
    const median = (values: readonly number[]): number =>
      [...values].sort((left, right) => left - right)[Math.floor(values.length / 2)] ?? 0;

    try {
      measure(25);
      const smallRuns = [measure(250), measure(250), measure(250)];
      const largeRuns = [measure(1_000), measure(1_000), measure(1_000)];
      const representative = largeRuns[0]?.extraction;
      if (representative === undefined) throw new Error("missing shared scaling result");
      expect(representative.dynamicDispatches).toHaveLength(1_000);
      expect(representative.atomFlowStats).toMatchObject({
        sources: 1,
        producers: 1_000,
        dataSinks: 1_000,
        invocationSinks: 0,
        escapes: 0,
        summaryMatches: 1_000,
      });
      expect(representative.atomFlowStats.roleEdges).toBeLessThan(4_010);
      expect(representative.atomFlowStats.queueVisits).toBeLessThan(6_020);
      const small = median(smallRuns.map((run) => run.elapsed));
      const large = median(largeRuns.map((run) => run.elapsed));
      expect(large).toBeLessThan(small * 8 + 30);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 10_000);

  it("joins many compiler-populated atom receiver events near-linearly", () => {
    const root = mkdtempSync(join(tmpdir(), "unused-atom-event-scaling-"));
    const file = "many_atom_events.ex";
    const measure = (count: number): number => {
      const functions = Array.from(
        { length: count },
        (_, index) => `  def run_${index}(name), do: String.to_existing_atom(name).run()\n`,
      ).join("");
      writeFileSync(
        join(root, file),
        ["defmodule NeutralScale.AtomEvents do\n", functions, "end\n"].join(""),
      );
      const events: TraceEvent[] = Array.from({ length: count }, (_, index) => ({
        k: "event",
        kind: "remote",
        file,
        line: index + 2,
        from_mod: "NeutralScale.AtomEvents",
        from_fun: `run_${index}/1`,
        to_mod: "String",
        name: "to_existing_atom",
        arity: 1,
        dyn: true,
        partition: "prod",
      }));
      const trace: TraceResult = {
        appMod: null,
        deps: [],
        compileOk: true,
        testPartition: "complete",
        modules: [mod("NeutralScale.AtomEvents", file)],
        functions: [],
        events,
      };
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

function ectoHexLock(version: string): string {
  return `%{\n  "ecto": ${ectoHexTuple(version)},\n}\n`;
}

function ectoHexTuple(version: string): string {
  return `{:hex, :ecto, "${version}", "neutral-checksum", [:mix], [], "hexpm", "neutral-outer-checksum"}`;
}
