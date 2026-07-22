import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fileId } from "../../core/ir/index.js";
import {
  BUILT_IN_LANGUAGE_PLUGINS,
  BUILT_IN_PLUGINS,
  typescriptLanguagePlugin,
} from "./builtins.js";
import { PluginRegistry } from "./registry.js";
import type { RepositoryAnalysisContext } from "./types.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("built-in language plugins", () => {
  it("registers the compiled-in language set deterministically", () => {
    const registry = new PluginRegistry(BUILT_IN_LANGUAGE_PLUGINS);
    expect(registry.languagePlugins().map((plugin) => plugin.id)).toEqual([
      "language:elixir",
      "language:rust",
      "language:typescript",
    ]);
  });

  it("registers conventions and bridges without orchestrator edits", () => {
    const registry = new PluginRegistry(BUILT_IN_PLUGINS);
    expect(registry.conventionPlugins().map((plugin) => plugin.id)).toEqual([
      "convention:ecto",
      "convention:elixir-runtime",
      "convention:elixir-scripts",
      "convention:rustler-elixir",
      "convention:rustler-rust",
      "convention:typescript-config-carriers",
    ]);
    expect(registry.bridgePlugins().map((plugin) => plugin.id)).toEqual(["bridge:rustler"]);
  });

  it("discovers, analyzes, and rebases a nested TypeScript boundary", async () => {
    const root = await mkdtemp(join(tmpdir(), "unused-plugin-builtins-"));
    temporaryRoots.push(root);
    const project = join(root, "services", "web");
    await mkdir(join(project, "src"), { recursive: true });
    await writeFile(
      join(project, "package.json"),
      JSON.stringify({ name: "neutral-web", type: "module", main: "src/index.ts" }),
    );
    await writeFile(join(project, "src", "index.ts"), "export const live = true;\n");
    await writeFile(join(project, "src", "dead.ts"), "export const dead = true;\n");
    const context: RepositoryAnalysisContext = {
      rootDir: root,
      gitignore: true,
      manifests: {
        packageJsonDirs: [project],
        mixExsDirs: [],
        cargoTomlDirs: [],
        elixirSourceFiles: [],
        rustSourceFiles: [],
      },
      now: new Date(0),
      toolVersion: "0.1.0",
    };

    const boundaries = await typescriptLanguagePlugin.discover(context);
    expect(boundaries).toMatchObject([
      { id: "ts:services/web", rootRelDir: "services/web", manifest: "services/web/package.json" },
    ]);
    const boundary = boundaries[0];
    if (boundary === undefined) throw new Error("expected TypeScript boundary");
    const fragment = await typescriptLanguagePlugin.analyze(context, boundary);

    expect(fragment.graph.getNode(fileId("services/web/src/index.ts"))).toBeDefined();
    expect(fragment.claimInputs.analysisFiles).toEqual(
      new Set(["services/web/src/dead.ts", "services/web/src/index.ts"]),
    );
    expect(fragment.claimInputs.units).toEqual([
      { rootRelDir: "services/web", name: "neutral-web" },
    ]);
    expect(fragment.metadata).toMatchObject({ projectName: "neutral-web", fileCount: 2 });
  });
});
