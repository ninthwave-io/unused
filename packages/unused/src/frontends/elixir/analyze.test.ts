import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { computeDeletionPlan, whyAlive } from "../../core/analysis/index.js";
import { isMixAvailable } from "../../testing/corpus/elixir-corpus.js";
import { ConfigError } from "../ts/config.js";
import { analyzeElixirProject, analyzeElixirProjectWithGraph } from "./analyze.js";

const sourceFixture = fileURLToPath(
  new URL("../../../../../fixtures/elixir/basic-dead-function", import.meta.url),
);
const completeTestFixture = fileURLToPath(
  new URL("../../../../../fixtures/elixir/test-only-zombie", import.meta.url),
);
const incompleteTestFixture = fileURLToPath(
  new URL("../../../../../fixtures/elixir/incomplete-test-partition", import.meta.url),
);
const temporaryProjects: string[] = [];
const MIX_AVAILABLE = isMixAvailable();

async function copyFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "unused-elixir-policy-"));
  temporaryProjects.push(root);
  await cp(sourceFixture, root, { recursive: true });
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
          "selected subject has a live analysis-completeness reference at mix.exs:1",
      });
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
