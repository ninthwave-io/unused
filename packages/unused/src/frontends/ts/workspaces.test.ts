/**
 * Monorepo workspace tests (T4.2 acceptance, phasing.md M4).
 *
 * Covers, over `./__testfixtures__/workspace-*` mini-monorepos:
 *  - detection per manager (pnpm / npm+yarn-classic / bun) and the
 *    single-package (no-workspace) degenerate case;
 *  - the Yarn PnP refusal (a typed {@link UnsupportedProjectError}, mapped to
 *    exit 2 by the CLI);
 *  - per-workspace claims with `subject.loc.package` populated;
 *  - the cross-workspace **alive-through-sibling-import** FP trap — a file
 *    reachable only via a sibling's name-based import must classify internal
 *    (alive), never be flagged;
 *  - the `pnpm-workspace.yaml` `packages:` parser;
 *  - single-package output carries no `loc.package` (no regression).
 */
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Claim } from "../../core/claims/types.js";
import { analyzeProject } from "./analyze.js";
import { Resolver } from "./resolve.js";
import { detectWorkspaces, parsePnpmPackages, UnsupportedProjectError } from "./workspaces.js";

const repoRoot = fileURLToPath(new URL("../../../../../", import.meta.url));
const corpus = (c: string): string => join(repoRoot, "fixtures/ts", c);
const testfx = (c: string): string =>
  fileURLToPath(new URL(`./__testfixtures__/${c}`, import.meta.url));
const FIXED_CLOCK = new Date(0);

interface Shape {
  kind: string;
  name: string;
  file: string;
  confidence: string;
  package: string | undefined;
}

function shapes(claims: readonly Claim[]): Shape[] {
  return claims
    .map((c) => ({
      kind: c.subject.kind,
      name: c.subject.name,
      file: c.subject.loc.file,
      confidence: c.confidence,
      package: c.subject.loc.package,
    }))
    .sort((a, b) => `${a.kind} ${a.name} ${a.file}`.localeCompare(`${b.kind} ${b.name} ${b.file}`));
}

// ---------------------------------------------------------------------------
// pnpm-workspace.yaml parser
// ---------------------------------------------------------------------------

describe("parsePnpmPackages", () => {
  it("parses a block sequence with comments and negation", () => {
    expect(
      parsePnpmPackages(
        ["# a comment", "packages:", "  - 'packages/*'", '  - "apps/**"', "  - '!**/dist/**'"].join(
          "\n",
        ),
      ),
    ).toEqual(["packages/*", "apps/**", "!**/dist/**"]);
  });

  it("parses a flow sequence", () => {
    expect(parsePnpmPackages("packages: ['packages/*', \"tools/*\"]")).toEqual([
      "packages/*",
      "tools/*",
    ]);
  });

  it("stops at the next top-level key and ignores a trailing comment on an item", () => {
    expect(
      parsePnpmPackages(
        ["packages:", "  - packages/* # inline", "catalog:", "  react: ^18"].join("\n"),
      ),
    ).toEqual(["packages/*"]);
  });

  it("returns [] when there is no packages key", () => {
    expect(parsePnpmPackages("catalog:\n  react: ^18\n")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Detection per manager + PnP refusal + single-package
// ---------------------------------------------------------------------------

describe("detectWorkspaces", () => {
  it("detects a pnpm workspace and its members (negated member excluded)", async () => {
    const layout = await detectWorkspaces(testfx("workspace-pnpm"));
    expect(layout.manager).toBe("pnpm");
    expect(layout.members.map((m) => m.name).sort()).toEqual([
      "@mono/app",
      "@mono/lib",
      "@mono/utils",
    ]);
    // `!packages/excluded` removes a real, populated would-be member.
    expect(layout.members.map((m) => m.rootRelDir)).not.toContain("packages/excluded");
    expect(layout.excludedDirs).toEqual(["packages/excluded"]);
  });

  it("detects an npm/yarn-classic workspace from the package.json `workspaces` array", async () => {
    const layout = await detectWorkspaces(testfx("workspace-npm"));
    expect(layout.manager).toBe("npm");
    expect(layout.members.map((m) => m.rootRelDir).sort()).toEqual(["packages/a", "packages/b"]);
  });

  it("labels a bun workspace via its bun.lock", async () => {
    const layout = await detectWorkspaces(testfx("workspace-bun"));
    expect(layout.manager).toBe("bun");
    expect(layout.members.map((m) => m.name).sort()).toEqual(["@bun/consumer", "@bun/dep"]);
  });

  it("returns no members for a single-package project", async () => {
    const layout = await detectWorkspaces(testfx("entrypoints"));
    expect(layout).toEqual({ manager: null, members: [], excludedDirs: [] });
  });

  it("refuses a Yarn PnP project with a typed UnsupportedProjectError", async () => {
    await expect(detectWorkspaces(testfx("workspace-pnp"))).rejects.toBeInstanceOf(
      UnsupportedProjectError,
    );
    await expect(detectWorkspaces(testfx("workspace-pnp"))).rejects.toThrow(/Plug'n'Play/);
  });

  it("refuses when a .pnp file lives in an ANCESTOR of the analysis root (walk-up)", async () => {
    // Analysis root is a member; `.pnp.mjs` is at the monorepo root above it.
    const member = testfx("workspace-pnp-nested/packages/app");
    await expect(detectWorkspaces(member)).rejects.toBeInstanceOf(UnsupportedProjectError);
    await expect(detectWorkspaces(member)).rejects.toThrow(/\.pnp\.mjs/);
  });
});

// ---------------------------------------------------------------------------
// End-to-end per-workspace claims + the cross-workspace FP trap
// ---------------------------------------------------------------------------

describe("analyzeProject over workspaces", () => {
  it("pnpm: per-package dead export + dead file, packages tagged; siblings stay alive", async () => {
    const run = await analyzeProject(testfx("workspace-pnpm"), { now: FIXED_CLOCK });
    expect(shapes(run.claims)).toEqual([
      {
        kind: "export",
        name: "deadHelper",
        file: "packages/lib/src/helper.ts",
        confidence: "high",
        package: "@mono/lib",
      },
      {
        kind: "file",
        name: "packages/app/src/orphan.ts",
        file: "packages/app/src/orphan.ts",
        confidence: "high",
        package: "@mono/app",
      },
    ]);
    // The FP trap: strings.ts is reachable ONLY through app's `@mono/utils/strings`
    // (no exports map, not a utils entrypoint) — it must never be flagged.
    expect(claimedFiles(run.claims)).not.toContain("packages/utils/strings.ts");
    // usedHelper (bare `@mono/lib`, exports map) and utils' own entrypoint stay alive.
    expect(claimedNames(run.claims)).not.toContain("slugify");
    expect(claimedNames(run.claims)).not.toContain("usedHelper");
    // The excluded member (`!packages/excluded`) is out of scope: none of its
    // sources are claimed, even though `orphan.ts` there would otherwise be dead.
    expect(claimedFiles(run.claims).some((f) => f.startsWith("packages/excluded/"))).toBe(false);
  });

  it("npm: name-based subpath import of a no-exports sibling keeps its file alive", async () => {
    const run = await analyzeProject(testfx("workspace-npm"), { now: FIXED_CLOCK });
    expect(shapes(run.claims)).toEqual([
      {
        kind: "export",
        name: "bDead",
        file: "packages/b/feature.ts",
        confidence: "high",
        package: "@x/b",
      },
      {
        kind: "file",
        name: "packages/a/orphan.ts",
        file: "packages/a/orphan.ts",
        confidence: "high",
        package: "@x/a",
      },
    ]);
    // feature() is used across the workspace boundary — the used export is not
    // flagged (feature.ts carries only the genuine dead `bDead`, never a file claim).
    expect(claimedNames(run.claims)).not.toContain("feature");
    expect(hasFileClaim(run.claims, "packages/b/feature.ts")).toBe(false);
  });

  it("bun: cross-workspace `workspace:` sibling import resolves internal (alive)", async () => {
    const run = await analyzeProject(testfx("workspace-bun"), { now: FIXED_CLOCK });
    expect(shapes(run.claims)).toEqual([
      {
        kind: "export",
        name: "depDead",
        file: "pkgs/dep/extra.ts",
        confidence: "high",
        package: "@bun/dep",
      },
    ]);
    // extra() is consumed via `@bun/dep/extra` — alive; only depDead is flagged.
    expect(claimedNames(run.claims)).not.toContain("extra");
    expect(hasFileClaim(run.claims, "pkgs/dep/extra.ts")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Resolver: a workspace sibling classifies internal, never external
// ---------------------------------------------------------------------------

describe("Resolver — workspace-sibling resolution (internal, not external)", () => {
  const root = testfx("workspace-pnpm");
  const importer = join(root, "packages/app/src/index.ts");
  const span = { start: 0, end: 0, startLine: 1, endLine: 1 } as const;
  const workspacePackages = new Map<string, string>([
    ["@mono/lib", join(root, "packages/lib")],
    ["@mono/utils", join(root, "packages/utils")],
  ]);

  it("resolves a bare sibling name through its exports map to source (internal)", () => {
    const resolver = new Resolver({ projectRoot: root, workspacePackages });
    const outcome = resolver.resolve("@mono/lib", importer, span, "import").outcome;
    expect(outcome).toEqual({ kind: "internal", path: join(root, "packages/lib/src/index.ts") });
  });

  it("resolves a subpath of a no-exports sibling to its source file (internal)", () => {
    const resolver = new Resolver({ projectRoot: root, workspacePackages });
    const outcome = resolver.resolve("@mono/utils/strings", importer, span, "import").outcome;
    expect(outcome).toEqual({ kind: "internal", path: join(root, "packages/utils/strings.ts") });
  });

  it("WITHOUT the workspace map the same sibling is external — the trap this fixes", () => {
    const resolver = new Resolver({ projectRoot: root });
    const outcome = resolver.resolve("@mono/utils/strings", importer, span, "import").outcome;
    expect(outcome.kind).toBe("external");
  });
});

// ---------------------------------------------------------------------------
// No regression: single-package claims carry no `loc.package`
// ---------------------------------------------------------------------------

describe("single-package analysis is unaffected", () => {
  it("emits no `subject.loc.package` (the field is monorepo-only)", async () => {
    const run = await analyzeProject(corpus("basic-dead-export"), { now: FIXED_CLOCK });
    expect(run.claims.length).toBeGreaterThan(0);
    for (const claim of run.claims) expect(claim.subject.loc.package).toBeUndefined();
  });
});

function claimedFiles(claims: readonly Claim[]): string[] {
  return claims.map((c) => c.subject.loc.file);
}
function claimedNames(claims: readonly Claim[]): string[] {
  return claims.map((c) => c.subject.name);
}
function hasFileClaim(claims: readonly Claim[], file: string): boolean {
  return claims.some((c) => c.subject.kind === "file" && c.subject.loc.file === file);
}
