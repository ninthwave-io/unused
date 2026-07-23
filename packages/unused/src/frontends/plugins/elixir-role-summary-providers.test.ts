import { describe, expect, it } from "vitest";
import {
  type ElixirAtomRoleSummary,
  type ElixirAtomRoleSummaryProvider,
  validateElixirAtomRoleSummaryProviders,
} from "../elixir/atom-role-summaries.js";
import { collectElixirAtomRoleSummaryProviders } from "./elixir-role-summary-providers.js";
import type { ConventionPlugin } from "./types.js";

const origin = { pluginId: "convention:neutral", dependency: "neutral_dep" } as const;
const summary: ElixirAtomRoleSummary = {
  module: "Neutral.Dependency",
  name: "consume",
  arity: 1,
  arguments: { 0: "consume-data" },
  origin,
};
const provider: ElixirAtomRoleSummaryProvider = {
  id: "convention:neutral",
  dependency: "neutral_dep",
  auditedVersions: ["1.2.3"],
  summaries: [summary],
};

function convention(
  id: string,
  semanticProvider?: ElixirAtomRoleSummaryProvider,
  languages: readonly string[] = ["ex"],
): ConventionPlugin {
  return {
    kind: "convention",
    id,
    version: "1",
    languages,
    ...(semanticProvider === undefined ? {} : { elixirAtomRoleSummaryProvider: semanticProvider }),
    applies: () => false,
    async analyze() {
      return {};
    },
  };
}

describe("Elixir atom role summary provider inventory", () => {
  it("collects an immutable inventory in plugin-id order independent of registration order", () => {
    const later = providerWith("convention:zeta", "zeta_dep", "Neutral.Zeta");
    const actual = collectElixirAtomRoleSummaryProviders([
      convention(later.id, later),
      convention("convention:unrelated"),
      convention(provider.id, provider),
    ]);

    expect(actual.map((entry) => entry.id)).toEqual(["convention:neutral", "convention:zeta"]);
    expect(Object.isFrozen(actual)).toBe(true);
    expect(() => (actual as ElixirAtomRoleSummaryProvider[]).push(provider)).toThrow();
  });

  it("rejects plugin ownership and language contract defects before analysis", () => {
    expect(() =>
      collectElixirAtomRoleSummaryProviders([convention("convention:other", provider)]),
    ).toThrow(/does not match plugin/);
    expect(() =>
      collectElixirAtomRoleSummaryProviders([convention(provider.id, provider, ["ts"])]),
    ).toThrow(/not an Elixir convention/);
  });

  it.each([
    ["malformed id", { ...provider, id: "ecto" as never }, /invalid.*provider id/],
    ["malformed dependency", { ...provider, dependency: "Neutral-Dep" }, /invalid.*dependency/],
    ["empty versions", { ...provider, auditedVersions: [] }, /no audited versions/],
    ["version range", { ...provider, auditedVersions: ["~> 1.2"] }, /invalid audited/],
    [
      "duplicate version",
      { ...provider, auditedVersions: ["1.2.3", "1.2.3"] },
      /duplicate audited/,
    ],
    ["empty summaries", { ...provider, summaries: [] }, /no summaries/],
    [
      "leading module whitespace",
      { ...provider, summaries: [{ ...summary, module: " Neutral.Dependency" }] },
      /invalid Elixir atom role summary module identity/,
    ],
    [
      "trailing function whitespace",
      { ...provider, summaries: [{ ...summary, name: "consume " }] },
      /invalid Elixir atom role summary function identity/,
    ],
    [
      "identity delimiter",
      { ...provider, summaries: [{ ...summary, name: "consume\0alias" }] },
      /invalid Elixir atom role summary function identity/,
    ],
    [
      "overlong identity",
      { ...provider, summaries: [{ ...summary, module: "N".repeat(256) }] },
      /invalid Elixir atom role summary module identity/,
    ],
    [
      "origin mismatch",
      {
        ...provider,
        summaries: [
          { ...summary, origin: { pluginId: "convention:neutral", dependency: "other_dep" } },
        ],
      },
      /not owned/,
    ],
    [
      "invalid role",
      { ...provider, summaries: [{ ...summary, arguments: { 0: "optimistic" as never } }] },
      /invalid Elixir atom argument role/,
    ],
    [
      "invalid callback audit",
      {
        ...provider,
        summaries: [
          {
            ...summary,
            arguments: {},
            implicitCallbackAudit: {
              inputArguments: [0],
              documentation: "file:///tmp/audit" as never,
            },
          },
        ],
      },
      /invalid callback documentation/,
    ],
    [
      "language collision",
      {
        ...provider,
        summaries: [{ ...summary, module: "Map", name: "get", arity: 2 }],
      },
      /duplicate Elixir atom role summary/,
    ],
  ])("rejects %s", (_name, malformed, message) => {
    expect(() =>
      validateElixirAtomRoleSummaryProviders([
        malformed as unknown as ElixirAtomRoleSummaryProvider,
      ]),
    ).toThrow(message as RegExp);
  });

  it("rejects duplicate providers and provider-to-provider canonical collisions", () => {
    expect(() => validateElixirAtomRoleSummaryProviders([provider, provider])).toThrow(
      /duplicate Elixir atom role summary provider/,
    );
    const other = providerWith("convention:other", "other_dep", summary.module);
    expect(() => validateElixirAtomRoleSummaryProviders([provider, other])).toThrow(
      /duplicate Elixir atom role summary/,
    );
  });
});

function providerWith(
  id: `convention:${string}`,
  dependency: string,
  module: string,
): ElixirAtomRoleSummaryProvider {
  return {
    id,
    dependency,
    auditedVersions: ["1.0.0"],
    summaries: [
      {
        module,
        name: "consume",
        arity: 1,
        arguments: { 0: "consume-data" },
        origin: { pluginId: id, dependency },
      },
    ],
  };
}
