import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Claim, SubjectKind } from "../../core/claims/index.js";
import {
  applyConfigSuppressions,
  assertUnambiguousWorkspaceKeys,
  ConfigError,
  collectConfigEntrypoints,
  computeAggregateConfigHash,
  computeBoundaryAnalysisFingerprint,
  computeConfigHash,
  EMPTY_CONFIG,
  filterFilesByConfig,
  findConfigFile,
  findWorkspaceOverrides,
  isClaimable,
  isIgnoredDependency,
  loadConfig,
  projectConfigMatchInventory,
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
    await writeFile(
      join(root, "unused.config.json"),
      '{ "suppressions": [{ "files": ["dist/**"], "kinds": ["file"], "reason": "generated" }] }',
    );
    const config = await loadConfig(root);
    expect(config.suppressions).toEqual([
      { files: ["dist/**"], kinds: ["file"], reason: "generated" },
    ]);
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
        suppressions: [{ files: ["**/*.generated.ts"], kinds: ["file"], reason: "generated" }],
        ignoreDependencies: ["@types/node"],
        workspaces: { "packages/api": { entry: ["src/server.ts"] } },
        gate: { threshold: "medium" },
      },
      "unused.config.jsonc",
    );
    expect(config.entry).toEqual(["src/index.ts", "src/pages/**/*.tsx"]);
    expect(config.project).toEqual(["src/**/*.{ts,tsx}"]);
    expect(config.suppressions).toEqual([
      { files: ["**/*.generated.ts"], kinds: ["file"], reason: "generated" },
    ]);
    expect(config.ignoreDependencies).toEqual(["@types/node"]);
    expect(config.workspaces).toEqual({
      "packages/api": {
        entry: ["src/server.ts"],
        entrySymbols: [],
        project: [],
        suppressions: [],
      },
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

  it("accepts strict exact symbol roots at repository and workspace scope", () => {
    const config = validateConfig(
      {
        entrySymbols: [
          { language: "ts", file: "src/api.ts", name: "run", reason: "public operation" },
        ],
        workspaces: {
          "services/backend": {
            entrySymbols: [
              {
                language: "ex",
                file: "lib/worker.ex",
                name: "Neutral.Worker.perform/1",
                reason: "runtime callback",
              },
            ],
          },
        },
      },
      "c.jsonc",
    );
    expect(config.entrySymbols).toEqual([
      { language: "ts", file: "src/api.ts", name: "run", reason: "public operation" },
    ]);
    expect(config.workspaces["services/backend"]?.entrySymbols).toEqual([
      {
        language: "ex",
        file: "lib/worker.ex",
        name: "Neutral.Worker.perform/1",
        reason: "runtime callback",
      },
    ]);
  });

  it.each([
    [{ entrySymbols: {} }, /entrySymbols.*must be an array/],
    [{ entrySymbols: ["src/api.ts"] }, /entrySymbols\[0\].*must be an object/],
    [
      { entrySymbols: [{ language: "ts", file: "src/api.ts", name: "run" }] },
      /entrySymbols\[0\]\.reason.*required/,
    ],
    [
      {
        entrySymbols: [{ language: "go", file: "src/api.ts", name: "run", reason: "public" }],
      },
      /entrySymbols\[0\]\.language/,
    ],
    [
      {
        entrySymbols: [{ language: "ts", file: "src/*.ts", name: "run", reason: "public" }],
      },
      /entrySymbols\[0\]\.file/,
    ],
    [
      {
        entrySymbols: [{ language: "ts", file: "../src/api.ts", name: "run", reason: "public" }],
      },
      /entrySymbols\[0\]\.file/,
    ],
    [
      {
        entrySymbols: [{ language: "ts", file: "src\\api.ts", name: "run", reason: "public" }],
      },
      /entrySymbols\[0\]\.file/,
    ],
    [
      {
        entrySymbols: [{ language: "ts", file: "   ", name: "run", reason: "public" }],
      },
      /entrySymbols\[0\]\.file/,
    ],
    [
      {
        entrySymbols: [{ language: "ts", file: "src/\0api.ts", name: "run", reason: "public" }],
      },
      /entrySymbols\[0\]\.file/,
    ],
    [
      {
        entrySymbols: [{ language: "ts", file: "src/api.ts", name: " ", reason: "public" }],
      },
      /entrySymbols\[0\]\.name/,
    ],
    [
      {
        entrySymbols: [{ language: "ts", file: "src/api.ts", name: "run", reason: " " }],
      },
      /entrySymbols\[0\]\.reason/,
    ],
    [
      {
        entrySymbols: [
          { language: "ts", file: "src/api.ts", name: "run", reason: "public", extra: true },
        ],
      },
      /entrySymbols\[0\]\.extra/,
    ],
  ])("rejects malformed exact symbol roots", (input, pattern) => {
    expect(() => validateConfig(input, "c.jsonc")).toThrow(pattern);
  });

  it("rejects duplicate exact selectors even when their reasons differ", () => {
    expect(() =>
      validateConfig(
        {
          entrySymbols: [
            { language: "ts", file: "src/api.ts", name: "run", reason: "one" },
            { language: "ts", file: "src/api.ts", name: "run", reason: "two" },
          ],
        },
        "c.jsonc",
      ),
    ).toThrow(/duplicates an earlier entrySymbols selector/);
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

  it("requires structured suppression fields, explicit claim kinds, and a reason", () => {
    expect(() => validateConfig({ suppressions: [{ files: ["src/**"] }] }, "c.jsonc")).toThrow(
      /suppressions\[0\]\.kinds/,
    );
    expect(() =>
      validateConfig(
        { suppressions: [{ files: ["src/**"], kinds: ["file"], reason: " " }] },
        "c.jsonc",
      ),
    ).toThrow(/suppressions\[0\]\.reason/);
    expect(() =>
      validateConfig(
        { suppressions: [{ files: ["src/**"], kinds: ["unknown"], reason: "legacy" }] },
        "c.jsonc",
      ),
    ).toThrow(/suppressions\[0\]\.kinds\[0\]/);
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

  // -------------------------------------------------------------------------
  // ciSecondsPerTestFile (T5.3, docs/design/report-and-badge.md §3)
  // -------------------------------------------------------------------------

  it("ciSecondsPerTestFile is undefined by default", () => {
    expect(validateConfig({}, "c.jsonc").ciSecondsPerTestFile).toBeUndefined();
  });

  it("accepts a positive ciSecondsPerTestFile override", () => {
    expect(validateConfig({ ciSecondsPerTestFile: 12 }, "c.jsonc").ciSecondsPerTestFile).toBe(12);
  });

  it("accepts a fractional ciSecondsPerTestFile override", () => {
    expect(validateConfig({ ciSecondsPerTestFile: 2.5 }, "c.jsonc").ciSecondsPerTestFile).toBe(2.5);
  });

  it("rejects a non-number ciSecondsPerTestFile, naming the field and the fix", () => {
    expect(() => validateConfig({ ciSecondsPerTestFile: "5" }, "c.jsonc")).toThrow(
      /ciSecondsPerTestFile.*must be a positive number/,
    );
  });

  it("rejects a zero ciSecondsPerTestFile", () => {
    expect(() => validateConfig({ ciSecondsPerTestFile: 0 }, "c.jsonc")).toThrow(
      /ciSecondsPerTestFile/,
    );
  });

  it("rejects a negative ciSecondsPerTestFile", () => {
    expect(() => validateConfig({ ciSecondsPerTestFile: -1 }, "c.jsonc")).toThrow(
      /ciSecondsPerTestFile/,
    );
  });

  it("rejects a non-finite ciSecondsPerTestFile", () => {
    expect(() =>
      validateConfig({ ciSecondsPerTestFile: Number.POSITIVE_INFINITY }, "c.jsonc"),
    ).toThrow(/ciSecondsPerTestFile/);
  });
});

describe("computeConfigHash", () => {
  it("preserves the historical empty-config hash when entrySymbols is empty", () => {
    expect(computeConfigHash(EMPTY_CONFIG)).toBe("291ed68f9f14");
  });

  it("preserves a historical non-empty config hash when symbol-root arrays are empty", () => {
    const config = validateConfig(
      {
        entry: ["src/index.ts"],
        project: ["src/**"],
        ignoreDependencies: ["neutral-dep"],
        workspaces: { "packages/api": { entry: ["src/server.ts"] } },
        gate: { threshold: "high" },
        presets: ["vite"],
        ciSecondsPerTestFile: 3,
      },
      "c.jsonc",
    );
    expect(computeConfigHash(config)).toBe("32ef8211a886");
  });

  it("includes ordered full entrySymbols rules, including rationale", () => {
    const base = {
      ...EMPTY_CONFIG,
      entrySymbols: [{ language: "ts", file: "src/api.ts", name: "run", reason: "public API" }],
    } as const;
    expect(computeConfigHash(base)).not.toBe(computeConfigHash(EMPTY_CONFIG));
    expect(computeConfigHash(base)).not.toBe(
      computeConfigHash({
        ...base,
        entrySymbols: [{ ...base.entrySymbols[0], reason: "runtime hook" }],
      }),
    );
  });

  it("preserves root-only hashes and deterministically includes effective boundary policy", () => {
    const root = validateConfig({ gate: { threshold: "medium" } }, "root.jsonc");
    const local = validateConfig(
      {
        entrySymbols: [
          {
            language: "ts",
            file: "src/operation.ts",
            name: "selected",
            reason: "neutral runtime operation",
          },
        ],
      },
      "local.jsonc",
    );
    const fingerprint = computeBoundaryAnalysisFingerprint(local);
    expect(computeAggregateConfigHash(root, [])).toBe(computeConfigHash(root));
    const first = computeAggregateConfigHash(root, [
      { boundaryId: "ts:services/alpha", ...fingerprint },
      {
        boundaryId: "ts:services/empty",
        ...computeBoundaryAnalysisFingerprint(EMPTY_CONFIG),
      },
    ]);
    expect(first).not.toBe(computeConfigHash(root));
    expect(
      computeAggregateConfigHash(root, [
        {
          boundaryId: "ts:services/empty",
          ...computeBoundaryAnalysisFingerprint(EMPTY_CONFIG),
        },
        { boundaryId: "ts:services/alpha", ...fingerprint },
      ]),
    ).toBe(first);
    expect(
      computeAggregateConfigHash(root, [{ boundaryId: "ts:services/beta", ...fingerprint }]),
    ).not.toBe(first);
  });

  it("hashes exactly effective nested policy and excludes shadowed economics/presets", () => {
    const localA = validateConfig(
      { gate: { threshold: "low" }, ciSecondsPerTestFile: 99, presets: ["next"] },
      "a.jsonc",
    );
    const localB = validateConfig(
      { gate: { threshold: "high" }, ciSecondsPerTestFile: 2, presets: ["vite"] },
      "b.jsonc",
    );
    expect(computeBoundaryAnalysisFingerprint(localA).fingerprint).not.toBe(
      computeBoundaryAnalysisFingerprint(localB).fingerprint,
    );
    expect(computeBoundaryAnalysisFingerprint(localA, { presetsShadowed: true })).toEqual(
      computeBoundaryAnalysisFingerprint(localB, { presetsShadowed: true }),
    );
    expect(
      computeBoundaryAnalysisFingerprint(
        validateConfig({ project: ["lib/**"], gate: { threshold: "low" } }, "c.jsonc"),
        { presetsShadowed: true },
      ).hasEffectivePolicy,
    ).toBe(true);
  });

  it("rejects duplicate effective boundary contributions", () => {
    const fingerprint = computeBoundaryAnalysisFingerprint(
      validateConfig({ project: ["src/**"] }, "local.jsonc"),
    );
    expect(() =>
      computeAggregateConfigHash(EMPTY_CONFIG, [
        { boundaryId: "ts:services/web", ...fingerprint },
        { boundaryId: "ts:services/web", ...fingerprint },
      ]),
    ).toThrow(/duplicate configuration contribution/);
  });

  it("orders case and non-ASCII boundary ids by code unit, independent of input order", () => {
    const fingerprint = computeBoundaryAnalysisFingerprint(
      validateConfig({ project: ["src/**"] }, "local.jsonc"),
    );
    const nonAscii = { boundaryId: "ts:Ångstrom", ...fingerprint };
    const lowercase = { boundaryId: "ts:alpha", ...fingerprint };
    const uppercase = { boundaryId: "ts:Zeta", ...fingerprint };
    const boundaries = [nonAscii, lowercase, uppercase];
    expect(computeAggregateConfigHash(EMPTY_CONFIG, boundaries)).toBe(
      computeAggregateConfigHash(EMPTY_CONFIG, [lowercase, uppercase, nonAscii]),
    );
  });
});

// ---------------------------------------------------------------------------
// findWorkspaceOverrides
// ---------------------------------------------------------------------------

describe("findWorkspaceOverrides", () => {
  const config: UnusedConfig = {
    ...EMPTY_CONFIG,
    workspaces: {
      "packages/api": { entry: ["src/server.ts"], project: [], suppressions: [] },
      "@scope/lib": {
        entry: [],
        project: [],
        suppressions: [{ files: ["**/*.gen.ts"], kinds: ["file"], reason: "generated" }],
      },
    },
  };

  it("matches by root-relative directory", () => {
    expect(
      findWorkspaceOverrides(config, { rootRelDir: "packages/api", name: "api" })[0]?.override
        .entry,
    ).toEqual(["src/server.ts"]);
  });

  it("matches by package name when the directory key doesn't match", () => {
    expect(
      findWorkspaceOverrides(config, { rootRelDir: "packages/lib", name: "@scope/lib" })[0]
        ?.override.suppressions,
    ).toEqual([{ files: ["**/*.gen.ts"], kinds: ["file"], reason: "generated" }]);
  });

  it("returns an empty list when neither matches", () => {
    expect(findWorkspaceOverrides(config, { rootRelDir: "packages/other", name: "other" })).toEqual(
      [],
    );
  });

  it("returns physical and ecosystem scopes in increasing specificity", () => {
    const both: UnusedConfig = {
      ...EMPTY_CONFIG,
      workspaces: {
        "packages/api": { entry: ["src/path.ts"], project: [], suppressions: [] },
        api: { entry: ["src/name.ts"], project: [], suppressions: [] },
      },
    };
    expect(findWorkspaceOverrides(both, { rootRelDir: "packages/api", name: "api" })).toEqual([
      expect.objectContaining({ key: "packages/api", specificity: 1 }),
      expect.objectContaining({ key: "api", specificity: 2 }),
    ]);
    expect(
      collectConfigEntrypoints(["packages/api/src/path.ts", "packages/api/src/name.ts"], both, [
        { rootRelDir: "packages/api", name: "api" },
      ]).map((hit) => hit.file),
    ).toEqual(["packages/api/src/path.ts", "packages/api/src/name.ts"]);
  });

  it("fails when one key is a directory and a different workspace's ecosystem name", () => {
    const collision = {
      ...EMPTY_CONFIG,
      workspaces: {
        alpha: { entry: [], project: [], suppressions: [] },
      },
    };
    expect(() =>
      assertUnambiguousWorkspaceKeys(collision, [
        { rootRelDir: "alpha", name: "physical" },
        { rootRelDir: "beta", name: "alpha" },
      ]),
    ).toThrow(/identifies a physical directory and an ecosystem name/);
  });

  it("keeps projected warning inventory size independent of file count and ids collision-proof", () => {
    const projected = projectConfigMatchInventory(
      {
        ...EMPTY_CONFIG,
        workspaces: {
          a: { entry: ["src/**"], project: [], suppressions: [] },
          "a.entry[0]": { entry: [], project: [], suppressions: [] },
        },
      },
      Array.from({ length: 2_000 }, (_, index) => `a/src/file-${index}.ts`),
      [
        { rootRelDir: "a", name: "first" },
        { rootRelDir: "other", name: "a.entry[0]" },
      ],
    );
    expect(projected).toHaveLength(3);
    expect(new Set(projected.map((item) => item.id)).size).toBe(projected.length);
    expect(JSON.stringify(projected)).not.toContain("file-1999.ts");
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

  it("never erases files from the graph for policy suppression", () => {
    const config: UnusedConfig = {
      ...EMPTY_CONFIG,
      suppressions: [
        {
          files: ["missing/**", "src/generated/**"],
          kinds: ["file"],
          reason: "generated",
        },
      ],
    };
    expect(filterFilesByConfig(files, config, units)).toEqual(files);
  });

  it("does NOT drop files outside a `project` glob (reviewer fix: project is claimability, not discovery)", () => {
    // Before the fix this silently dropped out-of-project files from the graph
    // entirely — which broke
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
      workspaces: { "packages/api": { entry: [], project: ["src/index.ts"], suppressions: [] } },
    };
    const result = filterFilesByConfig(files, config, units);
    expect(result).toEqual(files);
  });
});

describe("applyConfigSuppressions", () => {
  const units = [
    { rootRelDir: "", name: "root" },
    { rootRelDir: "packages/api", name: "@x/api" },
  ];

  function makeClaim(file: string, kind: SubjectKind = "file", reason?: string): Claim {
    return {
      id: `${kind}:${file}`,
      language: "ts",
      subject: { kind, name: file, loc: { file, span: [1, 1] } },
      verdict: kind === "test" ? "test-only" : "unused",
      confidence: "high",
      evidence: [{ type: "static-reachability", detail: "unreachable", source: "test" }],
      provenance: { analyzer: "test", version: "0", generatedAt: "2026-01-01T00:00:00Z" },
      ...(reason === undefined ? {} : { suppression: { reason } }),
    } as Claim;
  }

  it("marks matching claims without removing other claims or graph-visible files", () => {
    const claims = [
      makeClaim("src/generated/dead.ts"),
      makeClaim("src/generated/dead.ts", "export"),
    ];
    const config: UnusedConfig = {
      ...EMPTY_CONFIG,
      suppressions: [
        {
          files: ["missing/**", "src/generated/**"],
          kinds: ["file"],
          reason: "generated",
        },
      ],
    };
    const result = applyConfigSuppressions(claims, config, units, ["src/generated/dead.ts"]);
    expect(result).toHaveLength(2);
    expect(result[0]?.suppression).toEqual({
      reason: "generated",
      source: "config",
      pattern: "src/generated/**",
    });
    expect(result[1]?.suppression).toBeUndefined();
  });

  it("scopes workspace rules package-relative and preserves inline declaration reasons", () => {
    const claims = [
      makeClaim("packages/api/src/dead.ts"),
      makeClaim("packages/api/src/inline.ts", "file", "inline reason"),
      makeClaim("src/dead.ts"),
    ];
    const config: UnusedConfig = {
      ...EMPTY_CONFIG,
      workspaces: {
        "packages/api": {
          entry: [],
          project: [],
          suppressions: [{ files: ["src/**"], kinds: ["file"], reason: "workspace policy" }],
        },
      },
    };
    const result = applyConfigSuppressions(
      claims,
      config,
      units,
      claims.map((claim) => claim.subject.loc.file),
    );
    expect(result[0]?.suppression?.reason).toBe("workspace policy");
    expect(result[1]?.suppression?.reason).toBe("inline reason");
    expect(result[2]?.suppression).toBeUndefined();
  });

  it("warns for unmatched and stale suppression policies", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    applyConfigSuppressions(
      [],
      {
        ...EMPTY_CONFIG,
        suppressions: [
          { files: ["missing/**"], kinds: ["file"], reason: "unmatched" },
          { files: ["src/live.ts"], kinds: ["file"], reason: "stale" },
        ],
      },
      units,
      ["src/live.ts"],
    );
    expect(warn.mock.calls.map((call) => String(call[0])).join("\n")).toMatch(/matched no files/);
    expect(warn.mock.calls.map((call) => String(call[0])).join("\n")).toMatch(/may be stale/);
    warn.mockRestore();
  });

  it("prefers name suppression over directory policy while retaining directory fallback", () => {
    const claims = [makeClaim("packages/api/src/dead.ts"), makeClaim("packages/api/src/path.ts")];
    const config: UnusedConfig = {
      ...EMPTY_CONFIG,
      workspaces: {
        "packages/api": {
          entry: [],
          project: [],
          suppressions: [{ files: ["src/**"], kinds: ["file"], reason: "physical" }],
        },
        "@x/api": {
          entry: [],
          project: [],
          suppressions: [{ files: ["src/dead.ts"], kinds: ["file"], reason: "named" }],
        },
      },
    };
    const result = applyConfigSuppressions(
      claims,
      config,
      units,
      claims.map((claim) => claim.subject.loc.file),
    );
    expect(result.map((claim) => claim.suppression?.reason)).toEqual(["named", "physical"]);
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

  it("evaluates root project inclusions and negations in order", () => {
    const config: UnusedConfig = {
      ...EMPTY_CONFIG,
      project: ["src/**/*.ts", "!src/legacy/**", "src/legacy/keep.ts"],
    };
    expect(isClaimable("src/current.ts", config, units)).toBe(true);
    expect(isClaimable("src/legacy/dead.ts", config, units)).toBe(false);
    expect(isClaimable("src/legacy/keep.ts", config, units)).toBe(true);
    expect(isClaimable("scripts/build.ts", config, units)).toBe(false);
  });

  it("treats a project list containing only negations as include-by-default", () => {
    const config: UnusedConfig = { ...EMPTY_CONFIG, project: ["!src/legacy/**"] };
    expect(isClaimable("src/current.ts", config, units)).toBe(true);
    expect(isClaimable("src/legacy/dead.ts", config, units)).toBe(false);
  });

  it("a workspace override's project (package-relative) narrows claimability only within that unit", () => {
    const config: UnusedConfig = {
      ...EMPTY_CONFIG,
      workspaces: { "packages/api": { entry: [], project: ["src/index.ts"], suppressions: [] } },
    };
    expect(isClaimable("packages/api/src/index.ts", config, units)).toBe(true);
    expect(isClaimable("packages/api/src/gen/skip.ts", config, units)).toBe(false);
    // Root-owned files are unaffected by a workspace-scoped project glob.
    expect(isClaimable("src/orphan.ts", config, units)).toBe(true);
  });

  it("evaluates workspace project negations package-relative and in order", () => {
    const config: UnusedConfig = {
      ...EMPTY_CONFIG,
      workspaces: {
        "packages/api": {
          entry: [],
          project: ["src/**", "!src/generated/**", "src/generated/keep.ts"],
          suppressions: [],
        },
      },
    };
    expect(isClaimable("packages/api/src/current.ts", config, units)).toBe(true);
    expect(isClaimable("packages/api/src/generated/dead.ts", config, units)).toBe(false);
    expect(isClaimable("packages/api/src/generated/keep.ts", config, units)).toBe(true);
  });

  it("intersects simultaneous directory and ecosystem-name project scopes", () => {
    const config: UnusedConfig = {
      ...EMPTY_CONFIG,
      workspaces: {
        "packages/api": { entry: [], project: ["src/**"], suppressions: [] },
        "@x/api": { entry: [], project: ["src/allowed.ts"], suppressions: [] },
      },
    };
    expect(isClaimable("packages/api/src/allowed.ts", config, units)).toBe(true);
    expect(isClaimable("packages/api/src/denied.ts", config, units)).toBe(false);
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
      workspaces: { "packages/api": { entry: ["src/server.ts"], project: [], suppressions: [] } },
    };
    expect(collectConfigEntrypoints(analyzedFiles, config, units)).toEqual([
      { file: "packages/api/src/server.ts", reason: "config:workspaces.packages/api.entry" },
    ]);
  });

  it("never seeds a file that isn't in the graph-visible analyzed set", () => {
    // src/legacy.ts is not part of `analyzedFiles`; an entry glob matching it
    // cannot invent a source file that discovery never found.
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
  const scoped = discovered;
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

  it("checks a negated project pattern against its pattern body", () => {
    const warn = spyWarn();
    const config: UnusedConfig = { ...EMPTY_CONFIG, project: ["src/**", "!src/orphan.ts"] };
    warnOnEmptyConfigMatches(config, discovered, scoped, units);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("warns on a workspaces key that matches no unit by directory or name", () => {
    const warn = spyWarn();
    const config: UnusedConfig = {
      ...EMPTY_CONFIG,
      workspaces: { "packages/typo": { entry: [], project: [], suppressions: [] } },
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
      workspaces: {
        "packages/api": { entry: ["src/does-not-exist.ts"], project: [], suppressions: [] },
      },
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
      workspaces: { "packages/api": { entry: ["src/index.ts"], project: [], suppressions: [] } },
    };
    warnOnEmptyConfigMatches(config, discovered, scoped, units);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});
