import { describe, expect, it } from "vitest";
import {
  type ElixirAtomRoleSummary,
  type ElixirAtomRoleSummaryProvider,
  validateElixirAtomRoleSummaryProviders,
} from "../elixir/atom-role-summaries.js";
import { BUILT_IN_PLUGINS } from "./builtins.js";
import { collectElixirAtomRoleSummaryProviders } from "./elixir-role-summary-providers.js";
import type { ConventionPlugin } from "./types.js";

const origin = { pluginId: "convention:neutral", hexPackage: "neutral_dep" } as const;
const auditedRelease = (version = "1.2.3") => ({
  version,
  innerChecksum: "1".repeat(64),
  outerChecksum: "2".repeat(64),
});
const summary: ElixirAtomRoleSummary = {
  module: "Neutral.Dependency",
  name: "consume",
  arity: 1,
  arguments: { 0: "consume-data" },
  origin,
};
const provider: ElixirAtomRoleSummaryProvider = {
  id: "convention:neutral",
  compilerApp: "neutral_dep",
  otpApp: "neutral_dep",
  lockKey: "neutral_dep",
  hexPackage: "neutral_dep",
  repository: "hexpm",
  auditedReleases: [auditedRelease()],
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
  it("validates the complete built-in provider inventory without canonical collisions", () => {
    const conventions = BUILT_IN_PLUGINS.filter(
      (plugin): plugin is ConventionPlugin => plugin.kind === "convention",
    );
    expect(collectElixirAtomRoleSummaryProviders(conventions)).toMatchObject([
      { id: "convention:ecto", compilerApp: "ecto", hexPackage: "ecto", otpApp: "ecto" },
      {
        id: "convention:ex-money",
        compilerApp: "ex_money",
        hexPackage: "ex_money",
        otpApp: "ex_money",
      },
      { id: "convention:money", compilerApp: "money", hexPackage: "money", otpApp: "money" },
    ]);
  });

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
    [
      "malformed compiler app",
      { ...provider, compilerApp: "Neutral-Dep" },
      /invalid.*compiler app/,
    ],
    ["malformed OTP app", { ...provider, otpApp: "Neutral-Dep" }, /invalid.*OTP app/],
    ["malformed lock key", { ...provider, lockKey: "Neutral-Dep" }, /invalid.*lock key/],
    ["malformed package", { ...provider, hexPackage: "Neutral-Dep" }, /invalid.*Hex package/],
    ["private repository", { ...provider, repository: "private" }, /invalid.*repository/],
    ["empty releases", { ...provider, auditedReleases: [] }, /no audited releases/],
    [
      "version range",
      { ...provider, auditedReleases: [auditedRelease("~> 1.2")] },
      /invalid audited/,
    ],
    [
      "duplicate version",
      { ...provider, auditedReleases: [auditedRelease(), auditedRelease()] },
      /duplicate audited/,
    ],
    [
      "invalid inner checksum",
      { ...provider, auditedReleases: [{ ...auditedRelease(), innerChecksum: "checksum" }] },
      /invalid audited.*checksum/,
    ],
    [
      "invalid outer checksum",
      { ...provider, auditedReleases: [{ ...auditedRelease(), outerChecksum: "A".repeat(64) }] },
      /invalid audited.*checksum/,
    ],
    ["empty summaries", { ...provider, summaries: [] }, /no summaries/],
    [
      "empty supplemental releases",
      {
        ...provider,
        additionalReleaseGroups: [{ auditedReleases: [], summaries: [summary] }],
      },
      /empty additional release group/,
    ],
    [
      "overlapping supplemental release",
      {
        ...provider,
        additionalReleaseGroups: [{ auditedReleases: [auditedRelease()], summaries: [summary] }],
      },
      /duplicate audited/,
    ],
    [
      "empty supplemental summaries",
      {
        ...provider,
        additionalReleaseGroups: [{ auditedReleases: [auditedRelease("1.2.4")], summaries: [] }],
      },
      /no summaries/,
    ],
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
          { ...summary, origin: { pluginId: "convention:neutral", hexPackage: "other_dep" } },
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

  it("rejects duplicate providers but permits dependency-exclusive canonical collisions", () => {
    expect(() => validateElixirAtomRoleSummaryProviders([provider, provider])).toThrow(
      /duplicate Elixir atom role summary provider/,
    );
    const other = providerWith("convention:other", "other_dep", summary.module);
    expect(() => validateElixirAtomRoleSummaryProviders([provider, other])).not.toThrow();
  });
});

function providerWith(
  id: `convention:${string}`,
  hexPackage: string,
  module: string,
): ElixirAtomRoleSummaryProvider {
  return {
    id,
    compilerApp: hexPackage,
    otpApp: hexPackage,
    lockKey: hexPackage,
    hexPackage,
    repository: "hexpm",
    auditedReleases: [auditedRelease("1.0.0")],
    summaries: [
      {
        module,
        name: "consume",
        arity: 1,
        arguments: { 0: "consume-data" },
        origin: { pluginId: id, hexPackage },
      },
    ],
  };
}
