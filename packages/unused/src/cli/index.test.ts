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

describe("unused CLI — default (non-JSON) listing", () => {
  it("prints one line per claim plus a one-line summary, on a fixture with a finding", () => {
    const result = runCli(["--cwd", DEAD_FIXTURE]);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(
      "unused  export  subtract  src/math.ts:6  high\n1 claim (high: 1, medium: 0, low: 0).\n",
    );
  });

  it("prints just the summary line on a clean fixture", () => {
    const result = runCli(["--cwd", CLEAN_FIXTURE]);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("0 claims.\n");
  });
});
