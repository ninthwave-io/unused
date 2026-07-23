#!/usr/bin/env node

import { execFile, spawn } from "node:child_process";
import { isAbsolute, resolve } from "node:path";

const runnerArgument = process.argv[2];
const sizeArgument = process.argv[3];
const size = Number(sizeArgument);
const density = Number(process.argv[4] ?? "8");
if (
  runnerArgument === undefined ||
  !Number.isInteger(size) ||
  size < 1 ||
  size > 2_000 ||
  (density !== 1 && density !== 8)
) {
  throw new Error(
    "usage: measure-elixir-structural-memory.mjs <runner-module> <size> [density: 1|8]",
  );
}
const runner = isAbsolute(runnerArgument) ? runnerArgument : resolve(runnerArgument);
const benchmark = resolve("packages/unused/scripts/benchmark-elixir-structural.mjs");
const child = spawn(process.execPath, [benchmark, String(size), String(density)], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    ASDF_ELIXIR_VERSION: "1.20.2-otp-28",
    ASDF_ERLANG_VERSION: "28.5",
    UNUSED_RUNNER_MODULE: runner,
  },
  stdio: ["ignore", "pipe", "pipe"],
});

let stdout = "";
let stderr = "";
child.stdout.setEncoding("utf8");
child.stderr.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  stdout += chunk;
});
child.stderr.on("data", (chunk) => {
  stderr += chunk;
});

let nodePeakKiB = 0;
let beamPeakKiB = 0;
let treePeakKiB = 0;
let samples = 0;
let sampling = false;
const samplingStarted = performance.now();
const cpuMsByPid = new Map();

function cpuTimeMs(value) {
  const fields = value.split(":").map(Number);
  if (fields.some((field) => !Number.isFinite(field))) return 0;
  return fields.reduce((total, field) => total * 60 + field, 0) * 1_000;
}

function sample() {
  if (sampling) return;
  sampling = true;
  execFile("ps", ["-axo", "pid=,ppid=,rss=,time=,comm="], { encoding: "utf8" }, (error, output) => {
    sampling = false;
    if (error !== null) return;
    const rows = output
      .split("\n")
      .map((line) => line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+([\d:.]+)\s+(.+)$/u))
      .filter((match) => match !== null)
      .map((match) => ({
        pid: Number(match[1]),
        ppid: Number(match[2]),
        rssKiB: Number(match[3]),
        cpuMs: cpuTimeMs(match[4] ?? "0"),
        command: match[5] ?? "",
      }));
    const descendants = new Set([child.pid]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const row of rows) {
        if (descendants.has(row.ppid) && !descendants.has(row.pid)) {
          descendants.add(row.pid);
          changed = true;
        }
      }
    }
    let treeKiB = 0;
    for (const row of rows) {
      if (!descendants.has(row.pid)) continue;
      treeKiB += row.rssKiB;
      cpuMsByPid.set(row.pid, Math.max(cpuMsByPid.get(row.pid) ?? 0, row.cpuMs));
      if (row.pid === child.pid) nodePeakKiB = Math.max(nodePeakKiB, row.rssKiB);
      if (row.command.endsWith("beam.smp")) beamPeakKiB = Math.max(beamPeakKiB, row.rssKiB);
    }
    treePeakKiB = Math.max(treePeakKiB, treeKiB);
    samples += 1;
  });
}

const interval = setInterval(sample, 20);
sample();
const exitCode = await new Promise((resolveExit) => {
  child.on("exit", (code) => resolveExit(code ?? 1));
});
clearInterval(interval);
while (sampling) await new Promise((resolveWait) => setTimeout(resolveWait, 5));
const sampleElapsedMs = performance.now() - samplingStarted;

if (stderr !== "") process.stderr.write(stderr);
if (stdout !== "") process.stdout.write(stdout);
process.stdout.write(
  `${JSON.stringify({
    memorySample: {
      size,
      density,
      samples,
      sampleElapsedMs,
      effectiveSampleIntervalMs: samples === 0 ? null : sampleElapsedMs / samples,
      approximateTreeCpuMs: [...cpuMsByPid.values()].reduce((total, cpuMs) => total + cpuMs, 0),
      nodePeakKiB,
      beamPeakKiB,
      treePeakKiB,
    },
  })}\n`,
);
process.exitCode = exitCode;
