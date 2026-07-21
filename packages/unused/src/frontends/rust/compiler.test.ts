import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { collectCompilerDeadFunctions } from "./compiler.js";
import { loadCargoMetadata } from "./metadata.js";
import { CargoCompileError } from "./runner.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function crate(source: string, features = ""): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "unused-rust-compiler-"));
  roots.push(root);
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(
    join(root, "Cargo.toml"),
    `[package]\nname = "neutral-compiler-fixture"\nversion = "0.1.0"\nedition = "2024"\n${features}`,
  );
  await writeFile(join(root, "src", "lib.rs"), source);
  return root;
}

describe("Cargo compiler diagnostic join", () => {
  it("retains a private function dead in default and all-features builds", async () => {
    const root = await crate("pub fn live() {}\nfn dead_helper() {}\n");

    const facts = collectCompilerDeadFunctions(loadCargoMetadata(root));

    expect(facts).toMatchObject([
      {
        name: "dead_helper",
        file: "src/lib.rs",
        site: { file: "src/lib.rs", span: { startLine: 2, endLine: 2 } },
      },
    ]);
  });

  it("drops a default-only warning when an optional feature uses the function", async () => {
    const root = await crate(
      [
        "fn feature_helper() {}",
        '#[cfg(feature = "extra")] pub fn feature_entry() { feature_helper(); }',
        "pub fn live() {}",
        "",
      ].join("\n"),
      "\n[features]\nextra = []\n",
    );

    const facts = collectCompilerDeadFunctions(loadCargoMetadata(root));

    expect(facts.some((fact) => fact.name === "feature_helper")).toBe(false);
  });

  it("refuses when mutually exclusive features make all-features compilation fail", async () => {
    const root = await crate(
      '#[cfg(all(feature = "a", feature = "b"))]\ncompile_error!("features a and b are exclusive");\n',
      "\n[features]\na = []\nb = []\n",
    );

    expect(() => collectCompilerDeadFunctions(loadCargoMetadata(root))).toThrow(CargoCompileError);
  });
});
