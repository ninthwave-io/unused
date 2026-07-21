import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { entrypointId, IRGraph } from "../../core/ir/index.js";
import { analyzeProjectAuto } from "../dispatch.js";
import type { FrontendGraphFragment, RepositoryAnalysisContext } from "./types.js";
import { typescriptGithubActionsConventionPlugin } from "./typescript-conventions.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("TypeScript convention plugins", () => {
  it("emits a rebased config root from a nested boundary workflow", async () => {
    const root = await projectFixture();
    const project = join(root, "services/web");
    const context = repository(root, project);
    const fragment = tsFragment(project);

    const contribution = await typescriptGithubActionsConventionPlugin.analyze({
      repository: context,
      fragment,
    });

    expect(contribution.nodes).toEqual([
      {
        kind: "entrypoint",
        id: entrypointId("config", "services/web/scripts/release.ts"),
        entryKind: "config",
        file: "services/web/scripts/release.ts",
        reason: "config:github-actions:run",
      },
    ]);
  });

  it("owns the deferred convention in repository dispatch without changing liveness", async () => {
    const root = await projectFixture();
    const analysis = await analyzeProjectAuto(root, { now: new Date(0) });
    const subjects = analysis.claims.map((claim) => claim.subject.loc.file);

    expect(subjects).not.toContain("services/web/scripts/release.ts");
    expect(subjects).toContain("services/web/src/dead.ts");
  });
});

async function projectFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "unused-ts-convention-plugin-"));
  temporaryRoots.push(root);
  const project = join(root, "services/web");
  await mkdir(join(project, ".github/workflows"), { recursive: true });
  await mkdir(join(project, "scripts"), { recursive: true });
  await mkdir(join(project, "src"), { recursive: true });
  await writeFile(
    join(project, "package.json"),
    JSON.stringify({ name: "neutral-web", type: "module", main: "src/index.ts" }),
  );
  await writeFile(join(project, "src/index.ts"), "export const live = true;\n");
  await writeFile(join(project, "src/dead.ts"), "export const dead = true;\n");
  await writeFile(join(project, "scripts/release.ts"), "export const release = true;\n");
  await writeFile(
    join(project, ".github/workflows/release.yml"),
    "jobs:\n  release:\n    steps:\n      - run: node scripts/release.ts\n",
  );
  return root;
}

function repository(rootDir: string, project: string): RepositoryAnalysisContext {
  return {
    rootDir,
    gitignore: true,
    manifests: {
      packageJsonDirs: [project],
      mixExsDirs: [],
      cargoTomlDirs: [],
      rustSourceFiles: [],
    },
    now: new Date(0),
    toolVersion: "0.1.0",
  };
}

function tsFragment(rootDir: string): FrontendGraphFragment {
  return {
    pluginId: "language:typescript",
    language: "ts",
    boundary: {
      id: "ts:services/web",
      language: "ts",
      rootDir,
      rootRelDir: "services/web",
      manifest: "services/web/package.json",
      projectKind: "npm-workspace",
    },
    graph: new IRGraph(),
    provenance: { analyzer: "ts-test", version: "0.1.0", generatedAt: new Date(0).toISOString() },
    metadata: {
      projectName: "neutral-web",
      fileCount: 3,
      workspaceCount: 1,
      configHash: "test",
      gateThreshold: "high",
    },
    claimInputs: {
      fileLineCounts: new Map(),
      units: [{ rootRelDir: "services/web", name: "neutral-web" }],
      analysisFiles: new Set([
        "services/web/scripts/release.ts",
        "services/web/src/dead.ts",
        "services/web/src/index.ts",
      ]),
      claimableFiles: new Set([
        "services/web/scripts/release.ts",
        "services/web/src/dead.ts",
        "services/web/src/index.ts",
      ]),
    },
    claimAnnotations: new Map(),
    diagnostics: [],
  };
}
