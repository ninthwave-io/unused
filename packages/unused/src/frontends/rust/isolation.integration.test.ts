/** Real-Cargo proof that canonical Rust analysis leaves consumer trees untouched. */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  lutimes,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  realpath,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { analyzeRustProjectWithGraph } from "./analyze.js";
import { CargoCompileError, CargoMetadataError } from "./runner.js";

const CARGO_AVAILABLE = spawnSync("cargo", ["--version"], { encoding: "utf8" }).status === 0;
const FIXED_TIME = new Date("2001-02-03T04:05:06.000Z");
const roots: string[] = [];

interface SnapshotEntry {
  readonly path: string;
  readonly type: "directory" | "file" | "symlink";
  readonly mode: number;
  readonly mtimeNs: bigint;
  readonly size: bigint;
  readonly content: string;
}

interface CargoEnvironment extends NodeJS.ProcessEnv {
  HOME?: string;
  CARGO_HOME?: string;
  CARGO_TARGET_DIR?: string;
  CARGO_BUILD_TARGET_DIR?: string;
  CARGO_BUILD_BUILD_DIR?: string;
  UNUSED_CARGO_LOG?: string;
  UNUSED_REAL_CARGO?: string;
}

interface CargoInvocation {
  readonly args: readonly string[];
  readonly cargoHome: string;
  readonly targetDir: string;
  readonly buildTargetDir: string;
  readonly buildDir: string;
  readonly offline: string;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe.skipIf(!CARGO_AVAILABLE)("Rust frontend — isolated Cargo execution", () => {
  it("preserves source, lock, configured/inherited targets, and priv/native across cold and warm runs", async () => {
    const root = await project("unused-rust-isolation-project-");
    const targetParent = await project("unused-rust-isolation-targets-");
    const wrapperRoot = await project("unused-rust-isolation-wrapper-");
    const wrapper = join(wrapperRoot, "cargo-wrapper.mjs");
    const invocationLog = join(wrapperRoot, "invocations.jsonl");
    await writeCargoWrapper(wrapper);
    await writeNeutralCrate(root, true);
    await write(
      root,
      ".cargo/config.toml",
      '[build]\ntarget-dir = "configured-target"\nbuild-dir = "configured-build"\n',
    );
    await write(root, "configured-target/debug/neutral.d", "configured target sentinel\n");
    await write(root, "configured-build/neutral.o", "configured build sentinel\n");
    await write(root, "inherited-target/debug/neutral.d", "inherited target sentinel\n");
    await write(root, "inherited-build/neutral.o", "inherited build sentinel\n");
    await write(root, "priv/native/libneutral.so", "native library sentinel\n");
    await symlink("libneutral.so", join(root, "priv/native/current"));
    await stampTree(root);

    const before = await snapshotTree(root);
    const prior = takeCargoEnvironment();
    const environment = process.env as CargoEnvironment;
    environment.CARGO_TARGET_DIR = join(root, "inherited-target");
    environment.CARGO_BUILD_TARGET_DIR = join(root, "inherited-target");
    environment.CARGO_BUILD_BUILD_DIR = join(root, "inherited-build");
    environment.UNUSED_CARGO_LOG = invocationLog;
    environment.UNUSED_REAL_CARGO = "cargo";
    try {
      const cold = await analyzeRustProjectWithGraph(
        root,
        { now: new Date(0) },
        { cargoCommand: wrapper, cargoTargetParentDir: targetParent },
      );
      expect(await readdir(targetParent)).toEqual([]);
      expect(await snapshotTree(root)).toEqual(before);

      const warm = await analyzeRustProjectWithGraph(
        root,
        { now: new Date(0) },
        { cargoCommand: wrapper, cargoTargetParentDir: targetParent },
      );
      expect(await readdir(targetParent)).toEqual([]);
      expect(await snapshotTree(root)).toEqual(before);
      expect(warm.result.claims).toEqual(cold.result.claims);
      expect(cold.result.claims.map((claim) => claim.id)).toHaveLength(1);

      const invocations = (await readFile(invocationLog, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as CargoInvocation);
      expect(invocations).toHaveLength(6);
      for (const group of [invocations.slice(0, 3), invocations.slice(3, 6)]) {
        const targetDirs = new Set(group.map((invocation) => invocation.targetDir));
        expect(targetDirs.size).toBe(1);
        for (const invocation of group) {
          expect(invocation.args).toContain("--frozen");
          expect(invocation.cargoHome.startsWith(root)).toBe(false);
          expect(invocation.buildTargetDir).toBe(invocation.targetDir);
          expect(invocation.buildDir).toBe(join(invocation.targetDir, "build"));
          expect(invocation.offline).toBe("true");
          expect(invocation.targetDir.startsWith(`${await realpath(targetParent)}/`)).toBe(true);
          expect(invocation.targetDir.startsWith(root)).toBe(false);
        }
      }
      expect(invocations[0]?.args[0]).toBe("metadata");
      expect(invocations[1]?.args[0]).toBe("check");
      expect(invocations[2]?.args).toContain("--all-features");
      expect(invocations[0]?.targetDir).not.toBe(invocations[3]?.targetDir);
    } finally {
      restoreCargoEnvironment(prior);
    }
  }, 60_000);

  it("refuses a missing lock without touching the project or leaking its temporary target", async () => {
    const root = await project("unused-rust-frozen-project-");
    const targetParent = await project("unused-rust-frozen-targets-");
    await writeNeutralCrate(root, false);
    await write(root, "priv/native/libneutral.so", "native library sentinel\n");
    await stampTree(root);
    const before = await snapshotTree(root);

    await expect(
      analyzeRustProjectWithGraph(
        root,
        { now: new Date(0) },
        { cargoTargetParentDir: targetParent },
      ),
    ).rejects.toThrow(CargoCompileError);
    await expect(
      analyzeRustProjectWithGraph(
        root,
        { now: new Date(0) },
        { cargoTargetParentDir: targetParent },
      ),
    ).rejects.toThrow(/Cargo\.lock is missing or stale; update it explicitly before analysis/);
    expect(await snapshotTree(root)).toEqual(before);
    expect(await readdir(targetParent)).toEqual([]);
  });

  it("refuses a stale lock without touching the project or leaking its temporary target", async () => {
    const root = await project("unused-rust-stale-lock-project-");
    const targetParent = await project("unused-rust-stale-lock-targets-");
    await writeNeutralCrate(root, true);
    await write(
      root,
      "Cargo.toml",
      '[package]\nname = "neutral-isolation"\nversion = "0.2.0"\nedition = "2024"\n',
    );
    await stampTree(root);
    const before = await snapshotTree(root);

    await expect(
      analyzeRustProjectWithGraph(
        root,
        { now: new Date(0) },
        { cargoTargetParentDir: targetParent },
      ),
    ).rejects.toThrow(CargoCompileError);
    await expect(
      analyzeRustProjectWithGraph(
        root,
        { now: new Date(0) },
        { cargoTargetParentDir: targetParent },
      ),
    ).rejects.toThrow(/Cargo\.lock is missing or stale; update it explicitly before analysis/);
    expect(await snapshotTree(root)).toEqual(before);
    expect(await readdir(targetParent)).toEqual([]);
  });

  it("cleans the external target after a metadata refusal", async () => {
    const root = await project("unused-rust-metadata-refusal-project-");
    const targetParent = await project("unused-rust-metadata-refusal-targets-");
    await write(root, "Cargo.toml", "[package\n");
    await write(root, "priv/native/libneutral.so", "native library sentinel\n");
    await stampTree(root);
    const before = await snapshotTree(root);

    await expect(
      analyzeRustProjectWithGraph(
        root,
        { now: new Date(0) },
        { cargoTargetParentDir: targetParent },
      ),
    ).rejects.toThrow(CargoMetadataError);
    expect(await snapshotTree(root)).toEqual(before);
    expect(await readdir(targetParent)).toEqual([]);
  });

  it("refuses locally unavailable sources without network access or consumer writes", async () => {
    const root = await project("unused-rust-offline-project-");
    const targetParent = await project("unused-rust-offline-targets-");
    const wrapperRoot = await project("unused-rust-offline-wrapper-");
    const wrapper = join(wrapperRoot, "cargo-wrapper.mjs");
    await writeNeutralCrate(root, true);
    const canonicalRoot = await realpath(root);
    await writeFile(
      wrapper,
      [
        "#!/usr/bin/env node",
        "const args = process.argv.slice(2);",
        'if (!args.includes("--frozen") || process.env.CARGO_NET_OFFLINE !== "true") process.exit(2);',
        'if (args[0] === "metadata") {',
        "  process.stdout.write(JSON.stringify({",
        "    packages: [], workspace_members: [],",
        `    workspace_root: ${JSON.stringify(canonicalRoot)},`,
        "    target_directory: process.env.CARGO_TARGET_DIR,",
        "  }));",
        "  process.exit(0);",
        "}",
        'console.error("no matching package named `neutral-missing` found; offline mode");',
        "process.exit(101);",
        "",
      ].join("\n"),
    );
    await chmod(wrapper, 0o755);
    await stampTree(root);
    const before = await snapshotTree(root);

    await expect(
      analyzeRustProjectWithGraph(
        root,
        { now: new Date(0) },
        { cargoCommand: wrapper, cargoTargetParentDir: targetParent },
      ),
    ).rejects.toThrow(
      /required dependency sources are unavailable locally; fetch them explicitly before analysis/,
    );
    expect(await snapshotTree(root)).toEqual(before);
    expect(await readdir(targetParent)).toEqual([]);
  });

  it("refuses a registry dependency with an empty Cargo cache in frozen offline mode", async () => {
    const root = await project("unused-rust-no-cache-project-");
    const targetParent = await project("unused-rust-no-cache-targets-");
    const cargoHome = await project("unused-rust-no-cache-home-");
    await write(
      root,
      "Cargo.toml",
      '[package]\nname = "neutral-no-cache"\nversion = "0.1.0"\nedition = "2024"\n\n[dependencies]\nunicode-ident = "=1.0.24"\n',
    );
    await write(
      root,
      "Cargo.lock",
      [
        "# This file is automatically @generated by Cargo.",
        "version = 4",
        "",
        "[[package]]",
        'name = "neutral-no-cache"',
        'version = "0.1.0"',
        'dependencies = ["unicode-ident"]',
        "",
        "[[package]]",
        'name = "unicode-ident"',
        'version = "1.0.24"',
        'source = "registry+https://github.com/rust-lang/crates.io-index"',
        'checksum = "e6e4313cd5fcd3dad5cafa179702e2b244f760991f45397d14d4ebf38247da75"',
        "",
      ].join("\n"),
    );
    await write(root, "src/lib.rs", "pub fn public_api() {}\n");
    await stampTree(root);
    await stampTree(cargoHome);
    const before = await snapshotTree(root);
    expect(await readdir(cargoHome)).toEqual([]);
    const prior = takeCargoEnvironment();
    (process.env as CargoEnvironment).CARGO_HOME = cargoHome;
    try {
      await expect(
        analyzeRustProjectWithGraph(
          root,
          { now: new Date(0) },
          { cargoTargetParentDir: targetParent },
        ),
      ).rejects.toThrow(
        /required dependency sources are unavailable locally; fetch them explicitly before analysis/,
      );
    } finally {
      restoreCargoEnvironment(prior);
    }
    expect(await snapshotTree(root)).toEqual(before);
    expect(await readdir(targetParent)).toEqual([]);
  });

  it.each(["relative", "default", "symlink"] as const)(
    "refuses an effective %s Cargo home inside the consumer before creating a target",
    async (kind) => {
      const root = await project(`unused-rust-cargo-home-${kind}-project-`);
      const targetParent = await project(`unused-rust-cargo-home-${kind}-targets-`);
      const external = await project(`unused-rust-cargo-home-${kind}-external-`);
      await writeNeutralCrate(root, true);
      const environment = process.env as CargoEnvironment;
      const prior = takeCargoEnvironment();
      let refusedHome: string;
      if (kind === "relative") {
        environment.CARGO_HOME = "relative-cache";
        refusedHome = join(root, "relative-cache");
      } else if (kind === "default") {
        delete environment.CARGO_HOME;
        environment.HOME = root;
        refusedHome = join(root, ".cargo");
      } else {
        refusedHome = join(root, "linked-cache");
        await mkdir(refusedHome);
        const link = join(external, "cargo-home-link");
        await symlink(refusedHome, link, "dir");
        environment.CARGO_HOME = link;
      }
      await stampTree(root);
      await stampTree(targetParent);
      const projectBefore = await snapshotTree(root);
      const targetParentBefore = await lstat(targetParent, { bigint: true });
      const targetEntriesBefore = await readdir(targetParent);
      try {
        await expect(
          analyzeRustProjectWithGraph(
            root,
            { now: new Date(0) },
            { cargoTargetParentDir: targetParent },
          ),
        ).rejects.toThrow(/effective Cargo home inside the consumer project/);
      } finally {
        restoreCargoEnvironment(prior);
      }
      expect(await snapshotTree(root)).toEqual(projectBefore);
      expect(await readdir(targetParent)).toEqual(targetEntriesBefore);
      expect((await lstat(targetParent, { bigint: true })).mtimeNs).toBe(
        targetParentBefore.mtimeNs,
      );
      if (kind !== "symlink") {
        await expect(lstat(refusedHome)).rejects.toThrow();
      }
    },
  );
});

async function project(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

async function writeNeutralCrate(root: string, lock: boolean): Promise<void> {
  await write(
    root,
    "Cargo.toml",
    '[package]\nname = "neutral-isolation"\nversion = "0.1.0"\nedition = "2024"\nbuild = "build.rs"\n',
  );
  if (lock) {
    await write(
      root,
      "Cargo.lock",
      '# This file is automatically @generated by Cargo.\nversion = 4\n\n[[package]]\nname = "neutral-isolation"\nversion = "0.1.0"\n',
    );
  }
  await write(
    root,
    "build.rs",
    [
      "use std::{env, fs, path::Path};",
      "fn main() {",
      '    let out = env::var("OUT_DIR").expect("Cargo supplies OUT_DIR");',
      '    fs::write(Path::new(&out).join("neutral-generated.txt"), "generated").unwrap();',
      '    println!("cargo::rerun-if-changed=build.rs");',
      "}",
      "",
    ].join("\n"),
  );
  await write(root, "src/lib.rs", "pub fn public_api() {}\nfn dead_helper() {}\n");
}

async function write(root: string, path: string, contents: string): Promise<void> {
  const target = join(root, path);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, contents);
}

async function snapshotTree(root: string): Promise<readonly SnapshotEntry[]> {
  const rootStat = await lstat(root, { bigint: true });
  const entries: SnapshotEntry[] = [
    {
      path: ".",
      type: "directory",
      mode: Number(rootStat.mode),
      mtimeNs: rootStat.mtimeNs,
      size: rootStat.size,
      content: "",
    },
  ];
  const walk = async (dir: string): Promise<void> => {
    for (const name of (await readdir(dir)).sort()) {
      const path = join(dir, name);
      const stat = await lstat(path, { bigint: true });
      const common = {
        path: relative(root, path),
        mode: Number(stat.mode),
        mtimeNs: stat.mtimeNs,
        size: stat.size,
      };
      if (stat.isSymbolicLink()) {
        entries.push({ ...common, type: "symlink", content: await readlink(path) });
      } else if (stat.isDirectory()) {
        entries.push({ ...common, type: "directory", content: "" });
        await walk(path);
      } else {
        entries.push({
          ...common,
          type: "file",
          content: createHash("sha256")
            .update(await readFile(path))
            .digest("hex"),
        });
      }
    }
  };
  await walk(root);
  return entries;
}

async function stampTree(root: string): Promise<void> {
  const directories: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    directories.push(dir);
    for (const name of await readdir(dir)) {
      const path = join(dir, name);
      const stat = await lstat(path);
      if (stat.isSymbolicLink()) await lutimes(path, FIXED_TIME, FIXED_TIME);
      else if (stat.isDirectory()) await walk(path);
      else await utimes(path, FIXED_TIME, FIXED_TIME);
    }
  };
  await walk(root);
  for (const directory of directories.reverse()) await utimes(directory, FIXED_TIME, FIXED_TIME);
}

function takeCargoEnvironment(): Record<string, string | undefined> {
  const environment = process.env as CargoEnvironment;
  return {
    CARGO_HOME: environment.CARGO_HOME,
    CARGO_TARGET_DIR: environment.CARGO_TARGET_DIR,
    CARGO_BUILD_TARGET_DIR: environment.CARGO_BUILD_TARGET_DIR,
    CARGO_BUILD_BUILD_DIR: environment.CARGO_BUILD_BUILD_DIR,
    HOME: environment.HOME,
    UNUSED_CARGO_LOG: environment.UNUSED_CARGO_LOG,
    UNUSED_REAL_CARGO: environment.UNUSED_REAL_CARGO,
  };
}

async function writeCargoWrapper(path: string): Promise<void> {
  await writeFile(
    path,
    [
      "#!/usr/bin/env node",
      'import { spawnSync } from "node:child_process";',
      'import { appendFileSync } from "node:fs";',
      "const args = process.argv.slice(2);",
      "appendFileSync(process.env.UNUSED_CARGO_LOG, JSON.stringify({",
      "  args,",
      "  cargoHome: process.env.CARGO_HOME,",
      "  targetDir: process.env.CARGO_TARGET_DIR,",
      "  buildTargetDir: process.env.CARGO_BUILD_TARGET_DIR,",
      "  buildDir: process.env.CARGO_BUILD_BUILD_DIR,",
      "  offline: process.env.CARGO_NET_OFFLINE,",
      '}) + "\\n");',
      "const result = spawnSync(process.env.UNUSED_REAL_CARGO, args, {",
      '  stdio: "inherit", env: process.env,',
      "});",
      "if (result.error) throw result.error;",
      "process.exit(result.status ?? 1);",
      "",
    ].join("\n"),
  );
  await chmod(path, 0o755);
}

function restoreCargoEnvironment(prior: Readonly<Record<string, string | undefined>>): void {
  for (const [key, value] of Object.entries(prior)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}
