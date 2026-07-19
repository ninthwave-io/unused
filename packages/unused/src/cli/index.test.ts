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
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv2020 } from "ajv/dist/2020.js";
import type { FormatsPlugin } from "ajv-formats";
import { beforeAll, describe, expect, it } from "vitest";

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

beforeAll(() => {
  execFileSync(TSC_BIN, ["-p", join(PACKAGE_ROOT, "tsconfig.json")], {
    cwd: REPO_ROOT,
    stdio: "inherit",
  });
}, 120_000);

describe("unused CLI — shebang + executability", () => {
  it("dist/cli/index.js starts with the node shebang", () => {
    const firstLine = readFileSync(CLI_ENTRY, "utf8").split("\n")[0];
    expect(firstLine).toBe("#!/usr/bin/env node");
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
