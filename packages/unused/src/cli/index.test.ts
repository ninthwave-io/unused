/**
 * Spawn-based integration tests for the `unused` CLI (T2.5, docs/phasing.md
 * M2). These exercise the *built* `dist/cli/index.js` as a real child
 * process — the only way to honestly test argv parsing, exit codes, and
 * stdout/stderr separation for a `bin` entrypoint. `beforeAll` builds the
 * package first (plain `tsc -p packages/unused/tsconfig.json`, the same
 * invocation as the root `build` script) so this file is self-sufficient:
 * `pnpm run ci` need not run a separate `build` step for these to pass.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { cp, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv2020 } from "ajv/dist/2020.js";
import type { FormatsPlugin } from "ajv-formats";
import { beforeAll, describe, expect, it } from "vitest";
// Direct import (not spawned) is safe here — `isEntryPoint()` guards `main()`
// from auto-running merely because this module was imported (T9.1); this is
// the one export in this file worth unit-testing directly rather than via a
// spawned subprocess, since faking an old Node binary to spawn against isn't
// practical in CI.
import { checkNodeEngine } from "./index.js";

const addFormats = createRequire(import.meta.url)("ajv-formats") as FormatsPlugin;

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(HERE, "../..");
const REPO_ROOT = resolve(PACKAGE_ROOT, "../..");
const TSC_BIN = join(REPO_ROOT, "node_modules/.bin/tsc");
const CLI_ENTRY = join(PACKAGE_ROOT, "dist/cli/index.js");

const FIXTURES_ROOT = join(REPO_ROOT, "fixtures/ts");
const CLEAN_FIXTURE = join(FIXTURES_ROOT, "basic-alive-export"); // real entrypoint, zero dead code
const DEAD_FIXTURE = join(FIXTURES_ROOT, "basic-dead-export"); // real entrypoint, one dead export
const NO_ENTRYPOINTS_FIXTURE = join(
  PACKAGE_ROOT,
  "src/frontends/ts/__testfixtures__/no-entrypoints",
);
const TESTFIXTURES = join(PACKAGE_ROOT, "src/frontends/ts/__testfixtures__");
const PNP_FIXTURE = join(TESTFIXTURES, "workspace-pnp"); // Yarn PnP → refused
const WORKSPACE_FIXTURE = join(TESTFIXTURES, "workspace-pnpm"); // pnpm monorepo
const CONFIG_BASIC_FIXTURE = join(TESTFIXTURES, "config-basic"); // T4.3 entry/project/ignore
const ZOMBIE_TEST_FIXTURE = join(FIXTURES_ROOT, "test-root-recognition"); // T5.3: one zombie test
const MIXED_CONFIDENCE_FIXTURE = join(FIXTURES_ROOT, "string-computed-import"); // 1 high + 2 medium
const SUPPRESSION_FIXTURE = join(FIXTURES_ROOT, "suppression-comment"); // 2 high, both suppressed

function readSchema(): object {
  return JSON.parse(
    readFileSync(join(PACKAGE_ROOT, "src/core/claims/schema/claim-run.schema.json"), "utf8"),
  );
}

function compileSchema() {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  return ajv.compile(readSchema());
}

function runCli(args: readonly string[]) {
  return spawnSync(process.execPath, [CLI_ENTRY, ...args], { encoding: "utf8" });
}

/**
 * Copies `fixtureDir` into a fresh temp directory, runs `fn` against it, then
 * removes it. Every `unused baseline`/`unused check` test needs a *writable*
 * copy — the checked-in fixture directories are shared/read-only across this
 * whole test file, and `unused baseline` writes `.unused/baseline.jsonl` into
 * whatever `--cwd` it's pointed at (same `mkdtemp` pattern the `--sarif`
 * tests already use, applied here to a whole directory via `fs.cp`).
 */
async function withTempFixtureCopy<T>(
  fixtureDir: string,
  fn: (dir: string) => Promise<T>,
): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "unused-cli-"));
  try {
    await cp(fixtureDir, dir, { recursive: true });
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

beforeAll(() => {
  execFileSync(TSC_BIN, ["-p", join(PACKAGE_ROOT, "tsconfig.json")], {
    cwd: REPO_ROOT,
    stdio: "inherit",
  });
}, 120_000);

describe("Elixir frontend refusal (ADR 0011)", () => {
  it("maps a toolchain-absent (mix ENOENT) refusal to exit 2 with a clear message", async () => {
    // A directory with a mix.exs and no package.json routes to the Elixir
    // frontend (dispatch.ts). Running the built CLI with a PATH that lacks `mix`
    // forces the toolchain-absent refusal — the frontend's `mix` spawn ENOENTs,
    // becomes an ElixirToolchainError, and the CLI must map it to exit 2 with a
    // plain "unused:" message (a refusal, not an "analysis failed" crash).
    const dir = await mkdtemp(join(tmpdir(), "unused-cli-ex-"));
    try {
      await writeFile(
        join(dir, "mix.exs"),
        'defmodule X.MixProject do\n  use Mix.Project\n  def project, do: [app: :x, version: "0.1.0"]\nend\n',
      );
      const result = spawnSync(process.execPath, [CLI_ENTRY, "--cwd", dir], {
        encoding: "utf8",
        env: { ...process.env, PATH: "/usr/bin:/bin" },
      });
      expect(result.status).toBe(2);
      expect(result.stderr).toMatch(/mix.*was not found on PATH/i);
      expect(result.stderr.startsWith("unused:")).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("checkNodeEngine (T9.1: engines.node >=22 startup check)", () => {
  it("accepts a Node version at or above the floor", () => {
    expect(checkNodeEngine("v22.0.0")).toBeUndefined();
    expect(checkNodeEngine("v22.16.0")).toBeUndefined();
    expect(checkNodeEngine("v23.4.1")).toBeUndefined();
  });

  it("rejects a Node version below the floor, with a clear message naming the requirement", () => {
    const message = checkNodeEngine("v18.20.4");
    expect(message).toBeDefined();
    expect(message).toMatch(/Node\.js >=22/);
    expect(message).toContain("v18.20.4");
  });

  it("rejects a version just one major below the floor (boundary)", () => {
    expect(checkNodeEngine("v21.7.3")).toBeDefined();
  });

  it("degrades toward 'let it run' on an unparseable version string rather than refusing", () => {
    expect(checkNodeEngine("not-a-version")).toBeUndefined();
  });

  it("defaults to the real process.version when called with no argument", () => {
    // The environment actually running this test suite must itself satisfy
    // engines.node >=22 (package.json) — so this should always be undefined.
    expect(checkNodeEngine()).toBeUndefined();
  });
});

describe("unused CLI — shebang + executability", () => {
  it("dist/cli/index.js starts with the node shebang", () => {
    const firstLine = readFileSync(CLI_ENTRY, "utf8").split("\n")[0];
    expect(firstLine).toBe("#!/usr/bin/env node");
  });

  it("runs when invoked through a symlink, exactly as npm's `bin` install does (T9.1 pack-verification finding)", async () => {
    // npm/pnpm install `bin: { unused: "./dist/cli/index.js" }` as a symlink
    // at node_modules/.bin/unused — NOT a copy. `import.meta.url` resolves
    // through that symlink to the real file, but `process.argv[1]` stays the
    // symlink path (Node's ESM loader behaviour), which broke `isEntryPoint()`'s
    // first, naive string-compare implementation: `main()` silently never
    // ran (no stdout, no stderr, exit 0) when launched through a symlink —
    // caught only by the actual `npm pack`/install/cold-run transcript, not
    // by any of the other tests here, which all invoke CLI_ENTRY directly.
    const dir = await mkdtemp(join(tmpdir(), "unused-symlink-"));
    const linkPath = join(dir, "unused-link.js");
    try {
      await symlink(CLI_ENTRY, linkPath);
      const result = spawnSync(process.execPath, [linkPath, "--json", "--cwd", DEAD_FIXTURE], {
        encoding: "utf8",
      });
      expect(result.status).toBe(0);
      expect(() => JSON.parse(result.stdout)).not.toThrow();
      expect(JSON.parse(result.stdout).claims.length).toBeGreaterThan(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("unused CLI — exit codes (PRD §3 contract)", () => {
  it("exits 0 with --json on a fixture that has findings", () => {
    const result = runCli(["--json", "--cwd", DEAD_FIXTURE]);
    expect(result.status).toBe(0);
  });

  it("exits 0 with --json on a clean fixture (real entrypoint, nothing dead)", () => {
    const result = runCli(["--json", "--cwd", CLEAN_FIXTURE]);
    expect(result.status).toBe(0);
  });

  it("exits 3 on an unknown flag", () => {
    const result = runCli(["--bogus"]);
    expect(result.status).toBe(3);
    expect(result.stderr).toMatch(/unknown argument/);
    expect(result.stdout).toBe("");
  });

  it("exits 3 when --cwd is missing its argument", () => {
    const result = runCli(["--cwd"]);
    expect(result.status).toBe(3);
    expect(result.stderr).toMatch(/--cwd requires a directory argument/);
  });

  it("exits 2 on a nonexistent --cwd", () => {
    const result = runCli(["--cwd", join(REPO_ROOT, "does-not-exist-anywhere")]);
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/cannot read directory/);
    expect(result.stdout).toBe("");
  });
});

describe("unused CLI — --json is schema-valid and stdout-clean", () => {
  const validate = compileSchema();

  it("validates on a fixture with findings", () => {
    const result = runCli(["--json", "--cwd", DEAD_FIXTURE]);
    const parsed: unknown = JSON.parse(result.stdout);
    const valid = validate(parsed);
    expect(validate.errors, JSON.stringify(validate.errors)).toBeNull();
    expect(valid).toBe(true);
    expect((parsed as { claims: unknown[] }).claims.length).toBeGreaterThan(0);
  });

  it("validates on a clean fixture (zero claims is still valid schema)", () => {
    const result = runCli(["--json", "--cwd", CLEAN_FIXTURE]);
    const parsed: unknown = JSON.parse(result.stdout);
    const valid = validate(parsed);
    expect(validate.errors, JSON.stringify(validate.errors)).toBeNull();
    expect(valid).toBe(true);
    expect((parsed as { claims: unknown[] }).claims).toEqual([]);
  });

  it("stdout is nothing but the JSON document — no warnings, no listing", () => {
    const result = runCli(["--json", "--cwd", DEAD_FIXTURE]);
    // Exactly one JSON.parse-able line (plus the trailing newline).
    expect(result.stdout.trim().split("\n").length).toBe(1);
    expect(() => JSON.parse(result.stdout)).not.toThrow();
  });
});

describe("unused CLI — zero production entrypoints", () => {
  it("warns on stderr and still exits 0, with schema-valid --json on stdout", () => {
    const result = runCli(["--json", "--cwd", NO_ENTRYPOINTS_FIXTURE]);
    expect(result.status).toBe(0);
    expect(result.stderr).toMatch(/no production entrypoints detected/);
    const parsed: unknown = JSON.parse(result.stdout);
    const validate = compileSchema();
    const valid = validate(parsed);
    expect(validate.errors, JSON.stringify(validate.errors)).toBeNull();
    expect(valid).toBe(true);
    expect((parsed as { claims: unknown[] }).claims).toEqual([]);
  });

  it("does NOT warn on a clean fixture that has a real entrypoint", () => {
    const result = runCli(["--json", "--cwd", CLEAN_FIXTURE]);
    expect(result.stderr).not.toMatch(/no production entrypoints detected/);
  });

  it("the default (TTY) report distinguishes zero-entrypoints from a genuinely clean run — stdout must not read as an all-clear (reviewer finding)", () => {
    const zeroEntrypoints = runCli(["--cwd", NO_ENTRYPOINTS_FIXTURE]);
    expect(zeroEntrypoints.status).toBe(0);
    expect(zeroEntrypoints.stdout).toContain(
      "no production entrypoints detected -- nothing was analysed for liveness; see stderr.",
    );
    expect(zeroEntrypoints.stdout).not.toContain("clean --");

    const genuinelyClean = runCli(["--cwd", CLEAN_FIXTURE]);
    expect(genuinelyClean.status).toBe(0);
    expect(genuinelyClean.stdout).toContain(
      "clean -- no unused exports, files, or dependencies found.",
    );
    expect(genuinelyClean.stdout).not.toMatch(/no production entrypoints detected/);
  });
});

describe("unused CLI — monorepo workspaces (T4.2)", () => {
  it("refuses a Yarn PnP project: exit 2 with the unsupported message surfaced", () => {
    const result = runCli(["--cwd", PNP_FIXTURE]);
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/Plug'n'Play is unsupported/);
    expect(result.stdout).toBe("");
  });

  it("analyzes a pnpm monorepo: schema-valid --json with per-package claims", () => {
    const result = runCli(["--json", "--cwd", WORKSPACE_FIXTURE]);
    expect(result.status).toBe(0);
    const parsed: unknown = JSON.parse(result.stdout);
    const validate = compileSchema();
    expect(validate(parsed), JSON.stringify(validate.errors)).toBe(true);
    const claims = (parsed as { claims: { subject: { loc: { package?: string } } }[] }).claims;
    expect(claims.length).toBeGreaterThan(0);
    // Every workspace claim is tagged with its owning package.
    expect(claims.every((c) => typeof c.subject.loc.package === "string")).toBe(true);
  });
});

describe("unused CLI — config (T4.3)", () => {
  it("auto-discovers unused.config.jsonc at the root: entry/project/ignore apply", () => {
    const result = runCli(["--json", "--cwd", CONFIG_BASIC_FIXTURE]);
    expect(result.status).toBe(0);
    const parsed: unknown = JSON.parse(result.stdout);
    const claims = (parsed as { claims: { subject: { name: string } }[] }).claims;
    expect(claims.map((c) => c.subject.name)).toEqual(["src/orphan.ts"]);
  });

  it("--config <path> selects a specific config file, overriding auto-discovery", () => {
    // custom-empty.jsonc has none of config-basic's entry/project/ignore
    // fields — with it selected instead of unused.config.jsonc, every file
    // in the fixture is in scope and none of the config-seeded chain exists,
    // so this run's claim set differs from the auto-discovered one above.
    const result = runCli([
      "--json",
      "--cwd",
      CONFIG_BASIC_FIXTURE,
      "--config",
      "custom-empty.jsonc",
    ]);
    expect(result.status).toBe(0);
    const parsed: unknown = JSON.parse(result.stdout);
    const claims = (parsed as { claims: { subject: { name: string } }[] }).claims;
    const names = claims.map((c) => c.subject.name);
    // scripts/outside.ts is out of scope under unused.config.jsonc's
    // "project" glob, but IS analyzed under the empty custom config.
    expect(names).toContain("scripts/outside.ts");
  });

  it("exits 3 with the field named when --config points at an invalid config file", () => {
    const result = runCli(["--cwd", CONFIG_BASIC_FIXTURE, "--config", "invalid.jsonc"]);
    expect(result.status).toBe(3);
    expect(result.stderr).toMatch(/bogusField/);
    expect(result.stdout).toBe("");
  });

  it("exits 3 when --config points at a file that doesn't exist", () => {
    const result = runCli(["--cwd", CONFIG_BASIC_FIXTURE, "--config", "does-not-exist.jsonc"]);
    expect(result.status).toBe(3);
    expect(result.stderr).toMatch(/does not exist/);
  });

  it("exits 3 when --config is missing its path argument", () => {
    const result = runCli(["--config"]);
    expect(result.status).toBe(3);
    expect(result.stderr).toMatch(/--config requires a path argument/);
  });
});

describe("unused CLI — default (TTY) report (T6.1, docs/design/cli-ux.md §2/§5)", () => {
  // spawnSync's stdout is always a pipe (never a real TTY), so every one of
  // these runs resolves to the "plain" layout (`cli/index.ts`'s
  // `resolveTtyInputs`) — the stable, grep-able, ASCII line grammar cli-ux
  // §5 requires for non-TTY stdout. The "wide"/"narrow" color layouts are
  // unit-tested directly against `reporters/tty.ts` (no pty available here).
  it("prints header, summary strip, a section, and the next-step footer, on a fixture with a finding", () => {
    const result = runCli(["--cwd", DEAD_FIXTURE]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("unused v0.1.0 -- fixture-basic-dead-export (2 files) -- ");
    expect(result.stdout).toContain("1 unused export, 0 unused files, 0 unused dependencies");
    expect(result.stdout).toContain(
      "unused  export  subtract  src/math.ts:6  high  0 inbound references to `subtract`",
    );
    expect(result.stdout).toContain(
      "next: `unused why subtract` | `unused --json` | docs: unused.dev",
    );
    expect(result.stdout).not.toContain("\x1b["); // no ANSI in plain layout
  });

  it("prints the clean-repo celebration on a fixture with zero findings, never an empty table", () => {
    const result = runCli(["--cwd", CLEAN_FIXTURE]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("clean -- no unused exports, files, or dependencies found.");
    expect(result.stdout).toContain("unused badge");
    expect(result.stdout).toContain("unused check");
    expect(result.stdout).not.toMatch(/UNUSED EXPORTS|UNUSED FILES|UNUSED DEPENDENCIES/);
  });
});

describe("unused CLI — zombie-tests CI-seconds line (T5.3)", () => {
  it("prints the TEST-ONLY section and the estimated-CI-seconds line when the run has a zombie test", () => {
    const result = runCli(["--cwd", ZOMBIE_TEST_FIXTURE]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("unused  export  deadHelper  src/util.ts:7  high");
    expect(result.stdout).toContain("TEST-ONLY (production-dead, kept alive by tests)");
    expect(result.stdout).toContain("test-only  file  src/feature.ts  src/feature.ts:1  high");
    expect(result.stdout).toContain(
      "test-only  test  test/feature.test.ts  test/feature.test.ts:1  high",
    );
    expect(result.stdout).toContain("1 zombie test -- ~5s CI per run (estimated).");
  });

  it("omits the TEST-ONLY section and zombie-tests line on a clean fixture (no test claims at all)", () => {
    const result = runCli(["--cwd", CLEAN_FIXTURE]);
    expect(result.status).toBe(0);
    expect(result.stdout).not.toMatch(/zombie test/);
    expect(result.stdout).not.toContain("TEST-ONLY");
  });

  it("omits the TEST-ONLY section and zombie-tests line on a fixture with findings but no zombie test claims", () => {
    const result = runCli(["--cwd", DEAD_FIXTURE]);
    expect(result.status).toBe(0);
    expect(result.stdout).not.toMatch(/zombie test/);
    expect(result.stdout).not.toContain("TEST-ONLY");
  });

  it("--json includes the zombieTests summary block, schema-valid", () => {
    const result = runCli(["--json", "--cwd", ZOMBIE_TEST_FIXTURE]);
    expect(result.status).toBe(0);
    const parsed: unknown = JSON.parse(result.stdout);
    const validate = compileSchema();
    expect(validate(parsed), JSON.stringify(validate.errors)).toBe(true);
    const summary = (
      parsed as {
        summary: {
          zombieTests?: {
            count: number;
            estCiSecondsPerRun: number;
            estimated: true;
            avgSecondsPerTestFile: number;
          };
        };
      }
    ).summary;
    expect(summary.zombieTests).toEqual({
      count: 1,
      estCiSecondsPerRun: 5,
      estimated: true,
      avgSecondsPerTestFile: 5,
    });
  });
});

describe("unused CLI — --help / -h (T6.1)", () => {
  it("--help prints the help text and exits 0 without touching the filesystem (no --cwd needed)", () => {
    const result = runCli(["--help"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("USAGE");
    expect(result.stdout).toContain("--filter <kind>");
    expect(result.stdout).toContain("docs: unused.dev");
    expect(result.stderr).toBe("");
  });

  it("-h is a synonym for --help", () => {
    const result = runCli(["-h"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("USAGE");
  });

  it("--help short-circuits even alongside an otherwise-invalid flag", () => {
    const result = runCli(["--bogus", "--help"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("USAGE");
  });
});

describe("unused CLI — --filter (T6.2, PRD §3)", () => {
  it("restricts the TTY report to the requested kind", () => {
    const result = runCli(["--cwd", ZOMBIE_TEST_FIXTURE, "--filter", "export"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("unused  export  deadHelper");
    expect(result.stdout).not.toContain("TEST-ONLY");
  });

  it("accepts a comma-separated list", () => {
    const result = runCli(["--cwd", ZOMBIE_TEST_FIXTURE, "--filter", "export,test"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("deadHelper");
    expect(result.stdout).toContain("test/feature.test.ts");
    expect(result.stdout).not.toContain("src/feature.ts:1"); // the test-only FILE claim, not requested
  });

  it("is repeatable across multiple occurrences (union, same as comma-separation)", () => {
    const result = runCli(["--cwd", ZOMBIE_TEST_FIXTURE, "--filter", "export", "--filter", "test"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("deadHelper");
    expect(result.stdout).toContain("test/feature.test.ts");
  });

  it("also filters --json output — the flag applies to every output surface (delegation-spec decision)", () => {
    const result = runCli(["--json", "--cwd", ZOMBIE_TEST_FIXTURE, "--filter", "export"]);
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout) as { claims: { subject: { kind: string } }[] };
    expect(parsed.claims.every((c) => c.subject.kind === "export")).toBe(true);
    expect(parsed.claims.length).toBeGreaterThan(0);
    const validate = compileSchema();
    expect(validate(parsed), JSON.stringify(validate.errors)).toBe(true);
  });

  it("exits 3 naming the flag and the bad value on an invalid --filter kind", () => {
    const result = runCli(["--filter", "bogus"]);
    expect(result.status).toBe(3);
    expect(result.stderr).toMatch(/invalid --filter value: "bogus"/);
    expect(result.stderr).toMatch(/export, file, dependency, endpoint, test/);
    expect(result.stdout).toBe("");
  });

  it("exits 3 when --filter is missing its argument", () => {
    const result = runCli(["--filter"]);
    expect(result.status).toBe(3);
    expect(result.stderr).toMatch(/--filter requires a kind argument/);
  });
});

describe("unused CLI — --min-confidence (T6.2, PRD §3)", () => {
  it("drops claims below the floor in the TTY report", () => {
    const all = runCli(["--cwd", MIXED_CONFIDENCE_FIXTURE]);
    expect(all.stdout).toMatch(/medium/);

    const highOnly = runCli(["--cwd", MIXED_CONFIDENCE_FIXTURE, "--min-confidence", "high"]);
    expect(highOnly.status).toBe(0);
    expect(highOnly.stdout).not.toMatch(/\bmedium\b/);
  });

  it("--min-confidence low shows low-confidence rows instead of summarising them (cli-ux §2 affordance)", () => {
    // string-computed-import has no `low`-confidence claims, so this proves
    // the flag's effect on the *summarisation* default rather than on
    // content: no "N low-confidence candidate(s) hidden" line appears once
    // the user asked for the floor explicitly, even though the underlying
    // set here is unchanged (medium is still the lowest confidence present).
    const result = runCli(["--cwd", MIXED_CONFIDENCE_FIXTURE, "--min-confidence", "low"]);
    expect(result.status).toBe(0);
    expect(result.stdout).not.toMatch(/low-confidence candidate/);
  });

  it("also filters --json output and recomputes summary.byConfidence to match", () => {
    const result = runCli([
      "--json",
      "--cwd",
      MIXED_CONFIDENCE_FIXTURE,
      "--min-confidence",
      "high",
    ]);
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout) as {
      claims: { confidence: string }[];
      summary: { byConfidence: { high: number; medium: number; low: number } };
    };
    expect(parsed.claims.every((c) => c.confidence === "high")).toBe(true);
    expect(parsed.summary.byConfidence.medium).toBe(0);
    expect(parsed.summary.byConfidence.low).toBe(0);
    const validate = compileSchema();
    expect(validate(parsed), JSON.stringify(validate.errors)).toBe(true);
  });

  it("exits 3 naming the flag and the bad value on an invalid --min-confidence level", () => {
    const result = runCli(["--min-confidence", "extreme"]);
    expect(result.status).toBe(3);
    expect(result.stderr).toMatch(/invalid --min-confidence value: "extreme"/);
    expect(result.stderr).toMatch(/high, medium, low/);
    expect(result.stdout).toBe("");
  });

  it("exits 3 when --min-confidence is missing its argument", () => {
    const result = runCli(["--min-confidence"]);
    expect(result.status).toBe(3);
    expect(result.stderr).toMatch(/--min-confidence requires a level argument/);
  });
});

describe("unused CLI — --show-suppressed (T6.1, PRD §4/§6)", () => {
  it("hides suppressed claims from the TTY listing by default but still counts them", () => {
    const result = runCli(["--cwd", SUPPRESSION_FIXTURE]);
    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain("withReason");
    expect(result.stdout).toContain("suppressed -- `unused --show-suppressed`");
  });

  it("--show-suppressed lists them, with the reason inline", () => {
    const result = runCli(["--cwd", SUPPRESSION_FIXTURE, "--show-suppressed"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("withReason");
    expect(result.stdout).toContain("[suppressed: migration pending]");
  });

  it("--json always includes suppressed claims, marked, regardless of --show-suppressed (never silently dropped)", () => {
    const result = runCli(["--json", "--cwd", SUPPRESSION_FIXTURE]);
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout) as {
      claims: { subject: { name: string }; suppression?: { reason: string } }[];
    };
    const withReason = parsed.claims.find((c) => c.subject.name === "withReason");
    expect(withReason?.suppression).toEqual({ reason: "migration pending" });
  });
});

describe("unused CLI — --all (T6.2, defeats top-10 truncation)", () => {
  it("does not affect a fixture with fewer than 10 claims per section (smoke: flag is accepted, output unaffected)", () => {
    const withAll = runCli(["--cwd", DEAD_FIXTURE, "--all"]);
    const without = runCli(["--cwd", DEAD_FIXTURE]);
    expect(withAll.status).toBe(0);
    expect(withAll.stdout).toBe(without.stdout);
  });
});

describe("unused CLI — --no-color / NO_COLOR (cli-ux §5)", () => {
  it("--no-color is accepted and produces the same plain output as the (already non-TTY) default", () => {
    const withFlag = runCli(["--cwd", DEAD_FIXTURE, "--no-color"]);
    const withoutFlag = runCli(["--cwd", DEAD_FIXTURE]);
    expect(withFlag.status).toBe(0);
    expect(withFlag.stdout).toBe(withoutFlag.stdout);
    expect(withFlag.stdout).not.toContain("\x1b[");
  });

  it("NO_COLOR env var is accepted the same way", () => {
    const result = spawnSync(process.execPath, [CLI_ENTRY, "--cwd", DEAD_FIXTURE], {
      encoding: "utf8",
      env: { ...process.env, NO_COLOR: "1" },
    });
    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain("\x1b[");
  });
});

describe("unused CLI — --sarif <file> (T6.3)", () => {
  it("writes a schema-valid SARIF 2.1.0 log to the given path, and still prints the TTY report to stdout", async () => {
    const { mkdtemp, readFile, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const dir = await mkdtemp(join(tmpdir(), "unused-sarif-"));
    const sarifPath = join(dir, "out.sarif");
    try {
      const result = runCli(["--cwd", DEAD_FIXTURE, "--sarif", sarifPath]);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("unused  export  subtract"); // TTY report still on stdout

      const sarif = JSON.parse(await readFile(sarifPath, "utf8"));
      expect(sarif.version).toBe("2.1.0");
      expect(sarif.runs[0].results[0].ruleId).toBe("unused/export");
      expect(sarif.runs[0].results[0].partialFingerprints["unusedClaimId/v1"]).toMatch(/^exp_/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("composes with --json: both the SARIF file and the JSON stdout are produced from the same filtered run", async () => {
    const { mkdtemp, readFile, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const dir = await mkdtemp(join(tmpdir(), "unused-sarif-"));
    const sarifPath = join(dir, "out.sarif");
    try {
      const result = runCli(["--json", "--cwd", DEAD_FIXTURE, "--sarif", sarifPath]);
      expect(result.status).toBe(0);
      const json = JSON.parse(result.stdout) as { claims: { id: string }[] };
      const sarif = JSON.parse(await readFile(sarifPath, "utf8"));
      expect(
        sarif.runs[0].results.map(
          (r: { partialFingerprints: Record<string, string> }) =>
            r.partialFingerprints["unusedClaimId/v1"],
        ),
      ).toEqual(json.claims.map((c) => c.id));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("exits 3 when --sarif is missing its file-path argument", () => {
    const result = runCli(["--sarif"]);
    expect(result.status).toBe(3);
    expect(result.stderr).toMatch(/--sarif requires a file path argument/);
  });

  it("exits 2 when the SARIF path cannot be written (parent directory does not exist)", () => {
    const result = runCli([
      "--cwd",
      DEAD_FIXTURE,
      "--sarif",
      join(REPO_ROOT, "does-not-exist-dir", "out.sarif"),
    ]);
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/could not write SARIF log/);
    expect(result.stdout).toBe("");
  });
});

// ---------------------------------------------------------------------------
// `unused baseline` / `unused check` (T7.1/T7.2, docs/phasing.md M7)
// ---------------------------------------------------------------------------

/** Read `.unused/baseline.jsonl`'s header line (first line), parsed. */
async function readBaselineHeader(
  dir: string,
  rel = ".unused/baseline.jsonl",
): Promise<Record<string, unknown>> {
  const raw = await readFile(join(dir, rel), "utf8");
  return JSON.parse(raw.split("\n")[0] as string);
}

/** Patch `.unused/baseline.jsonl`'s header line in place (simulates a stale baseline: analyzer upgraded, config changed, etc.). */
async function tamperBaselineHeader(
  dir: string,
  patch: Record<string, unknown>,
  rel = ".unused/baseline.jsonl",
): Promise<void> {
  const path = join(dir, rel);
  const raw = await readFile(path, "utf8");
  const lines = raw.split("\n");
  const header = JSON.parse(lines[0] as string) as Record<string, unknown>;
  lines[0] = JSON.stringify({ ...header, ...patch });
  await writeFile(path, lines.join("\n"));
}

describe("unused baseline (T7.1)", () => {
  it("writes .unused/baseline.jsonl (header + id-sorted claims) and prints a bless summary", async () => {
    await withTempFixtureCopy(DEAD_FIXTURE, async (dir) => {
      const result = runCli(["baseline", "--cwd", dir]);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("unused baseline: wrote 1 baseline file (1 claim blessed).");
      expect(result.stdout).toContain("root -- 1 claim (.unused/baseline.jsonl)");
      expect(result.stdout).toContain(
        "by kind: 1 export, 0 file, 0 dependency, 0 endpoint, 0 test",
      );
      expect(result.stdout).toContain("regenerated on main only");

      const raw = await readFile(join(dir, ".unused/baseline.jsonl"), "utf8");
      const lines = raw.trim().split("\n");
      expect(lines).toHaveLength(2); // header + 1 claim
      const header = JSON.parse(lines[0] as string);
      expect(header.analyzerVersion).toBe("0.1.0");
      expect(header.idVersion).toBe(1);
      expect(header.schemaVersion).toBe("1.1.0");
      expect(typeof header.configHash).toBe("string");
      expect(typeof header.generatedAt).toBe("string");
      const claim = JSON.parse(lines[1] as string);
      expect(claim.subject.name).toBe("subtract");
    });
  });

  it("monorepo: writes one file per unit (root + every member, excluding an excluded member) — T7.1 acceptance", async () => {
    await withTempFixtureCopy(WORKSPACE_FIXTURE, async (dir) => {
      const result = runCli(["baseline", "--cwd", dir]);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("wrote 4 baseline files (2 claims blessed).");
      expect(result.stdout).toContain("root -- 0 claims (.unused/baseline.jsonl)");
      expect(result.stdout).toContain(
        "packages/app -- 1 claim (packages/app/.unused/baseline.jsonl)",
      );
      expect(result.stdout).toContain(
        "packages/lib -- 1 claim (packages/lib/.unused/baseline.jsonl)",
      );
      expect(result.stdout).toContain(
        "packages/utils -- 0 claims (packages/utils/.unused/baseline.jsonl)",
      );

      for (const rel of [
        ".unused/baseline.jsonl",
        "packages/app/.unused/baseline.jsonl",
        "packages/lib/.unused/baseline.jsonl",
        "packages/utils/.unused/baseline.jsonl",
      ]) {
        const raw = await readFile(join(dir, rel), "utf8");
        expect(raw.trim().length).toBeGreaterThan(0); // at least the header line
      }
      // `packages/excluded` is removed by the workspace glob's negative pattern
      // (pnpm-workspace.yaml) — never a unit, so it never gets a baseline file.
      await expect(
        readFile(join(dir, "packages/excluded/.unused/baseline.jsonl"), "utf8"),
      ).rejects.toThrow();
    });
  });

  it("baseline claim lines are id-sorted (minimal-diff-churn contract)", async () => {
    await withTempFixtureCopy(WORKSPACE_FIXTURE, async (dir) => {
      const result = runCli(["baseline", "--cwd", dir]);
      expect(result.status).toBe(0);
      const raw = await readFile(join(dir, ".unused/baseline.jsonl"), "utf8");
      // root has zero claims here, so exercise a unit that has some instead.
      const rawLib = await readFile(join(dir, "packages/lib/.unused/baseline.jsonl"), "utf8");
      const idsRoot = raw
        .trim()
        .split("\n")
        .slice(1)
        .map((l) => JSON.parse(l).id);
      const idsLib = rawLib
        .trim()
        .split("\n")
        .slice(1)
        .map((l) => JSON.parse(l).id);
      expect(idsRoot).toEqual([...idsRoot].sort());
      expect(idsLib).toEqual([...idsLib].sort());
    });
  });

  it("--help / -h print the general help and exit 0 (no --cwd needed)", () => {
    for (const args of [
      ["baseline", "--help"],
      ["baseline", "-h"],
    ]) {
      const result = runCli(args);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("USAGE");
    }
  });
});

describe("unused check (T7.2)", () => {
  it("exits 3 with a 'run: unused baseline' pointer when no baseline exists", () => {
    const result = runCli(["check", "--cwd", DEAD_FIXTURE]);
    expect(result.status).toBe(3);
    expect(result.stderr).toMatch(/no baseline found/);
    expect(result.stderr).toMatch(/unused baseline/);
    expect(result.stdout).toBe("");
  });

  it("clean: no changes since baseline -> exit 0, '✓ no new dead weight'", async () => {
    await withTempFixtureCopy(DEAD_FIXTURE, async (dir) => {
      expect(runCli(["baseline", "--cwd", dir]).status).toBe(0);
      const check = runCli(["check", "--cwd", dir]);
      expect(check.status).toBe(0);
      expect(check.stdout).toContain("PASS no new dead weight since baseline -- exit 0");
      expect(check.stdout).toMatch(/^baseline: \d{4}-\d{2}-\d{2} \(1 claim, analyzer 0\.1\.0\)/);
    });
  });

  it("new claim on branch -> exit 1, prints the new claim, remediation, and the verdict line", async () => {
    await withTempFixtureCopy(DEAD_FIXTURE, async (dir) => {
      expect(runCli(["baseline", "--cwd", dir]).status).toBe(0);

      const mathPath = join(dir, "src/math.ts");
      const original = await readFile(mathPath, "utf8");
      await writeFile(
        mathPath,
        `${original}\nexport function divide(a: number, b: number): number {\n  return a / b;\n}\n`,
      );

      const check = runCli(["check", "--cwd", dir]);
      expect(check.status).toBe(1);
      expect(check.stdout).toContain("unused  export  divide  src/math.ts");
      expect(check.stdout).toContain("remediation:");
      expect(check.stdout).toContain("unused:ignore <reason>");
      expect(check.stdout).toContain("re-baseline on main");
      expect(check.stdout).toContain("FAIL 1 new high-confidence claim since baseline");
      expect(check.stdout).toMatch(/exit 1$/m);
    });
  });

  it("suppressed new claim does NOT gate the build (suppression is the escape hatch)", async () => {
    await withTempFixtureCopy(DEAD_FIXTURE, async (dir) => {
      expect(runCli(["baseline", "--cwd", dir]).status).toBe(0);

      const mathPath = join(dir, "src/math.ts");
      const original = await readFile(mathPath, "utf8");
      await writeFile(
        mathPath,
        `${original}\n/* unused:ignore migration pending */\nexport function scratchFn(): void {\n  console.log("scratch");\n}\n`,
      );

      const check = runCli(["check", "--cwd", dir]);
      expect(check.status).toBe(0);
      expect(check.stdout).toContain("suppressed, not gated");
      expect(check.stdout).toContain("scratchFn");
      expect(check.stdout).toContain("PASS no new dead weight since baseline -- exit 0");
    });
  });

  it("a REASONLESS suppression (/* unused:ignore */, no reason) does NOT escape the gate — it gates like an unsuppressed claim (reviewer finding)", async () => {
    await withTempFixtureCopy(DEAD_FIXTURE, async (dir) => {
      expect(runCli(["baseline", "--cwd", dir]).status).toBe(0);

      const mathPath = join(dir, "src/math.ts");
      const original = await readFile(mathPath, "utf8");
      await writeFile(
        mathPath,
        `${original}\n/* unused:ignore */\nexport function scratchFn(): void {\n  console.log("scratch");\n}\n`,
      );

      const check = runCli(["check", "--cwd", dir]);
      expect(check.status).toBe(1);
      expect(check.stdout).toContain("unused  export  scratchFn");
      expect(check.stdout).not.toContain("suppressed, not gated");
      expect(check.stdout).toContain("FAIL 1 new high-confidence claim since baseline");
    });
  });

  it("rename reads as one resolved claim plus one new claim (ADR 0006 documented behaviour)", async () => {
    await withTempFixtureCopy(DEAD_FIXTURE, async (dir) => {
      expect(runCli(["baseline", "--cwd", dir]).status).toBe(0);

      const mathPath = join(dir, "src/math.ts");
      const original = await readFile(mathPath, "utf8");
      await writeFile(mathPath, original.replace(/subtract/g, "subtractNumbers"));

      const check = runCli(["check", "--cwd", dir]);
      expect(check.status).toBe(1);
      expect(check.stdout).toContain("subtractNumbers");
      expect(check.stdout).toContain("1 claim resolved since baseline.");
      expect(check.stdout).toContain("FAIL 1 new high-confidence claim since baseline");
    });
  });

  it("monorepo: per-workspace baselines are read and diffed together — clean run exits 0", async () => {
    await withTempFixtureCopy(WORKSPACE_FIXTURE, async (dir) => {
      expect(runCli(["baseline", "--cwd", dir]).status).toBe(0);
      const check = runCli(["check", "--cwd", dir]);
      expect(check.status).toBe(0);
      expect(check.stdout).toContain("PASS no new dead weight since baseline -- exit 0");
      expect(check.stdout).toMatch(/\(2 claims, analyzer 0\.1\.0\)/); // total across every workspace's baseline
    });
  });

  it("gate.threshold (config): a new medium-confidence claim gates only once the threshold is lowered to medium", async () => {
    await withTempFixtureCopy(MIXED_CONFIDENCE_FIXTURE, async (dir) => {
      expect(runCli(["baseline", "--cwd", dir]).status).toBe(0);

      // Under the SAME computed-import hazard as the fixture's existing
      // mods/alpha.ts and mods/beta.ts (both medium) — a new file here is a
      // genuinely new medium-confidence claim, not high.
      await writeFile(
        join(dir, "src/mods/gamma.ts"),
        'export function gammaFn(): void {\n  console.log("gamma");\n}\n',
      );

      const defaultThreshold = runCli(["check", "--cwd", dir]);
      expect(defaultThreshold.status).toBe(0); // default gate is high; the new claim is medium

      await writeFile(
        join(dir, "unused.config.jsonc"),
        JSON.stringify({ gate: { threshold: "medium" } }),
      );
      const mediumThreshold = runCli(["check", "--cwd", dir]);
      expect(mediumThreshold.status).toBe(1);
      expect(mediumThreshold.stdout).toContain("gamma.ts");
      expect(mediumThreshold.stdout).toContain(
        "1 new medium-confidence-or-above claim since baseline",
      );
    });
  });

  it("--min-confidence is rejected: the gate is controlled by config gate.threshold only (T7.2, documented)", () => {
    const result = runCli(["check", "--min-confidence", "medium"]);
    expect(result.status).toBe(3);
    expect(result.stderr).toMatch(/does not take --min-confidence/);
    expect(result.stderr).toMatch(/gate\.threshold/);
  });

  it("analyzerVersion-only mismatch (idVersion/schema unchanged) warns but still evaluates the gate normally (PRD §4 graceful degrade)", async () => {
    await withTempFixtureCopy(DEAD_FIXTURE, async (dir) => {
      expect(runCli(["baseline", "--cwd", dir]).status).toBe(0);
      const before = await readBaselineHeader(dir);
      await tamperBaselineHeader(dir, { analyzerVersion: "9.9.9" });

      const check = runCli(["check", "--cwd", dir]);
      expect(check.status).toBe(0); // zero NEW claims -> a genuinely-evaluated pass, not a skip
      expect(check.stdout).toMatch(/different conditions than this run/);
      expect(check.stdout).toContain(
        `analyzer version: baseline 9.9.9, current ${before["analyzerVersion"]}`,
      );
      expect(check.stdout).toContain("re-baseline");
      expect(check.stdout).toContain("PASS no new dead weight since baseline -- exit 0");
      expect(check.stdout).not.toContain("gate not evaluated");
    });
  });

  it("configHash mismatch (config changed underneath the baseline) warns but still evaluates the gate normally", async () => {
    await withTempFixtureCopy(DEAD_FIXTURE, async (dir) => {
      expect(runCli(["baseline", "--cwd", dir]).status).toBe(0);
      await tamperBaselineHeader(dir, { configHash: "0000deadbeef" });

      const check = runCli(["check", "--cwd", dir]);
      expect(check.status).toBe(0);
      expect(check.stdout).toContain("config: changed since baseline (configHash differs)");
      expect(check.stdout).toContain("PASS no new dead weight since baseline -- exit 0");
      expect(check.stdout).not.toContain("gate not evaluated");
    });
  });

  it("schemaVersion MINOR-only mismatch (e.g. 1.1.0 -> 1.2.0) still evaluates the gate — only a MAJOR change makes ids incomparable (ADR 0006)", async () => {
    await withTempFixtureCopy(DEAD_FIXTURE, async (dir) => {
      expect(runCli(["baseline", "--cwd", dir]).status).toBe(0);
      await tamperBaselineHeader(dir, { schemaVersion: "1.2.0" });

      const check = runCli(["check", "--cwd", dir]);
      expect(check.status).toBe(0);
      expect(check.stdout).toContain("schema version: baseline 1.2.0, current 1.1.0");
      expect(check.stdout).toContain("PASS no new dead weight since baseline -- exit 0");
      expect(check.stdout).not.toContain("gate not evaluated");
    });
  });

  it("idVersion mismatch skips the gate entirely (exit 0, 'gate not evaluated') even when a genuinely new claim exists — never paints the repo as failing (PRD §4, reviewer fix)", async () => {
    await withTempFixtureCopy(DEAD_FIXTURE, async (dir) => {
      expect(runCli(["baseline", "--cwd", dir]).status).toBe(0);
      await tamperBaselineHeader(dir, { idVersion: 99 });

      // A real new claim: under a matching idVersion this alone would fail
      // the gate (exit 1, see the "new claim on branch" test above). Under
      // an idVersion mismatch it must NOT — the ids aren't comparable, so
      // this would otherwise be a false "everything is new" avalanche.
      const mathPath = join(dir, "src/math.ts");
      const original = await readFile(mathPath, "utf8");
      await writeFile(
        mathPath,
        `${original}\nexport function divide(a: number, b: number): number {\n  return a / b;\n}\n`,
      );

      const check = runCli(["check", "--cwd", dir]);
      expect(check.status).toBe(0);
      expect(check.stdout).toContain("claim id recipe (idVersion): baseline 99, current 1");
      expect(check.stdout).toMatch(/gate not evaluated.*re-baseline required.*exit 0/);
      expect(check.stdout).not.toContain("divide"); // no NEW-claim list is rendered in this state
      expect(check.stdout).not.toContain("PASS no new dead weight");
      expect(check.stdout).not.toContain("FAIL");
    });
  });

  it("schemaVersion MAJOR mismatch (e.g. 1.1.0 -> 2.0.0) also skips the gate (ADR 0006: only MAJOR can change claim shape/identity)", async () => {
    await withTempFixtureCopy(DEAD_FIXTURE, async (dir) => {
      expect(runCli(["baseline", "--cwd", dir]).status).toBe(0);
      await tamperBaselineHeader(dir, { schemaVersion: "2.0.0" });

      const mathPath = join(dir, "src/math.ts");
      const original = await readFile(mathPath, "utf8");
      await writeFile(
        mathPath,
        `${original}\nexport function divide(a: number, b: number): number {\n  return a / b;\n}\n`,
      );

      const check = runCli(["check", "--cwd", dir]);
      expect(check.status).toBe(0);
      expect(check.stdout).toContain("schema version: baseline 2.0.0, current 1.1.0");
      expect(check.stdout).toMatch(/gate not evaluated.*re-baseline required.*exit 0/);
    });
  });

  it("--help / -h print the general help and exit 0", () => {
    for (const args of [
      ["check", "--help"],
      ["check", "-h"],
    ]) {
      const result = runCli(args);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("USAGE");
    }
  });
});

describe("unused CLI — why (T8.2, cli-ux §4)", () => {
  const REEXPORT_FIXTURE = join(FIXTURES_ROOT, "re-export-chain");

  it("renders the alive path through a re-export chain (exit 0)", () => {
    const result = runCli(["why", "usedThing", "--cwd", REEXPORT_FIXTURE]);
    expect(result.status).toBe(0);
    expect(result.stdout).toMatchInlineSnapshot(`
      "src/lib/usedThing.ts:1 usedThing -- alive

        reachable from a production entrypoint:
          src/index.ts (production entrypoint) -> src/barrel.ts:2 usedThing -> src/lib/usedThing.ts:1 usedThing
      "
    `);
  });

  it("explains a dead export with verdict, confidence, and evidence (exit 0)", () => {
    const result = runCli(["why", "subtract", "--cwd", DEAD_FIXTURE]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("subtract -- unused (confidence: high)");
    expect(result.stdout).toContain("evidence:");
    expect(result.stdout).toContain("0 inbound references");
    expect(result.stdout).toContain("hazards checked near this subject: none");
  });

  it("flags a test-only subject with the tier-2 note (exit 0)", () => {
    const result = runCli(["why", "src/feature.ts", "--cwd", ZOMBIE_TEST_FIXTURE]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("test-only (production-dead, kept alive by tests)");
    expect(result.stdout).toContain("(test entrypoint)");
    expect(result.stdout).toContain("tier-2:");
  });

  it("exits 3 with a fix hint on a nonexistent name (stdout clean)", () => {
    const result = runCli(["why", "noSuchSymbol", "--cwd", DEAD_FIXTURE]);
    expect(result.status).toBe(3);
    expect(result.stderr).toMatch(/no symbol or file matching "noSuchSymbol" found/);
    expect(result.stdout).toBe("");
  });

  it("exits 3 when no subject is given", () => {
    const result = runCli(["why", "--cwd", DEAD_FIXTURE]);
    expect(result.status).toBe(3);
    expect(result.stderr).toMatch(/why requires a symbol or file argument/);
  });

  it("exits 2 on a nonexistent --cwd", () => {
    const result = runCli(["why", "add", "--cwd", join(REPO_ROOT, "does-not-exist-anywhere")]);
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/cannot read directory/);
  });

  it("why --help prints the general help documenting `unused why`", () => {
    const result = runCli(["why", "--help"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("USAGE");
    expect(result.stdout).toContain("unused why");
  });
});

describe("unused CLI — mcp (T8.3)", () => {
  it("mcp --help prints the general help documenting `unused mcp`", () => {
    const result = runCli(["mcp", "--help"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("unused mcp");
    expect(result.stdout).toContain("find_unused, why_alive, usage_evidence");
  });
});

describe("unused report (T9.3, docs/design/report-and-badge.md §1)", () => {
  it("defaults to Markdown, writing .unused/report.md and printing a confirmation", async () => {
    await withTempFixtureCopy(DEAD_FIXTURE, async (dir) => {
      const result = runCli(["report", "--cwd", dir]);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("unused report: wrote");
      expect(result.stdout).toContain(".unused/report.md");
      expect(result.stdout).toContain("review before sharing outside your team");

      const content = await readFile(join(dir, ".unused/report.md"), "utf8");
      expect(content).toContain("# unused deletion report");
      expect(content).toContain("subtract"); // the fixture's one dead export
      expect(content).toContain("docs/generated/assumption-set.md");
    });
  });

  it("--html writes .unused/report.html — self-contained, no external assets", async () => {
    await withTempFixtureCopy(DEAD_FIXTURE, async (dir) => {
      const result = runCli(["report", "--html", "--cwd", dir]);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain(".unused/report.html");

      const content = await readFile(join(dir, ".unused/report.html"), "utf8");
      expect(content.startsWith("<!doctype html>")).toBe(true);
      expect(content).toContain("<style>");
      expect(content).not.toMatch(/<link\b/);
      expect(content).not.toMatch(/<script\b/);
    });
  });

  it("exits 3 when --md and --html are both given", () => {
    const result = runCli(["report", "--md", "--html", "--cwd", DEAD_FIXTURE]);
    expect(result.status).toBe(3);
    expect(result.stderr).toMatch(/mutually exclusive/);
  });

  it("report --help prints the general help documenting `unused report`", () => {
    const result = runCli(["report", "--help"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("unused report");
    expect(result.stdout).toContain("--md");
    expect(result.stdout).toContain("--html");
  });

  it("exits 2 on a nonexistent --cwd", () => {
    const result = runCli(["report", "--cwd", join(REPO_ROOT, "does-not-exist-anywhere")]);
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/cannot read directory/);
  });
});

describe("unused badge (T9.3, docs/design/report-and-badge.md §2)", () => {
  it("writes .unused/badge.json ('N claims', blue) on a fixture with a high-confidence claim", async () => {
    await withTempFixtureCopy(DEAD_FIXTURE, async (dir) => {
      const result = runCli(["badge", "--cwd", dir]);
      expect(result.status).toBe(0);
      expect(result.stdout).toBe(
        `unused badge: wrote ${join(dir, ".unused/badge.json")} (1 claim).\n`,
      );

      const badge = JSON.parse(await readFile(join(dir, ".unused/badge.json"), "utf8"));
      expect(badge).toEqual({
        schemaVersion: 1,
        label: "unused",
        message: "1 claim",
        color: "blue",
      });
    });
  });

  it("writes 'clean', green on a fixture with zero unused claims", async () => {
    await withTempFixtureCopy(CLEAN_FIXTURE, async (dir) => {
      const result = runCli(["badge", "--cwd", dir]);
      expect(result.status).toBe(0);
      const badge = JSON.parse(await readFile(join(dir, ".unused/badge.json"), "utf8"));
      expect(badge).toEqual({
        schemaVersion: 1,
        label: "unused",
        message: "clean",
        color: "green",
      });
    });
  });

  it("a mixed-confidence fixture (1 high + 2 medium, fixtures/ts/string-computed-import) counts only the high claim", async () => {
    await withTempFixtureCopy(MIXED_CONFIDENCE_FIXTURE, async (dir) => {
      const result = runCli(["badge", "--cwd", dir]);
      expect(result.status).toBe(0);
      const badge = JSON.parse(await readFile(join(dir, ".unused/badge.json"), "utf8"));
      expect(badge).toEqual({
        schemaVersion: 1,
        label: "unused",
        message: "1 claim",
        color: "blue",
      });
    });
  });

  it("badge --help prints the general help documenting `unused badge`", () => {
    const result = runCli(["badge", "--help"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("unused badge");
    expect(result.stdout).toContain(".unused/badge.json");
  });

  it("exits 2 on a nonexistent --cwd", () => {
    const result = runCli(["badge", "--cwd", join(REPO_ROOT, "does-not-exist-anywhere")]);
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/cannot read directory/);
  });
});
