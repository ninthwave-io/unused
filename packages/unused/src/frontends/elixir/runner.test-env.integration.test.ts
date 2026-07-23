/** Real-Mix coverage for the isolated `MIX_ENV=test` partition. */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { moneyElixirAtomRoleSummaryProvider } from "../plugins/money-conventions.js";
import type { ElixirAtomRoleSummaryProvider } from "./atom-role-summaries.js";
import { inspectMixLayout } from "./mix-isolation.js";
import { runTracer } from "./runner.js";
import { extractElixirRuntimeConventions } from "./runtime-references.js";
import { TRACER_SCRIPT } from "./tracer-script.js";

const MIX_AVAILABLE = spawnSync("mix", ["--version"], { encoding: "utf8" }).status === 0;

interface SnapshotEntry {
  readonly path: string;
  readonly type: "directory" | "file" | "symlink";
  readonly size: number;
  readonly mtimeMs: number;
  readonly content: string;
}

function snapshotTree(root: string): readonly SnapshotEntry[] {
  if (!existsSync(root)) return [];
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

function project(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(join(root, "lib"), { recursive: true });
  return root;
}

function write(root: string, path: string, contents: string): void {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, contents);
}

function basicMix(app: string, extra = ""): string {
  const module = app
    .split("_")
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join("");
  return `defmodule ${module}.MixProject do
  use Mix.Project
  def project, do: [app: :${app}, version: "0.1.0", elixir: "~> 1.17"${extra}]
end
`;
}

function expectMix(root: string, args: readonly string[], env: NodeJS.ProcessEnv = {}): void {
  const result = spawnSync("mix", args, {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  expect(result.status, result.stderr || result.stdout).toBe(0);
}

function withProcessEnv<T>(key: string, value: string, run: () => T): T {
  const prior = process.env[key];
  try {
    process.env[key] = value;
    return run();
  } finally {
    if (prior === undefined) delete process.env[key];
    else process.env[key] = prior;
  }
}

describe.skipIf(!MIX_AVAILABLE)("runTracer — isolated MIX_ENV=test", () => {
  const roots: string[] = [];
  afterAll(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  });

  it("compiles standard and custom support paths without starting the app or test_helper", {
    timeout: 60_000,
  }, () => {
    const root = project("unused-ex-test-paths-");
    roots.push(root);
    write(
      root,
      "mix.exs",
      `defmodule NeutralPaths.MixProject do
  use Mix.Project
  def project do
    [app: :neutral_paths, version: "0.1.0", elixir: "~> 1.17",
     elixirc_paths: elixirc_paths(Mix.env())]
  end
  def application, do: [mod: {NeutralPaths.Application, []}]
  defp elixirc_paths(:test), do: ["lib", "test/support", "neutral_helpers"]
  defp elixirc_paths(_), do: ["lib"]
end
`,
    );
    write(
      root,
      "lib/neutral_paths.ex",
      `defmodule NeutralPaths.Application do
  use Application
  def start(_type, _args), do: raise("consumer application must not start")
end

defmodule NeutralPaths.Subject do
  def standard, do: :standard
  def custom, do: :custom
end
`,
    );
    write(
      root,
      "test/support/standard_support.ex",
      `defmodule NeutralPaths.StandardSupport do
  defmacro value do
    quote do
      NeutralPaths.Subject.standard()
    end
  end
end
`,
    );
    write(
      root,
      "neutral_helpers/custom_support.ex",
      `defmodule NeutralPaths.CustomSupport do
  def value, do: NeutralPaths.Subject.custom()
end
`,
    );
    write(
      root,
      "test/test_helper.exs",
      `raise "test_helper must not be loaded"
`,
    );
    write(
      root,
      "test/paths_test.exs",
      `defmodule NeutralPathsTest do
  use ExUnit.Case
  require NeutralPaths.StandardSupport
  test "support paths compile" do
    assert NeutralPaths.StandardSupport.value() == :standard
    assert NeutralPaths.CustomSupport.value() == :custom
  end
end
`,
    );

    const trace = runTracer(root);
    expect(trace.testPartition).toBe("complete");
    expect(trace.modules.map((module) => [module.mod, module.file, module.partition])).toEqual(
      expect.arrayContaining([
        ["NeutralPaths.StandardSupport", "test/support/standard_support.ex", "test"],
        ["NeutralPaths.CustomSupport", "neutral_helpers/custom_support.ex", "test"],
        ["NeutralPathsTest", "test/paths_test.exs", "test"],
      ]),
    );
    expect(
      trace.events.some(
        (event) =>
          event.file === "test/paths_test.exs" &&
          event.to_mod === "NeutralPaths.Subject" &&
          event.name === "standard",
      ),
    ).toBe(true);
    expect(
      trace.events.some(
        (event) =>
          event.file === "neutral_helpers/custom_support.ex" &&
          event.to_mod === "NeutralPaths.Subject" &&
          event.name === "custom",
      ),
    ).toBe(true);
    expect(existsSync(join(root, "_build"))).toBe(false);
  });

  it("retains bounded test-environment edges from compatible production modules", {
    timeout: 60_000,
  }, () => {
    const root = project("unused-ex-test-conditional-edges-");
    roots.push(root);
    write(root, "mix.exs", basicMix("neutral_conditional_edges"));
    write(
      root,
      "lib/neutral_conditional_edges.ex",
      `defmodule NeutralConditionalEdges.Target do
  def direct, do: :direct
  def generated, do: :generated
end

defmodule NeutralConditionalEdges.Extension do
  defmacro __before_compile__(_env) do
    if Mix.env() == :test do
      Code.string_to_quoted!(
        "@neutral_generated NeutralConditionalEdges.Target.generated()",
        file: "neutral_generated"
      )
    else
      quote do: :ok
    end
  end
end

defmodule NeutralConditionalEdges.ConditionalExpansion do
  defmacro install do
    if Mix.env() == :test do
      quote do
        @neutral_direct NeutralConditionalEdges.Target.direct()
      end
    else
      quote do: :ok
    end
  end
end

defmodule NeutralConditionalEdges.DirectOwner do
  require NeutralConditionalEdges.ConditionalExpansion
  NeutralConditionalEdges.ConditionalExpansion.install()
  def stable, do: :stable
end

defmodule NeutralConditionalEdges.GeneratedOwner do
  @before_compile NeutralConditionalEdges.Extension
  def stable, do: :stable
end
`,
    );
    write(
      root,
      "test/conditional_edges_test.exs",
      `defmodule NeutralConditionalEdgesTest do
  use ExUnit.Case
  test "the neutral project compiles", do: assert(true)
end
`,
    );

    const trace = runTracer(root);
    expect(trace.testPartition).toBe("complete");
    expect(trace.testPartitionReason).toBeUndefined();
    expect(trace.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          partition: "test",
          file: "lib/neutral_conditional_edges.ex",
          from_mod: "NeutralConditionalEdges.DirectOwner",
          to_mod: "NeutralConditionalEdges.Target",
          name: "direct",
          arity: 0,
        }),
        expect.objectContaining({
          partition: "test",
          file: "lib/neutral_conditional_edges.ex",
          from_mod: "NeutralConditionalEdges.GeneratedOwner",
          to_mod: "NeutralConditionalEdges.Target",
          name: "generated",
          arity: 0,
        }),
      ]),
    );
    expect(trace.events.some((event) => event.file === "neutral_generated")).toBe(false);
    expect(existsSync(join(root, "_build"))).toBe(false);
  });

  it("discards an exact cross-phase duplicate with the same safe path-like template source", {
    timeout: 60_000,
  }, () => {
    const root = project("unused-ex-shared-macro-source-");
    roots.push(root);
    write(root, "mix.exs", basicMix("neutral_shared_source"));
    write(
      root,
      "lib/neutral_shared_source.ex",
      `defmodule NeutralSharedSource.Target do
  def value, do: :shared
end

defmodule NeutralSharedSource.Owner do
  require EEx
  EEx.function_from_file(:def, :render, Path.expand("priv/shared.eex"), [])
  def stable, do: :stable
end
`,
    );
    write(
      root,
      "priv/shared.eex",
      `<%= NeutralSharedSource.Target.value() %>
`,
    );
    write(
      root,
      "test/shared_source_test.exs",
      `defmodule NeutralSharedSourceTest do
  use ExUnit.Case
  test "the neutral project compiles", do: assert(true)
end
`,
    );

    const trace = runTracer(root);
    expect(trace.testPartition).toBe("complete");
    const sharedEvents = trace.events.filter(
      (event) =>
        event.from_mod === "NeutralSharedSource.Owner" &&
        event.to_mod === "NeutralSharedSource.Target" &&
        event.name === "value" &&
        event.arity === 0,
    );
    expect(sharedEvents).toEqual([
      expect.objectContaining({
        partition: "prod",
        file: "priv/shared.eex",
      }),
    ]);
    expect(sharedEvents[0]?.file).not.toBe("lib/neutral_shared_source.ex");
    expect(sharedEvents.some((event) => event.partition === "test")).toBe(false);
    expect(readFileSync(join(root, "priv/shared.eex"), "utf8")).toBe(
      `<%= NeutralSharedSource.Target.value() %>\n`,
    );
    expect(existsSync(join(root, "_build"))).toBe(false);
  });

  it("keeps a project with no test files complete without creating build artifacts", {
    timeout: 60_000,
  }, () => {
    const root = project("unused-ex-no-tests-");
    roots.push(root);
    write(root, "mix.exs", basicMix("neutral_no_tests"));
    write(
      root,
      "lib/neutral_no_tests.ex",
      "defmodule NeutralNoTests do\n  def value, do: :ok\nend\n",
    );

    const trace = runTracer(root);
    expect(trace.testPartition).toBe("complete");
    expect(trace.modules.some((module) => module.mod === "NeutralNoTests")).toBe(true);
    expect(existsSync(join(root, "_build"))).toBe(false);
  });

  it("reflects docs-disabled BEAM exports with zero fallback lines", {
    timeout: 60_000,
  }, () => {
    const root = project("unused-ex-docs-disabled-");
    roots.push(root);
    write(root, "mix.exs", basicMix("neutral_docs_disabled", ", elixirc_options: [docs: false]"));
    write(
      root,
      "lib/neutral_docs_disabled.ex",
      "defmodule NeutralDocsDisabled do\n  def value(argument \\\\ :neutral), do: argument\nend\n",
    );

    const trace = runTracer(root);
    expect(trace.testPartition).toBe("complete");
    expect(trace.modules).toContainEqual(
      expect.objectContaining({ mod: "NeutralDocsDisabled", line: 0 }),
    );
    expect(trace.functions).toContainEqual(
      expect.objectContaining({
        mod: "NeutralDocsDisabled",
        name: "value",
        arity: 0,
        line: 0,
        defaultTargetArity: 1,
      }),
    );
    expect(trace.functions).toContainEqual(
      expect.objectContaining({
        mod: "NeutralDocsDisabled",
        name: "value",
        arity: 1,
        line: 0,
        defaultTargetArity: null,
      }),
    );
    expect(existsSync(join(root, "_build"))).toBe(false);
  });

  it.each([
    ["compile-info chunk is missing", "missing_compile_info"],
    ["exports chunk is malformed", "malformed_exports"],
    ["behaviour attribute shape is malformed", "malformed_behaviour"],
    ["protocol attribute shape is malformed", "malformed_protocol"],
    ["implementation attribute shape is malformed", "malformed_impl"],
  ])("fails closed when %s", { timeout: 60_000 }, (_label, mutation) => {
    const root = project("unused-ex-malformed-beam-");
    roots.push(root);
    write(root, "mix.exs", basicMix("neutral_malformed_beam"));
    write(
      root,
      "lib/neutral_malformed_beam.ex",
      "defmodule NeutralMalformedBeam do\n  def value, do: :ok\nend\n",
    );
    expectMix(root, ["compile"]);

    const beam = join(
      root,
      "_build",
      "dev",
      "lib",
      "neutral_malformed_beam",
      "ebin",
      "Elixir.NeutralMalformedBeam.beam",
    );
    const mutateBeam = spawnSync(
      "elixir",
      [
        "-e",
        "[path, mutation] = System.argv(); " +
          "{:ok, _, chunks} = :beam_lib.all_chunks(String.to_charlist(path)); " +
          "replace = fn chunks, id, data -> Enum.map(chunks, fn {chunk_id, old} -> " +
          "if chunk_id == id, do: {chunk_id, data}, else: {chunk_id, old} end) end; " +
          "chunks = case mutation do " +
          '"missing_compile_info" -> Enum.reject(chunks, fn {id, _} -> id == ~c"CInf" end); ' +
          '"malformed_exports" -> replace.(chunks, ~c"ExpT", <<0>>); ' +
          '"malformed_behaviour" -> replace.(chunks, ~c"Attr", :erlang.term_to_binary([behaviour: NeutralMalformed])); ' +
          '"malformed_protocol" -> replace.(chunks, ~c"Attr", :erlang.term_to_binary([__protocol__: [fallback_to_any: :invalid]])); ' +
          '"malformed_impl" -> replace.(chunks, ~c"Attr", :erlang.term_to_binary([__impl__: [protocol: NeutralMalformed, for: "invalid"]])) ' +
          "end; " +
          "{:ok, binary} = :beam_lib.build_module(chunks); " +
          "File.write!(path, binary)",
        beam,
        mutation,
      ],
      { cwd: root, encoding: "utf8", env: process.env },
    );
    expect(mutateBeam.status, mutateBeam.stderr || mutateBeam.stdout).toBe(0);

    const reflectStart = TRACER_SCRIPT.indexOf("defmodule Unused.Reflect do");
    const reflectEnd = TRACER_SCRIPT.indexOf("defmodule Unused.Output do");
    expect(reflectStart).toBeGreaterThanOrEqual(0);
    expect(reflectEnd).toBeGreaterThan(reflectStart);
    const reflector = TRACER_SCRIPT.slice(reflectStart, reflectEnd);
    const script = join(root, "reflect_malformed_beam.exs");
    write(
      root,
      "reflect_malformed_beam.exs",
      `${reflector}
result = Unused.Reflect.dump_beam(fn _record -> :ok end, System.fetch_env!("BEAM_PATH"), File.cwd!(), "prod")
if result == {:error, :reflection}, do: System.halt(0), else: System.halt(1)
`,
    );
    const reflected = spawnSync("elixir", [script], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, BEAM_PATH: beam },
    });
    expect(reflected.status, reflected.stderr || reflected.stdout).toBe(0);
  });

  it("reflects protocol and implementation markers from persisted BEAM attributes", {
    timeout: 60_000,
  }, () => {
    const root = project("unused-ex-protocol-attributes-");
    roots.push(root);
    write(root, "mix.exs", basicMix("neutral_protocol_attributes"));
    write(
      root,
      "lib/neutral_protocol.ex",
      `defprotocol NeutralProtocol do
  def render(value)
end

defimpl NeutralProtocol, for: Atom do
  def render(value), do: Atom.to_string(value)
end
`,
    );

    const trace = runTracer(root);
    expect(trace.testPartition).toBe("complete");
    expect(trace.modules).toContainEqual(
      expect.objectContaining({
        mod: "NeutralProtocol",
        behaviours: ["Protocol"],
        protocol: true,
        impl: false,
      }),
    );
    expect(trace.modules).toContainEqual(
      expect.objectContaining({
        mod: "NeutralProtocol.Atom",
        behaviours: ["NeutralProtocol"],
        protocol: false,
        impl: true,
      }),
    );
    expect(existsSync(join(root, "_build"))).toBe(false);
  });

  it("bounds test discovery failures while retaining production facts", {
    timeout: 60_000,
  }, () => {
    const root = project("unused-ex-test-discovery-");
    roots.push(root);
    write(root, "mix.exs", basicMix("neutral_discovery"));
    write(
      root,
      "lib/neutral_discovery.ex",
      "defmodule NeutralDiscovery do\n  def value, do: :ok\nend\n",
    );
    write(root, "test", "not a directory\n");

    const trace = runTracer(root);
    expect(trace.testPartition).toBe("incomplete");
    expect(trace.testPartitionReason).toBe("layout");
    expect(trace.modules.some((module) => module.mod === "NeutralDiscovery")).toBe(true);
  });

  it("bounds a timed-out test child while retaining production facts", { timeout: 30_000 }, () => {
    const root = project("unused-ex-test-timeout-");
    roots.push(root);
    write(
      root,
      "mix.exs",
      `defmodule NeutralTimeout.MixProject do
  use Mix.Project
  def project, do: [app: :neutral_timeout, version: "0.1.0", elixirc_paths: paths(Mix.env())]
  defp paths(:test), do: ["lib", "test/support"]
  defp paths(_), do: ["lib"]
end
`,
    );
    write(
      root,
      "lib/neutral_timeout.ex",
      "defmodule NeutralTimeout do\n  def value, do: :ok\nend\n",
    );
    write(
      root,
      "test/support/slow_support.ex",
      "Process.sleep(6_000)\ndefmodule NeutralSlowSupport do\nend\n",
    );
    write(
      root,
      "test/timeout_test.exs",
      "defmodule NeutralTimeoutTest do\n  use ExUnit.Case\nend\n",
    );

    const trace = runTracer(root, { timeoutMs: 3_000 });
    expect(trace.testPartition).toBe("incomplete");
    expect(trace.testPartitionReason).toBe("timeout");
    expect(trace.modules.some((module) => module.mod === "NeutralTimeout")).toBe(true);
  });

  it("bounds missing required test-only dependency artifacts as partial", {
    timeout: 60_000,
  }, () => {
    const root = project("unused-ex-test-dep-");
    roots.push(root);
    write(
      root,
      "mix.exs",
      basicMix(
        "neutral_test_dep_host",
        ', deps: [{:neutral_test_dep, path: "neutral_test_dep", only: :test}]',
      ),
    );
    write(
      root,
      "lib/neutral_test_dep_host.ex",
      "defmodule NeutralTestDepHost do\n  def value, do: :ok\nend\n",
    );
    write(
      root,
      "test/host_test.exs",
      "defmodule NeutralTestDepHostTest do\n  use ExUnit.Case\nend\n",
    );
    write(root, "neutral_test_dep/mix.exs", basicMix("neutral_test_dep"));
    write(
      root,
      "neutral_test_dep/lib/neutral_test_dep.ex",
      "defmodule NeutralTestDep do\n  def value, do: :dep\nend\n",
    );

    const trace = runTracer(root);
    expect(trace.testPartition).toBe("incomplete");
    expect(trace.testPartitionReason).toBe("artifacts");
    expect(trace.modules.some((module) => module.mod === "NeutralTestDepHost")).toBe(true);
    expect(existsSync(join(root, "_build"))).toBe(false);
  });

  it("allows absent optional and compile-false/app-false dependency artifacts", {
    timeout: 60_000,
  }, () => {
    const root = project("unused-ex-optional-deps-");
    roots.push(root);
    write(
      root,
      "mix.exs",
      basicMix(
        "neutral_optional_host",
        ', deps: [{:neutral_optional_dep, path: "neutral_optional_dep", optional: true}, ' +
          '{:neutral_data_dep, path: "neutral_data_dep", compile: false, app: false}]',
      ),
    );
    write(
      root,
      "lib/neutral_optional_host.ex",
      "defmodule NeutralOptionalHost do\n  def value, do: :ok\nend\n",
    );
    write(
      root,
      "test/optional_test.exs",
      "defmodule NeutralOptionalHostTest do\n  use ExUnit.Case\nend\n",
    );
    write(root, "neutral_optional_dep/mix.exs", basicMix("neutral_optional_dep"));
    write(root, "neutral_data_dep/mix.exs", basicMix("neutral_data_dep"));

    const trace = runTracer(root);
    expect(trace.testPartition).toBe("complete");
    expect(trace.modules.some((module) => module.mod === "NeutralOptionalHost")).toBe(true);
    expect(existsSync(join(root, "_build"))).toBe(false);
  });

  it("accepts a compiled app:false dependency with no application resource", {
    timeout: 60_000,
  }, () => {
    const root = project("unused-ex-app-false-");
    roots.push(root);
    write(
      root,
      "mix.exs",
      basicMix(
        "neutral_app_false_host",
        ', deps: [{:neutral_app_false_dep, path: "neutral_app_false_dep", app: false}]',
      ),
    );
    write(
      root,
      "lib/neutral_app_false_host.ex",
      "defmodule NeutralAppFalseHost do\n  def value, do: NeutralAppFalseDep.value()\nend\n",
    );
    write(
      root,
      "test/app_false_test.exs",
      "defmodule NeutralAppFalseHostTest do\n  use ExUnit.Case\nend\n",
    );
    write(root, "neutral_app_false_dep/mix.exs", basicMix("neutral_app_false_dep"));
    write(
      root,
      "neutral_app_false_dep/lib/neutral_app_false_dep.ex",
      "defmodule NeutralAppFalseDep do\n  def value, do: :ok\nend\n",
    );

    const buildRoot = join(root, "app-false-build");
    expectMix(root, ["deps.compile"], { MIX_BUILD_ROOT: buildRoot });
    expectMix(root, ["compile"], { MIX_BUILD_ROOT: buildRoot });
    expectMix(root, ["deps.compile"], { MIX_ENV: "test", MIX_BUILD_ROOT: buildRoot });
    expectMix(root, ["compile"], { MIX_ENV: "test", MIX_BUILD_ROOT: buildRoot });
    rmSync(
      join(buildRoot, "dev", "lib", "neutral_app_false_dep", "ebin", "neutral_app_false_dep.app"),
      { force: true },
    );
    rmSync(
      join(buildRoot, "test", "lib", "neutral_app_false_dep", "ebin", "neutral_app_false_dep.app"),
      { force: true },
    );

    withProcessEnv("MIX_BUILD_ROOT", buildRoot, () => {
      const layout = inspectMixLayout("mix", root, join(root, "inspection-build"), 30_000);
      expect(layout.dependencyArtifacts).toEqual([
        expect.objectContaining({
          app: "neutral_app_false_dep",
          appResource: null,
          hex: false,
          otpApp: null,
          required: true,
        }),
      ]);
      const trace = runTracer(root);
      expect(trace.testPartition).toBe("complete");
    });
  });

  it("consults dependency application resources without trusting malformed or wrong identities", {
    timeout: 60_000,
  }, () => {
    const root = project("unused-ex-app-identity-");
    roots.push(root);
    write(
      root,
      "mix.exs",
      basicMix(
        "neutral_app_identity_host",
        ', deps: [{:neutral_app_identity_dep, path: "neutral_app_identity_dep"}]',
      ),
    );
    write(root, "lib/host.ex", "defmodule NeutralAppIdentityHost do\nend\n");
    write(root, "neutral_app_identity_dep/mix.exs", basicMix("neutral_app_identity_dep"));
    write(root, "neutral_app_identity_dep/lib/dep.ex", "defmodule NeutralAppIdentityDep do\nend\n");

    const buildRoot = join(root, "app-identity-build");
    expectMix(root, ["deps.compile"], { MIX_BUILD_ROOT: buildRoot });
    expectMix(root, ["compile"], { MIX_BUILD_ROOT: buildRoot });
    const appResource = join(
      buildRoot,
      "dev",
      "lib",
      "neutral_app_identity_dep",
      "ebin",
      "neutral_app_identity_dep.app",
    );
    const validApplication = readFileSync(appResource);

    withProcessEnv("MIX_BUILD_ROOT", buildRoot, () => {
      const inspect = () =>
        inspectMixLayout("mix", root, join(root, "identity-inspection"), 30_000)
          .dependencyArtifacts[0];
      expect(inspect()).toMatchObject({
        app: "neutral_app_identity_dep",
        hex: false,
        otpApp: "neutral_app_identity_dep",
      });

      const outsideResource = join(root, "outside-neutral-app.app");
      writeFileSync(outsideResource, validApplication);
      rmSync(appResource);
      symlinkSync(outsideResource, appResource);
      expect(inspect()).toMatchObject({ otpApp: null });
      rmSync(appResource);
      writeFileSync(appResource, validApplication);

      writeFileSync(appResource, "not an application term\n", "utf8");
      expect(inspect()).toMatchObject({ otpApp: null });

      writeFileSync(appResource, "{:application, :other_identity, []}.\n", "utf8");
      expect(inspect()).toMatchObject({ otpApp: null });

      rmSync(appResource);
      expect(inspect()).toMatchObject({ otpApp: null });
    });
  });

  it("inventories recursive compiler and OTP application ownership once", {
    timeout: 60_000,
  }, () => {
    const root = project("unused-ex-recursive-apps-");
    roots.push(root);
    write(
      root,
      "mix.exs",
      basicMix(
        "neutral_recursive_host",
        ', deps: [{:neutral_recursive_bridge, path: "neutral_recursive_bridge"}]',
      ),
    );
    write(root, "lib/host.ex", "defmodule NeutralRecursiveHost do\nend\n");
    write(
      root,
      "neutral_recursive_bridge/mix.exs",
      basicMix(
        "neutral_recursive_bridge",
        ', deps: [{:neutral_recursive_leaf, path: "../neutral_recursive_leaf"}]',
      ),
    );
    write(
      root,
      "neutral_recursive_bridge/lib/bridge.ex",
      "defmodule NeutralRecursiveBridge do\nend\n",
    );
    write(root, "neutral_recursive_leaf/mix.exs", basicMix("neutral_recursive_leaf"));
    write(root, "neutral_recursive_leaf/lib/leaf.ex", "defmodule NeutralRecursiveLeaf do\nend\n");

    const buildRoot = join(root, "recursive-build");
    expectMix(root, ["deps.compile"], { MIX_BUILD_ROOT: buildRoot });
    expectMix(root, ["compile"], { MIX_BUILD_ROOT: buildRoot });
    withProcessEnv("MIX_BUILD_ROOT", buildRoot, () => {
      const layout = inspectMixLayout("mix", root, join(root, "recursive-inspection"), 30_000);
      expect(
        layout.dependencyArtifacts.map(({ app, hex, otpApp }) => ({ app, hex, otpApp })),
      ).toEqual([
        { app: "neutral_recursive_bridge", hex: false, otpApp: "neutral_recursive_bridge" },
        { app: "neutral_recursive_leaf", hex: false, otpApp: "neutral_recursive_leaf" },
      ]);
    });
  });

  it("atomically joins a real Hex Mix dependency artifact to its exact aliased lock", {
    timeout: 60_000,
  }, () => {
    const root = project("unused-ex-hex-provider-");
    roots.push(root);
    write(
      root,
      "mix.exs",
      basicMix(
        "neutral_hex_host",
        ', deps: [{:neutral_money_alias, "1.15.0", hex: :money, runtime: false}]',
      ),
    );
    write(
      root,
      "mix.lock",
      `%{
  "neutral_money_alias": {:hex, :money, "1.15.0", "48ce20e3b0ab774fe8a41713869f70470365b899dcc80c6662c3c639cbe60bb8", [:mix], [], "hexpm", "25a0400bd518a0dab4166563f3bd8625376b69da23563070b67fadf363663533"},
}
`,
    );
    write(
      root,
      "lib/host.ex",
      "defmodule NeutralHexHost do\n  def run(raw), do: Money.new(100, String.to_atom(raw)) |> Map.fetch!(:currency) |> Atom.to_string()\nend\n",
    );
    write(
      root,
      "deps/neutral_money_alias/mix.exs",
      basicMix("neutral_money_alias").replace('version: "0.1.0"', 'version: "1.15.0"'),
    );
    write(
      root,
      "deps/neutral_money_alias/lib/money.ex",
      "defmodule Money do\n  def new(amount, currency), do: %{amount: amount, currency: currency}\nend\n",
    );
    // Public Hex SCM metadata for money 1.15.0; package source remains independently synthetic.
    writeFileSync(
      join(root, "deps/neutral_money_alias/.hex"),
      Buffer.from(
        "g2gCaAN3A2hleGECYQB0AAAABncEbmFtZW0AAAAFbW9uZXl3B3ZlcnNpb25tAAAABjEuMTUuMHcIbWFuYWdlcnNsAAAAAXcDbWl4ancOaW5uZXJfY2hlY2tzdW1tAAAAQDQ4Y2UyMGUzYjBhYjc3NGZlOGE0MTcxMzg2OWY3MDQ3MDM2NWI4OTlkY2M4MGM2NjYyYzNjNjM5Y2JlNjBiYjh3Dm91dGVyX2NoZWNrc3VtbQAAAEAyNWEwNDAwYmQ1MThhMGRhYjQxNjY1NjNmM2JkODYyNTM3NmI2OWRhMjM1NjMwNzBiNjdmYWRmMzYzNjYzNTMzdwRyZXBvbQAAAAVoZXhwbQ==",
        "base64",
      ),
    );

    expectMix(root, ["deps.compile", "neutral_money_alias"]);
    expectMix(root, ["compile"]);
    const trace = runTracer(root);
    expect(trace.hexDependencyApplications).toEqual([
      {
        compilerApp: "neutral_money_alias",
        otpApp: "neutral_money_alias",
        lockKey: "neutral_money_alias",
        hexPackage: "money",
        version: "1.15.0",
        innerChecksum: "48ce20e3b0ab774fe8a41713869f70470365b899dcc80c6662c3c639cbe60bb8",
        repository: "hexpm",
        outerChecksum: "25a0400bd518a0dab4166563f3bd8625376b69da23563070b67fadf363663533",
      },
    ]);

    const aliasProvider: ElixirAtomRoleSummaryProvider = {
      ...moneyElixirAtomRoleSummaryProvider,
      id: "convention:neutral-money-alias",
      compilerApp: "neutral_money_alias",
      otpApp: "neutral_money_alias",
      lockKey: "neutral_money_alias",
      summaries: moneyElixirAtomRoleSummaryProvider.summaries.map((summary) => ({
        ...summary,
        origin: {
          pluginId: "convention:neutral-money-alias",
          hexPackage: "money",
        },
      })),
    };
    const flow = (candidate: typeof trace) =>
      extractElixirRuntimeConventions(root, candidate, [aliasProvider]).dynamicDispatches.find(
        (fact) => fact.factKind === "computed-atom" && fact.fromFun === "run/1",
      );
    expect(flow(trace)).toMatchObject({ factKind: "computed-atom", flow: "data" });
    expect(
      flow({
        ...trace,
        hexDependencyApplications: (trace.hexDependencyApplications ?? []).map((application) => ({
          ...application,
          lockKey: "money",
        })),
      }),
    ).toMatchObject({ factKind: "computed-atom", flow: "escape" });
  });

  it("requires an application resource for an ordinary dependency", { timeout: 60_000 }, () => {
    const root = project("unused-ex-app-required-");
    roots.push(root);
    write(
      root,
      "mix.exs",
      basicMix(
        "neutral_app_required_host",
        ', deps: [{:neutral_app_required_dep, path: "neutral_app_required_dep"}]',
      ),
    );
    write(
      root,
      "lib/neutral_app_required_host.ex",
      "defmodule NeutralAppRequiredHost do\n  def value, do: :ok\nend\n",
    );
    write(
      root,
      "test/app_required_test.exs",
      "defmodule NeutralAppRequiredHostTest do\n  use ExUnit.Case\nend\n",
    );
    write(root, "neutral_app_required_dep/mix.exs", basicMix("neutral_app_required_dep"));
    write(
      root,
      "neutral_app_required_dep/lib/neutral_app_required_dep.ex",
      "defmodule NeutralAppRequiredDep do\n  def value, do: :ok\nend\n",
    );

    const buildRoot = join(root, "app-required-build");
    expectMix(root, ["deps.compile"], { MIX_BUILD_ROOT: buildRoot });
    expectMix(root, ["compile"], { MIX_BUILD_ROOT: buildRoot });
    expectMix(root, ["deps.compile"], { MIX_ENV: "test", MIX_BUILD_ROOT: buildRoot });
    expectMix(root, ["compile"], { MIX_ENV: "test", MIX_BUILD_ROOT: buildRoot });
    rmSync(
      join(
        buildRoot,
        "test",
        "lib",
        "neutral_app_required_dep",
        "ebin",
        "neutral_app_required_dep.app",
      ),
      { force: true },
    );

    withProcessEnv("MIX_BUILD_ROOT", buildRoot, () => {
      const trace = runTracer(root);
      expect(trace.testPartition).toBe("incomplete");
      expect(trace.testPartitionReason).toBe("artifacts");
      expect(trace.modules.some((module) => module.mod === "NeutralAppRequiredHost")).toBe(true);
    });
  });

  it.each([
    ["support", "test/support/broken_support.ex", 'raise "support compile failed"\n'],
    ["test", "test/broken_test.exs", 'raise "test compile failed"\n'],
  ])(
    "bounds a %s compile/runtime failure as partial",
    { timeout: 60_000 },
    (_kind, brokenPath, brokenSource) => {
      const root = project("unused-ex-test-failure-");
      roots.push(root);
      write(
        root,
        "mix.exs",
        `defmodule NeutralFailure.MixProject do
  use Mix.Project
  def project do
    [app: :neutral_failure, version: "0.1.0", elixirc_paths: elixirc_paths(Mix.env())]
  end
  defp elixirc_paths(:test), do: ["lib", "test/support"]
  defp elixirc_paths(_), do: ["lib"]
end
`,
      );
      write(
        root,
        "lib/neutral_failure.ex",
        "defmodule NeutralFailure do\n  def value, do: :ok\nend\n",
      );
      write(
        root,
        "test/subject_test.exs",
        "defmodule NeutralFailureTest do\n  use ExUnit.Case\nend\n",
      );
      write(root, brokenPath, brokenSource);

      const trace = runTracer(root);
      expect(trace.testPartition).toBe("incomplete");
      expect(trace.modules.some((module) => module.mod === "NeutralFailure")).toBe(true);
    },
  );

  it("bounds a compiler-rejected duplicate production/test module as a compile failure", {
    timeout: 60_000,
  }, () => {
    const root = project("unused-ex-test-collision-");
    roots.push(root);
    write(
      root,
      "mix.exs",
      `defmodule NeutralCollision.MixProject do
  use Mix.Project
  def project, do: [app: :neutral_collision, version: "0.1.0", elixirc_paths: paths(Mix.env())]
  defp paths(:test), do: ["lib", "test/support"]
  defp paths(_), do: ["lib"]
end
`,
    );
    write(
      root,
      "lib/neutral_collision.ex",
      "defmodule NeutralCollision do\n  def value, do: :prod\nend\n",
    );
    write(
      root,
      "test/support/collision.ex",
      "defmodule NeutralCollision do\n  def value, do: :test\nend\n",
    );
    write(
      root,
      "test/collision_test.exs",
      "defmodule NeutralCollisionTest do\n  use ExUnit.Case\nend\n",
    );

    const trace = runTracer(root);
    expect(trace.testPartition).toBe("incomplete");
    expect(trace.testPartitionReason).toBe("compile");
    expect(trace.modules.every((module) => module.partition === "prod")).toBe(true);
  });

  it("reflects a test BEAM even when the compiled module purges itself from the code server", {
    timeout: 60_000,
  }, () => {
    const root = project("unused-ex-test-reflection-");
    roots.push(root);
    write(root, "mix.exs", basicMix("neutral_reflection"));
    write(
      root,
      "lib/neutral_reflection.ex",
      "defmodule NeutralReflection do\n  def value, do: :ok\nend\n",
    );
    write(
      root,
      "test/reflection_test.exs",
      `defmodule NeutralReflectionTest do
  use ExUnit.Case
  @after_compile __MODULE__
  def __after_compile__(env, _bytecode) do
    :code.purge(env.module)
    :code.delete(env.module)
  end
end
`,
    );

    const trace = runTracer(root);
    expect(trace.testPartition).toBe("complete");
    expect(trace.modules).toContainEqual(
      expect.objectContaining({
        mod: "NeutralReflectionTest",
        file: "test/reflection_test.exs",
        partition: "test",
      }),
    );
    expect(existsSync(join(root, "_build"))).toBe(false);
  });

  it("uses distinct MIX_BUILD_ROOT dev/test artifacts without mutating either", {
    timeout: 60_000,
  }, () => {
    const root = project("unused-ex-custom-build-");
    roots.push(root);
    write(
      root,
      "mix.exs",
      `defmodule NeutralCustomBuild.MixProject do
  use Mix.Project
  def project do
    [app: :neutral_custom_build, version: "0.1.0", deps: deps(Mix.env())]
  end
  defp deps(:test), do: [{:neutral_test_dep, path: "neutral_test_dep"}]
  defp deps(_), do: [{:neutral_dev_dep, path: "neutral_dev_dep"}]
end
`,
    );
    write(
      root,
      "lib/neutral_custom_build.ex",
      "defmodule NeutralCustomBuild do\n  def value, do: :ok\nend\n",
    );
    write(
      root,
      "test/custom_test.exs",
      "defmodule NeutralCustomBuildTest do\n  use ExUnit.Case\nend\n",
    );
    write(root, "neutral_dev_dep/mix.exs", basicMix("neutral_dev_dep"));
    write(
      root,
      "neutral_dev_dep/lib/neutral_dev_dep.ex",
      "defmodule NeutralDevDep do\n  def value, do: :dev\nend\n",
    );
    write(root, "neutral_test_dep/mix.exs", basicMix("neutral_test_dep"));
    write(
      root,
      "neutral_test_dep/lib/neutral_test_dep.ex",
      "defmodule NeutralTestDep do\n  def value, do: :test\nend\n",
    );

    const customRoot = join(root, "custom-build-root");
    const customDev = join(customRoot, "dev");
    const testBuild = join(customRoot, "test");
    expectMix(root, ["deps.compile"], { MIX_BUILD_ROOT: customRoot });
    expectMix(root, ["compile"], { MIX_BUILD_ROOT: customRoot });
    expectMix(root, ["deps.compile"], { MIX_ENV: "test", MIX_BUILD_ROOT: customRoot });
    expectMix(root, ["compile"], { MIX_ENV: "test", MIX_BUILD_ROOT: customRoot });
    const devBefore = snapshotTree(customDev);
    const testBefore = snapshotTree(testBuild);
    expect(devBefore.some((entry) => entry.path.includes("neutral_dev_dep"))).toBe(true);
    expect(devBefore.some((entry) => entry.path.includes("neutral_test_dep"))).toBe(false);
    expect(testBefore.some((entry) => entry.path.includes("neutral_test_dep"))).toBe(true);
    expect(testBefore.some((entry) => entry.path.includes("neutral_dev_dep"))).toBe(false);

    withProcessEnv("MIX_BUILD_ROOT", customRoot, () => {
      const trace = runTracer(root);
      expect(trace.testPartition).toBe("complete");
    });

    expect(snapshotTree(customDev)).toEqual(devBefore);
    expect(snapshotTree(testBuild)).toEqual(testBefore);
  });

  it("honors an exact MIX_BUILD_PATH and the dependency's derived deps_build_path", {
    timeout: 60_000,
  }, () => {
    const root = project("unused-ex-exact-build-");
    roots.push(root);
    write(
      root,
      "mix.exs",
      basicMix("neutral_exact_build", ', deps: [{:neutral_exact_dep, path: "neutral_exact_dep"}]'),
    );
    write(
      root,
      "lib/neutral_exact_build.ex",
      "defmodule NeutralExactBuild do\n  def value, do: NeutralExactDep.value()\nend\n",
    );
    write(
      root,
      "test/exact_test.exs",
      "defmodule NeutralExactBuildTest do\n  use ExUnit.Case\nend\n",
    );
    write(root, "neutral_exact_dep/mix.exs", basicMix("neutral_exact_dep"));
    write(
      root,
      "neutral_exact_dep/lib/neutral_exact_dep.ex",
      "defmodule NeutralExactDep do\n  def value, do: :ok\nend\n",
    );

    const exactBuild = join(root, "exact-build");
    expectMix(root, ["deps.compile"], { MIX_BUILD_PATH: exactBuild });
    expectMix(root, ["compile"], { MIX_BUILD_PATH: exactBuild });
    expectMix(root, ["deps.compile"], { MIX_ENV: "test", MIX_BUILD_PATH: exactBuild });
    expectMix(root, ["compile"], { MIX_ENV: "test", MIX_BUILD_PATH: exactBuild });
    const before = snapshotTree(exactBuild);

    withProcessEnv("MIX_BUILD_PATH", exactBuild, () => {
      const devLayout = inspectMixLayout("mix", root, join(root, "inspect-dev"), 30_000);
      const testLayout = inspectMixLayout("mix", root, join(root, "inspect-test"), 30_000, "test");
      const expectedDepBuild = join(exactBuild, "lib", "neutral_exact_dep");
      expect(devLayout.buildPath).toBe(exactBuild);
      expect(testLayout.buildPath).toBe(exactBuild);
      expect(devLayout.dependencyArtifacts[0]?.buildPath).toBe(expectedDepBuild);
      expect(testLayout.dependencyArtifacts[0]?.buildPath).toBe(expectedDepBuild);
      expect(runTracer(root).testPartition).toBe("complete");
    });

    expect(snapshotTree(exactBuild)).toEqual(before);
  });

  it("follows and validates a dependency's custom app resource path", {
    timeout: 60_000,
  }, () => {
    const root = project("unused-ex-custom-app-");
    roots.push(root);
    write(
      root,
      "mix.exs",
      basicMix(
        "neutral_custom_app_host",
        ', deps: [{:neutral_custom_app_dep, path: "neutral_custom_app_dep", runtime: false, app: "custom/neutral_custom_app_dep.app"}]',
      ),
    );
    write(
      root,
      "lib/neutral_custom_app_host.ex",
      "defmodule NeutralCustomAppHost do\n  def value, do: NeutralCustomAppDep.value()\nend\n",
    );
    write(
      root,
      "test/custom_app_test.exs",
      "defmodule NeutralCustomAppHostTest do\n  use ExUnit.Case\nend\n",
    );
    write(root, "neutral_custom_app_dep/mix.exs", basicMix("neutral_custom_app_dep"));
    write(
      root,
      "neutral_custom_app_dep/lib/neutral_custom_app_dep.ex",
      "defmodule NeutralCustomAppDep do\n  def value, do: :ok\nend\n",
    );

    const buildRoot = join(root, "custom-app-build");
    for (const environment of ["dev", "test"] as const) {
      const depBuild = join(buildRoot, environment, "lib", "neutral_custom_app_dep");
      expectMix(join(root, "neutral_custom_app_dep"), ["compile"], {
        MIX_ENV: environment,
        MIX_BUILD_PATH: join(buildRoot, environment),
      });
      const customResource = join(depBuild, "custom", "neutral_custom_app_dep.app");
      mkdirSync(dirname(customResource), { recursive: true });
      copyFileSync(join(depBuild, "ebin", "neutral_custom_app_dep.app"), customResource);
    }

    withProcessEnv("MIX_BUILD_ROOT", buildRoot, () => {
      const testLayout = inspectMixLayout("mix", root, join(root, "inspect-test"), 30_000, "test");
      expect(testLayout.dependencyArtifacts[0]?.appResource).toBe(
        join(
          buildRoot,
          "test",
          "lib",
          "neutral_custom_app_dep",
          "custom",
          "neutral_custom_app_dep.app",
        ),
      );
      expect(runTracer(root).testPartition).toBe("complete");

      rmSync(
        join(
          buildRoot,
          "test",
          "lib",
          "neutral_custom_app_dep",
          "custom",
          "neutral_custom_app_dep.app",
        ),
      );
      const partial = runTracer(root);
      expect(partial.testPartition).toBe("incomplete");
      expect(partial.testPartitionReason).toBe("artifacts");

      const outsideResource = join(buildRoot, "test", "lib", "outside.app");
      copyFileSync(
        join(
          buildRoot,
          "dev",
          "lib",
          "neutral_custom_app_dep",
          "custom",
          "neutral_custom_app_dep.app",
        ),
        outsideResource,
      );
      write(
        root,
        "mix.exs",
        basicMix(
          "neutral_custom_app_host",
          ', deps: [{:neutral_custom_app_dep, path: "neutral_custom_app_dep", runtime: false, app: "../outside.app"}]',
        ),
      );
      expect(
        inspectMixLayout("mix", root, join(root, "inspect-escape"), 30_000, "test")
          .dependencyArtifacts[0],
      ).toMatchObject({ appResource: outsideResource, otpApp: null });
    });
  });

  it("honors MIX_TARGET with a shared build_per_environment dependency layout", {
    timeout: 60_000,
  }, () => {
    const root = project("unused-ex-target-shared-");
    roots.push(root);
    write(
      root,
      "mix.exs",
      `defmodule NeutralTargetShared.MixProject do
  use Mix.Project
  def project do
    [app: :neutral_target_shared, version: "0.1.0", build_per_environment: false,
     deps: [{:neutral_target_dep, path: "neutral_target_dep"}]]
  end
end
`,
    );
    write(
      root,
      "lib/neutral_target_shared.ex",
      "defmodule NeutralTargetShared do\n  def value, do: NeutralTargetDep.value()\nend\n",
    );
    write(
      root,
      "test/target_test.exs",
      "defmodule NeutralTargetSharedTest do\n  use ExUnit.Case\nend\n",
    );
    write(root, "neutral_target_dep/mix.exs", basicMix("neutral_target_dep"));
    write(
      root,
      "neutral_target_dep/lib/neutral_target_dep.ex",
      "defmodule NeutralTargetDep do\n  def value, do: :ok\nend\n",
    );

    const buildRoot = join(root, "target-build");
    const environment = { MIX_BUILD_ROOT: buildRoot, MIX_TARGET: "neutral" };
    expectMix(root, ["deps.compile"], environment);
    expectMix(root, ["compile"], environment);
    const sharedBuild = join(buildRoot, "neutral_shared");
    const before = snapshotTree(sharedBuild);

    withProcessEnv("MIX_BUILD_ROOT", buildRoot, () =>
      withProcessEnv("MIX_TARGET", "neutral", () => {
        const trace = runTracer(root);
        expect(trace.testPartition).toBe("complete");
      }),
    );

    expect(snapshotTree(sharedBuild)).toEqual(before);
  });
});
