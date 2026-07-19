/**
 * `analyzeProject` end-to-end config integration (T4.3 acceptance,
 * phasing.md M4): `entry`/`project`/`suppressions`/`ignoreDependencies`/
 * `workspaces` overrides, `--config <path>`, the hazard-scope interaction
 * note, and invalid-config → `ConfigError` (CLI maps to exit 3).
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Claim } from "../../core/claims/types.js";
import { analyzeProject } from "./analyze.js";
import { ConfigError } from "./config.js";

const testfx = (c: string): string =>
  fileURLToPath(new URL(`./__testfixtures__/${c}`, import.meta.url));
const FIXED_CLOCK = new Date(0);

interface Shape {
  kind: string;
  name: string;
  file: string;
  confidence: string;
  verdict: string;
  package?: string;
}

function shapes(claims: readonly Claim[]): Shape[] {
  return claims
    .map((c) => ({
      kind: c.subject.kind,
      name: c.subject.name,
      file: c.subject.loc.file,
      confidence: c.confidence,
      verdict: c.verdict,
      ...(c.subject.loc.package !== undefined ? { package: c.subject.loc.package } : {}),
    }))
    .sort((a, b) => `${a.kind} ${a.name} ${a.file}`.localeCompare(`${b.kind} ${b.name} ${b.file}`));
}

describe("config: entry + project + graph-preserving suppression", () => {
  it("keeps suppressed files in analysis while marking their claims", async () => {
    const run = await analyzeProject(testfx("config-basic"), { now: FIXED_CLOCK });
    expect(shapes(run.claims.filter((claim) => claim.suppression === undefined))).toEqual([
      {
        kind: "file",
        name: "src/orphan.ts",
        file: "src/orphan.ts",
        confidence: "high",
        verdict: "unused",
      },
    ]);
    expect(
      run.claims.find((claim) => claim.subject.name === "src/generated/skip.ts")?.suppression,
    ).toEqual({ reason: "generated source", source: "config", pattern: "src/generated/**" });
    const claimedFiles = run.claims.map((c) => c.subject.name);
    for (const notClaimed of [
      "src/index.ts", // an entrypoint
      "src/extra-entry.ts", // an entrypoint (config-seeded)
      "src/chained.ts", // alive via the extra-entry chain
      "scripts/outside.ts", // out of project scope — unclaimable, not undiscovered
    ]) {
      expect(claimedFiles).not.toContain(notClaimed);
    }
  });

  it("config-project-narrowing: preserves a dead out-of-project import edge without making it a liveness root", async () => {
    const run = await analyzeProject(testfx("config-project-narrowing"), { now: FIXED_CLOCK });
    // scripts/build.ts remains represented in the graph, but project scope does
    // not turn the otherwise-dead script into a production root. Its target is
    // therefore truthfully dead too, while the script itself is unclaimable.
    expect(shapes(run.claims)).toEqual([
      {
        kind: "file",
        name: "src/helper.ts",
        file: "src/helper.ts",
        confidence: "high",
        verdict: "unused",
      },
      {
        kind: "file",
        name: "src/orphan.ts",
        file: "src/orphan.ts",
        confidence: "high",
        verdict: "unused",
      },
    ]);
    const claimedFiles = run.claims.map((c) => c.subject.name);
    expect(claimedFiles).toContain("src/helper.ts");
    expect(claimedFiles).not.toContain("scripts/build.ts");
  });
});

describe("config: ignoreDependencies", () => {
  const fixture = "config-ignore-dependencies";
  beforeAll(async () => {
    // Materialize installed (no-bin) manifests so the dependency claims aren't
    // masked by pre-install bin conservatism (mirrors dependencies.test.ts).
    for (const dep of ["left-pad", "right-pad"]) {
      const dir = join(testfx(fixture), "node_modules", dep);
      await mkdir(dir, { recursive: true });
      await writeFile(
        join(dir, "package.json"),
        JSON.stringify({ name: dep, version: "1.0.0" }, null, 2),
      );
    }
  });
  afterAll(async () => {
    await rm(join(testfx(fixture), "node_modules"), { recursive: true, force: true });
  });

  it("suppresses the ignored dependency claim, keeps the other one", async () => {
    const run = await analyzeProject(testfx(fixture), { now: FIXED_CLOCK });
    const depClaims = run.claims.filter((c) => c.subject.kind === "dependency");
    expect(depClaims.map((c) => c.subject.name)).toEqual(["right-pad"]);
  });
});

describe("config: workspaces override (scoped, doesn't leak to sibling units)", () => {
  it("config-workspace-override: packages/api's extra.ts chain is alive; packages/web's same-shaped file is dead", async () => {
    const run = await analyzeProject(testfx("config-workspace-override"), { now: FIXED_CLOCK });
    expect(shapes(run.claims)).toEqual([
      {
        kind: "file",
        name: "packages/web/src/extra.ts",
        file: "packages/web/src/extra.ts",
        confidence: "high",
        verdict: "unused",
        package: "@x/web",
      },
    ]);
  });
});

describe("config: suppressions preserve graph hazards", () => {
  it("keeps a suppressed computed-import carrier analyzed", async () => {
    const run = await analyzeProject(testfx("config-ignore-hazard"), { now: FIXED_CLOCK });
    const loader = run.claims.find((claim) => claim.subject.name === "src/loader.ts");
    expect(loader?.suppression).toEqual({
      reason: "runtime loader retained by policy",
      source: "config",
      pattern: "src/loader.ts",
    });
    expect(run.fileCount).toBe(3);
  });
});

describe("config: --config <path>", () => {
  const tmpDirs: string[] = [];
  async function makeTmpDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "unused-analyze-config-test-"));
    tmpDirs.push(dir);
    return dir;
  }
  afterEach(async () => {
    await Promise.all(tmpDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });

  it("loads config from an explicit path, ignoring any default-named file at the root", async () => {
    const root = await makeTmpDir();
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ name: "x", main: "src/index.ts" }),
    );
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src", "index.ts"), "export const main = 1;\n");
    await writeFile(join(root, "src", "orphan.ts"), "export const orphan = 1;\n");
    // A default-named config that would suppress the orphan, and a custom one
    // that doesn't — --config must select the custom one.
    await writeFile(
      join(root, "unused.config.jsonc"),
      '{ "suppressions": [{ "files": ["src/orphan.ts"], "kinds": ["file"], "reason": "default policy" }] }',
    );
    await writeFile(join(root, "custom.jsonc"), "{}");

    const run = await analyzeProject(root, { now: FIXED_CLOCK, configPath: "custom.jsonc" });
    expect(run.claims.map((c) => c.subject.name)).toContain("src/orphan.ts");
  });

  it("a missing --config target throws ConfigError (CLI maps this to exit 3)", async () => {
    const root = await makeTmpDir();
    await writeFile(join(root, "package.json"), JSON.stringify({ name: "x" }));
    await expect(
      analyzeProject(root, { now: FIXED_CLOCK, configPath: "does-not-exist.jsonc" }),
    ).rejects.toThrow(ConfigError);
  });

  it("a malformed config file throws ConfigError naming the fix", async () => {
    const root = await makeTmpDir();
    await writeFile(join(root, "package.json"), JSON.stringify({ name: "x" }));
    await writeFile(join(root, "unused.config.jsonc"), '{ "entry": [oops] }');
    await expect(analyzeProject(root, { now: FIXED_CLOCK })).rejects.toThrow(ConfigError);
  });

  it("an unknown config field throws ConfigError naming the field", async () => {
    const root = await makeTmpDir();
    await writeFile(join(root, "package.json"), JSON.stringify({ name: "x" }));
    await writeFile(join(root, "unused.config.jsonc"), '{ "bogusField": [] }');
    await expect(analyzeProject(root, { now: FIXED_CLOCK })).rejects.toThrow(/bogusField/);
  });
});

describe("config: ciSecondsPerTestFile (T5.3, end-to-end)", () => {
  const tmpDirs: string[] = [];
  async function makeTmpDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "unused-analyze-config-cisec-test-"));
    tmpDirs.push(dir);
    return dir;
  }
  afterEach(async () => {
    await Promise.all(tmpDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });

  /** A minimal fixture with exactly one zombie test (one test-only file, one zombie test claim). */
  async function makeZombieTestFixture(root: string): Promise<void> {
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ name: "x", main: "src/index.ts" }),
    );
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src", "index.ts"), "export const main = 1;\n");
    await writeFile(
      join(root, "src", "feature.ts"),
      "export function computeFeature(x: number): number {\n  return x * 2;\n}\n",
    );
    await writeFile(
      join(root, "src", "feature.test.ts"),
      'import { computeFeature } from "./feature.js";\n' +
        'if (computeFeature(2) !== 4) throw new Error("unexpected");\n',
    );
  }

  it("uses the DEFAULT_CI_SECONDS_PER_TEST_FILE average (5) with no config", async () => {
    const root = await makeTmpDir();
    await makeZombieTestFixture(root);
    const run = await analyzeProject(root, { now: FIXED_CLOCK });
    expect(run.summary.zombieTests).toEqual({
      count: 1,
      estCiSecondsPerRun: 5,
      estimated: true,
      avgSecondsPerTestFile: 5,
    });
  });

  it("honours a config ciSecondsPerTestFile override end-to-end", async () => {
    const root = await makeTmpDir();
    await makeZombieTestFixture(root);
    await writeFile(join(root, "unused.config.jsonc"), '{ "ciSecondsPerTestFile": 12 }');
    const run = await analyzeProject(root, { now: FIXED_CLOCK });
    expect(run.summary.zombieTests).toEqual({
      count: 1,
      estCiSecondsPerRun: 12,
      estimated: true,
      avgSecondsPerTestFile: 12,
    });
  });

  it("omits zombieTests entirely on a run with no zombie tests", async () => {
    const root = await makeTmpDir();
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ name: "x", main: "src/index.ts" }),
    );
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src", "index.ts"), "export const main = 1;\n");
    const run = await analyzeProject(root, { now: FIXED_CLOCK });
    expect(run.summary.zombieTests).toBeUndefined();
  });
});

describe("config: empty-match warnings (reviewer-adopted optional, end-to-end)", () => {
  const tmpDirs: string[] = [];
  async function makeTmpDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "unused-analyze-config-warn-test-"));
    tmpDirs.push(dir);
    return dir;
  }
  afterEach(async () => {
    await Promise.all(tmpDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });

  it("a typo'd entry glob warns to stderr but does not fail the run", async () => {
    const root = await makeTmpDir();
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ name: "x", main: "src/index.ts" }),
    );
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src", "index.ts"), "export const main = 1;\n");
    await writeFile(
      join(root, "unused.config.jsonc"),
      '{ "entry": ["src/typo-does-not-exist.ts"] }',
    );

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const run = await analyzeProject(root, { now: FIXED_CLOCK });
      expect(run.claims).toEqual([]); // still analyzes successfully
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]?.[0])).toMatch(/"entry".*matched no files/);
    } finally {
      warn.mockRestore();
    }
  });

  it("a config with every pattern matching is silent", async () => {
    const root = await makeTmpDir();
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ name: "x", main: "src/index.ts" }),
    );
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src", "index.ts"), "export const main = 1;\n");
    await writeFile(join(root, "unused.config.jsonc"), '{ "project": ["src/**"] }');

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await analyzeProject(root, { now: FIXED_CLOCK });
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});
