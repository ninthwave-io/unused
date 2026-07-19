import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EMPTY_CONFIG, type UnusedConfig } from "./config.js";
import {
  activePresetsForUnit,
  detectPreset,
  matchPresetEntryPatterns,
  NEXT_PRESET,
  VITE_PRESET,
  viteHtmlEntrypoints,
} from "./presets.js";

const tmpDirs: string[] = [];
async function makeTmpDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "unused-presets-test-"));
  tmpDirs.push(dir);
  return dir;
}
afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe("detectPreset", () => {
  it("is false when no marker config file or dependency is present", async () => {
    const dir = await makeTmpDir();
    await writeFile(join(dir, "package.json"), JSON.stringify({ name: "x" }));
    expect(await detectPreset(VITE_PRESET, dir)).toBe(false);
    expect(await detectPreset(NEXT_PRESET, dir)).toBe(false);
  });

  it("activates on a marker config file alone", async () => {
    const dir = await makeTmpDir();
    await writeFile(join(dir, "vite.config.ts"), "export default {};");
    expect(await detectPreset(VITE_PRESET, dir)).toBe(true);
    expect(await detectPreset(NEXT_PRESET, dir)).toBe(false);
  });

  it("activates on a declared dependency alone (dependencies)", async () => {
    const dir = await makeTmpDir();
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({ name: "x", dependencies: { next: "^14.0.0" } }),
    );
    expect(await detectPreset(NEXT_PRESET, dir)).toBe(true);
  });

  it("activates on a declared dependency alone (devDependencies)", async () => {
    const dir = await makeTmpDir();
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({ name: "x", devDependencies: { vite: "^5.0.0" } }),
    );
    expect(await detectPreset(VITE_PRESET, dir)).toBe(true);
  });

  it("does not confuse a similarly-prefixed package name with the marker dependency", async () => {
    const dir = await makeTmpDir();
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({ name: "x", dependencies: { "vite-plugin-foo": "^1.0.0" } }),
    );
    expect(await detectPreset(VITE_PRESET, dir)).toBe(false);
  });
});

describe("activePresetsForUnit", () => {
  it("auto-detects nothing when EMPTY_CONFIG and no markers are present", async () => {
    const dir = await makeTmpDir();
    expect(await activePresetsForUnit(EMPTY_CONFIG, dir)).toEqual([]);
  });

  it("auto-detects vite when its marker is present and config.presets is undefined", async () => {
    const dir = await makeTmpDir();
    await writeFile(join(dir, "vite.config.ts"), "export default {};");
    const active = await activePresetsForUnit(EMPTY_CONFIG, dir);
    expect(active.map((p) => p.name)).toEqual(["vite"]);
  });

  it("config.presets FORCES the named presets even with no marker present", async () => {
    const dir = await makeTmpDir();
    const config: UnusedConfig = { ...EMPTY_CONFIG, presets: ["next"] };
    const active = await activePresetsForUnit(config, dir);
    expect(active.map((p) => p.name)).toEqual(["next"]);
  });

  it("config.presets: [] force-disables auto-detection even with a marker present", async () => {
    const dir = await makeTmpDir();
    await writeFile(join(dir, "vite.config.ts"), "export default {};");
    const config: UnusedConfig = { ...EMPTY_CONFIG, presets: [] };
    expect(await activePresetsForUnit(config, dir)).toEqual([]);
  });
});

describe("matchPresetEntryPatterns — next", () => {
  it("matches Pages Router files anywhere under pages/, including pages/api/**", () => {
    const files = ["pages/index.tsx", "pages/api/hello.ts", "src/pages/about.tsx"];
    const hits = matchPresetEntryPatterns(NEXT_PRESET, files, "").map((h) => h.file);
    expect(hits.sort()).toEqual(files.sort());
  });

  it("matches only App Router convention filenames, not arbitrary files under app/**", () => {
    const files = [
      "app/page.tsx",
      "app/layout.tsx",
      "app/blog/[slug]/page.tsx",
      "app/api/hello/route.ts",
      "app/components/OrphanButton.tsx", // NOT a convention name — must not match
    ];
    const hits = matchPresetEntryPatterns(NEXT_PRESET, files, "").map((h) => h.file);
    expect(hits.sort()).toEqual(
      [
        "app/page.tsx",
        "app/layout.tsx",
        "app/blog/[slug]/page.tsx",
        "app/api/hello/route.ts",
      ].sort(),
    );
  });

  it("matches App Router metadata-route conventions (reviewer fix, false-positive finding)", () => {
    const files = [
      "app/sitemap.ts",
      "app/robots.ts",
      "app/manifest.ts",
      "app/opengraph-image.tsx",
      "app/twitter-image.tsx",
      "app/icon.tsx",
      "app/apple-icon.tsx",
      "src/app/sitemap.ts",
      "app/components/NotAMetadataFile.tsx", // NOT a convention name — must not match
    ];
    const hits = matchPresetEntryPatterns(NEXT_PRESET, files, "").map((h) => h.file);
    expect(hits.sort()).toEqual(
      [
        "app/sitemap.ts",
        "app/robots.ts",
        "app/manifest.ts",
        "app/opengraph-image.tsx",
        "app/twitter-image.tsx",
        "app/icon.tsx",
        "app/apple-icon.tsx",
        "src/app/sitemap.ts",
      ].sort(),
    );
  });

  it("matches src/app/** convention files and middleware/instrumentation", () => {
    const files = [
      "src/app/page.tsx",
      "middleware.ts",
      "src/instrumentation.ts",
      "src/app/components/Widget.tsx",
    ];
    const hits = matchPresetEntryPatterns(NEXT_PRESET, files, "").map((h) => h.file);
    expect(hits.sort()).toEqual(
      ["src/app/page.tsx", "middleware.ts", "src/instrumentation.ts"].sort(),
    );
  });

  it("scopes matching to the given unit (package-relative) in a monorepo", () => {
    const files = ["packages/web/pages/index.tsx", "packages/other/pages/index.tsx"];
    const hits = matchPresetEntryPatterns(NEXT_PRESET, files, "packages/web").map((h) => h.file);
    expect(hits).toEqual(["packages/web/pages/index.tsx"]);
  });

  it("vite's entryPatterns are empty — glob matching alone never seeds anything", () => {
    expect(matchPresetEntryPatterns(VITE_PRESET, ["src/main.ts"], "")).toEqual([]);
  });
});

describe("viteHtmlEntrypoints", () => {
  it("seeds a root-relative script src (leading /) that resolves to an analyzed file", async () => {
    const dir = await makeTmpDir();
    await writeFile(
      join(dir, "index.html"),
      '<!doctype html><html><body><script type="module" src="/src/main.ts"></script></body></html>',
    );
    const hits = await viteHtmlEntrypoints(dir, "", new Set(["src/main.ts", "src/orphan.ts"]));
    expect(hits).toEqual([{ file: "src/main.ts", reason: "preset:vite:index.html" }]);
  });

  it("seeds a relative script src, resolved against the html file's directory", async () => {
    const dir = await makeTmpDir();
    await writeFile(join(dir, "index.html"), '<script src="./src/main.ts"></script>');
    const hits = await viteHtmlEntrypoints(dir, "", new Set(["src/main.ts"]));
    expect(hits).toEqual([{ file: "src/main.ts", reason: "preset:vite:index.html" }]);
  });

  it("strips a query string / fragment before resolving", async () => {
    const dir = await makeTmpDir();
    await writeFile(join(dir, "index.html"), '<script src="/src/main.ts?dev"></script>');
    const hits = await viteHtmlEntrypoints(dir, "", new Set(["src/main.ts"]));
    expect(hits).toEqual([{ file: "src/main.ts", reason: "preset:vite:index.html" }]);
  });

  it("resolves an extension-less src against the analyzed source extensions", async () => {
    const dir = await makeTmpDir();
    await writeFile(join(dir, "index.html"), '<script type="module" src="/src/main"></script>');
    const hits = await viteHtmlEntrypoints(dir, "", new Set(["src/main.tsx"]));
    expect(hits).toEqual([{ file: "src/main.tsx", reason: "preset:vite:index.html" }]);
  });

  it("skips an external URL script src", async () => {
    const dir = await makeTmpDir();
    await writeFile(
      join(dir, "index.html"),
      '<script src="https://cdn.example.com/x.js"></script>',
    );
    expect(await viteHtmlEntrypoints(dir, "", new Set(["src/main.ts"]))).toEqual([]);
  });

  it("ignores an html file nested below the package root (not top-level)", async () => {
    const dir = await makeTmpDir();
    await mkdir(join(dir, "public"), { recursive: true });
    await writeFile(join(dir, "public", "nested.html"), '<script src="/src/main.ts"></script>');
    expect(await viteHtmlEntrypoints(dir, "", new Set(["src/main.ts"]))).toEqual([]);
  });

  it("a src that resolves to nothing in the analyzed set is silently skipped (no crash, no hit)", async () => {
    const dir = await makeTmpDir();
    await writeFile(join(dir, "index.html"), '<script src="/src/missing.ts"></script>');
    expect(await viteHtmlEntrypoints(dir, "", new Set(["src/main.ts"]))).toEqual([]);
  });

  it("prefixes the hit with the workspace unit's root-relative directory in a monorepo", async () => {
    const dir = await makeTmpDir();
    await writeFile(join(dir, "index.html"), '<script src="/src/main.ts"></script>');
    const hits = await viteHtmlEntrypoints(dir, "packages/web", new Set(["src/main.ts"]));
    expect(hits).toEqual([{ file: "packages/web/src/main.ts", reason: "preset:vite:index.html" }]);
  });
});
