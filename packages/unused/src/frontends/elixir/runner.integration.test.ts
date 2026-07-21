/**
 * Compiler-boundary regression coverage for ADR 0011.
 *
 * The fixture is generated independently from ordinary Mix conventions. It
 * proves that tracing leaves the consumer's `_build` byte-for-byte and
 * timestamp-for-timestamp unchanged, including consolidated protocols, and
 * that a subsequent warnings-as-errors compile remains green without cleanup.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { runTracer } from "./runner.js";

const MIX_AVAILABLE = spawnSync("mix", ["--version"], { encoding: "utf8" }).status === 0;

interface SnapshotEntry {
  readonly path: string;
  readonly type: "directory" | "file" | "symlink";
  readonly size: number;
  readonly mtimeMs: number;
  readonly content: string;
}

function snapshotTree(root: string): readonly SnapshotEntry[] {
  const entries: SnapshotEntry[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      const stat = lstatSync(path);
      const rel = relative(root, path);
      if (stat.isSymbolicLink()) {
        entries.push({
          path: rel,
          type: "symlink",
          size: stat.size,
          mtimeMs: stat.mtimeMs,
          content: readlinkSync(path),
        });
      } else if (stat.isDirectory()) {
        entries.push({
          path: rel,
          type: "directory",
          size: stat.size,
          mtimeMs: stat.mtimeMs,
          content: "",
        });
        walk(path);
      } else {
        entries.push({
          path: rel,
          type: "file",
          size: stat.size,
          mtimeMs: stat.mtimeMs,
          content: createHash("sha256").update(readFileSync(path)).digest("hex"),
        });
      }
    }
  };
  walk(root);
  return entries;
}

describe.skipIf(!MIX_AVAILABLE)("runTracer — isolated Mix build", () => {
  const dirs: string[] = [];
  afterAll(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });

  it("preserves build artifacts while exposing priv resources", { timeout: 60_000 }, () => {
    const projectDir = mkdtempSync(join(tmpdir(), "unused-ex-isolation-test-"));
    dirs.push(projectDir);
    mkdirSync(join(projectDir, "lib"));
    mkdirSync(join(projectDir, "priv"));
    const resourcePath = join(projectDir, "priv", "neutral-resource.txt");
    writeFileSync(resourcePath, "tracked neutral resource\n");
    writeFileSync(
      join(projectDir, "mix.exs"),
      `defmodule NeutralIsolation.MixProject do
  use Mix.Project
  def project, do: [app: :neutral_isolation, version: "0.1.0", elixir: "~> 1.17"]
end
`,
    );
    writeFileSync(
      join(projectDir, "lib", "neutral_isolation.ex"),
      `defprotocol NeutralIsolation.Renderable do
  def render(value)
end

defimpl NeutralIsolation.Renderable, for: Integer do
  def render(value), do: Integer.to_string(value)
end

defmodule NeutralIsolation do
  @resource Application.app_dir(:neutral_isolation, "priv/neutral-resource.txt")
  @resource_contents File.read!(@resource)

  def render(value), do: NeutralIsolation.Renderable.render(value)
  def resource_contents, do: @resource_contents
  def unused_public, do: :unused
end
`,
    );

    const initialCompile = spawnSync("mix", ["compile", "--warnings-as-errors"], {
      cwd: projectDir,
      encoding: "utf8",
    });
    expect(initialCompile.status, initialCompile.stderr).toBe(0);
    const buildPath = join(projectDir, "_build");
    const before = snapshotTree(buildPath);
    const resourceBefore = {
      contents: readFileSync(resourcePath, "utf8"),
      mtimeMs: lstatSync(resourcePath).mtimeMs,
    };

    const trace = runTracer(projectDir);
    expect(trace.modules.some((module) => module.mod === "NeutralIsolation")).toBe(true);
    expect(
      trace.functions.some(
        (fn) => fn.mod === "NeutralIsolation" && fn.name === "resource_contents" && fn.arity === 0,
      ),
    ).toBe(true);
    expect(snapshotTree(buildPath)).toEqual(before);
    expect(readFileSync(resourcePath, "utf8")).toBe(resourceBefore.contents);
    expect(lstatSync(resourcePath).mtimeMs).toBe(resourceBefore.mtimeMs);

    const subsequentCompile = spawnSync("mix", ["compile", "--warnings-as-errors"], {
      cwd: projectDir,
      encoding: "utf8",
    });
    expect(subsequentCompile.status, subsequentCompile.stderr).toBe(0);
    expect(subsequentCompile.stdout).not.toContain("Consolidated");
  });

  it("refuses clearly when a fetched dependency has no compiled artifacts", () => {
    const projectDir = mkdtempSync(join(tmpdir(), "unused-ex-missing-build-test-"));
    dirs.push(projectDir);
    mkdirSync(join(projectDir, "lib"));
    mkdirSync(join(projectDir, "neutral_dep", "lib"), { recursive: true });
    writeFileSync(
      join(projectDir, "mix.exs"),
      `defmodule NeutralMissingBuild.MixProject do
  use Mix.Project
  def project do
    [app: :neutral_missing_build, version: "0.1.0", deps: [{:neutral_dep, path: "neutral_dep"}]]
  end
end
`,
    );
    writeFileSync(
      join(projectDir, "lib", "neutral_missing_build.ex"),
      "defmodule NeutralMissingBuild do\n  require NeutralDep\n  def value, do: NeutralDep.value()\nend\n",
    );
    writeFileSync(
      join(projectDir, "neutral_dep", "mix.exs"),
      `defmodule NeutralDep.MixProject do
  use Mix.Project
  def project, do: [app: :neutral_dep, version: "0.1.0"]
end
`,
    );
    writeFileSync(
      join(projectDir, "neutral_dep", "lib", "neutral_dep.ex"),
      "defmodule NeutralDep do\n  defmacro value, do: :ok\nend\n",
    );

    expect(() => runTracer(projectDir)).toThrow(/dependency build artifacts exist from a clean/);
    expect(existsSync(join(projectDir, "_build"))).toBe(false);
  });
});
