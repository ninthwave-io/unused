import { describe, expect, it } from "vitest";
import { fileId, IRGraph, symbolId } from "../../core/ir/index.js";
import {
  ECTO_ADD_ERROR_AUDITED_RELEASES,
  ECTO_ADD_ERROR_AUDITED_VERSIONS,
  ectoElixirAtomRoleSummaryProvider,
  ectoElixirConventionPlugin,
  elixirRuntimeConventionPlugin,
  elixirScriptConventionPlugin,
} from "./elixir-conventions.js";
import type { FrontendGraphFragment, GraphContribution } from "./types.js";

const site = {
  file: "lib/neutral/runtime.ex",
  span: { start: 0, end: 0, startLine: 4, endLine: 4 },
};

describe("ectoElixirConventionPlugin", () => {
  it("owns a dependency-and-version-gated semantic-summary provider before graph emission", () => {
    expect(ectoElixirConventionPlugin).toMatchObject({
      id: "convention:ecto",
      kind: "convention",
      languages: ["ex"],
      elixirAtomRoleSummaryProvider: ectoElixirAtomRoleSummaryProvider,
    });
    expect(ectoElixirAtomRoleSummaryProvider.summaries.length).toBeGreaterThan(0);
    expect(
      ectoElixirAtomRoleSummaryProvider.auditedReleases.map((release) => release.version),
    ).toEqual(["3.14.1"]);
    expect(ECTO_ADD_ERROR_AUDITED_VERSIONS).toEqual([
      "3.12.0",
      "3.12.1",
      "3.12.2",
      "3.12.3",
      "3.12.4",
      "3.12.5",
      "3.12.6",
      "3.13.0",
      "3.13.1",
      "3.13.2",
      "3.13.3",
      "3.13.4",
      "3.13.5",
      "3.13.6",
      "3.14.0",
      "3.14.1",
    ]);
    expect(ECTO_ADD_ERROR_AUDITED_RELEASES).toHaveLength(16);
    expect(ectoElixirAtomRoleSummaryProvider.additionalReleaseGroups).toHaveLength(1);
    expect(
      ectoElixirAtomRoleSummaryProvider.additionalReleaseGroups?.[0]?.summaries.map(
        (summary) => `${summary.module}.${summary.name}/${summary.arity}`,
      ),
    ).toEqual(["Ecto.Changeset.add_error/3", "Ecto.Changeset.add_error/4"]);
    for (const summary of ectoElixirAtomRoleSummaryProvider.summaries) {
      expect(summary.origin).toEqual({ pluginId: "convention:ecto", hexPackage: "ecto" });
    }
    expect(
      ectoElixirAtomRoleSummaryProvider.summaries
        .filter((summary) => summary.name === "add_error")
        .map((summary) => [summary.arity, summary.arguments]),
    ).toEqual([
      [3, { 0: "propagate-to-result", 1: "propagate-to-result" }],
      [
        4,
        {
          0: "propagate-to-result",
          1: "propagate-to-result",
          3: "propagate-to-result",
        },
      ],
    ]);
    for (const audited of ECTO_ADD_ERROR_AUDITED_RELEASES) {
      expect(audited.innerChecksum).toMatch(/^[0-9a-f]{64}$/);
      expect(audited.outerChecksum).toMatch(/^[0-9a-f]{64}$/);
    }
  });
});

describe("elixirRuntimeConventionPlugin", () => {
  it("activates exactly the contribution prepared from the existing compiler trace", async () => {
    const contribution: GraphContribution = {
      edges: [
        {
          kind: "references",
          referenceKind: "runtime-resolved",
          from: symbolId("lib/neutral/runtime.ex", "Neutral.Runtime.callback/0"),
          to: symbolId("lib/neutral/callback.ex", "Neutral.Callback.call/1"),
          site,
          name: "Neutral.Callback.call/1",
        },
      ],
      hazards: [
        {
          file: fileId("lib/neutral/runtime.ex"),
          hazardClass: "elixir-dynamic-dispatch",
          detail: "neutral dynamic dispatch",
          site,
        },
      ],
    };
    const fragment = fixtureFragment(new Map([[elixirRuntimeConventionPlugin.id, contribution]]));
    const context = { repository: repository(), fragment };

    expect(await elixirRuntimeConventionPlugin.applies(context)).toBe(true);
    expect(await elixirRuntimeConventionPlugin.analyze(context)).toBe(contribution);
  });

  it("does not apply when the language frontend prepared no matching facts", async () => {
    const context = { repository: repository(), fragment: fixtureFragment() };
    expect(await elixirRuntimeConventionPlugin.applies(context)).toBe(false);
    expect(await elixirRuntimeConventionPlugin.analyze(context)).toEqual({});
  });
});

describe("elixirScriptConventionPlugin", () => {
  it("activates untraced script nodes and references prepared by the frontend", async () => {
    const contribution: GraphContribution = {
      nodes: [
        {
          kind: "file",
          id: fileId("scripts/neutral.exs"),
          path: "scripts/neutral.exs",
        },
      ],
      edges: [
        {
          kind: "references",
          referenceKind: "static",
          from: fileId("scripts/neutral.exs"),
          to: symbolId("lib/neutral/callback.ex", "Neutral.Callback.call/1"),
          site: { ...site, file: "scripts/neutral.exs" },
          name: "Neutral.Callback.call/1",
        },
      ],
    };
    const fragment = fixtureFragment(new Map([[elixirScriptConventionPlugin.id, contribution]]));
    const context = { repository: repository(), fragment };

    expect(await elixirScriptConventionPlugin.applies(context)).toBe(true);
    expect(await elixirScriptConventionPlugin.analyze(context)).toEqual(contribution);
  });
});

function repository() {
  return {
    rootDir: "/neutral",
    gitignore: true,
    manifests: {
      packageJsonDirs: [],
      mixExsDirs: ["/neutral"],
      cargoTomlDirs: [],
      elixirSourceFiles: [],
      rustSourceFiles: [],
    },
    now: new Date(0),
    toolVersion: "0.1.0",
  } as const;
}

function fixtureFragment(
  deferredContributions?: ReadonlyMap<string, GraphContribution>,
): FrontendGraphFragment {
  return {
    pluginId: "language:elixir",
    language: "ex",
    boundary: {
      id: "ex:fixture",
      language: "ex",
      rootDir: "/neutral",
      rootRelDir: "",
      manifest: "mix.exs",
      projectKind: "mix",
    },
    graph: new IRGraph(),
    provenance: {
      analyzer: "elixir-test",
      version: "0.1.0",
      generatedAt: new Date(0).toISOString(),
    },
    metadata: {
      projectName: "neutral",
      fileCount: 1,
      workspaceCount: 1,
      configHash: "test",
      gateThreshold: "high",
      completeness: { production: "complete", config: "complete", test: "complete" },
    },
    claimInputs: {
      fileLineCounts: new Map(),
      units: [{ rootRelDir: "", name: "neutral" }],
      analysisFiles: new Set(["lib/neutral/runtime.ex"]),
      claimableFiles: new Set(["lib/neutral/runtime.ex"]),
    },
    claimAnnotations: new Map(),
    ...(deferredContributions === undefined ? {} : { deferredContributions }),
    diagnostics: [],
  };
}
