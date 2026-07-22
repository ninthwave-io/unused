import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { computeDeletionPlan, whyAlive } from "../../core/analysis/index.js";
import { isMixAvailable } from "../../testing/corpus/elixir-corpus.js";
import { ConfigError } from "../ts/config.js";
import { analyzeElixirProject, analyzeElixirProjectWithGraph } from "./analyze.js";
import { runTracer } from "./runner.js";

const sourceFixture = fileURLToPath(
  new URL("../../../../../fixtures/elixir/basic-dead-function", import.meta.url),
);
const completeTestFixture = fileURLToPath(
  new URL("../../../../../fixtures/elixir/test-only-zombie", import.meta.url),
);
const incompleteTestFixture = fileURLToPath(
  new URL("../../../../../fixtures/elixir/incomplete-test-partition", import.meta.url),
);
const testSupportFixture = fileURLToPath(
  new URL("../../../../../fixtures/elixir/test-support-paths", import.meta.url),
);
const onLoadFixture = fileURLToPath(
  new URL("../../../../../fixtures/elixir/on-load-beam-reflection", import.meta.url),
);
const scriptFixture = fileURLToPath(
  new URL("../../../../../fixtures/elixir/standalone-script-references", import.meta.url),
);
const temporaryProjects: string[] = [];
const MIX_AVAILABLE = isMixAvailable();

async function copyFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "unused-elixir-policy-"));
  temporaryProjects.push(root);
  await cp(sourceFixture, root, { recursive: true });
  return root;
}

async function copyFixtureFrom(source: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "unused-elixir-policy-"));
  temporaryProjects.push(root);
  await cp(source, root, { recursive: true });
  return root;
}

afterEach(async () => {
  await Promise.all(
    temporaryProjects.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("Elixir analysis policy", () => {
  it("validates config before invoking the compiler", async () => {
    const root = await mkdtemp(join(tmpdir(), "unused-elixir-invalid-config-"));
    temporaryProjects.push(root);
    await writeFile(join(root, "mix.exs"), "defmodule Invalid.MixProject do\nend\n");
    await writeFile(join(root, "unused.config.jsonc"), '{ "suppressions": "invalid" }');

    await expect(analyzeElixirProject(root)).rejects.toBeInstanceOf(ConfigError);
  });

  it.skipIf(!MIX_AVAILABLE)(
    "keeps standalone scripts dead while retaining their literal deletion prerequisites",
    async () => {
      const root = await copyFixtureFrom(scriptFixture);
      const analysis = await analyzeElixirProjectWithGraph(root, { now: new Date(0) });
      expect(
        analysis.result.claims
          .filter((claim) => claim.subject.kind === "file")
          .map((claim) => ({ file: claim.subject.loc.file, confidence: claim.confidence }))
          .sort((a, b) => a.file.localeCompare(b.file)),
      ).toEqual([
        { file: "lib/neutral_script/target.ex", confidence: "high" },
        { file: "scripts/module_caller.exs", confidence: "high" },
        { file: "scripts/module_surface.exs", confidence: "medium" },
        { file: "scripts/neutral_bench.exs", confidence: "high" },
        { file: "scripts/opaque.exs", confidence: "medium" },
      ]);
      expect(
        analysis.result.claims.some(
          (claim) => claim.subject.loc.file === "lib/mix/tasks/neutral.audit.ex",
        ),
      ).toBe(false);
      expect(analysis.graph.getNode("file:ignored/hidden.exs")).toBeUndefined();
      expect(
        analysis.reachability.production.reachableFiles.has("file:scripts/neutral_bench.exs"),
      ).toBe(false);
      expect(
        analysis.graph
          .entrypoints()
          .some(
            (entrypoint) =>
              entrypoint.file === "scripts/invoked.exs" &&
              entrypoint.reason === "config:taskfile:cmd",
          ),
      ).toBe(true);
      expect(
        analysis.graph
          .entrypoints()
          .filter((entrypoint) => entrypoint.file.startsWith("."))
          .map((entrypoint) => ({ file: entrypoint.file, reason: entrypoint.reason }))
          .sort((a, b) => a.file.localeCompare(b.file)),
      ).toEqual([
        { file: ".formatter.exs", reason: "elixir:formatter-config" },
        { file: ".iex.exs", reason: "elixir:iex-config" },
      ]);

      const scriptEdges = analysis.graph
        .edges()
        .filter(
          (edge) => edge.kind === "references" && edge.site.file === "scripts/neutral_bench.exs",
        );
      expect(scriptEdges.some((edge) => edge.site.span.startLine === 1)).toBe(true);
      expect(
        scriptEdges.some(
          (edge) => edge.referenceKind === "static" && edge.name === "NeutralScript.Target.zero/0",
        ),
      ).toBe(true);
      expect(
        scriptEdges.some(
          (edge) =>
            edge.referenceKind === "runtime-resolved" && edge.name === "NeutralScript.Target.one/1",
        ),
      ).toBe(true);

      expect(
        computeDeletionPlan({
          graph: analysis.graph,
          reachability: analysis.reachability,
          subject: { kind: "file", file: "lib/neutral_script/target.ex" },
        }),
      ).toMatchObject({
        supported: false,
        unsupportedReason:
          "non-re-export inbound reference remains at scripts/neutral_bench.exs:1; coordinated caller edits or deletion cohort are not modeled",
        reExportEdits: [],
        stages: [],
      });
      expect(
        computeDeletionPlan({
          graph: analysis.graph,
          reachability: analysis.reachability,
          subject: { kind: "file", file: "scripts/module_surface.exs" },
        }),
      ).toMatchObject({
        supported: false,
        unsupportedReason:
          "non-re-export inbound reference remains at scripts/module_caller.exs:1; coordinated caller edits or deletion cohort are not modeled",
      });

      const runnable = spawnSync("mix", ["run", "scripts/neutral_bench.exs"], {
        cwd: root,
        encoding: "utf8",
      });
      expect(runnable.status, runnable.stderr + runnable.stdout).toBe(0);

      await unlink(join(root, "lib/neutral_script/target.ex"));
      const dangling = spawnSync("mix", ["run", "scripts/neutral_bench.exs"], {
        cwd: root,
        encoding: "utf8",
      });
      expect(dangling.status).not.toBe(0);
      expect(dangling.stderr + dangling.stdout).toContain("NeutralScript.Target.zero/0");

      await unlink(join(root, "scripts/neutral_bench.exs"));
      const cohort = spawnSync("mix", ["compile", "--warnings-as-errors"], {
        cwd: root,
        encoding: "utf8",
      });
      expect(cohort.status, cohort.stderr + cohort.stdout).toBe(0);
    },
    60_000,
  );

  it.skipIf(!MIX_AVAILABLE)(
    "reflects failing-on-load modules from BEAM paths without executing their hooks",
    async () => {
      const root = await copyFixtureFrom(onLoadFixture);
      const marker = join(root, ".neutral-on-load-ran");
      const compile = spawnSync("mix", ["compile"], { cwd: root, encoding: "utf8" });
      expect(compile.status, compile.stderr || compile.stdout).toBe(0);
      expect(existsSync(marker)).toBe(false);

      const explicitLoad = spawnSync(
        "mix",
        [
          "run",
          "--no-start",
          "-e",
          "case Code.ensure_loaded(NeutralOnLoad.NativeBoundary) do " +
            "{:error, :on_load_failure} -> System.halt(0); " +
            "other -> IO.inspect(other); System.halt(1) end",
        ],
        { cwd: root, encoding: "utf8" },
      );
      expect(explicitLoad.status, explicitLoad.stderr || explicitLoad.stdout).toBe(0);
      expect(existsSync(marker)).toBe(true);
      await unlink(marker);

      const trace = runTracer(root);
      expect(trace.testPartition).toBe("complete");
      expect(trace.modules).toContainEqual(
        expect.objectContaining({
          mod: "NeutralOnLoad.NativeBoundary",
          behaviours: ["NeutralOnLoad.Callback"],
          protocol: false,
          impl: false,
        }),
      );
      const nativeFunctions = trace.functions.filter(
        (fn) => fn.mod === "NeutralOnLoad.NativeBoundary",
      );
      expect(nativeFunctions.map((fn) => `${fn.name}/${fn.arity}`)).toEqual([
        "perform/0",
        "reachable/0",
        "unused_sibling/0",
        "with_default/0",
        "with_default/1",
      ]);
      const defaultWrappers = nativeFunctions.filter((fn) => fn.name === "with_default");
      expect(defaultWrappers).toHaveLength(2);
      expect(defaultWrappers[0]?.line).toBeGreaterThan(0);
      expect(defaultWrappers[0]?.line).toBe(defaultWrappers[1]?.line);
      expect(existsSync(marker)).toBe(false);

      const analysis = await analyzeElixirProjectWithGraph(root, { now: new Date(0) });
      expect(analysis.result.run.boundaries).toEqual([
        expect.objectContaining({
          status: "complete",
          partitions: { production: "complete", config: "complete", test: "complete" },
        }),
      ]);
      const why = whyAlive({
        graph: analysis.graph,
        reachability: analysis.reachability,
        claims: analysis.result.claims,
        query: "NeutralOnLoad.NativeBoundary.reachable/0",
      });
      expect(why).toMatchObject({ outcome: "alive", entrypointKind: "production" });
      if (why.outcome !== "alive") throw new Error("expected production liveness");
      expect(why.paths[0]?.hops.map((hop) => hop.file)).toEqual([
        "lib/neutral_on_load/application.ex",
        "lib/neutral_on_load/native_boundary.ex",
      ]);

      const callbackWhy = whyAlive({
        graph: analysis.graph,
        reachability: analysis.reachability,
        claims: analysis.result.claims,
        query: "NeutralOnLoad.NativeBoundary.perform/0",
      });
      expect(callbackWhy).toMatchObject({ outcome: "alive", entrypointKind: "production" });
      if (callbackWhy.outcome !== "alive") throw new Error("expected behaviour callback liveness");
      expect(
        computeDeletionPlan({
          graph: analysis.graph,
          reachability: analysis.reachability,
          subject: callbackWhy.subject,
        }),
      ).toMatchObject({ supported: false });
      expect(existsSync(marker)).toBe(false);
    },
    60_000,
  );

  it.skipIf(!MIX_AVAILABLE)(
    "uses shared project suppression, provenance, config hash, and gate semantics",
    async () => {
      const root = await copyFixture();
      await writeFile(
        join(root, "unused.config.jsonc"),
        JSON.stringify({
          project: ["lib/**"],
          suppressions: [
            {
              files: ["lib/basic_dead/core.ex"],
              kinds: ["export"],
              reason: "retained compatibility API",
            },
          ],
          gate: { threshold: "medium" },
        }),
      );

      const run = await analyzeElixirProject(root, { now: new Date(0) });
      const claim = run.claims.find(
        (candidate) => candidate.subject.name === "BasicDead.Core.unused_helper/1",
      );
      expect(claim?.suppression).toEqual({
        reason: "retained compatibility API",
        source: "config",
        pattern: "lib/basic_dead/core.ex",
      });
      expect(run.run.configHash).not.toBe("elixir");
      expect(run.gateThreshold).toBe("medium");
    },
    30_000,
  );

  it.skipIf(!MIX_AVAILABLE)(
    "makes compiler-traced gitignored files unclaimable unless the audit escape hatch is used",
    async () => {
      const root = await copyFixture();
      await writeFile(join(root, ".gitignore"), "lib/basic_dead/core.ex\n");

      const normal = await analyzeElixirProject(root, { now: new Date(0) });
      expect(
        normal.claims.some((claim) => claim.subject.name === "BasicDead.Core.unused_helper/1"),
      ).toBe(false);

      const audit = await analyzeElixirProject(root, { now: new Date(0), gitignore: false });
      expect(
        audit.claims.some((claim) => claim.subject.name === "BasicDead.Core.unused_helper/1"),
      ).toBe(true);
    },
    30_000,
  );

  it.skipIf(!MIX_AVAILABLE)(
    "publishes partial test completeness and fails closed for potentially test-reachable subjects",
    async () => {
      const analysis = await analyzeElixirProjectWithGraph(incompleteTestFixture, {
        now: new Date(0),
      });
      expect(analysis.result.run.boundaries).toEqual([
        {
          status: "partial",
          pluginId: "language:elixir",
          boundaryId: "ex:.",
          language: "ex",
          fileCount: 2,
          workspaceCount: 1,
          partitions: { production: "complete", config: "complete", test: "incomplete" },
        },
      ]);
      expect(analysis.result.diagnostics).toEqual([
        expect.objectContaining({
          severity: "warning",
          code: "elixir-test-partition-incomplete",
          boundaryId: "ex:.",
        }),
      ]);
      expect(analysis.result.claims).toEqual([]);

      const why = whyAlive({
        graph: analysis.graph,
        reachability: analysis.reachability,
        claims: analysis.result.claims,
        query: "NeutralPartition.Subject.checked_only_in_test/0",
      });
      expect(why).toMatchObject({
        outcome: "alive",
        entrypointKind: "config",
        paths: [{ entrypointReason: "incomplete-test-partition" }],
      });
      if (why.outcome !== "alive") throw new Error("expected conservative liveness");
      expect(
        computeDeletionPlan({
          graph: analysis.graph,
          reachability: analysis.reachability,
          subject: why.subject,
        }),
      ).toMatchObject({
        supported: false,
        unsupportedReason:
          "non-re-export inbound reference remains at mix.exs:1; coordinated caller edits or deletion cohort are not modeled",
      });
    },
    30_000,
  );

  it.skipIf(!MIX_AVAILABLE)(
    "traces standard and custom effective test-support paths with why evidence",
    async () => {
      const analysis = await analyzeElixirProjectWithGraph(testSupportFixture, {
        now: new Date(0),
      });
      expect(analysis.result.run.boundaries).toEqual([
        {
          status: "complete",
          pluginId: "language:elixir",
          boundaryId: "ex:.",
          language: "ex",
          fileCount: 4,
          workspaceCount: 1,
          partitions: { production: "complete", config: "complete", test: "complete" },
        },
      ]);
      expect(analysis.result.diagnostics).toBeUndefined();
      expect(analysis.result.claims).toEqual([]);

      for (const [query, supportFile] of [
        ["NeutralSupport.Subject.reached_from_standard_support/0", "test/subject_test.exs"],
        [
          "NeutralSupport.Subject.reached_from_custom_support/0",
          "test/custom_helpers/custom_case.ex",
        ],
      ] as const) {
        const why = whyAlive({
          graph: analysis.graph,
          reachability: analysis.reachability,
          claims: analysis.result.claims,
          query,
        });
        expect(why).toMatchObject({
          outcome: "alive",
          entrypointKind: "test",
          testOnly: true,
          paths: [{ entrypointReason: "exunit-test" }],
        });
        if (why.outcome !== "alive") throw new Error("expected test-only liveness");
        expect(why.paths[0]?.hops.map((hop) => hop.file)).toEqual([
          supportFile,
          "lib/neutral_support/subject.ex",
        ]);
      }
    },
    30_000,
  );

  it.skipIf(!MIX_AVAILABLE)(
    "preserves the complete test fixture claim set apart from required 1.4 metadata",
    async () => {
      const run = await analyzeElixirProject(completeTestFixture, { now: new Date(0) });
      expect(run.run.boundaries).toEqual([
        {
          status: "complete",
          pluginId: "language:elixir",
          boundaryId: "ex:.",
          language: "ex",
          fileCount: 5,
          workspaceCount: 1,
          partitions: { production: "complete", config: "complete", test: "complete" },
        },
      ]);
      expect(run.diagnostics).toBeUndefined();
      expect(
        run.claims.map((claim) => ({
          id: claim.id,
          kind: claim.subject.kind,
          name: claim.subject.name,
          file: claim.subject.loc.file,
          verdict: claim.verdict,
          confidence: claim.confidence,
        })),
      ).toEqual([
        {
          id: "fil_d1b0e58873cafe99",
          kind: "file",
          name: "lib/tob/fixture_factory.ex",
          file: "lib/tob/fixture_factory.ex",
          verdict: "test-only",
          confidence: "high",
        },
        {
          id: "tst_b4a937dafa0c5a30",
          kind: "test",
          name: "test/fixture_factory_test.exs",
          file: "test/fixture_factory_test.exs",
          verdict: "test-only",
          confidence: "high",
        },
      ]);
    },
    30_000,
  );
});
