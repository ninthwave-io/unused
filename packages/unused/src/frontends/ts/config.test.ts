import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ConfigError,
  collectConfigEntrypoints,
  EMPTY_CONFIG,
  filterFilesByConfig,
  findConfigFile,
  findWorkspaceOverride,
  isClaimable,
  isIgnoredDependency,
  loadConfig,
  type UnusedConfig,
  validateConfig,
  warnOnEmptyConfigMatches,
} from "./config.js";

// ---------------------------------------------------------------------------
// Filesystem-backed: discovery + loading
// ---------------------------------------------------------------------------

const tmpDirs: string[] = [];
async function makeTmpDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "unused-config-test-"));
  tmpDirs.push(dir);
  return dir;
}
afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe("findConfigFile", () => {
  it("returns null when no config file exists (the zero-config path)", async () => {
    const root = await makeTmpDir();
    expect(await findConfigFile(root)).toBeNull();
  });

  it("finds unused.config.jsonc at the root", async () => {
    const root = await makeTmpDir();
    await writeFile(join(root, "unused.config.jsonc"), "{}");
    expect(await findConfigFile(root)).toBe(join(root, "unused.config.jsonc"));
  });

  it("finds unused.config.json when .jsonc is absent", async () => {
    const root = await makeTmpDir();
    await writeFile(join(root, "unused.config.json"), "{}");
    expect(await findConfigFile(root)).toBe(join(root, "unused.config.json"));
  });

  it("prefers .jsonc over .json when both exist", async () => {
    const root = await makeTmpDir();
    await writeFile(join(root, "unused.config.jsonc"), "{}");
    await writeFile(join(root, "unused.config.json"), "{}");
    expect(await findConfigFile(root)).toBe(join(root, "unused.config.jsonc"));
  });

  it("--config resolves against the root and wins over auto-discovery", async () => {
    const root = await makeTmpDir();
    await writeFile(join(root, "unused.config.jsonc"), "{}");
    await writeFile(join(root, "custom.jsonc"), "{}");
    expect(await findConfigFile(root, "custom.jsonc")).toBe(join(root, "custom.jsonc"));
  });

  it("a missing --config target is a ConfigError, never a silent fall-through", async () => {
    const root = await makeTmpDir();
    await expect(findConfigFile(root, "does-not-exist.jsonc")).rejects.toThrow(ConfigError);
  });
});

describe("loadConfig", () => {
  it("returns EMPTY_CONFIG when no config file is present", async () => {
    const root = await makeTmpDir();
    expect(await loadConfig(root)).toEqual(EMPTY_CONFIG);
  });

  it("parses a JSONC file with comments and trailing commas", async () => {
    const root = await makeTmpDir();
    await writeFile(
      join(root, "unused.config.jsonc"),
      '{\n  // a comment\n  "entry": ["src/extra.ts"],\n}\n',
    );
    const config = await loadConfig(root);
    expect(config.entry).toEqual(["src/extra.ts"]);
  });

  it("parses a strict .json file", async () => {
    const root = await makeTmpDir();
    await writeFile(join(root, "unused.config.json"), '{ "ignore": ["dist/**"] }');
    const config = await loadConfig(root);
    expect(config.ignore).toEqual(["dist/**"]);
  });

  it("malformed JSON is a ConfigError naming the fix", async () => {
    const root = await makeTmpDir();
    await writeFile(join(root, "unused.config.jsonc"), '{ "entry": [oops] }');
    await expect(loadConfig(root)).rejects.toThrow(ConfigError);
    await expect(loadConfig(root)).rejects.toThrow(/not valid JSON/);
  });

  it("an invalid field is a ConfigError naming the field and the fix", async () => {
    const root = await makeTmpDir();
    await writeFile(join(root, "unused.config.jsonc"), '{ "typo_field": [] }');
    await expect(loadConfig(root)).rejects.toThrow(/typo_field/);
  });
});

// ---------------------------------------------------------------------------
// validateConfig — the schema mirror
// ---------------------------------------------------------------------------

describe("validateConfig", () => {
  it("accepts the PRD §6 worked example verbatim", () => {
    const config = validateConfig(
      {
        entry: ["src/index.ts", "src/pages/**/*.tsx"],
        project: ["src/**/*.{ts,tsx}"],
        ignore: ["**/*.generated.ts", "src/legacy/**"],
        ignoreDependencies: ["@types/node"],
        workspaces: { "packages/api": { entry: ["src/server.ts"] } },
        gate: { threshold: "medium" },
      },
      "unused.config.jsonc",
    );
    expect(config.entry).toEqual(["src/index.ts", "src/pages/**/*.tsx"]);
    expect(config.project).toEqual(["src/**/*.{ts,tsx}"]);
    expect(config.ignore).toEqual(["**/*.generated.ts", "src/legacy/**"]);
    expect(config.ignoreDependencies).toEqual(["@types/node"]);
    expect(config.workspaces).toEqual({
      "packages/api": { entry: ["src/server.ts"], project: [], ignore: [] },
    });
    expect(config.gate).toEqual({ threshold: "medium" });
    expect(config.presets).toBeUndefined();
  });

  it("accepts an empty object (every field optional)", () => {
    expect(validateConfig({}, "c.jsonc")).toEqual(EMPTY_CONFIG);
  });

  it("rejects a non-object root", () => {
    expect(() => validateConfig([], "c.jsonc")).toThrow(/must be a JSON object/);
    expect(() => validateConfig("nope", "c.jsonc")).toThrow(/must be a JSON object/);
    expect(() => validateConfig(null, "c.jsonc")).toThrow(/must be a JSON object/);
  });

  it("rejects an unknown top-level field, naming it", () => {
    expect(() => validateConfig({ bogus: 1 }, "c.jsonc")).toThrow(/"bogus"/);
  });

  it("rejects entry that is not an array", () => {
    expect(() => validateConfig({ entry: "src/index.ts" }, "c.jsonc")).toThrow(
      /"entry".*must be an array/,
    );
  });

  it("rejects an entry array element that is not a non-empty string", () => {
    expect(() => validateConfig({ entry: [""] }, "c.jsonc")).toThrow(/entry\[0\]/);
    expect(() => validateConfig({ entry: [42] }, "c.jsonc")).toThrow(/entry\[0\]/);
  });

  it("rejects workspaces that is not an object", () => {
    expect(() => validateConfig({ workspaces: [] }, "c.jsonc")).toThrow(/"workspaces"/);
  });

  it("rejects an unknown workspace-override field", () => {
    expect(() =>
      validateConfig({ workspaces: { "packages/api": { bogus: [] } } }, "c.jsonc"),
    ).toThrow(/workspaces\.packages\/api\.bogus/);
  });

  it("rejects a malformed workspace-override entry array", () => {
    expect(() =>
      validateConfig({ workspaces: { "packages/api": { entry: "not-an-array" } } }, "c.jsonc"),
    ).toThrow(/workspaces\.packages\/api\.entry/);
  });

  it("rejects gate that is not an object", () => {
    expect(() => validateConfig({ gate: "high" }, "c.jsonc")).toThrow(/"gate"/);
  });

  it("rejects an invalid gate.threshold value", () => {
    expect(() => validateConfig({ gate: { threshold: "critical" } }, "c.jsonc")).toThrow(
      /gate\.threshold/,
    );
  });

  it("rejects an unknown gate field", () => {
    expect(() => validateConfig({ gate: { threshold: "high", extra: 1 } }, "c.jsonc")).toThrow(
      /gate\.extra/,
    );
  });

  it("rejects presets that is not an array", () => {
    expect(() => validateConfig({ presets: "vite" }, "c.jsonc")).toThrow(/"presets"/);
  });

  it("rejects an unrecognised preset name", () => {
    expect(() => validateConfig({ presets: ["webpack"] }, "c.jsonc")).toThrow(/presets\[0\]/);
  });

  it("accepts an empty presets array (an explicit force-off)", () => {
    expect(validateConfig({ presets: [] }, "c.jsonc").presets).toEqual([]);
  });

  it("accepts forced presets", () => {
    expect(validateConfig({ presets: ["vite", "next"] }, "c.jsonc").presets).toEqual([
      "vite",
      "next",
    ]);
  });
});

// ---------------------------------------------------------------------------
// findWorkspaceOverride
// ---------------------------------------------------------------------------

describe("findWorkspaceOverride", () => {
  const config: UnusedConfig = {
    ...EMPTY_CONFIG,
    workspaces: {
      "packages/api": { entry: ["src/server.ts"], project: [], ignore: [] },
      "@scope/lib": { entry: [], project: [], ignore: ["**/*.gen.ts"] },
    },
  };

  it("matches by root-relative directory", () => {
    expect(
      findWorkspaceOverride(config, { rootRelDir: "packages/api", name: "api" })?.entry,
    ).toEqual(["src/server.ts"]);
  });

  it("matches by package name when the directory key doesn't match", () => {
    expect(
      findWorkspaceOverride(config, { rootRelDir: "packages/lib", name: "@scope/lib" })?.ignore,
    ).toEqual(["**/*.gen.ts"]);
  });

  it("returns undefined when neither matches", () => {
    expect(
      findWorkspaceOverride(config, { rootRelDir: "packages/other", name: "other" }),
    ).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// filterFilesByConfig
// ---------------------------------------------------------------------------

describe("filterFilesByConfig", () => {
  const files = [
    "src/index.ts",
    "src/orphan.ts",
    "src/generated/skip.ts",
    "scripts/outside.ts",
    "packages/api/src/index.ts",
    "packages/api/src/gen/skip.ts",
  ];
  const units = [
    { rootRelDir: "", name: "root" },
    { rootRelDir: "packages/api", name: "@x/api" },
  ];

  it("is a no-op against EMPTY_CONFIG (T4.3 no-config regression contract)", () => {
    expect(filterFilesByConfig(files, EMPTY_CONFIG, units)).toEqual(files);
  });

  it("drops files matched by a root-level ignore glob", () => {
    const config: UnusedConfig = { ...EMPTY_CONFIG, ignore: ["src/generated/**"] };
    expect(filterFilesByConfig(files, config, units)).not.toContain("src/generated/skip.ts");
  });

  it("applies a workspace override's ignore only within that unit", () => {
    const config: UnusedConfig = {
      ...EMPTY_CONFIG,
      workspaces: { "packages/api": { entry: [], project: [], ignore: ["src/gen/**"] } },
    };
    const result = filterFilesByConfig(files, config, units);
    expect(result).not.toContain("packages/api/src/gen/skip.ts");
    // A same-shaped path outside the overridden unit is unaffected.
    expect(result).toContain("src/generated/skip.ts");
  });

  it("does NOT drop files outside a `project` glob (reviewer fix: project is claimability, not discovery)", () => {
    // Before the fix this behaved like a second `ignore` and silently
    // dropped out-of-project files from the graph entirely — which broke
    // import edges FROM those files (see the `isClaimable` describe block
    // below and config-integration.test.ts's "project-narrowing" fixture
    // for the end-to-end false-positive this caused).
    const config: UnusedConfig = { ...EMPTY_CONFIG, project: ["src/**/*.ts"] };
    const result = filterFilesByConfig(files, config, units);
    expect(result).toEqual(files);
  });

  it("does NOT drop files outside a workspace override's `project` glob either", () => {
    const config: UnusedConfig = {
      ...EMPTY_CONFIG,
      workspaces: { "packages/api": { entry: [], project: ["src/index.ts"], ignore: [] } },
    };
    const result = filterFilesByConfig(files, config, units);
    expect(result).toEqual(files);
  });
});

// ---------------------------------------------------------------------------
// isClaimable (project narrowing — claimability, not discovery)
// ---------------------------------------------------------------------------

describe("isClaimable", () => {
  const units = [
    { rootRelDir: "", name: "root" },
    { rootRelDir: "packages/api", name: "@x/api" },
  ];

  it("is always claimable against EMPTY_CONFIG (T4.3 no-config regression contract)", () => {
    expect(isClaimable("scripts/outside.ts", EMPTY_CONFIG, units)).toBe(true);
  });

  it("a root-level project glob narrows claimability, root-relative", () => {
    const config: UnusedConfig = { ...EMPTY_CONFIG, project: ["src/**/*.ts"] };
    expect(isClaimable("src/index.ts", config, units)).toBe(true);
    expect(isClaimable("scripts/outside.ts", config, units)).toBe(false);
    // A workspace member's own files are owned by a different unit and are
    // unaffected by the root project glob matched against root-relative
    // paths — packages/api/src/index.ts does not match "src/**/*.ts".
    expect(isClaimable("packages/api/src/index.ts", config, units)).toBe(false);
  });

  it("a workspace override's project (package-relative) narrows claimability only within that unit", () => {
    const config: UnusedConfig = {
      ...EMPTY_CONFIG,
      workspaces: { "packages/api": { entry: [], project: ["src/index.ts"], ignore: [] } },
    };
    expect(isClaimable("packages/api/src/index.ts", config, units)).toBe(true);
    expect(isClaimable("packages/api/src/gen/skip.ts", config, units)).toBe(false);
    // Root-owned files are unaffected by a workspace-scoped project glob.
    expect(isClaimable("src/orphan.ts", config, units)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// collectConfigEntrypoints
// ---------------------------------------------------------------------------

describe("collectConfigEntrypoints", () => {
  const analyzedFiles = ["src/index.ts", "src/extra.ts", "packages/api/src/server.ts"];
  const units = [
    { rootRelDir: "", name: "root" },
    { rootRelDir: "packages/api", name: "@x/api" },
  ];

  it("is a no-op against EMPTY_CONFIG", () => {
    expect(collectConfigEntrypoints(analyzedFiles, EMPTY_CONFIG, units)).toEqual([]);
  });

  it("seeds a root-level entry glob match, root-relative", () => {
    const config: UnusedConfig = { ...EMPTY_CONFIG, entry: ["src/extra.ts"] };
    expect(collectConfigEntrypoints(analyzedFiles, config, units)).toEqual([
      { file: "src/extra.ts", reason: "config:entry" },
    ]);
  });

  it("seeds a workspace-override entry glob, matched package-relative but reported root-relative", () => {
    const config: UnusedConfig = {
      ...EMPTY_CONFIG,
      workspaces: { "packages/api": { entry: ["src/server.ts"], project: [], ignore: [] } },
    };
    expect(collectConfigEntrypoints(analyzedFiles, config, units)).toEqual([
      { file: "packages/api/src/server.ts", reason: "config:workspaces.packages/api.entry" },
    ]);
  });

  it("never seeds a file that isn't in the already-filtered analyzed set (ignore wins over entry)", () => {
    // src/legacy.ts is not part of `analyzedFiles` at all (as if `ignore` had
    // already dropped it) — an entry glob matching it must not resurrect it.
    const config: UnusedConfig = { ...EMPTY_CONFIG, entry: ["src/legacy.ts"] };
    expect(collectConfigEntrypoints(analyzedFiles, config, units)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// isIgnoredDependency
// ---------------------------------------------------------------------------

describe("isIgnoredDependency", () => {
  it("is false against EMPTY_CONFIG", () => {
    expect(isIgnoredDependency("left-pad", EMPTY_CONFIG)).toBe(false);
  });

  it("matches an exact name", () => {
    const config: UnusedConfig = { ...EMPTY_CONFIG, ignoreDependencies: ["@types/node"] };
    expect(isIgnoredDependency("@types/node", config)).toBe(true);
    expect(isIgnoredDependency("@types/react", config)).toBe(false);
  });

  it("matches a wildcard pattern", () => {
    const config: UnusedConfig = { ...EMPTY_CONFIG, ignoreDependencies: ["@internal/*"] };
    expect(isIgnoredDependency("@internal/tooling", config)).toBe(true);
    expect(isIgnoredDependency("@external/tooling", config)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// warnOnEmptyConfigMatches (reviewer-adopted optional: typo self-detection)
// ---------------------------------------------------------------------------

describe("warnOnEmptyConfigMatches", () => {
  const discovered = ["src/index.ts", "src/orphan.ts", "packages/api/src/index.ts"];
  const scoped = discovered; // no `ignore` in play for most of these cases
  const units = [
    { rootRelDir: "", name: "root" },
    { rootRelDir: "packages/api", name: "@x/api" },
  ];

  function spyWarn() {
    return vi.spyOn(console, "warn").mockImplementation(() => {});
  }

  it("is silent against EMPTY_CONFIG", () => {
    const warn = spyWarn();
    warnOnEmptyConfigMatches(EMPTY_CONFIG, discovered, scoped, units);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("is silent when every pattern matches something", () => {
    const warn = spyWarn();
    const config: UnusedConfig = {
      ...EMPTY_CONFIG,
      entry: ["src/index.ts"],
      ignore: ["src/orphan.ts"],
    };
    warnOnEmptyConfigMatches(config, discovered, scoped, units);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("warns on a root-level entry glob that matches nothing", () => {
    const warn = spyWarn();
    const config: UnusedConfig = { ...EMPTY_CONFIG, entry: ["src/does-not-exist.ts"] };
    warnOnEmptyConfigMatches(config, discovered, scoped, units);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toMatch(
      /"entry".*"src\/does-not-exist\.ts".*matched no files/,
    );
    warn.mockRestore();
  });

  it("warns on a root-level project glob that matches nothing", () => {
    const warn = spyWarn();
    const config: UnusedConfig = { ...EMPTY_CONFIG, project: ["nowhere/**"] };
    warnOnEmptyConfigMatches(config, discovered, scoped, units);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toMatch(/"project"/);
    warn.mockRestore();
  });

  it("warns on a root-level ignore glob that matches nothing (checked against the PRE-ignore set)", () => {
    const warn = spyWarn();
    const config: UnusedConfig = { ...EMPTY_CONFIG, ignore: ["nowhere/**"] };
    warnOnEmptyConfigMatches(config, discovered, scoped, units);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toMatch(/"ignore"/);
    warn.mockRestore();
  });

  it("warns on a workspaces key that matches no unit by directory or name", () => {
    const warn = spyWarn();
    const config: UnusedConfig = {
      ...EMPTY_CONFIG,
      workspaces: { "packages/typo": { entry: [], project: [], ignore: [] } },
    };
    warnOnEmptyConfigMatches(config, discovered, scoped, units);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toMatch(
      /"workspaces".*"packages\/typo".*matched no workspace package/,
    );
    warn.mockRestore();
  });

  it("warns on a workspace override's entry glob that matches nothing within that unit", () => {
    const warn = spyWarn();
    const config: UnusedConfig = {
      ...EMPTY_CONFIG,
      workspaces: { "packages/api": { entry: ["src/does-not-exist.ts"], project: [], ignore: [] } },
    };
    warnOnEmptyConfigMatches(config, discovered, scoped, units);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toMatch(/"workspaces\.packages\/api\.entry"/);
    warn.mockRestore();
  });

  it("does not warn when a workspace override's glob DOES match within its own unit", () => {
    const warn = spyWarn();
    const config: UnusedConfig = {
      ...EMPTY_CONFIG,
      workspaces: { "packages/api": { entry: ["src/index.ts"], project: [], ignore: [] } },
    };
    warnOnEmptyConfigMatches(config, discovered, scoped, units);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});
