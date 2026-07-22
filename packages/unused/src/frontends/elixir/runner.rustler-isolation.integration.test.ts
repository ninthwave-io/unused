/**
 * Public-only integration proof for Rustler's documented Mix compiler path.
 * Third-party sources are unpacked from the developer/CI public package cache
 * at runtime and are never copied into this repository.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
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
import { homedir, tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { runTracer } from "./runner.js";

const RUSTLER_VERSION = "0.38.0";
const JASON_VERSION = "1.4.5";
const publicHexCache = join(homedir(), ".hex/packages/hexpm");
const rustlerArchive = join(publicHexCache, `rustler-${RUSTLER_VERSION}.tar`);
const jasonArchive = join(publicHexCache, `jason-${JASON_VERSION}.tar`);
const cargoCacheRoot = join(homedir(), ".cargo/registry/cache");
const toolsAvailable =
  spawnSync("mix", ["--version"], { encoding: "utf8" }).status === 0 &&
  spawnSync("cargo", ["--version"], { encoding: "utf8" }).status === 0 &&
  spawnSync("tar", ["--version"], { encoding: "utf8" }).status === 0;
const publicPackagesAvailable =
  existsSync(rustlerArchive) &&
  existsSync(jasonArchive) &&
  existsSync(cargoCacheRoot) &&
  readdirSync(cargoCacheRoot).some((registry) =>
    existsSync(join(cargoCacheRoot, registry, `rustler-${RUSTLER_VERSION}.crate`)),
  );

interface SnapshotEntry {
  readonly path: string;
  readonly type: "directory" | "file" | "symlink" | "other";
  readonly size: string;
  readonly mtimeNs: string;
  readonly mode: string;
  readonly content: string;
}

function snapshotWholeTree(root: string): readonly SnapshotEntry[] {
  const entries: SnapshotEntry[] = [];
  const walk = (path: string): void => {
    const metadata = lstatSync(path, { bigint: true });
    const type = metadata.isDirectory()
      ? "directory"
      : metadata.isFile()
        ? "file"
        : metadata.isSymbolicLink()
          ? "symlink"
          : "other";
    entries.push({
      path: relative(root, path) || ".",
      type,
      size: metadata.size.toString(),
      mtimeNs: metadata.mtimeNs.toString(),
      mode: metadata.mode.toString(),
      content:
        type === "file"
          ? createHash("sha256").update(readFileSync(path)).digest("hex")
          : type === "symlink"
            ? readlinkSync(path)
            : "",
    });
    if (type === "directory") {
      for (const entry of readdirSync(path).sort()) walk(join(path, entry));
    }
  };
  walk(root);
  return entries;
}

function write(root: string, path: string, contents: string): void {
  const destination = join(root, path);
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, contents, "utf8");
}

function run(command: string, args: readonly string[], cwd: string): void {
  const result = spawnSync(command, [...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, CARGO_NET_OFFLINE: "true", HEX_OFFLINE: "1" },
  });
  expect(result.status, `${command} ${args.join(" ")}\n${result.stderr}\n${result.stdout}`).toBe(0);
}

function extractHexPackage(archive: string, destination: string, staging: string): void {
  mkdirSync(destination, { recursive: true });
  mkdirSync(staging, { recursive: true });
  run("tar", ["-xf", archive, "-C", staging], staging);
  run("tar", ["-xzf", join(staging, "contents.tar.gz"), "-C", destination], staging);
}

function withPath<T>(path: string, operation: () => T): T {
  const previous = process.env["PATH"];
  process.env["PATH"] = path;
  try {
    return operation();
  } finally {
    if (previous === undefined) delete process.env["PATH"];
    else process.env["PATH"] = previous;
  }
}

describe.skipIf(!toolsAvailable || !publicPackagesAvailable)(
  "runTracer — public Rustler compiler isolation",
  () => {
    const roots: string[] = [];
    afterAll(() => {
      for (const root of roots) rmSync(root, { recursive: true, force: true });
    });

    it("keeps the whole consumer tree unchanged cold and warm without invoking Cargo", {
      timeout: 180_000,
    }, () => {
      const root = mkdtempSync(join(tmpdir(), "unused-public-rustler-test-"));
      roots.push(root);
      const project = join(root, "neutral_app");
      const rustlerDependency = join(root, "deps/rustler");
      const jasonDependency = join(root, "deps/jason");
      extractHexPackage(rustlerArchive, rustlerDependency, join(root, "archives/rustler"));
      extractHexPackage(jasonArchive, jasonDependency, join(root, "archives/jason"));

      write(
        project,
        "mix.exs",
        `defmodule NeutralRustlerIsolation.MixProject do
  use Mix.Project
  def project do
    [
      app: :neutral_rustler_isolation,
      version: "0.1.0",
      elixir: "~> 1.15",
      deps: [
        {:jason, path: ${JSON.stringify(jasonDependency)}, override: true},
        {:rustler, path: ${JSON.stringify(rustlerDependency)}, override: true}
      ]
    ]
  end
  def application, do: [extra_applications: [:logger]]
end
`,
      );
      write(
        project,
        "lib/neutral/native.ex",
        `defmodule Neutral.Native do
  use Rustler, otp_app: :neutral_rustler_isolation, crate: :neutral_native
  def add(_left, _right), do: :erlang.nif_error(:nif_not_loaded)
end
`,
      );
      write(project, "priv/resource.txt", "neutral public resource\n");
      symlinkSync("resource.txt", join(project, "priv/resource-link.txt"));
      write(
        project,
        "native/neutral_native/Cargo.toml",
        `[package]
name = "neutral_native"
version = "0.1.0"
edition = "2021"

[lib]
name = "neutral_native"
crate-type = ["cdylib"]

[dependencies]
rustler = "=${RUSTLER_VERSION}"
`,
      );
      write(
        project,
        "native/neutral_native/src/lib.rs",
        `#[rustler::nif]
fn add(left: i64, right: i64) -> i64 { left + right }

rustler::init!("Elixir.Neutral.Native");
`,
      );

      run("mix", ["deps.get"], project);
      run("mix", ["deps.compile"], project);
      run("cargo", ["generate-lockfile", "--offline"], join(project, "native/neutral_native"));
      run("mix", ["compile"], project);

      const cargoTargetParent = join(root, "analyzer-cargo-targets");
      const wrapperDir = join(root, "cargo-wrapper");
      const cargoLog = join(root, "cargo-invocations.log");
      mkdirSync(cargoTargetParent);
      mkdirSync(wrapperDir);
      write(
        wrapperDir,
        "cargo",
        `#!/bin/sh
printf '%s\\n' "$*" >> ${JSON.stringify(cargoLog)}
exit 97
`,
      );
      chmodSync(join(wrapperDir, "cargo"), 0o755);

      const before = snapshotWholeTree(project);
      const originalPath = process.env["PATH"] ?? "";
      const first = withPath(`${wrapperDir}:${originalPath}`, () =>
        runTracer(project, { cargoTargetParentDir: cargoTargetParent }),
      );
      expect(snapshotWholeTree(project)).toEqual(before);
      expect(readdirSync(cargoTargetParent)).toEqual([]);
      expect(existsSync(cargoLog)).toBe(false);

      const second = withPath(`${wrapperDir}:${originalPath}`, () =>
        runTracer(project, { cargoTargetParentDir: cargoTargetParent }),
      );
      expect(snapshotWholeTree(project)).toEqual(before);
      expect(readdirSync(cargoTargetParent)).toEqual([]);
      expect(existsSync(cargoLog)).toBe(false);
      expect(second).toEqual(first);

      expect(first.modules.map((module) => module.mod)).toContain("Neutral.Native");
      expect(
        first.functions.some(
          (fn) => fn.mod === "Neutral.Native" && fn.name === "rustler_init" && fn.arity === 0,
        ),
      ).toBe(true);
      expect(first.events.some((event) => event.name === "load_nif" && event.arity === 2)).toBe(
        true,
      );
    });
  },
);
