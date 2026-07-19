/**
 * `analyzeProject` end-to-end preset integration (T4.4 acceptance,
 * phasing.md M4): vite (index.html carrier), next (page/dynamic-route/API
 * route reservation), preset auto-activation (config-file and
 * dependency-only marker arms), and a config-forced preset with no marker
 * present at all.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { Claim } from "../../core/claims/types.js";
import { analyzeProject } from "./analyze.js";

const testfx = (c: string): string =>
  fileURLToPath(new URL(`./__testfixtures__/${c}`, import.meta.url));
const FIXED_CLOCK = new Date(0);

function claimNames(claims: readonly Claim[]): string[] {
  return claims.map((c) => c.subject.name).sort();
}

describe("vite preset — index.html as an entrypoint carrier (config-file marker)", () => {
  it("preset-vite: the html → main.ts → app.ts chain is alive; the orphan is dead/high; zero FPs", async () => {
    const run = await analyzeProject(testfx("preset-vite"), { now: FIXED_CLOCK });
    expect(run.claims).toHaveLength(1);
    expect(run.claims[0]).toMatchObject({
      subject: { kind: "file", name: "src/orphan.ts" },
      verdict: "unused",
      confidence: "high",
    });
    expect(claimNames(run.claims)).not.toContain("src/main.ts");
    expect(claimNames(run.claims)).not.toContain("src/app.ts");
  });
});

describe("vite preset — dependency-only marker auto-activation", () => {
  it("preset-vite-dep-marker: a bare vite devDependency (no vite.config.*) is enough to activate the preset", async () => {
    const run = await analyzeProject(testfx("preset-vite-dep-marker"), { now: FIXED_CLOCK });
    // src/main.ts is the only file in this fixture; it must be alive (an
    // entrypoint via index.html), so there is nothing left to claim.
    expect(run.claims).toEqual([]);
    expect(run.productionEntrypointCount).toBe(1);
  });
});

describe("next preset — page + dynamic route + API route reserved; orphan component still flags", () => {
  it("preset-next: zero FPs on route/page/API-route/metadata files; the orphan component is dead/high", async () => {
    const run = await analyzeProject(testfx("preset-next"), { now: FIXED_CLOCK });
    expect(run.claims).toHaveLength(1);
    expect(run.claims[0]).toMatchObject({
      subject: { kind: "file", name: "src/app/components/OrphanButton.tsx" },
      verdict: "unused",
      confidence: "high",
    });
    const claimed = claimNames(run.claims);
    for (const alwaysAlive of [
      "src/app/page.tsx",
      "src/app/blog/[slug]/page.tsx",
      "src/app/api/hello/route.ts",
      // Metadata-route conventions (reviewer fix, false-positive finding):
      // Next invokes these by filename, no import edge, same as page/route.
      "src/app/sitemap.ts",
      "src/app/robots.ts",
      "src/app/manifest.ts",
      "src/app/opengraph-image.tsx",
      "src/app/twitter-image.tsx",
      "src/app/icon.tsx",
      "src/app/apple-icon.tsx",
    ]) {
      expect(claimed).not.toContain(alwaysAlive);
    }
  });
});

describe("next preset — dependency-only marker auto-activation (Pages Router)", () => {
  it("preset-next-dep-marker: a bare next dependency (no next.config.*) activates the preset; pages/foo.tsx alive, orphan dead", async () => {
    const run = await analyzeProject(testfx("preset-next-dep-marker"), { now: FIXED_CLOCK });
    expect(run.claims).toEqual([
      expect.objectContaining({
        subject: expect.objectContaining({ kind: "file", name: "src/orphan.ts" }),
        confidence: "high",
        verdict: "unused",
      }),
    ]);
  });
});

describe("preset auto-activation — no marker, no config ⇒ inactive (nothing anchors liveness)", () => {
  const tmpDirs: string[] = [];
  async function makeTmpDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "unused-preset-noop-test-"));
    tmpDirs.push(dir);
    return dir;
  }
  afterEach(async () => {
    await Promise.all(tmpDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });

  it("a bare pages/foo.tsx with no next marker anywhere is NOT seeded as an entrypoint", async () => {
    const root = await makeTmpDir();
    await writeFile(join(root, "package.json"), JSON.stringify({ name: "no-marker" }));
    await mkdir(join(root, "pages"));
    await writeFile(
      join(root, "pages", "foo.tsx"),
      "export default function Foo() { return 1; }\n",
    );
    const run = await analyzeProject(root, { now: FIXED_CLOCK });
    expect(run.productionEntrypointCount).toBe(0);
    expect(run.claims).toEqual([]); // no entrypoints ⇒ core emits nothing, never a false "unused"
  });
});

describe("config-forced preset — activates with no marker present at all", () => {
  it("preset-forced: pages/foo.tsx is alive ONLY because unused.config.jsonc forces the next preset", async () => {
    const run = await analyzeProject(testfx("preset-forced"), { now: FIXED_CLOCK });
    expect(run.productionEntrypointCount).toBe(1);
    expect(run.claims).toEqual([]);
  });
});
