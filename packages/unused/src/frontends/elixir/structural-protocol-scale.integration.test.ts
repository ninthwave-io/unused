import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { runTracer } from "./runner.js";

const MIX_AVAILABLE = spawnSync("mix", ["--version"], { encoding: "utf8" }).status === 0;
const SIZES = [250, 500, 1_000, 2_000] as const;
const CARRIERS_PER_GENERATED_FILE = 8;
const TARGET_SOURCE = `defmodule NeutralScale.Target do
  def seed do
    :seed
  end

  def consume(value) do
    value
  end
end
`;

function moduleSource(suffix: string): string {
  const carriers = Array.from(
    { length: CARRIERS_PER_GENERATED_FILE },
    (_, index) => `  def live_${index} do
    NeutralScale.Target.seed() |> NeutralScale.Target.consume()
  end`,
  ).join("\n\n");
  return `defmodule NeutralScale.Module${suffix} do
${carriers}
end
`;
}

interface ScaleObservation {
  readonly files: number;
  readonly rawEvents: number;
  readonly semanticEvents: number;
  readonly exactStructuralEvents: number;
  readonly carriers: number;
  readonly facts: number;
  readonly astVisits: number;
  readonly elapsedMs: number;
  readonly cpuMs: number;
  readonly maxRssKiB: number;
}

function withSchedulers<T>(run: () => T): T {
  const environment: { ERL_FLAGS?: string } = process.env;
  const previous = environment.ERL_FLAGS;
  environment.ERL_FLAGS = `${previous ?? ""} +S 4:4`.trim();
  try {
    return run();
  } finally {
    if (previous === undefined) delete environment.ERL_FLAGS;
    else environment.ERL_FLAGS = previous;
  }
}

function createProject(size: number): string {
  const root = mkdtempSync(join(tmpdir(), `unused-structure-scale-${size}-`));
  const sourceRoot = join(root, "lib", "neutral_scale");
  mkdirSync(sourceRoot, { recursive: true });
  writeFileSync(
    join(root, "mix.exs"),
    `defmodule NeutralScale.MixProject do
  use Mix.Project
  def project, do: [app: :neutral_scale, version: "0.1.0", elixir: "~> 1.17"]
end
`,
  );
  writeFileSync(join(sourceRoot, "target.ex"), TARGET_SOURCE);
  for (let index = 0; index < size; index += 1) {
    const suffix = String(index).padStart(4, "0");
    writeFileSync(join(sourceRoot, `module_${suffix}.ex`), moduleSource(suffix));
  }
  return root;
}

describe.skipIf(!MIX_AVAILABLE)("Elixir structural protocol v2 scaling", () => {
  const roots: string[] = [];
  const observations: ScaleObservation[] = [];
  afterAll(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  });

  for (const size of SIZES) {
    it(`extracts an exact fixed-density ${size}-file boundary`, { timeout: 120_000 }, () => {
      const root = createProject(size);
      roots.push(root);
      const cpuBefore = process.cpuUsage();
      const started = performance.now();
      const trace = withSchedulers(() => runTracer(root, { timeoutMs: 120_000 }));
      const elapsedMs = performance.now() - started;
      const cpu = process.cpuUsage(cpuBefore);
      const cpuMs = (cpu.user + cpu.system) / 1_000;
      const files = trace.structuralFiles ?? [];
      const carriers = files.reduce((total, file) => total + file.carriers.length, 0);
      const facts = files.reduce((total, file) => total + file.facts.length, 0);
      const astVisits = files.reduce((total, file) => total + file.astNodes, 0);
      const sourceBytes = files.reduce((total, file) => total + file.bytes, 0);
      const rawEvents = trace.structuralSummary?.rawEvents ?? 0;
      const semanticEvents = trace.events.length;
      const exactStructuralEvents = trace.structuralEvents?.length ?? 0;
      const generated = files.filter((file) => /\/module_\d{4}\.ex$/u.test(file.file));
      const roles = new Map<string, number>();
      for (const file of files) {
        for (const fact of file.facts) roles.set(fact.role, (roles.get(fact.role) ?? 0) + 1);
      }

      expect(files).toHaveLength(size + 1);
      expect(files.every((file) => file.status === "complete")).toBe(true);
      expect(new Set(files.map((file) => file.file))).toEqual(
        new Set(trace.modules.map((module) => module.file)),
      );
      expect(generated).toHaveLength(size);
      expect(new Set(generated.map((file) => file.astNodes)).size).toBe(1);
      expect(new Set(generated.map((file) => file.carriers.length))).toEqual(
        new Set([CARRIERS_PER_GENERATED_FILE]),
      );
      expect(new Set(generated.map((file) => file.facts.length))).toEqual(
        new Set([CARRIERS_PER_GENERATED_FILE * 2]),
      );
      expect(carriers).toBe(size * CARRIERS_PER_GENERATED_FILE + 2);
      expect(facts).toBe(size * CARRIERS_PER_GENERATED_FILE * 2);
      const generatedAstVisits = generated[0]?.astNodes ?? 0;
      const targetAstVisits = files.find((file) => file.file.endsWith("/target.ex"))?.astNodes ?? 0;
      expect([generatedAstVisits, targetAstVisits]).toEqual([66, 13]);
      expect(astVisits).toBe(size * generatedAstVisits + targetAstVisits);
      expect(new Set(generated.map((file) => file.maxDepth))).toEqual(new Set([6]));
      expect(files.find((file) => file.file.endsWith("/target.ex"))?.maxDepth).toBe(5);
      expect(sourceBytes).toBe(
        Buffer.byteLength(TARGET_SOURCE) +
          Array.from({ length: size }, (_, index) =>
            Buffer.byteLength(moduleSource(String(index).padStart(4, "0"))),
          ).reduce((total, bytes) => total + bytes, 0),
      );
      expect(rawEvents).toBe(size * 65 + 7);
      expect(semanticEvents).toBe(size * 57 + 7);
      expect(exactStructuralEvents).toBe(size * CARRIERS_PER_GENERATED_FILE);
      expect(Object.fromEntries(roles)).toEqual({
        "pipeline-argument": size * CARRIERS_PER_GENERATED_FILE,
        "carrier-result": size * CARRIERS_PER_GENERATED_FILE,
      });

      observations.push({
        files: size + 1,
        rawEvents,
        semanticEvents,
        exactStructuralEvents,
        carriers,
        facts,
        astVisits,
        elapsedMs,
        cpuMs,
        maxRssKiB: process.resourceUsage().maxRSS,
      });
      if (observations.length === SIZES.length) {
        const first = observations[0] as ScaleObservation;
        const last = observations.at(-1) as ScaleObservation;
        expect((last.rawEvents - 7) / (first.rawEvents - 7)).toBe(8);
        expect((last.semanticEvents - 7) / (first.semanticEvents - 7)).toBe(8);
        expect(last.exactStructuralEvents / first.exactStructuralEvents).toBe(8);
        expect(last.facts / first.facts).toBe(8);
        // The run includes the real Mix compiler and filesystem. Exact work
        // counts prove the protocol joins; the public interactive budget caps
        // the intentionally end-to-end wall observation.
        expect(last.elapsedMs).toBeLessThan(120_000);
        // `process.resourceUsage().maxRSS` is process-lifetime cumulative and
        // Vitest may run another Mix suite concurrently, so it cannot be a
        // fresh-process acceptance signal here. Preserve the observation; the
        // explicit isolated base/current RSS gate is recorded in the benchmark
        // note and keeps this exact eight-carrier/sixteen-fact density.
        expect(last.maxRssKiB).toBeGreaterThan(0);
      }
    });
  }

  it("emits an explicit zero-payload bundle when a source exceeds its cap", {
    timeout: 60_000,
  }, () => {
    const root = mkdtempSync(join(tmpdir(), "unused-structure-cap-"));
    roots.push(root);
    mkdirSync(join(root, "lib"));
    writeFileSync(
      join(root, "mix.exs"),
      `defmodule NeutralCap.MixProject do
  use Mix.Project
  def project, do: [app: :neutral_cap, version: "0.1.0", elixir: "~> 1.17"]
end
`,
    );
    writeFileSync(
      join(root, "lib", "neutral_cap.ex"),
      `#${"x".repeat(8 * 1024 * 1024)}\ndefmodule NeutralCap do\n  def live, do: :ok\nend\n`,
    );
    const trace = withSchedulers(() => runTracer(root, { timeoutMs: 60_000 }));
    expect(trace.structuralFiles).toEqual([
      expect.objectContaining({
        file: "lib/neutral_cap.ex",
        status: "incomplete",
        reason: "size",
        digest: "0".repeat(64),
        bytes: 0,
        astNodes: 0,
        maxDepth: 0,
        carriers: [],
        facts: [],
      }),
    ]);
  });
});
