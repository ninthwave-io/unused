import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import type { FormatsPlugin } from "ajv-formats";
import { afterEach, describe, expect, it } from "vitest";
import { computeDeletionPlan, whyAlive } from "../../core/analysis/index.js";
import { isMixAvailable } from "../../testing/corpus/elixir-corpus.js";
import { analyzeProjectAutoWithGraph } from "../dispatch.js";
import type { ElixirAtomRoleSummaryProvider } from "../elixir/atom-role-summaries.js";
import { BUILT_IN_PLUGINS } from "./builtins.js";
import type { AnalyzerPlugin, ConventionPlugin } from "./types.js";

const temporaryRoots: string[] = [];
const addFormats = createRequire(import.meta.url)("ajv-formats") as FormatsPlugin;
const claimRunSchema = JSON.parse(
  readFileSync(new URL("../../core/claims/schema/claim-run.schema.json", import.meta.url), "utf8"),
) as object;

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe.skipIf(!isMixAvailable())("Elixir semantic-provider topology parity", () => {
  it("activates an exact synthetic ex_money artifact for why and deletion planning", {
    timeout: 120_000,
  }, async () => {
    const repository = await mkdtemp(join(tmpdir(), "unused-provider-ex-money-"));
    temporaryRoots.push(repository);
    await writeExactExMoneyProject(repository);
    compileMixProject(repository);

    const analysis = await analyzeProjectAutoWithGraph(repository, { now: new Date(0) });
    expect(
      analysis.graph
        .hazards()
        .filter((hazard) => hazard.hazardClass === "elixir-computed-atom-escape"),
    ).toEqual([]);

    for (const query of [
      "NeutralProvider.Flow.amount_first/1",
      "NeutralProvider.Flow.currency_first/1",
    ]) {
      const alive = whyAlive({
        graph: analysis.graph,
        reachability: analysis.reachability,
        claims: analysis.result.claims,
        query,
        hazardEvaluations: analysis.hazardEvaluations,
      });
      expect(alive).toMatchObject({ outcome: "alive", entrypointKind: "production" });
      if (alive.outcome !== "alive") throw new Error("expected exact provider flow to be alive");
      expect(
        computeDeletionPlan({
          graph: analysis.graph,
          reachability: analysis.reachability,
          subject: alive.subject,
          hazardEvaluations: analysis.hazardEvaluations,
        }),
      ).toMatchObject({ supported: false, stages: [] });
    }

    const dead = whyAlive({
      graph: analysis.graph,
      reachability: analysis.reachability,
      claims: analysis.result.claims,
      query: "NeutralProvider.Flow.genuinely_unused/0",
      hazardEvaluations: analysis.hazardEvaluations,
    });
    expect(dead).toMatchObject({ outcome: "dead", confidence: "high" });
    if (dead.outcome !== "dead") throw new Error("expected isolated dead control");
    expect(
      computeDeletionPlan({
        graph: analysis.graph,
        reachability: analysis.reachability,
        subject: dead.subject,
        hazardEvaluations: analysis.hazardEvaluations,
      }),
    ).toMatchObject({ supported: true });
  });

  it("refuses the same lock-only neutral provider in root, nested, and mixed boundaries", {
    timeout: 120_000,
  }, async () => {
    const outcomes = [];
    for (const topology of ["root", "nested", "mixed"] as const) {
      const repository = await mkdtemp(join(tmpdir(), `unused-provider-${topology}-`));
      temporaryRoots.push(repository);
      const project = topology === "root" ? repository : join(repository, "apps", "service");
      await writeNeutralMixProject(project);
      if (topology === "mixed") await writeNeutralTypescriptProject(repository);

      const analysis = await analyzeProjectAutoWithGraph(
        repository,
        { now: new Date(0) },
        { plugins: neutralPlugins() },
      );
      const dead = analysis.result.claims.find(
        (claim) =>
          claim.subject.kind === "file" &&
          claim.subject.loc.file.endsWith("lib/neutral_topology/dead.ex"),
      );
      outcomes.push({
        topology,
        confidence: dead?.confidence,
        verdict: dead?.verdict,
        atomHazards: analysis.graph
          .hazards()
          .filter((hazard) => hazard.hazardClass === "elixir-computed-atom-escape").length,
      });

      if (topology === "root") {
        const {
          productionEntrypointCount: _productionEntrypointCount,
          fileCount: _fileCount,
          workspaceCount: _workspaceCount,
          repoName: _repoName,
          units: _units,
          gateThreshold: _gateThreshold,
          diagnostics: _diagnostics,
          ...claimRun
        } = analysis.result;
        const serialized = JSON.stringify(claimRun);
        const ajv = new Ajv2020({ allErrors: true, strict: true });
        addFormats(ajv);
        const validate = ajv.compile(claimRunSchema);
        expect(serialized).not.toContain("\n");
        expect(validate(JSON.parse(serialized)), JSON.stringify(validate.errors)).toBe(true);

        const safe = whyAlive({
          graph: analysis.graph,
          reachability: analysis.reachability,
          claims: analysis.result.claims,
          query: "lib/neutral_topology/dead.ex",
          hazardEvaluations: analysis.hazardEvaluations,
        });
        expect(safe).toMatchObject({
          outcome: "dead",
          confidence: "medium",
          hazards: [expect.objectContaining({ hazardClass: "elixir-computed-atom-escape" })],
        });
        if (safe.outcome !== "dead") throw new Error("expected neutral dead control");
        expect(
          computeDeletionPlan({
            graph: analysis.graph,
            reachability: analysis.reachability,
            subject: safe.subject,
            hazardEvaluations: analysis.hazardEvaluations,
          }),
        ).toMatchObject({ supported: false, stages: [] });

        await writeNeutralLock(project, "2.0.0");
        const conservative = await analyzeProjectAutoWithGraph(
          repository,
          { now: new Date(0) },
          { plugins: neutralPlugins() },
        );
        const refused = whyAlive({
          graph: conservative.graph,
          reachability: conservative.reachability,
          claims: conservative.result.claims,
          query: "lib/neutral_topology/dead.ex",
          hazardEvaluations: conservative.hazardEvaluations,
        });
        expect(refused).toMatchObject({
          outcome: "dead",
          confidence: "medium",
          hazards: [expect.objectContaining({ hazardClass: "elixir-computed-atom-escape" })],
        });
        if (refused.outcome !== "dead") throw new Error("expected conservative dead control");
        expect(
          computeDeletionPlan({
            graph: conservative.graph,
            reachability: conservative.reachability,
            subject: refused.subject,
            hazardEvaluations: conservative.hazardEvaluations,
          }),
        ).toMatchObject({
          supported: false,
          stages: [],
          unsupportedReason: expect.stringContaining("computed atom escapes analysis"),
        });
      }
    }

    expect(outcomes).toEqual([
      { topology: "root", confidence: "medium", verdict: "unused", atomHazards: 1 },
      { topology: "nested", confidence: "medium", verdict: "unused", atomHazards: 1 },
      { topology: "mixed", confidence: "medium", verdict: "unused", atomHazards: 1 },
    ]);
  });
});

const neutralProvider: ElixirAtomRoleSummaryProvider = {
  id: "convention:neutral",
  compilerApp: "neutral_dep",
  otpApp: "neutral_dep",
  lockKey: "neutral_dep",
  hexPackage: "neutral_dep",
  repository: "hexpm",
  auditedReleases: [
    {
      version: "1.0.0",
      innerChecksum: "1".repeat(64),
      outerChecksum: "2".repeat(64),
    },
  ],
  summaries: [
    {
      module: "String",
      name: "upcase",
      arity: 1,
      arguments: { 0: "consume-data" },
      origin: { pluginId: "convention:neutral", hexPackage: "neutral_dep" },
    },
  ],
};

const neutralConvention: ConventionPlugin = {
  kind: "convention",
  id: "convention:neutral",
  version: "1.0.0",
  languages: ["ex"],
  elixirAtomRoleSummaryProvider: neutralProvider,
  applies: () => false,
  async analyze() {
    return {};
  },
};

function neutralPlugins(): readonly AnalyzerPlugin[] {
  return [
    ...BUILT_IN_PLUGINS.filter((plugin) => plugin.id !== "convention:ecto"),
    neutralConvention,
  ];
}

async function writeNeutralMixProject(project: string): Promise<void> {
  await mkdir(join(project, "lib", "neutral_topology"), { recursive: true });
  await writeFile(
    join(project, "mix.exs"),
    `defmodule NeutralTopology.MixProject do
  use Mix.Project
  def project, do: [app: :neutral_topology, version: "0.1.0", elixir: "~> 1.20", deps: [{:neutral_dep, "1.0.0", only: :test}]]
  def application, do: [mod: {NeutralTopology.Application, []}]
end
`,
  );
  await writeFile(
    join(project, "lib", "neutral_topology", "application.ex"),
    `defmodule NeutralTopology.Application do
  use Application
  def start(_type, args) do
    kind = String.to_atom(Keyword.get(args, :kind, "known"))
    _ = String.upcase(kind)
    Supervisor.start_link([], strategy: :one_for_one, name: NeutralTopology.Supervisor)
  end
end
`,
  );
  await writeFile(
    join(project, "lib", "neutral_topology", "dead.ex"),
    `defmodule NeutralTopology.Dead do
  def genuinely_unused, do: :unused
end
`,
  );
  await writeNeutralLock(project, "1.0.0");
}

async function writeNeutralLock(project: string, version: string): Promise<void> {
  await writeFile(
    join(project, "mix.lock"),
    `%{
  "neutral_dep": {:hex, :neutral_dep, "${version}", "${"1".repeat(64)}", [:mix], [], "hexpm", "${"2".repeat(64)}"},
}
`,
  );
}

async function writeNeutralTypescriptProject(repository: string): Promise<void> {
  await mkdir(join(repository, "web"), { recursive: true });
  await writeFile(
    join(repository, "web", "package.json"),
    JSON.stringify({ name: "neutral-web", type: "module", main: "index.ts" }),
  );
  await writeFile(join(repository, "web", "index.ts"), "export const live = true;\n");
}

async function writeExactExMoneyProject(repository: string): Promise<void> {
  await mkdir(join(repository, "lib", "neutral_provider"), { recursive: true });
  await mkdir(join(repository, "deps", "ex_money", "lib"), { recursive: true });
  await writeFile(
    join(repository, "mix.exs"),
    `defmodule NeutralProvider.MixProject do
  use Mix.Project
  def project, do: [app: :neutral_provider, version: "0.1.0", elixir: "~> 1.20", deps: [{:ex_money, "6.1.1"}]]
  def application, do: [mod: {NeutralProvider.Application, []}]
end
`,
  );
  await writeFile(
    join(repository, "mix.lock"),
    `%{
  "ex_money": {:hex, :ex_money, "6.1.1", "19dbfc6457ba9205f68fe97711d8bd4e8ccac7bb3118767bf9bda71870e4d45c", [:mix], [], "hexpm", "fec324fbc47ec7e3545091374267bfca56d32ea948cfa4d9e172ad505ff41509"},
}
`,
  );
  await writeFile(
    join(repository, "lib", "neutral_provider", "application.ex"),
    `defmodule NeutralProvider.Application do
  use Application
  def start(_type, _args) do
    _ = NeutralProvider.Flow.amount_first("USD")
    _ = NeutralProvider.Flow.currency_first("USD")
    {:ok, self()}
  end
end
`,
  );
  await writeFile(
    join(repository, "lib", "neutral_provider", "flow.ex"),
    `defmodule NeutralProvider.Flow do
  def amount_first(raw), do: Money.new(100, String.to_atom(raw)) |> Map.fetch!(:currency) |> Atom.to_string()
  def currency_first(raw), do: Money.new(String.to_atom(raw), 100) |> Map.fetch!(:currency) |> Atom.to_string()
  def genuinely_unused, do: :unused
end
`,
  );
  await writeFile(
    join(repository, "deps", "ex_money", "mix.exs"),
    `defmodule ExMoney.MixProject do
  use Mix.Project
  def project, do: [app: :ex_money, version: "6.1.1", elixir: "~> 1.20"]
end
`,
  );
  await writeFile(
    join(repository, "deps", "ex_money", "lib", "money.ex"),
    `defmodule Money do
  def new(amount, currency) when is_number(amount), do: %{amount: amount, currency: currency}
  def new(currency, amount) when is_number(amount), do: %{amount: amount, currency: currency}
end
`,
  );
  // Public Hex SCM identity; dependency source above is independently synthetic.
  await writeFile(
    join(repository, "deps", "ex_money", ".hex"),
    Buffer.from(
      "g2gCaAN3A2hleGECYQB0AAAABncEbmFtZW0AAAAIZXhfbW9uZXl3B3ZlcnNpb25tAAAABTYuMS4xdwhtYW5hZ2Vyc2wAAAABdwNtaXhqdw5pbm5lcl9jaGVja3N1bW0AAABAMTlkYmZjNjQ1N2JhOTIwNWY2OGZlOTc3MTFkOGJkNGU4Y2NhYzdiYjMxMTg3NjdiZjliZGE3MTg3MGU0ZDQ1Y3cOb3V0ZXJfY2hlY2tzdW1tAAAAQGZlYzMyNGZiYzQ3ZWM3ZTM1NDUwOTEzNzQyNjdiZmNhNTZkMzJlYTk0OGNmYTRkOWUxNzJhZDUwNWZmNDE1MDl3BHJlcG9tAAAABWhleHBt",
      "base64",
    ),
  );
}

function compileMixProject(repository: string): void {
  for (const mixEnv of [undefined, "test"]) {
    for (const args of [["deps.compile"], ["compile"]]) {
      const result = spawnSync("mix", args, {
        cwd: repository,
        encoding: "utf8",
        env: { ...process.env, ...(mixEnv === undefined ? {} : { MIX_ENV: mixEnv }) },
      });
      if (result.status !== 0) {
        throw new Error(`Mix fixture compile failed: ${result.stderr || result.stdout}`);
      }
    }
  }
}
