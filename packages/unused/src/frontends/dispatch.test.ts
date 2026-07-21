import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
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
