/**
 * `analyzeProject` end-to-end config integration (T4.3 acceptance,
 * phasing.md M4): `entry`/`project`/`ignore`/`ignoreDependencies`/
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

describe("config: entry (additive) + project (claimability) + ignore (undiscovery)", () => {
  it("config-basic: extra-entry chain alive, project-scoped orphan flagged, ignored file invisible, out-of-project orphan just unclaimable", async () => {
    const run = await analyzeProject(testfx("config-basic"), { now: FIXED_CLOCK });
    // Only the genuinely-dead, claimable, non-ignored orphan is claimed.
    // scripts/outside.ts is a real orphan too (nothing imports it either),
    // but "project" only narrows claimability — it is still discovered and
    // parsed (unlike the ignored src/generated/skip.ts), it just can never
    // itself be flagged.
    expect(shapes(run.claims)).toEqual([
      {
        kind: "file",
        name: "src/orphan.ts",
        file: "src/orphan.ts",
        confidence: "high",
        verdict: "unused",
      },
    ]);
    const claimedFiles = run.claims.map((c) => c.subject.name);
    for (const notClaimed of [
      "src/index.ts", // an entrypoint
      "src/extra-entry.ts", // an entrypoint (config-seeded)
      "src/chained.ts", // alive via the extra-entry chain
      "src/generated/skip.ts", // ignore-undiscovered
      "scripts/outside.ts", // out of project scope — unclaimable, not undiscovered
    ]) {
      expect(claimedFiles).not.toContain(notClaimed);
    }
  });

  it("config-project-narrowing (reviewer fix, fooling input): an out-of-project importer keeps an in-project file alive; the out-of-project file is itself never claimed", async () => {
    const run = await analyzeProject(testfx("config-project-narrowing"), { now: FIXED_CLOCK });
    // src/helper.ts is referenced ONLY by scripts/build.ts (out of
    // "project": ["src/**"]) — before the fix, build.ts was dropped from the
    // graph entirely and helper.ts false-flagged as a confident "unused".
    // scripts/build.ts itself is never claimable, even though nothing
    // imports it. Only the genuine in-project orphan is flagged.
    expect(shapes(run.claims)).toEqual([
      {
        kind: "file",
        name: "src/orphan.ts",
        file: "src/orphan.ts",
        confidence: "high",
        verdict: "unused",
      },
    ]);
    const claimedFiles = run.claims.map((c) => c.subject.name);
    expect(claimedFiles).not.toContain("src/helper.ts");
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

describe("config: hazard-scope interaction — an ignored file can't host a hazard", () => {
  it("config-ignore-hazard: with the computed-import file ignored, the orphan it would have capped is a plain HIGH claim", async () => {
    const run = await analyzeProject(testfx("config-ignore-hazard"), { now: FIXED_CLOCK });
    expect(shapes(run.claims)).toEqual([
      {
        kind: "file",
        name: "src/mods/alpha.ts",
        file: "src/mods/alpha.ts",
        confidence: "high", // NOT medium — contrast with fixtures/ts/string-computed-import
        verdict: "unused",
      },
    ]);
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
    // A default-named config that would ignore the orphan, and a custom one
    // that doesn't — --config must select the custom one.
    await writeFile(join(root, "unused.config.jsonc"), '{ "ignore": ["src/orphan.ts"] }');
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
