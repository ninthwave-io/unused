import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadCargoMetadata } from "./metadata.js";
import { CargoMetadataError, CargoToolchainError } from "./runner.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Cargo metadata boundary", () => {
  it("loads workspace members, targets, and features without dependencies", async () => {
    const root = await mkdtemp(join(tmpdir(), "unused-cargo-metadata-"));
    roots.push(root);
    await mkdir(join(root, "crates", "worker", "src"), { recursive: true });
    await writeFile(
      join(root, "Cargo.toml"),
      '[workspace]\nmembers = ["crates/worker"]\nresolver = "3"\n',
    );
    await writeFile(
      join(root, "crates", "worker", "Cargo.toml"),
      '[package]\nname = "neutral-worker"\nversion = "0.1.0"\nedition = "2024"\n\n[features]\nextra = []\n',
    );
    await writeFile(join(root, "crates", "worker", "src", "lib.rs"), "pub fn live() {}\n");

    const metadata = loadCargoMetadata(root);

    expect(metadata.workspaceRoot).toBe(await realpath(root));
    expect(metadata.packages).toHaveLength(1);
    expect(metadata.packages[0]).toMatchObject({
      name: "neutral-worker",
      features: { extra: [] },
      targets: [
        {
          name: "neutral_worker",
          kinds: ["lib"],
          crateTypes: ["lib"],
          edition: "2024",
        },
      ],
    });
    expect(metadata.workspaceMemberIds.has(metadata.packages[0]?.id ?? "missing")).toBe(true);
  });

  it("attributes a missing Cargo executable to the toolchain", async () => {
    const root = await mkdtemp(join(tmpdir(), "unused-cargo-toolchain-"));
    roots.push(root);
    expect(() => loadCargoMetadata(root, { cargoCommand: "unused-cargo-does-not-exist" })).toThrow(
      CargoToolchainError,
    );
  });

  it("refuses invalid Cargo projects explicitly", async () => {
    const root = await mkdtemp(join(tmpdir(), "unused-cargo-invalid-"));
    roots.push(root);
    await writeFile(join(root, "Cargo.toml"), "[package\n");
    expect(() => loadCargoMetadata(root)).toThrow(CargoMetadataError);
  });
});
