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
import { ElixirCompileError, runTracer } from "./runner.js";

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
  const structuralSummary = trace.structuralSummary;
  const stable =
    structuralSummary === undefined
      ? trace
      : {
          ...trace,
          structuralSummary: {
            ...structuralSummary,
            elapsedUs: 0,
            eventIndexUs: 0,
            fileExtractionUs: 0,
            emitUs: 0,
          },
        };
  return createHash("sha256").update(JSON.stringify(stable)).digest("hex");
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

const COLLISION_OWNERSHIP_REFUSAL =
  "cannot analyze Elixir project: the production tracer emitted conflicting or incomplete module ownership.";
const COLLISION_PROTOCOL_REFUSALS = new Set([
  "cannot analyze Elixir project: the production tracer emitted an incomplete or malformed phase protocol.",
  "cannot analyze Elixir project: the production tracer did not complete.",
]);
const COLLISION_COMPILE_REFUSAL =
  "cannot analyze Elixir project: `mix compile` reported errors. Fix the compile errors and ensure dependency build artifacts exist from a clean project compile, then retry.";

function expectCrossFileCollisionRefusal(run: () => unknown): void {
  let error: unknown;
  try {
    run();
  } catch (thrown) {
    error = thrown;
  }
  expect(error).toBeInstanceOf(ElixirCompileError);
  const message = (error as ElixirCompileError).message;
  const firstLine = message.split("\n", 1)[0] ?? "";
  const sanctioned =
    message === COLLISION_OWNERSHIP_REFUSAL ||
    COLLISION_PROTOCOL_REFUSALS.has(message) ||
    firstLine === COLLISION_COMPILE_REFUSAL ||
    message.startsWith("cannot analyze Elixir project: `mix compile` failed in ");
  expect(sanctioned, `unexpected cross-file collision refusal: ${message}`).toBe(true);
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
	def grapheme_result(name), do: "é😀#{name}"
  def through_private(value), do: normalize(value)
  def structural_roles(value) do
    (case value do
      nil -> render(0)
      rendered ->
        try do
          render(rendered)
        rescue
          ArgumentError -> render(0)
        end
    end)
    |> render()
  end
  def unsupported_control(value) do
    try do
      render(value)
    rescue
      ArgumentError -> :invalid
    else
      rendered -> rendered
    end
  end
  def unused_public, do: :unused
  defp normalize(value) do
    value
  end
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
    const structure = trace.structuralFiles?.find(
      (file) => file.file === "lib/neutral_isolation.ex",
    );
    expect(structure).toMatchObject({
      status: "complete",
      reason: null,
      bytes: Buffer.byteLength(readFileSync(join(projectDir, "lib", "neutral_isolation.ex"))),
    });
    expect(structure?.digest).toMatch(/^[a-f0-9]{64}$/u);
    expect(structure?.astNodes).toBeGreaterThan(0);
    expect(structure?.maxDepth).toBeGreaterThan(0);
    expect(structure?.carriers.some((carrier) => carrier.fun === "render/1")).toBe(true);
    expect(structure?.carriers.some((carrier) => carrier.fun === "normalize/1")).toBe(true);
    const graphemeCarrier = structure?.carriers.find(
      (carrier) => carrier.fun === "grapheme_result/1",
    );
    expect(graphemeCarrier?.body).toEqual({ sl: 15, sc: 2, el: 15, ec: 44 });
    // The quoted interpolation's internal `::` node is not an executable
    // source call. Its plain variable argument produces no value-flow fact;
    // the carrier span still proves Elixir/Node grapheme-column agreement.
    expect(structure?.facts.filter((fact) => fact.carrier === graphemeCarrier?.id)).toEqual([]);
    const roles = new Set(structure?.facts.map((fact) => fact.role));
    expect(roles).toEqual(
      new Set([
        "branch-result",
        "rescue-success",
        "rescue-result",
        "pipeline-argument",
        "carrier-result",
      ]),
    );
    const unsupportedCarrier = structure?.carriers.find(
      (carrier) => carrier.fun === "unsupported_control/1",
    );
    expect(unsupportedCarrier).toBeDefined();
    expect(structure?.facts.filter((fact) => fact.carrier === unsupportedCarrier?.id)).toEqual([]);
    expect(trace.structuralFiles?.map((file) => file.file)).toEqual([
      ...new Set(trace.modules.map((module) => module.file)),
    ]);
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

  it("accepts neutral structural spans across literals and token metadata", {
    timeout: 60_000,
  }, () => {
    const projectDir = mkdtempSync(join(tmpdir(), "unused-ex-span-matrix-"));
    dirs.push(projectDir);
    mkdirSync(join(projectDir, "lib"));
    writeFileSync(
      join(projectDir, "mix.exs"),
      `defmodule NeutralSpanMatrix.MixProject do
  use Mix.Project
  def project, do: [app: :neutral_span_matrix, version: "0.1.0"]
end
`,
    );
    writeFileSync(
      join(projectDir, "lib", "neutral_span_matrix.ex"),
      `defmodule NeutralSpanMatrix do
  def combined(value), do: "é👨‍👩‍👧‍👦#{value}"
  def modifier(value), do: "👍🏽#{value}"
  def regional(value), do: "🇬🇧#{value}"
  def keycap(value), do: "1️⃣#{value}"
  def heredoc(_value), do: """
  neutral #{inspect(String.trim(" value "))}
  """
  def charlist_heredoc(value), do: '''
  neutral #{value}
  '''
  def sigil(value), do: ~s|neutral #{value}|
  def literal_sigil(value), do: ~S|neutral #{value}|
  def wrap(value), do: value
  def alias_value, do: wrap(String)
  def qualified_alias, do: wrap(NeutralSpanMatrix.Nested)
  def wrapped_heredoc(value), do: wrap("""
  neutral #{value}
  """)
  def wrapped_tuple(value), do: wrap({:ok, value})
  def wrapped_map(value), do: wrap(%{value: value})
  def wrapped_binary(value), do: wrap(<<value::binary>>)
  def wrapped_fn(value), do: wrap(fn -> value end)
  def wrapped_case(value), do: wrap(case value do
    nil -> :none
    other -> other
  end)
  def multiline_call(value), do: inspect(
    value
  )
  def multiline_pipeline(value), do: value
  |> inspect()
  |> String.trim()
  def multiline_tuple(value), do: {
    :ok,
    String.trim(inspect(value))
  }
  def multiline_map(value), do: %{
    result: String.trim(inspect(value))
  }
  def binary(value), do: <<byte_size(String.trim(value))>>
  def branch(value) do
    case value do
      nil -> inspect(:none)
      other -> inspect(other)
    end
  end
  def rescue_value(value) do
    try do
      inspect(value)
    rescue
      ArgumentError -> inspect(:invalid)
    end
  end
  def anonymous(value), do: (fn
    nil -> String.trim(inspect(:none))
    other -> String.trim(inspect(other))
  end).(value)
  def trailing(value), do: inspect(value) # neutral
  def semicolon(value), do: (inspect(value); :ok)
end
`,
    );

    const trace = runTracer(projectDir, { timeoutMs: 60_000 });
    expect(trace.structuralFiles).toEqual([
      expect.objectContaining({ status: "complete", reason: null }),
    ]);
    const structure = trace.structuralFiles?.[0];
    expect(structure?.carriers).toHaveLength(27);
    const carrierByFunction = new Map(
      structure?.carriers.map((carrier) => [carrier.fun, carrier.id] as const),
    );
    expect(
      structure?.facts.some(
        (fact) =>
          fact.carrier === carrierByFunction.get("heredoc/1") &&
          fact.role === "call-argument" &&
          fact.resolution === "exact",
      ),
    ).toBe(true);
    for (const [fun, width] of [
      ["alias_value/0", "String".length],
      ["qualified_alias/0", "NeutralSpanMatrix.Nested".length],
    ] as const) {
      const aliasFact = structure?.facts.find(
        (fact) =>
          fact.carrier === carrierByFunction.get(fun) &&
          fact.role === "call-argument" &&
          fact.resolution === "exact",
      );
      expect(aliasFact, fun).toBeDefined();
      expect(aliasFact?.from.sl, fun).toBe(aliasFact?.from.el);
      expect((aliasFact?.from.ec ?? 0) - (aliasFact?.from.sc ?? 0), fun).toBe(width);
    }
    for (const fun of [
      "combined/1",
      "modifier/1",
      "regional/1",
      "keycap/1",
      "heredoc/1",
      "charlist_heredoc/1",
      "sigil/1",
      "literal_sigil/1",
    ]) {
      expect(
        structure?.facts.some(
          (fact) => fact.carrier === carrierByFunction.get(fun) && fact.role === "carrier-result",
        ),
        fun,
      ).toBe(false);
    }
    const wrapEventIdByCarrier = new Map(
      trace.structuralEvents
        ?.filter((event) => event.name === "wrap" && event.eventId !== undefined)
        .map((event) => [event.from_fun, event.eventId] as const),
    );
    for (const fun of ["wrapped_heredoc/1", "wrapped_tuple/1"]) {
      expect(
        structure?.facts.some(
          (fact) =>
            fact.carrier === carrierByFunction.get(fun) &&
            fact.eventId === wrapEventIdByCarrier.get(fun),
        ),
        fun,
      ).toBe(false);
    }
    for (const fun of ["wrapped_map/1", "wrapped_binary/1", "wrapped_fn/1", "wrapped_case/1"]) {
      expect(
        structure?.facts.some(
          (fact) =>
            fact.carrier === carrierByFunction.get(fun) &&
            fact.eventId === wrapEventIdByCarrier.get(fun) &&
            fact.resolution === "exact",
        ),
        fun,
      ).toBe(true);
    }
    for (const fun of ["multiline_tuple/1", "multiline_map/1", "binary/1"]) {
      expect(
        structure?.facts.some(
          (fact) =>
            fact.carrier === carrierByFunction.get(fun) &&
            fact.role === "call-argument" &&
            fact.resolution === "exact",
        ),
        fun,
      ).toBe(true);
    }
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
  def guarded(value \\\\ :ok) when is_atom(value) when value != :blocked, do: inspect(value)
  def mixed(:first) when is_atom(:first), do: inspect(:first)
  def mixed(other), do: inspect(other)

  defmodule Inner do
    def guarded(value) when is_atom(value), do: inspect(value)
  end

  defmodule Elixir.NeutralOwnerAbsolute do
    def guarded(value) when is_atom(value), do: inspect(value)
  end

  defmodule NeutralOwnerStable.Qualified do
    def guarded(value) when is_atom(value), do: inspect(value)
  end
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
    const subjectStructure = cold.structuralFiles?.find((file) => file.file === "lib/d_subject.ex");
    const carriers = subjectStructure?.carriers ?? [];
    expect(
      carriers.filter(
        (carrier) => carrier.mod === "NeutralOwnerStable.Subject" && carrier.fun === "guarded/1",
      ),
    ).toHaveLength(1);
    expect(
      carriers.filter(
        (carrier) => carrier.mod === "NeutralOwnerStable.Subject" && carrier.fun === "mixed/1",
      ),
    ).toHaveLength(2);
    expect(
      carriers.some(
        (carrier) =>
          carrier.mod === "NeutralOwnerStable.Subject.Inner" && carrier.fun === "guarded/1",
      ),
    ).toBe(true);
    expect(
      carriers.some(
        (carrier) => carrier.mod === "NeutralOwnerAbsolute" && carrier.fun === "guarded/1",
      ),
    ).toBe(true);
    expect(
      carriers.some(
        (carrier) =>
          carrier.mod === "NeutralOwnerStable.Subject.NeutralOwnerStable.Qualified" &&
          carrier.fun === "guarded/1",
      ),
    ).toBe(true);
    expect(
      carriers.some(
        (carrier) => carrier.mod === "NeutralOwnerStable.Subject" && carrier.fun === "guarded/0",
      ),
    ).toBe(false);
    for (const carrier of carriers.filter((candidate) => candidate.fun === "guarded/1")) {
      const facts = subjectStructure?.facts.filter((fact) => fact.carrier === carrier.id) ?? [];
      expect(facts).toHaveLength(1);
      expect(new Set(facts.map((fact) => fact.role))).toEqual(new Set(["carrier-result"]));
    }
  });

  it("accepts same-file redefinition but refuses a macro-generated cross-file collision", {
    timeout: 120_000,
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
    const sameOne = withSchedulers("1:1", () => runTracer(sameFileDir, { timeoutMs: 120_000 }));
    const sameFour = withSchedulers("4:4", () => runTracer(sameFileDir, { timeoutMs: 120_000 }));
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
    // Mix may compile the replacement before or after the original under
    // parallel load. Depending on that order, the compiler itself refuses,
    // the production phase cannot finish, or both owners reach validation.
    // Every sanctioned outcome is a fail-closed refusal; success is forbidden.
    for (const schedulers of ["1:1", "4:4", "1:1", "4:4"]) {
      expectCrossFileCollisionRefusal(() =>
        withSchedulers(schedulers, () => runTracer(collisionDir, { timeoutMs: 120_000 })),
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
