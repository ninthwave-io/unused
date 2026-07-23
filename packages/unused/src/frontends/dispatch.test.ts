import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  computeDeletionPlan,
  type PerformancePhaseEvent,
  PerformanceTracker,
  whyAlive,
} from "../core/analysis/index.js";
import { fileId } from "../core/ir/index.js";
import { isMixAvailable } from "../testing/corpus/elixir-corpus.js";
import {
  analyzeProjectAuto,
  analyzeProjectAutoWithGraph,
  assertCompleteLocalConfigContributions,
  assertConsistentApplicableSuppressionScopes,
  assertConsistentFrontendConfigContributions,
  assertUnambiguousProjectedWorkspaceMatches,
  deriveDirectBoundaryMetadata,
} from "./dispatch.js";

const elixirFixture = fileURLToPath(
  new URL("../../../../fixtures/elixir/test-only-zombie", import.meta.url),
);
const elixirDeadFunctionFixture = fileURLToPath(
  new URL("../../../../fixtures/elixir/basic-dead-function", import.meta.url),
);
const temporaryProjects: string[] = [];
const MIX_AVAILABLE = isMixAvailable();

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    temporaryProjects.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe.skipIf(!MIX_AVAILABLE)("mixed-language dispatch policy", () => {
  it("uses union config diagnostics and preserves configured zombie-test cost", async () => {
    const root = await mkdtemp(join(tmpdir(), "unused-mixed-policy-"));
    temporaryProjects.push(root);
    await cp(elixirFixture, root, { recursive: true });
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ name: "mixed-policy", type: "module", main: "src/index.ts" }),
    );
    await writeFile(join(root, "src", "index.ts"), "export const live = true;\n");
    await writeFile(join(root, "src", "orphan.ts"), "export const orphan = true;\n");
    await writeFile(
      join(root, "unused.config.jsonc"),
      JSON.stringify({
        entry: ["src/index.ts", "absent-entry/**/*.ts"],
        suppressions: [
          {
            files: ["src/orphan.ts"],
            kinds: ["file"],
            reason: "retained during migration",
          },
          {
            files: ["absent-suppression/**/*.ts"],
            kinds: ["file"],
            reason: "retained if generated",
          },
        ],
        ciSecondsPerTestFile: 12,
      }),
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const run = await analyzeProjectAuto(root, { now: new Date(0) });

    expect(run.summary.zombieTests).toMatchObject({
      avgSecondsPerTestFile: 12,
      estCiSecondsPerRun: 12,
    });
    expect(
      run.claims.find(
        (claim) => claim.subject.kind === "file" && claim.subject.loc.file === "src/orphan.ts",
      )?.suppression,
    ).toMatchObject({ reason: "retained during migration", source: "config" });
    const warnings = warn.mock.calls.map(([message]) => String(message));
    expect(warnings.some((message) => message.includes("src/index.ts"))).toBe(false);
    expect(warnings.some((message) => message.includes('"suppressions[0]"'))).toBe(false);
    expect(warnings.filter((message) => message.includes("absent-entry"))).toHaveLength(1);
    expect(warnings.filter((message) => message.includes('"suppressions[1]"'))).toHaveLength(1);
    expect(warnings).toHaveLength(2);
  }, 30_000);

  it("analyzes nested TypeScript and Elixir boundaries in one repository graph", async () => {
    const root = await mkdtemp(join(tmpdir(), "unused-nested-mixed-"));
    temporaryProjects.push(root);
    const backend = join(root, "services", "backend");
    const web = join(root, "services", "web");
    await mkdir(join(root, "services"), { recursive: true });
    await cp(elixirFixture, backend, { recursive: true });
    await mkdir(join(web, "src"), { recursive: true });
    await writeFile(
      join(web, "package.json"),
      JSON.stringify({ name: "neutral-web", type: "module", main: "src/index.ts" }),
    );
    await writeFile(join(web, "src", "index.ts"), "export const live = true;\n");
    await writeFile(join(web, "src", "dead.ts"), "export const dead = true;\n");

    const analysis = await analyzeProjectAutoWithGraph(root, { now: new Date(0) });
    expect(
      analysis.result.claims.some(
        (claim) =>
          claim.subject.loc.file === "services/web/src/dead.ts" && claim.subject.kind === "file",
      ),
    ).toBe(true);
    expect(
      analysis.result.claims.some(
        (claim) =>
          claim.subject.loc.file.startsWith("services/backend/") &&
          claim.provenance.analyzer === "elixir-reference-graph",
      ),
    ).toBe(true);
    expect(analysis.result.units.map((unit) => unit.rootRelDir)).toEqual([
      "services/backend",
      "services/web",
    ]);
    expect(analysis.boundaries).toMatchObject([
      { status: "complete", boundaryId: "ex:services/backend", language: "ex" },
      { status: "complete", boundaryId: "ts:services/web", language: "ts" },
    ]);
  }, 30_000);

  it("resolves exact symbol roots once across nested language boundaries", async () => {
    const root = await mkdtemp(join(tmpdir(), "unused-nested-entry-symbols-"));
    temporaryProjects.push(root);
    const backend = join(root, "services", "backend");
    const web = join(root, "services", "web");
    await mkdir(join(root, "services"), { recursive: true });
    await cp(elixirFixture, backend, { recursive: true });
    await mkdir(join(web, "src"), { recursive: true });
    await writeFile(
      join(web, "package.json"),
      JSON.stringify({ name: "neutral-web", type: "module", main: "src/index.ts" }),
    );
    await writeFile(join(web, "src", "index.ts"), "export const boot = true;\n");
    await writeFile(
      join(web, "src", "operations.ts"),
      "export const selected = true;\nexport const unusedSibling = false;\n",
    );
    await writeFile(
      join(root, "unused.config.jsonc"),
      JSON.stringify({
        workspaces: {
          "services/web": {
            entrySymbols: [
              {
                language: "ts",
                file: "src/operations.ts",
                name: "selected",
                reason: "browser operation",
              },
            ],
          },
          "services/backend": {
            entrySymbols: [
              {
                language: "ex",
                file: "lib/tob/fixture_factory.ex",
                name: "Tob.FixtureFactory.build/0",
                reason: "runtime operation",
              },
            ],
          },
        },
      }),
    );

    const analysis = await analyzeProjectAutoWithGraph(root, { now: new Date(0) });
    const names = analysis.result.claims.map((claim) => claim.subject.name);
    expect(names).not.toContain("selected");
    expect(names).toContain("unusedSibling");
    expect(names).not.toContain("Tob.FixtureFactory.build/0");
    expect(
      analysis.graph
        .entrypoints()
        .filter((entrypoint) => entrypoint.targetSymbol !== undefined)
        .map((entrypoint) => ({
          file: entrypoint.file,
          reason: entrypoint.reason,
          targetSymbol: entrypoint.targetSymbol,
        })),
    ).toEqual([
      {
        file: "services/backend/lib/tob/fixture_factory.ex",
        reason: "runtime operation",
        targetSymbol:
          "symbol:services/backend/lib/tob/fixture_factory.ex#Tob.FixtureFactory.build/0",
      },
      {
        file: "services/web/src/operations.ts",
        reason: "browser operation",
        targetSymbol: "symbol:services/web/src/operations.ts#selected",
      },
    ]);
  }, 30_000);

  it("preserves a nested Elixir boundary's local exact root through why and deletion", async () => {
    const root = await mkdtemp(join(tmpdir(), "unused-nested-local-elixir-root-"));
    temporaryProjects.push(root);
    const backend = join(root, "services", "runtime");
    await mkdir(join(root, "services"), { recursive: true });
    await cp(elixirDeadFunctionFixture, backend, { recursive: true });
    await writeFile(
      join(backend, "unused.config.jsonc"),
      JSON.stringify({
        entrySymbols: [
          {
            language: "ex",
            file: "lib/basic_dead/core.ex",
            name: "BasicDead.Core.unused_helper/1",
            reason: "neutral runtime callback",
          },
        ],
      }),
    );

    const analysis = await analyzeProjectAutoWithGraph(root, { now: new Date(0) });
    expect(
      analysis.result.claims.some(
        (claim) => claim.subject.name === "BasicDead.Core.unused_helper/1",
      ),
    ).toBe(false);
    const why = whyAlive({
      graph: analysis.graph,
      reachability: analysis.reachability,
      claims: analysis.result.claims,
      query: "BasicDead.Core.unused_helper/1",
    });
    expect(why).toMatchObject({
      outcome: "alive",
      paths: [{ entrypointReason: "neutral runtime callback" }],
    });
    expect(
      computeDeletionPlan({
        graph: analysis.graph,
        reachability: analysis.reachability,
        subject: {
          kind: "export",
          file: "services/runtime/lib/basic_dead/core.ex",
          name: "BasicDead.Core.unused_helper/1",
        },
      }),
    ).toMatchObject({
      supported: false,
      unsupportedReason: expect.stringContaining("neutral runtime callback"),
    });
  }, 30_000);

  it("merges complementary exact roots from a same-directory polyglot config once", async () => {
    const root = await mkdtemp(join(tmpdir(), "unused-same-root-polyglot-config-"));
    temporaryProjects.push(root);
    const project = join(root, "services", "runtime");
    await mkdir(join(root, "services"), { recursive: true });
    await cp(elixirDeadFunctionFixture, project, { recursive: true });
    await mkdir(join(project, "src"), { recursive: true });
    await writeFile(
      join(project, "package.json"),
      JSON.stringify({ name: "@neutral/polyglot", type: "module", main: "src/index.ts" }),
    );
    await writeFile(join(project, "src", "index.ts"), "export const boot = true;\n");
    await writeFile(join(project, "src", "operations.ts"), "export const selected = true;\n");
    await writeFile(
      join(project, "unused.config.jsonc"),
      JSON.stringify({
        entrySymbols: [
          {
            language: "ex",
            file: "lib/basic_dead/core.ex",
            name: "BasicDead.Core.unused_helper/1",
            reason: "neutral runtime callback",
          },
        ],
        workspaces: {
          "@neutral/polyglot": {
            entrySymbols: [
              {
                language: "ts",
                file: "src/operations.ts",
                name: "selected",
                reason: "neutral browser callback",
              },
            ],
            suppressions: [
              {
                files: ["lib/basic_dead/core.ex"],
                kinds: ["export"],
                reason: "must remain TypeScript-owned",
              },
            ],
          },
        },
        gate: { threshold: "low" },
      }),
    );

    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const analysis = await analyzeProjectAutoWithGraph(root, { now: new Date(0) });
    expect(
      analysis.graph
        .entrypoints()
        .filter((entrypoint) => entrypoint.targetSymbol !== undefined)
        .map(({ file, reason }) => ({ file, reason })),
    ).toEqual([
      {
        file: "services/runtime/lib/basic_dead/core.ex",
        reason: "neutral runtime callback",
      },
      {
        file: "services/runtime/src/operations.ts",
        reason: "neutral browser callback",
      },
    ]);
    expect(analysis.result.claims.map((claim) => claim.subject.name)).not.toContain(
      "BasicDead.Core.unused_helper/1",
    );
    expect(analysis.result.claims.map((claim) => claim.subject.name)).not.toContain("selected");
    expect(analysis.result.diagnostics?.map((diagnostic) => diagnostic.code)).toEqual([
      "BOUNDARY_GATE_POLICY_IGNORED",
    ]);
    expect(
      warn.mock.calls.filter(([message]) => String(message).includes("matched no files")),
    ).toHaveLength(1);
  }, 30_000);

  it("does not let one ecosystem name select another same-directory language", async () => {
    const root = await mkdtemp(join(tmpdir(), "unused-polyglot-root-alias-"));
    temporaryProjects.push(root);
    const project = join(root, "services", "runtime");
    await mkdir(join(root, "services"), { recursive: true });
    await cp(elixirDeadFunctionFixture, project, { recursive: true });
    await mkdir(join(project, "src"), { recursive: true });
    await writeFile(
      join(project, "package.json"),
      JSON.stringify({ name: "@neutral/typescript-name", type: "module", main: "src/index.ts" }),
    );
    await writeFile(join(project, "src", "index.ts"), "export const boot = true;\n");
    await writeFile(
      join(root, "unused.config.jsonc"),
      JSON.stringify({
        workspaces: {
          "@neutral/typescript-name": {
            entrySymbols: [
              {
                language: "ex",
                file: "lib/basic_dead/core.ex",
                name: "BasicDead.Core.unused_helper/1",
                reason: "cross-ecosystem workspace alias",
              },
            ],
          },
        },
      }),
    );

    await expect(analyzeProjectAutoWithGraph(root, { now: new Date(0) })).rejects.toThrow(
      'workspace entrySymbols key "@neutral/typescript-name" matched no analysis workspace',
    );
  }, 30_000);

  it("applies a root directory selector across same-directory languages", async () => {
    const root = await mkdtemp(join(tmpdir(), "unused-polyglot-root-directory-"));
    temporaryProjects.push(root);
    const project = join(root, "services", "runtime");
    await mkdir(join(root, "services"), { recursive: true });
    await cp(elixirDeadFunctionFixture, project, { recursive: true });
    await mkdir(join(project, "src"), { recursive: true });
    await writeFile(
      join(project, "package.json"),
      JSON.stringify({ name: "@neutral/typescript-name", type: "module", main: "src/index.ts" }),
    );
    await writeFile(join(project, "src", "index.ts"), "export const boot = true;\n");
    await writeFile(
      join(root, "unused.config.jsonc"),
      JSON.stringify({
        workspaces: {
          "services/runtime": {
            entrySymbols: [
              {
                language: "ex",
                file: "lib/basic_dead/core.ex",
                name: "BasicDead.Core.unused_helper/1",
                reason: "physical directory selector",
              },
            ],
          },
        },
      }),
    );

    const analysis = await analyzeProjectAutoWithGraph(root, { now: new Date(0) });
    expect(
      analysis.graph.entrypoints().find((entrypoint) => entrypoint.targetSymbol !== undefined),
    ).toMatchObject({
      file: "services/runtime/lib/basic_dead/core.ex",
      reason: "physical directory selector",
    });
  }, 30_000);

  it("scopes root directory policy physically and name policy to its ecosystem", async () => {
    const root = await mkdtemp(join(tmpdir(), "unused-polyglot-policy-scope-"));
    temporaryProjects.push(root);
    const project = join(root, "services", "runtime");
    await mkdir(join(root, "services"), { recursive: true });
    await cp(elixirDeadFunctionFixture, project, { recursive: true });
    await mkdir(join(project, "src"), { recursive: true });
    await writeFile(
      join(project, "package.json"),
      JSON.stringify({ name: "@neutral/typescript-name", type: "module", main: "src/index.ts" }),
    );
    await writeFile(join(project, "src", "index.ts"), "export const boot = true;\n");
    await writeFile(join(project, "src", "dead.ts"), "export const dead = true;\n");
    await writeFile(
      join(project, "Cargo.toml"),
      '[package]\nname = "neutral-runtime"\nversion = "0.1.0"\nedition = "2024"\n',
    );
    await writeFile(
      join(project, "Cargo.lock"),
      '# This file is automatically @generated by Cargo.\nversion = 4\n\n[[package]]\nname = "neutral-runtime"\nversion = "0.1.0"\n',
    );
    await writeFile(join(project, "src", "lib.rs"), "fn dead_native_helper() {}\n");
    const scope = (reason: string) => ({
      suppressions: [
        {
          files: ["src/dead.ts", "lib/basic_dead/core.ex", "src/lib.rs"],
          kinds: ["file", "export"],
          reason,
        },
      ],
    });
    const policy = (nameKey: string, nameReason: string) =>
      JSON.stringify({
        workspaces: {
          "services/runtime": scope("physical policy"),
          [nameKey]: scope(nameReason),
        },
      });
    const findClaims = async () => {
      const analysis = await analyzeProjectAuto(root, { now: new Date(0) });
      return {
        ts: analysis.claims.find((claim) => claim.subject.loc.file.endsWith("src/dead.ts")),
        ex: analysis.claims.find(
          (claim) => claim.subject.name === "BasicDead.Core.unused_helper/1",
        ),
        rs: analysis.claims.find((claim) => claim.subject.name === "dead_native_helper"),
      };
    };

    await writeFile(
      join(root, "unused.config.jsonc"),
      policy("@neutral/typescript-name", "typescript policy"),
    );
    const typescriptNamed = await findClaims();
    expect(typescriptNamed.ts?.suppression).toMatchObject({ reason: "typescript policy" });
    expect(typescriptNamed.ex?.suppression).toMatchObject({ reason: "physical policy" });
    expect(typescriptNamed.rs?.suppression).toMatchObject({ reason: "physical policy" });

    await writeFile(join(root, "unused.config.jsonc"), policy("basic_dead", "elixir policy"));
    const elixirNamed = await findClaims();
    expect(elixirNamed.ts?.suppression).toMatchObject({ reason: "physical policy" });
    expect(elixirNamed.ex?.suppression).toMatchObject({ reason: "elixir policy" });
    expect(elixirNamed.rs?.suppression).toMatchObject({ reason: "physical policy" });

    await writeFile(join(root, "unused.config.jsonc"), policy("neutral-runtime", "rust policy"));
    const rustNamed = await findClaims();
    expect(rustNamed.ts?.suppression).toMatchObject({ reason: "physical policy" });
    expect(rustNamed.ex?.suppression).toMatchObject({ reason: "physical policy" });
    expect(rustNamed.rs?.suppression).toMatchObject({ reason: "rust policy" });
  }, 30_000);

  it("does not satisfy ecosystem-name diagnostics with another same-root language", async () => {
    const root = await mkdtemp(join(tmpdir(), "unused-polyglot-warning-scope-"));
    temporaryProjects.push(root);
    const project = join(root, "services", "runtime");
    await mkdir(join(root, "services"), { recursive: true });
    await cp(elixirDeadFunctionFixture, project, { recursive: true });
    await mkdir(join(project, "src"), { recursive: true });
    await writeFile(
      join(project, "package.json"),
      JSON.stringify({ name: "@neutral/warning-owner", type: "module", main: "src/index.ts" }),
    );
    await writeFile(join(project, "src", "index.ts"), "export const boot = true;\n");
    const policy = (key: string) =>
      JSON.stringify({
        workspaces: {
          [key]: {
            entry: ["lib/basic_dead/core.ex"],
            project: ["lib/basic_dead/core.ex"],
            suppressions: [
              {
                files: ["lib/basic_dead/core.ex"],
                kinds: ["export"],
                reason: "warning ownership probe",
              },
            ],
          },
        },
      });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await writeFile(join(root, "unused.config.jsonc"), policy("@neutral/warning-owner"));
    await analyzeProjectAuto(root, { now: new Date(0) });
    const nameMessages = warn.mock.calls.map(([message]) => String(message));
    expect(nameMessages.filter((message) => message.includes("matched no files"))).toHaveLength(3);

    warn.mockClear();
    await writeFile(join(root, "unused.config.jsonc"), policy("services/runtime"));
    await analyzeProjectAuto(root, { now: new Date(0) });
    const pathMessages = warn.mock.calls.map(([message]) => String(message));
    expect(pathMessages.filter((message) => message.includes("matched no files"))).toHaveLength(0);
  }, 30_000);
});

describe("nested-boundary dispatch", () => {
  it("fails closed when a same-root frontend omits its entire config contribution", () => {
    expect(() =>
      assertCompleteLocalConfigContributions("services/polyglot", [
        {
          analysisFingerprint: "a".repeat(64),
          hasEffectiveAnalysisPolicy: false,
          configuredSymbolRoots: [],
          configuredSymbolSelectorInventory: [],
          configMatchInventory: [],
        },
        undefined,
      ]),
    ).toThrow(/incomplete local configuration ownership/);
  });

  it("fails closed when one same-root frontend omits a projected config rule", () => {
    const base = {
      analysisFingerprint: "a".repeat(64),
      hasEffectiveAnalysisPolicy: true,
      configuredSymbolRoots: [],
      configuredSymbolSelectorInventory: [],
      configMatchInventory: [
        {
          id: '["entry",0]',
          category: "entry" as const,
          label: "entry",
          pattern: "src/**",
          fileMatched: true,
        },
      ],
    };
    expect(() =>
      assertConsistentFrontendConfigContributions("services/polyglot", [
        base,
        { ...base, configMatchInventory: [] },
      ]),
    ).toThrow(/inconsistent local configuration contributions/);
  });

  it("fails closed for a cross-language local directory/name collision", () => {
    expect(() =>
      assertUnambiguousProjectedWorkspaceMatches("services/polyglot", [
        {
          id: '["workspace","packages/a"]',
          category: "workspace",
          label: "packages/a",
          workspaceKey: "packages/a",
          fileMatched: true,
          workspaceMatches: [
            { role: "directory", rootRelDir: "services/polyglot/packages/a" },
            { role: "name", rootRelDir: "services/polyglot/packages/b" },
          ],
        },
      ]),
    ).toThrow(/identifies a physical directory and an ecosystem name/);
  });

  it("rejects divergent scopes among applicable same-root suppression projections", () => {
    const inventory = (scopeRootRelDir: string) => [
      {
        id: '["workspace","shared"]',
        category: "workspace" as const,
        label: "shared",
        workspaceKey: "shared",
        fileMatched: true,
        workspaceMatches: [{ role: "name" as const, rootRelDir: scopeRootRelDir }],
      },
      {
        id: '["workspace-suppression","shared",0]',
        category: "suppression" as const,
        label: "workspaces.shared.suppressions[0]",
        workspaceKey: "shared",
        fileMatched: true,
        patterns: ["src/**"],
        scopeRootRelDir,
        claimKinds: ["file" as const],
      },
    ];
    expect(() =>
      assertConsistentApplicableSuppressionScopes("services/polyglot", [
        inventory("services/polyglot/a"),
        inventory("services/polyglot/b"),
      ]),
    ).toThrow(/inconsistent applicable local suppression scopes/);
  });

  it("fails closed when a direct analyzer omits boundary completeness metadata", () => {
    expect(() =>
      deriveDirectBoundaryMetadata({
        analyzerBoundaries: [],
        pluginId: "language:neutral",
        boundaryId: "neutral:fallback",
        language: "neutral",
        fileCount: 1,
        workspaceCount: 1,
      }),
    ).toThrow(
      "analysis completeness contract violation: language:neutral omitted required boundary metadata",
    );
  });

  it("analyzes a nested TypeScript project from the repository root", async () => {
    const root = await mkdtemp(join(tmpdir(), "unused-nested-dispatch-"));
    temporaryProjects.push(root);
    const project = join(root, "services", "web");
    await mkdir(join(project, "src"), { recursive: true });
    await writeFile(
      join(project, "package.json"),
      JSON.stringify({ name: "neutral-web", type: "module", main: "src/index.ts" }),
    );
    await writeFile(join(project, "src", "index.ts"), "export const live = true;\n");
    await writeFile(join(project, "src", "dead.ts"), "export const dead = true;\n");
    await writeFile(
      join(root, "unused.config.jsonc"),
      JSON.stringify({
        suppressions: [
          {
            files: ["services/web/src/dead.ts"],
            kinds: ["file"],
            reason: "neutral retained fixture",
          },
        ],
      }),
    );

    const analysis = await analyzeProjectAutoWithGraph(root, { now: new Date(0) });
    const dead = analysis.result.claims.find(
      (claim) => claim.subject.loc.file === "services/web/src/dead.ts",
    );

    expect(dead).toMatchObject({
      subject: { kind: "file" },
      suppression: { reason: "neutral retained fixture", source: "config" },
    });
    expect(analysis.result).toMatchObject({
      fileCount: 2,
      workspaceCount: 1,
      units: [{ rootRelDir: "services/web", name: "neutral-web" }],
    });
    expect(
      analysis.reachability.production.productionEntrypointFiles.has(
        fileId("services/web/src/index.ts"),
      ),
    ).toBe(true);
  });

  it("keeps local exact TS roots boundary-scoped and preserves why/delete evidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "unused-local-ts-roots-"));
    temporaryProjects.push(root);
    for (const name of ["alpha", "beta"] as const) {
      const project = join(root, "services", name);
      await mkdir(join(project, "src"), { recursive: true });
      await writeFile(
        join(project, "package.json"),
        JSON.stringify({ name: "@neutral/shared-name", type: "module", main: "src/index.ts" }),
      );
      await writeFile(join(project, "src", "index.ts"), "export const boot = true;\n");
      await writeFile(
        join(project, "src", "operations.ts"),
        "export const selected = true;\nexport const sibling = false;\n",
      );
      if (name === "alpha") {
        await writeFile(
          join(project, "unused.config.jsonc"),
          JSON.stringify({
            entrySymbols: [
              {
                language: "ts",
                file: "src/operations.ts",
                name: "selected",
                reason: "alpha runtime operation",
              },
            ],
          }),
        );
      }
    }

    const analysis = await analyzeProjectAutoWithGraph(root, { now: new Date(0) });
    expect(
      analysis.graph.entrypoints().filter((entrypoint) => entrypoint.targetSymbol !== undefined),
    ).toMatchObject([
      {
        file: "services/alpha/src/operations.ts",
        reason: "alpha runtime operation",
      },
    ]);
    expect(
      analysis.result.claims.some(
        (claim) =>
          claim.subject.loc.file === "services/alpha/src/operations.ts" &&
          claim.subject.name === "selected",
      ),
    ).toBe(false);
    expect(
      analysis.result.claims.some(
        (claim) =>
          claim.subject.loc.file === "services/alpha/src/operations.ts" &&
          claim.subject.name === "sibling",
      ),
    ).toBe(true);
    expect(
      analysis.result.claims.some(
        (claim) => claim.subject.loc.file === "services/beta/src/operations.ts",
      ),
    ).toBe(true);

    const why = whyAlive({
      graph: analysis.graph,
      reachability: analysis.reachability,
      claims: analysis.result.claims,
      query: "services/alpha/src/operations.ts:selected",
    });
    expect(why).toMatchObject({
      outcome: "alive",
      paths: [{ entrypointReason: "alpha runtime operation" }],
    });
    expect(
      computeDeletionPlan({
        graph: analysis.graph,
        reachability: analysis.reachability,
        subject: {
          kind: "export",
          file: "services/alpha/src/operations.ts",
          name: "selected",
        },
      }),
    ).toMatchObject({
      supported: false,
      unsupportedReason: expect.stringContaining("alpha runtime operation"),
    });

    await writeFile(
      join(root, "services", "alpha", "unused.config.jsonc"),
      JSON.stringify({
        entrySymbols: [
          {
            language: "ts",
            file: "src/operations.ts",
            name: "selected",
            reason: "changed runtime rationale",
          },
        ],
      }),
    );
    const changed = await analyzeProjectAutoWithGraph(root, { now: new Date(0) });
    expect(changed.result.run.configHash).not.toBe(analysis.result.run.configHash);
  });

  it("fails once when an ecosystem name identifies multiple physical workspaces", async () => {
    const root = await mkdtemp(join(tmpdir(), "unused-ambiguous-workspace-name-"));
    temporaryProjects.push(root);
    for (const directory of ["alpha", "beta"]) {
      const project = join(root, "services", directory);
      await mkdir(join(project, "src"), { recursive: true });
      await writeFile(
        join(project, "package.json"),
        JSON.stringify({ name: "@neutral/duplicate", type: "module", main: "src/index.ts" }),
      );
      await writeFile(join(project, "src", "index.ts"), "export const boot = true;\n");
    }
    await writeFile(
      join(root, "unused.config.jsonc"),
      JSON.stringify({
        workspaces: {
          "@neutral/duplicate": { entry: ["src/index.ts"] },
        },
      }),
    );

    await expect(analyzeProjectAutoWithGraph(root, { now: new Date(0) })).rejects.toThrow(
      'workspace name "@neutral/duplicate" is ambiguous across 2 physical workspaces',
    );
  });

  it("projects root forced and disabled presets into nested TS boundaries", async () => {
    const makeProject = async (presets: readonly string[], localPresets?: readonly string[]) => {
      const root = await mkdtemp(join(tmpdir(), "unused-root-preset-projection-"));
      temporaryProjects.push(root);
      const project = join(root, "services", "web");
      await mkdir(join(project, "src", "pages"), { recursive: true });
      await writeFile(
        join(project, "package.json"),
        JSON.stringify({ name: "@neutral/web", type: "module", main: "src/index.ts" }),
      );
      await writeFile(join(project, "src", "index.ts"), "export const boot = true;\n");
      await writeFile(join(project, "src", "pages", "route.ts"), "export const handler = true;\n");
      await writeFile(join(project, "src", "orphan.ts"), "export const orphan = true;\n");
      await writeFile(join(root, "unused.config.jsonc"), JSON.stringify({ presets }));
      if (localPresets !== undefined) {
        await writeFile(
          join(project, "unused.config.jsonc"),
          JSON.stringify({ presets: localPresets }),
        );
      }
      return { root };
    };

    const forced = await makeProject(["next"]);
    const forcedRun = await analyzeProjectAutoWithGraph(forced.root, { now: new Date(0) });
    expect(
      forcedRun.graph
        .entrypoints()
        .some(
          (entrypoint) =>
            entrypoint.file === "services/web/src/pages/route.ts" &&
            entrypoint.reason === "preset:next",
        ),
    ).toBe(true);
    expect(
      forcedRun.result.claims.some((claim) =>
        claim.subject.loc.file.endsWith("src/pages/route.ts"),
      ),
    ).toBe(false);
    expect(
      forcedRun.result.claims.some((claim) => claim.subject.loc.file.endsWith("src/orphan.ts")),
    ).toBe(true);

    const disabled = await makeProject([], ["next"]);
    const disabledRun = await analyzeProjectAutoWithGraph(disabled.root, { now: new Date(0) });
    expect(
      disabledRun.graph
        .entrypoints()
        .some((entrypoint) => entrypoint.file.endsWith("src/pages/route.ts")),
    ).toBe(false);
    expect(
      disabledRun.result.claims.some((claim) =>
        claim.subject.loc.file.endsWith("src/pages/route.ts"),
      ),
    ).toBe(true);
  });

  it("makes auto-discovered and explicit repository config semantically identical", async () => {
    const root = await mkdtemp(join(tmpdir(), "unused-explicit-root-policy-"));
    temporaryProjects.push(root);
    const project = join(root, "services", "web");
    await mkdir(join(project, "src"), { recursive: true });
    await writeFile(
      join(project, "package.json"),
      JSON.stringify({ name: "@neutral/web", type: "module", main: "src/index.ts" }),
    );
    await writeFile(join(project, "src", "index.ts"), "export const boot = true;\n");
    await writeFile(join(project, "src", "dead.ts"), "export const dead = true;\n");
    const policy = JSON.stringify({ project: ["services/web/src/**"] });
    await writeFile(join(root, "unused.config.jsonc"), policy);
    await writeFile(join(root, "alternate-policy.jsonc"), policy);
    await writeFile(
      join(project, "unused.config.jsonc"),
      JSON.stringify({
        suppressions: [{ files: ["src/dead.ts"], kinds: ["file"], reason: "nested local policy" }],
      }),
    );

    const automatic = await analyzeProjectAutoWithGraph(root, { now: new Date(0) });
    const explicit = await analyzeProjectAutoWithGraph(root, {
      now: new Date(0),
      configPath: "alternate-policy.jsonc",
    });
    expect(explicit.result.run.configHash).toBe(automatic.result.run.configHash);
    expect(explicit.result.claims).toEqual(automatic.result.claims);
    expect(explicit.graph.entrypoints()).toEqual(automatic.graph.entrypoints());
    expect(explicit.result.claims[0]?.suppression).toMatchObject({
      reason: "nested local policy",
    });
  });

  it("keeps aggregate economics root-owned and warns for shadowed boundary values", async () => {
    const root = await mkdtemp(join(tmpdir(), "unused-root-economics-"));
    temporaryProjects.push(root);
    const project = join(root, "services", "web");
    await mkdir(join(project, "src"), { recursive: true });
    await writeFile(
      join(project, "package.json"),
      JSON.stringify({ name: "@neutral/web", type: "module", main: "src/index.ts" }),
    );
    await writeFile(join(project, "src", "index.ts"), "export const boot = true;\n");
    await writeFile(
      join(root, "unused.config.jsonc"),
      JSON.stringify({
        gate: { threshold: "medium" },
        ciSecondsPerTestFile: 12,
      }),
    );
    await writeFile(
      join(project, "unused.config.jsonc"),
      JSON.stringify({
        gate: { threshold: "low" },
        ciSecondsPerTestFile: 99,
      }),
    );

    const analysis = await analyzeProjectAutoWithGraph(root, { now: new Date(0) });
    expect(analysis.result.gateThreshold).toBe("medium");
    expect(analysis.result.diagnostics?.map((diagnostic) => diagnostic.code)).toEqual([
      "BOUNDARY_CI_ECONOMICS_IGNORED",
      "BOUNDARY_GATE_POLICY_IGNORED",
    ]);
  });

  it("sorts boundary diagnostics by deterministic code-unit order", async () => {
    const root = await mkdtemp(join(tmpdir(), "unused-diagnostic-order-"));
    temporaryProjects.push(root);
    for (const directory of ["alpha", "Zeta"]) {
      const project = join(root, "services", directory);
      await mkdir(join(project, "src"), { recursive: true });
      await writeFile(
        join(project, "package.json"),
        JSON.stringify({ name: `@neutral/${directory}`, type: "module", main: "src/index.ts" }),
      );
      await writeFile(join(project, "src", "index.ts"), "export const boot = true;\n");
      await writeFile(
        join(project, "unused.config.jsonc"),
        JSON.stringify({ gate: { threshold: "low" } }),
      );
    }

    const analysis = await analyzeProjectAuto(root, { now: new Date(0) });
    expect(analysis.diagnostics?.map((diagnostic) => diagnostic.boundaryId)).toEqual([
      "ts:services/Zeta",
      "ts:services/alpha",
    ]);
  });

  it("reports root workspace entry, project, and suppression misses once", async () => {
    const root = await mkdtemp(join(tmpdir(), "unused-workspace-warning-"));
    temporaryProjects.push(root);
    const project = join(root, "services", "web");
    await mkdir(join(project, "src"), { recursive: true });
    await writeFile(
      join(project, "package.json"),
      JSON.stringify({ name: "@neutral/warnings", type: "module", main: "src/index.ts" }),
    );
    await writeFile(join(project, "src", "index.ts"), "export const boot = true;\n");
    await writeFile(
      join(root, "unused.config.jsonc"),
      JSON.stringify({
        workspaces: {
          "services/web": {
            entry: ["missing-entry.ts"],
            project: ["missing-project.ts"],
            suppressions: [{ files: ["missing-suppression.ts"], kinds: ["file"], reason: "stale" }],
          },
        },
      }),
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await analyzeProjectAuto(root, { now: new Date(0) });
    const messages = warn.mock.calls.map(([message]) => String(message));
    expect(messages.filter((message) => message.includes("missing-entry"))).toHaveLength(1);
    expect(messages.filter((message) => message.includes("missing-project"))).toHaveLength(1);
    expect(
      messages.filter((message) => message.includes('"workspaces.services/web.suppressions[0]"')),
    ).toHaveLength(1);
  });

  it("reports nested local config misses and stale suppressions exactly once", async () => {
    const root = await mkdtemp(join(tmpdir(), "unused-local-warning-"));
    temporaryProjects.push(root);
    const project = join(root, "services", "web");
    await mkdir(join(project, "src"), { recursive: true });
    await writeFile(
      join(project, "package.json"),
      JSON.stringify({ name: "@neutral/local-warning", type: "module", main: "src/index.ts" }),
    );
    await writeFile(join(project, "src", "index.ts"), "export const boot = true;\n");
    await writeFile(join(project, "src", "dead.ts"), "export const dead = true;\n");
    await writeFile(
      join(project, "unused.config.jsonc"),
      JSON.stringify({
        entry: ["missing-entry.ts"],
        project: ["src/**", "missing-project.ts"],
        suppressions: [
          { files: ["missing-file.ts"], kinds: ["file"], reason: "missing" },
          { files: ["src/dead.ts"], kinds: ["test"], reason: "stale kind" },
        ],
      }),
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await analyzeProjectAuto(root, { now: new Date(0) });
    const messages = warn.mock.calls.map(([message]) => String(message));
    expect(messages.filter((message) => message.includes("missing-entry"))).toHaveLength(1);
    expect(messages.filter((message) => message.includes("missing-project"))).toHaveLength(1);
    expect(messages.filter((message) => message.includes('"suppressions[0]"'))).toHaveLength(1);
    expect(messages.filter((message) => message.includes('"suppressions[1]"'))).toHaveLength(1);
    expect(messages).toHaveLength(4);
    expect(messages.every((message) => message.includes('boundary "services/web"'))).toBe(true);
  });

  it("attributes identical nested warning labels to their repository boundaries", async () => {
    const root = await mkdtemp(join(tmpdir(), "unused-local-warning-attribution-"));
    temporaryProjects.push(root);
    for (const name of ["alpha", "beta"]) {
      const project = join(root, "services", name);
      await mkdir(join(project, "src"), { recursive: true });
      await writeFile(
        join(project, "package.json"),
        JSON.stringify({ name: `@neutral/${name}`, type: "module", main: "src/index.ts" }),
      );
      await writeFile(join(project, "src", "index.ts"), "export const boot = true;\n");
      await writeFile(
        join(project, "unused.config.jsonc"),
        JSON.stringify({ entry: ["same-missing-entry.ts"] }),
      );
    }
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await analyzeProjectAuto(root, { now: new Date(0) });
    const messages = warn.mock.calls.map(([message]) => String(message));
    expect(messages).toHaveLength(2);
    expect(messages.some((message) => message.includes('boundary "services/alpha"'))).toBe(true);
    expect(messages.some((message) => message.includes('boundary "services/beta"'))).toBe(true);
  });

  it("reports one local unmatched-workspace warning without child duplicates", async () => {
    const root = await mkdtemp(join(tmpdir(), "unused-local-workspace-warning-"));
    temporaryProjects.push(root);
    const project = join(root, "services", "web");
    await mkdir(join(project, "src"), { recursive: true });
    await writeFile(
      join(project, "package.json"),
      JSON.stringify({ name: "@neutral/web", type: "module", main: "src/index.ts" }),
    );
    await writeFile(join(project, "src", "index.ts"), "export const boot = true;\n");
    await writeFile(
      join(project, "unused.config.jsonc"),
      JSON.stringify({
        workspaces: {
          missing: {
            entry: ["missing-entry.ts"],
            project: ["missing-project.ts"],
            suppressions: [{ files: ["missing-file.ts"], kinds: ["file"], reason: "missing" }],
          },
        },
      }),
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await analyzeProjectAuto(root, { now: new Date(0) });
    expect(warn.mock.calls).toHaveLength(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain('key "missing"');
  });

  it("composes root and local entry, project, dependency, and suppression policy", async () => {
    const root = await mkdtemp(join(tmpdir(), "unused-config-composition-"));
    temporaryProjects.push(root);
    const project = join(root, "services", "web");
    await mkdir(join(project, "src"), { recursive: true });
    await mkdir(join(project, "node_modules", "neutral-local-ignore"), { recursive: true });
    await mkdir(join(project, "node_modules", "neutral-root-ignore"), { recursive: true });
    await writeFile(
      join(project, "package.json"),
      JSON.stringify({
        name: "@neutral/composition",
        type: "module",
        dependencies: {
          "neutral-local-ignore": "1.0.0",
          "neutral-root-ignore": "1.0.0",
          "neutral-visible": "1.0.0",
        },
      }),
    );
    for (const dependency of ["neutral-local-ignore", "neutral-root-ignore"]) {
      await writeFile(
        join(project, "node_modules", dependency, "package.json"),
        JSON.stringify({ name: dependency, version: "1.0.0" }),
      );
    }
    await writeFile(join(project, "src", "root-entry.ts"), "export const rootEntry = true;\n");
    await writeFile(join(project, "src", "local-entry.ts"), "export const localEntry = true;\n");
    await writeFile(join(project, "src", "both-project.ts"), "export const both = true;\n");
    await writeFile(join(project, "src", "root-only.ts"), "export const rootOnly = true;\n");
    await writeFile(join(project, "src", "local-only.ts"), "export const localOnly = true;\n");
    await writeFile(join(project, "src", "sibling.ts"), "export const sibling = true;\n");
    await writeFile(
      join(root, "unused.config.jsonc"),
      JSON.stringify({
        entry: ["services/web/src/root-entry.ts"],
        project: [
          "services/web/src/root-entry.ts",
          "services/web/src/both-project.ts",
          "services/web/src/root-only.ts",
          "services/web/src/sibling.ts",
        ],
        ignoreDependencies: ["neutral-root-ignore"],
        suppressions: [
          { files: ["services/web/src/*.ts"], kinds: ["file"], reason: "root fallback" },
        ],
      }),
    );
    await writeFile(
      join(project, "unused.config.jsonc"),
      JSON.stringify({
        entry: ["src/local-entry.ts"],
        project: [
          "src/root-entry.ts",
          "src/local-entry.ts",
          "src/both-project.ts",
          "src/sibling.ts",
        ],
        ignoreDependencies: ["neutral-local-ignore"],
        suppressions: [
          { files: ["src/both-project.ts"], kinds: ["file"], reason: "local precedence" },
        ],
      }),
    );

    const analysis = await analyzeProjectAutoWithGraph(root, { now: new Date(0) });
    const fileClaims = analysis.result.claims.filter((claim) => claim.subject.kind === "file");
    expect(fileClaims.map((claim) => claim.subject.loc.file).sort()).toEqual([
      "services/web/src/both-project.ts",
      "services/web/src/sibling.ts",
    ]);
    expect(
      fileClaims.find((claim) => claim.subject.loc.file.endsWith("both-project.ts"))?.suppression,
    ).toMatchObject({ reason: "local precedence" });
    expect(
      fileClaims.find((claim) => claim.subject.loc.file.endsWith("sibling.ts"))?.suppression,
    ).toMatchObject({ reason: "root fallback" });
    expect(
      analysis.result.claims
        .filter((claim) => claim.subject.kind === "dependency")
        .map((claim) => claim.subject.name),
    ).toEqual(["neutral-visible"]);
    expect(
      analysis.graph
        .entrypoints()
        .filter((entrypoint) => entrypoint.reason === "config:entry")
        .map((entrypoint) => entrypoint.file)
        .sort(),
    ).toEqual(["services/web/src/local-entry.ts", "services/web/src/root-entry.ts"]);
  });

  it("performs one repository reachability pass across TypeScript boundaries", async () => {
    const root = await mkdtemp(join(tmpdir(), "unused-multi-ts-dispatch-"));
    temporaryProjects.push(root);
    for (const name of ["alpha", "beta"]) {
      const project = join(root, "services", name);
      await mkdir(join(project, "src"), { recursive: true });
      await writeFile(
        join(project, "package.json"),
        JSON.stringify({
          name: `neutral-${name}`,
          type: "module",
          main: "src/index.ts",
          ...(name === "alpha" ? { dependencies: { "neutral-unused": "1.0.0" } } : {}),
        }),
      );
      await writeFile(join(project, "src", "index.ts"), "export const live = true;\n");
      await writeFile(join(project, "src", "dead.ts"), "export const dead = true;\n");
      if (name === "alpha") {
        await mkdir(join(project, "node_modules", "neutral-unused"), { recursive: true });
        await writeFile(
          join(project, "node_modules", "neutral-unused", "package.json"),
          JSON.stringify({ name: "neutral-unused", version: "1.0.0" }),
        );
        await writeFile(
          join(project, "unused.config.json"),
          JSON.stringify({
            suppressions: [
              {
                files: ["src/dead.ts"],
                kinds: ["file"],
                reason: "local file policy",
              },
              {
                files: ["package.json"],
                kinds: ["dependency"],
                reason: "local dependency policy",
              },
            ],
          }),
        );
      }
    }
    const performance = new PerformanceTracker();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const analysis = await analyzeProjectAutoWithGraph(root, {
      now: new Date(0),
      performance,
    });

    expect(analysis.result.claims.map((claim) => claim.subject.loc.file).sort()).toEqual([
      "services/alpha/package.json",
      "services/alpha/src/dead.ts",
      "services/beta/src/dead.ts",
    ]);
    expect(
      analysis.result.claims.find(
        (claim) => claim.subject.loc.file === "services/alpha/src/dead.ts",
      )?.suppression,
    ).toMatchObject({ reason: "local file policy", source: "config" });
    expect(
      analysis.result.claims.find((claim) => claim.subject.kind === "dependency")?.suppression,
    ).toMatchObject({ reason: "local dependency policy", source: "config" });
    expect(performance.snapshot().counters.graphWalks).toBe(3);
    expect(warn.mock.calls.some(([message]) => String(message).includes('"suppressions[1]"'))).toBe(
      false,
    );
  });

  it("reports monotonic cumulative counters across five 50-file boundaries", async () => {
    const root = await mkdtemp(join(tmpdir(), "unused-counter-dispatch-"));
    temporaryProjects.push(root);
    for (let boundary = 0; boundary < 5; boundary += 1) {
      const project = join(root, "services", `unit-${boundary}`);
      await mkdir(join(project, "src"), { recursive: true });
      await writeFile(
        join(project, "package.json"),
        JSON.stringify({
          name: `@neutral/unit-${boundary}`,
          type: "module",
          main: "src/index.ts",
        }),
      );
      await writeFile(join(project, "src", "index.ts"), "export const live = true;\n");
      await Promise.all(
        Array.from({ length: 49 }, (_, file) =>
          writeFile(
            join(project, "src", `dead-${file}.ts`),
            `export const dead${file} = ${file};\n`,
          ),
        ),
      );
    }
    const events: PerformancePhaseEvent[] = [];
    const performance = new PerformanceTracker((event) => events.push(event));

    const analysis = await analyzeProjectAutoWithGraph(root, {
      now: new Date(0),
      performance,
    });

    const files = events.map((event) => event.counters.files);
    const resolutions = events.map((event) => event.counters.resolutionAttempts);
    expect(files).toEqual([...files].sort((a, b) => a - b));
    expect(resolutions).toEqual([...resolutions].sort((a, b) => a - b));
    expect(new Set(files)).toEqual(new Set([0, 50, 100, 150, 200, 250]));
    expect(events.every((event) => event.counters.deletionPlanSimulations === 0)).toBe(true);
    expect(performance.snapshot().counters).toMatchObject({
      files: 250,
      workspaces: 5,
      deletionPlanSimulations: 0,
    });
    expect(analysis.result).toMatchObject({ fileCount: 250, workspaceCount: 5 });
  });

  it("preserves workspace package attribution when the same project is nested", async () => {
    const root = await mkdtemp(join(tmpdir(), "unused-package-parity-"));
    temporaryProjects.push(root);
    const project = join(root, "services", "web");
    const unit = join(project, "packages", "unit");
    await mkdir(join(project, "src"), { recursive: true });
    await mkdir(join(unit, "src"), { recursive: true });
    await writeFile(
      join(project, "package.json"),
      JSON.stringify({
        name: "neutral-root",
        private: true,
        type: "module",
        main: "src/index.ts",
        workspaces: ["packages/*"],
      }),
    );
    await writeFile(join(project, "src", "index.ts"), "export const live = true;\n");
    await writeFile(
      join(unit, "package.json"),
      JSON.stringify({ name: "@neutral/unit", type: "module", main: "src/index.ts" }),
    );
    await writeFile(join(unit, "src", "index.ts"), "export const entry = true;\n");
    await writeFile(join(unit, "src", "dead.ts"), "export const dead = true;\n");
    await writeFile(join(unit, "src", "manual.ts"), "export const manual = true;\n");
    await writeFile(join(unit, "src", "test-helper.ts"), "export const helper = true;\n");
    await writeFile(
      join(unit, "src", "case.test.ts"),
      'import { helper } from "./test-helper.js";\nexport const observed = helper;\n',
    );
    await writeFile(
      join(project, "unused.config.jsonc"),
      JSON.stringify({
        workspaces: {
          "@neutral/unit": {
            entry: ["src/manual.ts"],
            suppressions: [
              { files: ["src/dead.ts"], kinds: ["file"], reason: "local parity policy" },
            ],
          },
        },
      }),
    );

    const direct = await analyzeProjectAuto(project, { now: new Date(0) });
    const nested = await analyzeProjectAuto(root, { now: new Date(0) });
    const select = (claims: typeof direct.claims, prefix: string) =>
      claims
        .filter(
          (claim) =>
            claim.subject.loc.file.endsWith("packages/unit/src/dead.ts") ||
            (claim.subject.kind === "test" &&
              claim.subject.loc.file.endsWith("packages/unit/src/case.test.ts")),
        )
        .map((claim) => ({
          kind: claim.subject.kind,
          file: claim.subject.loc.file.slice(prefix.length),
          package: claim.subject.loc.package,
          verdict: claim.verdict,
          suppression: claim.suppression?.reason,
        }))
        .sort((a, b) => a.kind.localeCompare(b.kind));

    expect(select(direct.claims, "")).toEqual([
      {
        kind: "file",
        file: "packages/unit/src/dead.ts",
        package: "@neutral/unit",
        verdict: "unused",
        suppression: "local parity policy",
      },
      {
        kind: "test",
        file: "packages/unit/src/case.test.ts",
        package: "@neutral/unit",
        verdict: "test-only",
        suppression: undefined,
      },
    ]);
    expect(select(nested.claims, "services/web/")).toEqual(select(direct.claims, ""));
    const directGraph = await analyzeProjectAutoWithGraph(project, { now: new Date(0) });
    const nestedGraph = await analyzeProjectAutoWithGraph(root, { now: new Date(0) });
    const configEntries = (
      entrypoints: ReturnType<typeof directGraph.graph.entrypoints>,
      prefix: string,
    ) =>
      entrypoints
        .filter((entrypoint) => entrypoint.reason.startsWith("config:workspaces."))
        .map((entrypoint) => entrypoint.file.slice(prefix.length));
    expect(configEntries(nestedGraph.graph.entrypoints(), "services/web/")).toEqual(
      configEntries(directGraph.graph.entrypoints(), ""),
    );
  });

  it("analyzes a nested Cargo project and rebases compiler evidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "unused-nested-rust-dispatch-"));
    temporaryProjects.push(root);
    const project = join(root, "native", "core");
    await mkdir(join(project, "src"), { recursive: true });
    await writeFile(
      join(project, "Cargo.toml"),
      '[package]\nname = "neutral-core"\nversion = "0.1.0"\nedition = "2024"\n',
    );
    await writeFile(
      join(project, "Cargo.lock"),
      '# This file is automatically @generated by Cargo.\nversion = 4\n\n[[package]]\nname = "neutral-core"\nversion = "0.1.0"\n',
    );
    await writeFile(
      join(project, "src", "lib.rs"),
      "pub fn public_api() {}\nfn dead_helper() {}\n",
    );

    const analysis = await analyzeProjectAutoWithGraph(root, { now: new Date(0) });

    expect(analysis.result.claims).toMatchObject([
      {
        subject: {
          kind: "export",
          name: "dead_helper",
          loc: { file: "native/core/src/lib.rs" },
        },
        evidence: [{ source: "rustc-dead-code" }],
      },
    ]);
    expect(analysis.boundaries).toMatchObject([
      { status: "complete", boundaryId: "rs:native/core", language: "rs", fileCount: 1 },
    ]);
  });

  it("preserves a nested Rust boundary's local exact root through why and deletion", async () => {
    const root = await mkdtemp(join(tmpdir(), "unused-nested-rust-local-root-"));
    temporaryProjects.push(root);
    const project = join(root, "native", "core");
    await mkdir(join(project, "src"), { recursive: true });
    await writeFile(
      join(project, "Cargo.toml"),
      '[package]\nname = "neutral-local-root"\nversion = "0.1.0"\nedition = "2024"\n',
    );
    await writeFile(
      join(project, "Cargo.lock"),
      '# This file is automatically @generated by Cargo.\nversion = 4\n\n[[package]]\nname = "neutral-local-root"\nversion = "0.1.0"\n',
    );
    await writeFile(
      join(project, "src", "lib.rs"),
      "fn configured_operation() {}\nfn unused_sibling() {}\n",
    );
    await writeFile(
      join(project, "unused.config.jsonc"),
      JSON.stringify({
        entrySymbols: [
          {
            language: "rs",
            file: "src/lib.rs",
            name: "configured_operation",
            reason: "neutral native callback",
          },
        ],
      }),
    );

    const analysis = await analyzeProjectAutoWithGraph(root, { now: new Date(0) });
    expect(analysis.result.claims.map((claim) => claim.subject.name)).toEqual(["unused_sibling"]);
    expect(
      whyAlive({
        graph: analysis.graph,
        reachability: analysis.reachability,
        claims: analysis.result.claims,
        query: "configured_operation",
      }),
    ).toMatchObject({
      outcome: "alive",
      paths: [{ entrypointReason: "neutral native callback" }],
    });
    expect(
      computeDeletionPlan({
        graph: analysis.graph,
        reachability: analysis.reachability,
        subject: {
          kind: "export",
          file: "native/core/src/lib.rs",
          name: "configured_operation",
        },
      }),
    ).toMatchObject({
      supported: false,
      unsupportedReason: expect.stringContaining("neutral native callback"),
    });
  });
});
