import { describe, expect, it } from "vitest";
import { PluginRegistry } from "./registry.js";
import {
  executePluginOperation,
  type LanguageFrontendPlugin,
  PluginExecutionError,
} from "./types.js";

function languagePlugin(id: string, language = id): LanguageFrontendPlugin {
  return {
    kind: "language",
    id,
    version: "1",
    language,
    capabilities: {
      files: true,
      symbols: true,
      dependencies: false,
      testPartition: true,
      configPartition: true,
      compilerExecution: false,
      mutation: false,
    },
    async discover() {
      return [];
    },
    async analyze() {
      throw new Error("not used by registry tests");
    },
  };
}

describe("PluginRegistry", () => {
  it("returns plugins in stable id order independent of registration order", () => {
    const registry = new PluginRegistry([
      languagePlugin("language:typescript", "ts"),
      languagePlugin("language:elixir", "ex"),
      {
        kind: "bridge",
        id: "bridge:rustler",
        version: "1",
        requiredLanguages: ["ex", "rs"],
        applies: () => true,
        async analyze() {
          return {};
        },
      },
    ]);

    expect(registry.plugins().map((plugin) => plugin.id)).toEqual([
      "bridge:rustler",
      "language:elixir",
      "language:typescript",
    ]);
    expect(registry.languagePlugins().map((plugin) => plugin.language)).toEqual(["ex", "ts"]);
    expect(registry.bridgePlugins().map((plugin) => plugin.id)).toEqual(["bridge:rustler"]);
    expect(registry.conventionPlugins()).toEqual([]);
  });

  it("rejects duplicate and malformed plugin ids", () => {
    const registry = new PluginRegistry([languagePlugin("language:typescript", "ts")]);
    expect(() => registry.register(languagePlugin("language:typescript", "ts"))).toThrow(
      "duplicate plugin id: language:typescript",
    );
    expect(() => registry.register(languagePlugin("TypeScript", "ts"))).toThrow(
      "invalid plugin id",
    );
    expect(() =>
      registry.register({ ...languagePlugin("language:rust", "rs"), version: "" }),
    ).toThrow("empty version");
  });

  it("attributes execution failures to the plugin and boundary", async () => {
    const failure = await executePluginOperation("language:elixir", "ex:apps/service", async () => {
      throw new Error("compiler refused");
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(PluginExecutionError);
    expect(failure).toMatchObject({
      pluginId: "language:elixir",
      boundaryId: "ex:apps/service",
      message: "plugin language:elixir failed for boundary ex:apps/service: compiler refused",
    });
  });
});
