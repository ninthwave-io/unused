/** Synthetic scaling probe for gitignore-bounded standalone Elixir extraction. */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractElixirScriptFacts } from "../dist/frontends/elixir/script-references.js";

const SIZES = [250, 500, 1_000, 2_000, 4_000];
const REPEATS = 7;
const source = [
  "alias Neutral.Target, as: Target",
  "Target.zero()",
  "Neutral.Target.one(:sample)",
  "Neutral.Target.one(fn left, right -> Target.zero() end)",
  "Neutral.Target.one(",
  "  %{value: :sample, callback: fn item, index -> {item, index} end}",
  ")",
  "{Target, :zero, []}",
  "Neutral.Target.zero()",
  "{Neutral.Target, :one, [:sample]}",
  'Code.require_file("bench_0000.exs", __DIR__)',
  "",
].join("\n");
const trace = {
  events: [],
  modules: [
    {
      k: "module",
      mod: "Neutral.Target",
      file: "lib/target.ex",
      line: 1,
      behaviours: [],
      protocol: false,
      impl: false,
      partition: "prod",
    },
  ],
  functions: [
    {
      k: "function",
      mod: "Neutral.Target",
      name: "zero",
      arity: 0,
      file: "lib/target.ex",
      line: 2,
      partition: "prod",
    },
    {
      k: "function",
      mod: "Neutral.Target",
      name: "one",
      arity: 1,
      file: "lib/target.ex",
      line: 3,
      partition: "prod",
    },
  ],
  appMod: null,
  deps: [],
  compileOk: true,
  testPartition: "complete",
};

const root = mkdtempSync(join(tmpdir(), "unused-elixir-script-bench-"));
try {
  mkdirSync(join(root, "scripts"));
  const allFiles = [];
  for (let index = 0; index < SIZES.at(-1); index += 1) {
    const file = join(root, "scripts", `bench_${String(index).padStart(4, "0")}.exs`);
    writeFileSync(file, source);
    allFiles.push(file);
  }

  const fileSeries = [];
  for (const fileCount of SIZES) {
    const files = allFiles.slice(0, fileCount);
    const durations = [];
    let facts;
    for (let repeat = 0; repeat < REPEATS; repeat += 1) {
      const started = performance.now();
      facts = extractElixirScriptFacts(root, files, trace);
      durations.push(performance.now() - started);
    }
    fileSeries.push({
      files: fileCount,
      bytes: fileCount * Buffer.byteLength(source),
      references: facts.referenceCount,
      resolutionAttempts: facts.resolutionAttempts,
      medianMs: median(durations),
    });
  }
  const moduleDensity = [];
  const denseFile = join(root, "scripts", "module_density.exs");
  for (const moduleCount of SIZES) {
    const denseSource = Array.from(
      { length: moduleCount },
      (_, index) => `defmodule Neutral.Generated${index} do\nend`,
    ).join("\n");
    writeFileSync(denseFile, denseSource);
    const durations = [];
    for (let repeat = 0; repeat < REPEATS; repeat += 1) {
      const started = performance.now();
      extractElixirScriptFacts(root, [denseFile], trace);
      durations.push(performance.now() - started);
    }
    moduleDensity.push({
      modules: moduleCount,
      bytes: Buffer.byteLength(denseSource),
      medianMs: median(durations),
    });
  }
  process.stdout.write(`${JSON.stringify({ fileSeries, moduleDensity }, null, 2)}\n`);
} finally {
  rmSync(root, { recursive: true, force: true });
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}
