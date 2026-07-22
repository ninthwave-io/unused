import { describe, expect, it } from "vitest";
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
        },
      ]),
    ).toThrow(/also has a value role/);
  });
});
