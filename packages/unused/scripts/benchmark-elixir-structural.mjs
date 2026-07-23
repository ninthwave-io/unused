#!/usr/bin/env node

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const rawSize = process.argv[2];
const size = Number(rawSize);
if (!Number.isInteger(size) || size < 1 || size > 2_000) {
  throw new Error("expected one fixture size from 1 through 2000");
}
const density = Number(process.argv[3] ?? "8");
if (density !== 1 && density !== 8) {
  throw new Error("expected carrier density 1 or 8");
}
const configuredRunner = process.env.UNUSED_RUNNER_MODULE;
const runnerPath =
  configuredRunner === undefined
    ? resolve("packages/unused/dist/frontends/elixir/runner.js")
    : isAbsolute(configuredRunner)
      ? configuredRunner
      : resolve(configuredRunner);
const { runTracer } = await import(pathToFileURL(runnerPath).href);

const targetSource = `defmodule NeutralScale.Target do
  def seed do
    :seed
  end

  def consume(value) do
    value
  end
end
`;
const moduleSource = (suffix) => {
  if (density === 1) {
    return `defmodule NeutralScale.Module${suffix} do
  def live do
    NeutralScale.Target.consume(NeutralScale.Target.seed())
  end
end
`;
  }
  const carriers = Array.from(
    { length: 8 },
    (_, index) => `  def live_${index} do
    NeutralScale.Target.seed() |> NeutralScale.Target.consume()
  end`,
  ).join("\n\n");
  return `defmodule NeutralScale.Module${suffix} do
${carriers}
end
`;
};

const root = mkdtempSync(join(tmpdir(), `unused-structure-benchmark-${size}-`));
try {
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
  writeFileSync(join(sourceRoot, "target.ex"), targetSource);
  for (let index = 0; index < size; index += 1) {
    const suffix = String(index).padStart(4, "0");
    writeFileSync(join(sourceRoot, `module_${suffix}.ex`), moduleSource(suffix));
  }
  const priorFlags = process.env.ERL_FLAGS;
  process.env.ERL_FLAGS = `${priorFlags ?? ""} +S 4:4`.trim();
  const cpuBefore = process.cpuUsage();
  const started = performance.now();
  const trace = runTracer(root, { timeoutMs: 120_000 });
  const wallMs = performance.now() - started;
  const cpu = process.cpuUsage(cpuBefore);
  if (priorFlags === undefined) delete process.env.ERL_FLAGS;
  else process.env.ERL_FLAGS = priorFlags;
  const summary = trace.structuralSummary;
  const rawEvents = summary?.rawEvents ?? trace.events.length;
  process.stdout.write(
    `${JSON.stringify({
      size,
      density,
      wallMs,
      nodeUserMs: cpu.user / 1_000,
      nodeSystemMs: cpu.system / 1_000,
      modules: trace.modules.length,
      rawEvents,
      semanticEvents: trace.events.length,
      exactStructuralEvents: trace.structuralEvents?.length ?? 0,
      ...(summary === undefined
        ? {}
        : {
            extractionMs: summary.elapsedUs / 1_000,
            eventIndexMs: summary.eventIndexUs / 1_000,
            fileExtractionMs: summary.fileExtractionUs / 1_000,
            emitMs: summary.emitUs / 1_000,
            files: summary.files,
            bytes: summary.bytes,
            astVisits: summary.astNodes,
            carriers: summary.carriers,
            facts: summary.facts,
            roles: summary.roles,
          }),
    })}\n`,
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}
