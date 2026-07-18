/**
 * Discovery tests (T2.1): extension filter, node_modules/dist/hidden exclusion,
 * deterministic sorted order, and no-symlink-following.
 */
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { discover } from "./discover.js";

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
});
