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

function traceDigest(trace: ReturnType<typeof runTracer>): string {
  return createHash("sha256").update(JSON.stringify(trace)).digest("hex");
}

function withSchedulers<T>(schedulers: string, run: () => T): T {
  const environment = process.env as NodeJS.ProcessEnv & { ERL_FLAGS?: string };
  const previous = environment.ERL_FLAGS;
  environment.ERL_FLAGS = `+S ${schedulers}`;
  try {
    return run();
  } finally {
    if (previous === undefined) delete environment.ERL_FLAGS;
    else environment.ERL_FLAGS = previous;
  }
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

  it("refuses clearly when a fetched dependency has no compiled artifacts", {
    timeout: 60_000,
  }, () => {
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

  it("keeps compiler ownership and reflected metadata deterministic cold and warm", {
    timeout: 60_000,
  }, () => {
    const projectDir = mkdtempSync(join(tmpdir(), "unused-ex-owner-stable-"));
    dirs.push(projectDir);
    mkdirSync(join(projectDir, "lib"));
    writeFileSync(
      join(projectDir, "mix.exs"),
      `defmodule NeutralOwnerStable.MixProject do
  use Mix.Project
  def project, do: [app: :neutral_owner_stable, version: "0.1.0"]
end
`,
    );
    writeFileSync(
      join(projectDir, "lib", "a_behaviours.ex"),
      `defmodule NeutralOwnerStable.Zulu do
  @callback zulu() :: atom()
end

defmodule NeutralOwnerStable.Alpha do
  @callback alpha() :: atom()
end
`,
    );
    writeFileSync(
      join(projectDir, "lib", "b_factory.ex"),
      `defmodule NeutralOwnerStable.Factory do
  defmacro emit(module) do
    quote do
      defmodule unquote(module) do
        def generated, do: :ok
      end
    end
  end
end
`,
    );
    writeFileSync(
      join(projectDir, "lib", "c_generated.ex"),
      `require NeutralOwnerStable.Factory
NeutralOwnerStable.Factory.emit(NeutralOwnerStable.Generated)
`,
    );
    writeFileSync(
      join(projectDir, "lib", "d_subject.ex"),
      `defmodule NeutralOwnerStable.Subject do
  @moduledoc "Neutral documentation"
  @behaviour NeutralOwnerStable.Zulu
  @behaviour NeutralOwnerStable.Alpha

  @doc "A neutral function"
  def value(input \\\\ :ok), do: input
  def alpha, do: :alpha
  def zulu, do: :zulu
  def select(:first), do: :first
  def select(_other), do: :other
end
`,
    );

    expect(existsSync(join(projectDir, "_build"))).toBe(false);
    const cold = withSchedulers("1:1", () => runTracer(projectDir));
    expect(existsSync(join(projectDir, "_build"))).toBe(false);

    const initialCompile = spawnSync("mix", ["compile"], { cwd: projectDir, encoding: "utf8" });
    expect(initialCompile.status, initialCompile.stderr).toBe(0);
    const buildPath = join(projectDir, "_build");
    const before = snapshotTree(buildPath);
    const warmRuns = ["1:1", "1:1", "4:4", "4:4"].map((schedulers) => {
      const trace = withSchedulers(schedulers, () => runTracer(projectDir));
      expect(snapshotTree(buildPath)).toEqual(before);
      return trace;
    });

    expect(new Set([cold, ...warmRuns].map(traceDigest)).size).toBe(1);
    const subject = cold.modules.find((module) => module.mod === "NeutralOwnerStable.Subject");
    expect(subject).toMatchObject({
      file: "lib/d_subject.ex",
      line: 1,
      behaviours: ["NeutralOwnerStable.Alpha", "NeutralOwnerStable.Zulu"],
    });
    expect(cold.modules.find((module) => module.mod === "NeutralOwnerStable.Generated")?.file).toBe(
      "lib/c_generated.ex",
    );
    expect(
      cold.functions
        .filter((fn) => fn.mod === "NeutralOwnerStable.Subject" && fn.name === "value")
        .map((fn) => [fn.arity, fn.line]),
    ).toEqual([
      [0, 7],
      [1, 7],
    ]);
    expect(
      cold.functions.find(
        (fn) => fn.mod === "NeutralOwnerStable.Subject" && fn.name === "select" && fn.arity === 1,
      )?.line,
    ).toBe(10);
  });

  it("accepts same-file redefinition but refuses a macro-generated cross-file collision", {
    timeout: 60_000,
  }, () => {
    const sameFileDir = mkdtempSync(join(tmpdir(), "unused-ex-owner-same-file-"));
    dirs.push(sameFileDir);
    mkdirSync(join(sameFileDir, "lib"));
    writeFileSync(
      join(sameFileDir, "mix.exs"),
      `defmodule NeutralOwnerSameFile.MixProject do
  use Mix.Project
  def project, do: [app: :neutral_owner_same_file, version: "0.1.0"]
end
`,
    );
    writeFileSync(
      join(sameFileDir, "lib", "subject.ex"),
      `defmodule NeutralOwnerSameFile.Subject do
  def first, do: :first
end

defmodule NeutralOwnerSameFile.Subject do
  def final, do: :final
end
`,
    );
    const sameOne = withSchedulers("1:1", () => runTracer(sameFileDir));
    const sameFour = withSchedulers("4:4", () => runTracer(sameFileDir));
    expect(traceDigest(sameOne)).toBe(traceDigest(sameFour));
    expect(
      sameOne.functions.some(
        (fn) => fn.mod === "NeutralOwnerSameFile.Subject" && fn.name === "final",
      ),
    ).toBe(true);
    expect(
      sameOne.functions.some(
        (fn) => fn.mod === "NeutralOwnerSameFile.Subject" && fn.name === "first",
      ),
    ).toBe(false);

    const collisionDir = mkdtempSync(join(tmpdir(), "unused-ex-owner-collision-"));
    dirs.push(collisionDir);
    mkdirSync(join(collisionDir, "lib"));
    writeFileSync(
      join(collisionDir, "mix.exs"),
      `defmodule NeutralOwnerCollision.MixProject do
  use Mix.Project
  def project, do: [app: :neutral_owner_collision, version: "0.1.0"]
end
`,
    );
    writeFileSync(
      join(collisionDir, "lib", "a_factory.ex"),
      `defmodule NeutralOwnerCollision.Factory do
  defmacro replace(module) do
    quote do
      defmodule unquote(module) do
        def replacement, do: :replacement
      end
    end
  end
end

defmodule NeutralOwnerCollision.Subject do
  def original, do: :original
end
`,
    );
    writeFileSync(
      join(collisionDir, "lib", "b_replacement.ex"),
      `require NeutralOwnerCollision.Factory
NeutralOwnerCollision.Factory.replace(NeutralOwnerCollision.Subject)
`,
    );
    for (const schedulers of ["1:1", "4:4"]) {
      expect(() => withSchedulers(schedulers, () => runTracer(collisionDir))).toThrow(
        /conflicting or incomplete module ownership|mix compile/,
      );
    }

    const testCollisionDir = mkdtempSync(join(tmpdir(), "unused-ex-test-owner-collision-"));
    dirs.push(testCollisionDir);
    mkdirSync(join(testCollisionDir, "lib"));
    mkdirSync(join(testCollisionDir, "test", "support"), { recursive: true });
    writeFileSync(
      join(testCollisionDir, "mix.exs"),
      `defmodule NeutralTestOwnerCollision.MixProject do
  use Mix.Project
  def project do
    [app: :neutral_test_owner_collision, version: "0.1.0", elixirc_paths: paths(Mix.env())]
  end
  defp paths(:test), do: ["lib", "test/support"]
  defp paths(_), do: ["lib"]
end
`,
    );
    writeFileSync(
      join(testCollisionDir, "lib", "subject.ex"),
      `defmodule NeutralTestOwnerCollision.Production do
  def value, do: :production
end
`,
    );
    writeFileSync(
      join(testCollisionDir, "test", "support", "a_factory.ex"),
      `defmodule NeutralTestOwnerCollision.Factory do
  defmacro replace(module) do
    quote do
      defmodule unquote(module) do
        def replacement, do: :replacement
      end
    end
  end
end

defmodule NeutralTestOwnerCollision.Subject do
  def original, do: :original
end
`,
    );
    writeFileSync(
      join(testCollisionDir, "test", "subject_test.exs"),
      `require NeutralTestOwnerCollision.Factory
NeutralTestOwnerCollision.Factory.replace(NeutralTestOwnerCollision.Subject)
`,
    );
    const testCollision = withSchedulers("1:1", () => runTracer(testCollisionDir));
    expect(testCollision).toMatchObject({
      testPartition: "incomplete",
      testPartitionReason: "ownership",
    });
    expect(
      testCollision.modules.some((module) => module.mod === "NeutralTestOwnerCollision.Production"),
    ).toBe(true);
    expect(
      testCollision.modules.some((module) => module.mod === "NeutralTestOwnerCollision.Subject"),
    ).toBe(false);
  });
});
