/**
 * Discovery tests (T2.1): extension filter, node_modules/dist/hidden exclusion,
 * deterministic sorted order, and no-symlink-following.
 */
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { discover, discoverProjectInventory, filterGitignoredRelativePaths } from "./discover.js";

const created: string[] = [];

async function fixtureTree(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "unused-discover-"));
  created.push(root);
  const files = [
    "src/index.ts",
    "src/app.tsx",
    "src/mod.mts",
    "src/legacy.cts",
    "src/util.js",
    "src/view.jsx",
    "src/esm.mjs",
    "src/cjs.cjs",
    "src/readme.md", // not a source extension
    "src/styles.css", // not a source extension
    "src/nested/deep.ts",
    "node_modules/pkg/index.ts", // excluded dir
    "dist/build.js", // excluded dir
    ".hidden/secret.ts", // hidden dir
    "src/.env.ts", // hidden file
  ];
  for (const rel of files) {
    const abs = join(root, rel);
    await mkdir(join(abs, ".."), { recursive: true });
    await writeFile(abs, "export const x = 1;\n");
  }
  return root;
}

afterAll(async () => {
  const { rm } = await import("node:fs/promises");
  for (const dir of created) await rm(dir, { recursive: true, force: true });
});

describe("discover", () => {
  it("finds all source extensions, excludes node_modules/dist/hidden, sorted", async () => {
    const root = await fixtureTree();
    const found = (await discover(root)).map((p) => relative(root, p).split(sep).join("/"));
    expect(found).toEqual(
      [
        "src/app.tsx",
        "src/cjs.cjs",
        "src/esm.mjs",
        "src/legacy.cts",
        "src/mod.mts",
        "src/nested/deep.ts",
        "src/util.js",
        "src/view.jsx",
        "src/index.ts",
      ].sort(),
    );
  });

  it("returns absolute paths in deterministic (identical across runs) order", async () => {
    const root = await fixtureTree();
    const a = await discover(root);
    const b = await discover(root);
    expect(a).toEqual(b);
    expect(a.every((p) => p.startsWith(root))).toBe(true);
    expect(a).toEqual([...a].sort());
  });

  it("does not follow symlinked files or directories", async () => {
    const root = await mkdtemp(join(tmpdir(), "unused-symlink-"));
    created.push(root);
    await mkdir(join(root, "real"), { recursive: true });
    await writeFile(join(root, "real", "a.ts"), "export const a = 1;\n");
    // symlinked file and symlinked directory
    try {
      await symlink(join(root, "real", "a.ts"), join(root, "link.ts"));
      await symlink(join(root, "real"), join(root, "linkdir"));
    } catch {
      return; // platform without symlink permission — skip
    }
    const found = (await discover(root)).map((p) => relative(root, p).split(sep).join("/"));
    expect(found).toEqual(["real/a.ts"]);
  });

  it("respects root and nested .gitignore rules, including negations", async () => {
    const root = await mkdtemp(join(tmpdir(), "unused-gitignore-"));
    created.push(root);
    const files = [
      "src/live.ts",
      "src/generated/dead.ts",
      "src/generated/keep.ts",
      "src/nested/drop.ts",
      "src/nested/keep.ts",
    ];
    for (const rel of files) {
      const abs = join(root, rel);
      await mkdir(join(abs, ".."), { recursive: true });
      await writeFile(abs, "export const value = 1;\n");
    }
    await writeFile(join(root, ".gitignore"), "src/generated/*\n!src/generated/keep.ts\n");
    await writeFile(join(root, "src/nested/.gitignore"), "*.ts\n!keep.ts\n");

    const found = (await discover(root)).map((p) => relative(root, p).split(sep).join("/"));
    expect(found).toEqual(["src/generated/keep.ts", "src/live.ts", "src/nested/keep.ts"]);
  });

  it("can disable .gitignore handling", async () => {
    const root = await mkdtemp(join(tmpdir(), "unused-no-gitignore-"));
    created.push(root);
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, ".gitignore"), "src/ignored.ts\n");
    await writeFile(join(root, "src/ignored.ts"), "export const ignored = 1;\n");

    expect(await discover(root)).toEqual([]);
    const found = (await discover(root, { gitignore: false })).map((p) =>
      relative(root, p).split(sep).join("/"),
    );
    expect(found).toEqual(["src/ignored.ts"]);
  });

  it("bounds config inventory by the same gitignore and build-output rules", async () => {
    const root = await mkdtemp(join(tmpdir(), "unused-config-inventory-"));
    created.push(root);
    await mkdir(join(root, "src"), { recursive: true });
    await mkdir(join(root, "generated", "member"), { recursive: true });
    await mkdir(join(root, "node_modules", "dependency"), { recursive: true });
    await mkdir(join(root, "cdk.out"), { recursive: true });
    await writeFile(join(root, ".gitignore"), "generated/\n");
    await writeFile(join(root, "package.json"), "{}\n");
    await writeFile(join(root, "src", "config.json"), "{}\n");
    await writeFile(join(root, "generated", "member", "package.json"), "{}\n");
    await writeFile(join(root, "node_modules", "dependency", "package.json"), "{}\n");
    await writeFile(join(root, "cdk.out", "manifest.json"), "{}\n");

    const inventory = await discoverProjectInventory(root);
    expect(inventory.jsonFiles.map((path) => relative(root, path).split(sep).join("/"))).toEqual([
      "package.json",
      "src/config.json",
    ]);
    expect(
      inventory.packageRootDirs.map((path) => relative(root, path).split(sep).join("/")),
    ).toEqual([""]);

    const audit = await discoverProjectInventory(root, { gitignore: false });
    expect(audit.jsonFiles.map((path) => relative(root, path).split(sep).join("/"))).toEqual([
      "generated/member/package.json",
      "package.json",
      "src/config.json",
    ]);
    expect(audit.packageRootDirs.map((path) => relative(root, path).split(sep).join("/"))).toEqual([
      "",
      "generated/member",
    ]);
  });

  it("applies ancestor .gitignore rules when the analysis root is below the Git root", async () => {
    const repository = await mkdtemp(join(tmpdir(), "unused-ancestor-gitignore-"));
    created.push(repository);
    const root = join(repository, "packages", "app");
    await mkdir(join(repository, ".git"), { recursive: true });
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(repository, ".gitignore"), "packages/app/src/ignored.ts\n");
    await writeFile(join(root, "src/ignored.ts"), "export const ignored = 1;\n");
    await writeFile(join(root, "src/live.ts"), "export const live = 1;\n");

    const found = (await discover(root)).map((p) => relative(root, p).split(sep).join("/"));
    expect(found).toEqual(["src/live.ts"]);

    const audit = (await discover(root, { gitignore: false })).map((p) =>
      relative(root, p).split(sep).join("/"),
    );
    expect(audit).toEqual(["src/ignored.ts", "src/live.ts"]);
  });

  it("applies ancestor rules outermost-to-innermost with negations", async () => {
    const repository = await mkdtemp(join(tmpdir(), "unused-ancestor-negation-"));
    created.push(repository);
    const root = join(repository, "packages", "app");
    await mkdir(join(repository, ".git"), { recursive: true });
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(repository, ".gitignore"), "packages/app/src/*.ts\n");
    await writeFile(join(repository, "packages/.gitignore"), "!app/src/keep.ts\n");
    await writeFile(join(root, "src/drop.ts"), "export const drop = 1;\n");
    await writeFile(join(root, "src/keep.ts"), "export const keep = 1;\n");

    const found = (await discover(root)).map((p) => relative(root, p).split(sep).join("/"));
    expect(found).toEqual(["src/keep.ts"]);
  });

  it("filters compiler-discovered non-JavaScript paths through the same ignore stack", async () => {
    const repository = await mkdtemp(join(tmpdir(), "unused-compiler-gitignore-"));
    created.push(repository);
    const root = join(repository, "apps", "service");
    await mkdir(join(repository, ".git"), { recursive: true });
    await mkdir(join(root, "lib/generated"), { recursive: true });
    await writeFile(join(repository, ".gitignore"), "apps/service/lib/generated/*\n");
    await writeFile(join(root, "lib/generated/.gitignore"), "!keep.ex\n");

    await expect(
      filterGitignoredRelativePaths(root, [
        "lib/app.ex",
        "lib/generated/drop.ex",
        "lib/generated/keep.ex",
      ]),
    ).resolves.toEqual(["lib/app.ex", "lib/generated/keep.ex"]);
  });
});
