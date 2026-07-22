import { describe, expect, it } from "vitest";
import { ectoElixirAtomRoleSummaryProvider } from "../plugins/elixir-conventions.js";
import {
  ELIXIR_ATOM_ROLE_SUMMARIES,
  type ElixirAtomRoleSummary,
  lookupElixirAtomRoleSummary,
  validateElixirAtomRoleSummaries,
} from "./atom-role-summaries.js";

const valid: ElixirAtomRoleSummary = {
  module: "Neutral.Collection",
  name: "read",
  arity: 2,
  arguments: { 0: "propagate-to-result", 1: "consume-data" },
  origin: { pluginId: "language:elixir" },
};

describe("Elixir computed-atom role summaries", () => {
  it("validates the shipped registry and performs exact sparse lookup", () => {
    expect(() => validateElixirAtomRoleSummaries(ELIXIR_ATOM_ROLE_SUMMARIES)).not.toThrow();
    expect(lookupElixirAtomRoleSummary("Map", "has_key?", 2)?.arguments).toEqual({
      0: "consume-data",
      1: "consume-data",
    });
    expect(lookupElixirAtomRoleSummary("Map", "has_key?", 3)).toBeUndefined();
    expect(lookupElixirAtomRoleSummary("Project.Map", "has_key?", 2)).toBeUndefined();
  });

  it("rejects duplicate callees, invalid positions, and overlapping callback roles", () => {
    expect(() => validateElixirAtomRoleSummaries([valid, valid])).toThrow(/duplicate/);
    expect(() =>
      validateElixirAtomRoleSummaries([{ ...valid, arguments: { 2: "consume-data" } }]),
    ).toThrow(/invalid Elixir atom role argument/);
    expect(() =>
      validateElixirAtomRoleSummaries([
        {
          ...valid,
          arguments: { 1: "consume-data" },
          callbackResults: { 1: "propagate-to-result" },
          callbackAudits: {
            1: {
              inputArguments: [],
              resultRole: "propagate-to-result",
              documentation: "https://hexdocs.pm/elixir/Enum.html",
            },
          },
        },
      ]),
    ).toThrow(/also has a value role/);
  });

  it("requires every callback result to have a fail-closed public semantics audit", () => {
    expect(() =>
      validateElixirAtomRoleSummaries([
        { ...valid, arguments: {}, callbackResults: { 1: "propagate-to-result" } },
      ]),
    ).toThrow(/result\/audit mismatch/);
    expect(() =>
      validateElixirAtomRoleSummaries([
        {
          ...valid,
          arguments: { 0: "consume-data" },
          callbackResults: { 1: "propagate-to-result" },
          callbackAudits: {
            1: {
              inputArguments: [0],
              resultRole: "propagate-to-result",
              documentation: "https://hexdocs.pm/elixir/Enum.html#map/2",
            },
          },
        },
      ]),
    ).toThrow(/callback-fed input 0 has an optimistic role/);
    expect(() =>
      validateElixirAtomRoleSummaries([
        {
          ...valid,
          arguments: {},
          callbackAudits: {
            1: {
              inputArguments: [],
              resultRole: "unknown" as never,
              documentation: "https://hexdocs.pm/elixir/1.20.2/Enum.html#map/2",
            },
          },
        },
      ]),
    ).toThrow(/invalid callback result role/);
    expect(() =>
      validateElixirAtomRoleSummaries([
        {
          ...valid,
          implicitCallbackAudit: {
            inputArguments: [0],
            documentation: "https://hexdocs.pm/elixir/Collectable.html",
          },
        },
      ]),
    ).toThrow(/callback-fed input 0 has an optimistic role/);
  });

  it("locks the complete callback-bearing registry to audited official semantics", () => {
    const all = [...ELIXIR_ATOM_ROLE_SUMMARIES, ...ectoElixirAtomRoleSummaryProvider.summaries];
    const actual = Object.fromEntries(
      all.flatMap((entry) =>
        Object.entries(entry.callbackAudits ?? {}).map(([callbackArgument, audit]) => [
          `${entry.module}.${entry.name}/${entry.arity}`,
          {
            callbackArgument: Number(callbackArgument),
            inputArguments: audit.inputArguments,
            resultRole: audit.resultRole,
            documentation: audit.documentation,
          },
        ]),
      ),
    );
    expect(actual).toEqual({
      "Map.get_lazy/3": callbackAudit(2, [], "Map.html#get_lazy/3"),
      "Map.put_new_lazy/3": callbackAudit(2, [], "Map.html#put_new_lazy/3"),
      "Map.update/4": callbackAudit(3, [0], "Map.html#update/4"),
      "Map.update!/3": callbackAudit(2, [0], "Map.html#update!/3"),
      "Map.get_and_update/3": callbackAudit(2, [0], "Map.html#get_and_update/3"),
      "Map.merge/3": callbackAudit(2, [0, 1], "Map.html#merge/3"),
      "Map.new/2": callbackAudit(1, [0], "Map.html#new/2"),
      "Keyword.get_lazy/3": callbackAudit(2, [], "Keyword.html#get_lazy/3"),
      "Keyword.put_new_lazy/3": callbackAudit(2, [], "Keyword.html#put_new_lazy/3"),
      "Keyword.update/4": callbackAudit(3, [0], "Keyword.html#update/4"),
      "Keyword.update!/3": callbackAudit(2, [0], "Keyword.html#update!/3"),
      "Keyword.merge/3": callbackAudit(2, [0, 1], "Keyword.html#merge/3"),
      "Keyword.new/2": callbackAudit(1, [0], "Keyword.html#new/2"),
      "MapSet.new/2": callbackAudit(1, [0], "MapSet.html#new/2"),
      "Enum.map/2": callbackAudit(1, [0], "Enum.html#map/2"),
      "Enum.flat_map/2": callbackAudit(1, [0], "Enum.html#flat_map/2", "escape"),
      "Enum.reduce/3": callbackAudit(2, [0, 1], "Enum.html#reduce/3", "escape"),
      "Enum.into/3": callbackAudit(2, [0], "Enum.html#into/3", "escape"),
    });

    expect(
      ectoElixirAtomRoleSummaryProvider.summaries.filter(
        (entry) => entry.callbackResults !== undefined || entry.callbackAudits !== undefined,
      ),
    ).toEqual([]);
    expect(
      Object.fromEntries(
        all
          .filter((entry) => entry.implicitCallbackAudit !== undefined)
          .map((entry) => [
            `${entry.module}.${entry.name}/${entry.arity}`,
            entry.implicitCallbackAudit,
          ]),
      ),
    ).toEqual({
      "Map.new/1": implicitAudit([0], `${ELIXIR_DOCS}/Enumerable.html`),
      "Keyword.new/1": implicitAudit([0], `${ELIXIR_DOCS}/Enumerable.html`),
      "MapSet.new/1": implicitAudit([0], `${ELIXIR_DOCS}/Enumerable.html`),
      "Enum.member?/2": implicitAudit([0, 1], `${ELIXIR_DOCS}/Enum.html#member?/2`),
      "Enum.into/2": implicitAudit([0, 1], `${ELIXIR_DOCS}/Enum.html#into/2`),
      "Enum.into/3": implicitAudit([1], `${ELIXIR_DOCS}/Collectable.html`),
      "Ecto.Changeset.change/1": implicitAudit([0], ECTO_CHANGESET_SOURCE),
      "Ecto.Changeset.change/2": implicitAudit([0, 1], ECTO_CHANGESET_SOURCE),
      "Ecto.Changeset.cast/3": implicitAudit([0, 1, 2], ECTO_CHANGESET_SOURCE),
      "Ecto.Changeset.cast/4": implicitAudit([0, 1, 2, 3], ECTO_CHANGESET_SOURCE),
      "Ecto.Changeset.put_change/3": implicitAudit([0, 2], ECTO_CHANGESET_SOURCE),
      "Ecto.Changeset.validate_inclusion/3": implicitAudit([0, 2], ECTO_CHANGESET_SOURCE),
      "Ecto.Changeset.validate_inclusion/4": implicitAudit([0, 2], ECTO_CHANGESET_SOURCE),
      "Ecto.Type.cast/2": implicitAudit([1], ECTO_TYPE_SOURCE),
      "Ecto.Type.load/2": implicitAudit([1], ECTO_TYPE_SOURCE),
      "Ecto.Type.dump/2": implicitAudit([1], ECTO_TYPE_SOURCE),
      "Ecto.Type.equal?/3": implicitAudit([1, 2], ECTO_TYPE_SOURCE),
      "Ecto.Type.embed_as/2": implicitAudit([1], ECTO_TYPE_SOURCE),
      "Ecto.Type.type/1": implicitAudit([], ECTO_TYPE_SOURCE),
    });
    expect(
      ectoElixirAtomRoleSummaryProvider.summaries
        .filter((entry) => entry.module === "Ecto.Type")
        .map((entry) => [`${entry.name}/${entry.arity}`, entry.arguments[0]]),
    ).toEqual([
      ["cast/2", "invocation-selector"],
      ["load/2", "invocation-selector"],
      ["dump/2", "invocation-selector"],
      ["equal?/3", "invocation-selector"],
      ["embed_as/2", "invocation-selector"],
      ["type/1", "invocation-selector"],
    ]);
  });
});

const ECTO_CHANGESET_SOURCE =
  "https://github.com/elixir-ecto/ecto/blob/v3.14.1/lib/ecto/changeset.ex";
const ECTO_TYPE_SOURCE = "https://github.com/elixir-ecto/ecto/blob/v3.14.1/lib/ecto/type.ex";
const ELIXIR_DOCS = "https://hexdocs.pm/elixir/1.20.2";

function implicitAudit(inputArguments: readonly number[], documentation: string) {
  return { inputArguments, documentation };
}

function callbackAudit(
  callbackArgument: number,
  inputArguments: readonly number[],
  path: string,
  resultRole: "propagate-to-result" | "escape" = "propagate-to-result",
): {
  readonly callbackArgument: number;
  readonly inputArguments: readonly number[];
  readonly resultRole: "propagate-to-result" | "escape";
  readonly documentation: string;
} {
  return {
    callbackArgument,
    inputArguments,
    resultRole,
    documentation: `${ELIXIR_DOCS}/${path}`,
  };
}
