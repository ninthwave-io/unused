/**
 * Unit tests for Elixir project detection and the config module-reference scan
 * (ADR 0011). No Elixir toolchain needed.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { scanConfigModuleReferences } from "./analyze.js";
import { detectElixirProject, isElixirProject } from "./detect.js";

const tmpDirs: string[] = [];
function tempProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "unused-ex-detect-"));
  tmpDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
});

describe("detectElixirProject", () => {
  it("detects a directory with a mix.exs", () => {
    const dir = tempProject();
    writeFileSync(join(dir, "mix.exs"), "defmodule X.MixProject do\nend\n");
    const project = detectElixirProject(dir);
    expect(project?.projectDir).toBe(dir);
    expect(project?.mixExsPath).toBe(join(dir, "mix.exs"));
    expect(isElixirProject(dir)).toBe(true);
  });

  it("returns null for a directory without a mix.exs", () => {
    const dir = tempProject();
    writeFileSync(join(dir, "package.json"), "{}");
    expect(detectElixirProject(dir)).toBeNull();
    expect(isElixirProject(dir)).toBe(false);
  });
});

describe("scanConfigModuleReferences", () => {
  it("keeps alive project modules named in config/*.exs", () => {
    const dir = tempProject();
    mkdirSync(join(dir, "config"));
    writeFileSync(
      join(dir, "config", "config.exs"),
      [
        "import Config",
        'config :my_app, MyApp.Repo, database: "x"',
        "config :my_app, ecto_repos: [MyApp.Repo]",
        'config :my_app, MyApp.Endpoint, url: [host: "localhost"]',
      ].join("\n"),
    );
    const projectModules = new Set(["MyApp.Repo", "MyApp.Endpoint", "MyApp.Unmentioned"]);
    const referenced = scanConfigModuleReferences(dir, projectModules);
    expect(referenced.has("MyApp.Repo")).toBe(true);
    expect(referenced.has("MyApp.Endpoint")).toBe(true);
    expect(referenced.has("MyApp.Unmentioned")).toBe(false);
  });

  it("returns an empty set when there is no config directory", () => {
    const dir = tempProject();
    expect(scanConfigModuleReferences(dir, new Set(["MyApp.Repo"])).size).toBe(0);
  });

  it("ignores non-project module tokens", () => {
    const dir = tempProject();
    mkdirSync(join(dir, "config"));
    writeFileSync(join(dir, "config", "runtime.exs"), "config :logger, Logger, level: :info\n");
    // Logger is a stdlib module, not a project module — must not be returned.
    const referenced = scanConfigModuleReferences(dir, new Set(["MyApp.Repo"]));
    expect(referenced.size).toBe(0);
  });
});
