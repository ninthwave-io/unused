import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { ConfigError } from "../ts/config.js";
import { analyzeElixirProject } from "./analyze.js";

const sourceFixture = fileURLToPath(
  new URL("../../../../../fixtures/elixir/basic-dead-function", import.meta.url),
);
const temporaryProjects: string[] = [];

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

  it("uses shared project suppression, provenance, config hash, and gate semantics", async () => {
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
  }, 30_000);

  it("makes compiler-traced gitignored files unclaimable unless the audit escape hatch is used", async () => {
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
  }, 30_000);
});
