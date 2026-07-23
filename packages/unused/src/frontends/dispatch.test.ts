import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type PerformancePhaseEvent, PerformanceTracker } from "../core/analysis/index.js";
import { fileId } from "../core/ir/index.js";
import { isMixAvailable } from "../testing/corpus/elixir-corpus.js";
import {
  analyzeProjectAuto,
  analyzeProjectAutoWithGraph,
  deriveDirectBoundaryMetadata,
} from "./dispatch.js";

const elixirFixture = fileURLToPath(
  new URL("../../../../fixtures/elixir/test-only-zombie", import.meta.url),
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
});

describe("nested-boundary dispatch", () => {
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
    await writeFile(join(unit, "src", "test-helper.ts"), "export const helper = true;\n");
    await writeFile(
      join(unit, "src", "case.test.ts"),
      'import { helper } from "./test-helper.js";\nexport const observed = helper;\n',
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
        }))
        .sort((a, b) => a.kind.localeCompare(b.kind));

    expect(select(direct.claims, "")).toEqual([
      {
        kind: "file",
        file: "packages/unit/src/dead.ts",
        package: "@neutral/unit",
        verdict: "unused",
      },
      {
        kind: "test",
        file: "packages/unit/src/case.test.ts",
        package: "@neutral/unit",
        verdict: "test-only",
      },
    ]);
    expect(select(nested.claims, "services/web/")).toEqual(select(direct.claims, ""));
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
});
