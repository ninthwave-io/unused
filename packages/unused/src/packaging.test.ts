/**
 * Packaging metadata tests (T9.1, docs/phasing.md M9; ADR 0008). These guard
 * the parts of `npm pack`'s output that a runtime test can't reach directly:
 * `packages/unused/LICENSE` and `packages/unused/README.md` are checked-in
 * *copies* of the repo-root files (npm only ships files from the publishing
 * package's own directory, and the repo root isn't inside `packages/unused`
 * — see both files' neighbouring docstrings/comments), so nothing enforces
 * they stay identical except this test. `package.json`'s `files`/`exports`/
 * `engines`/metadata fields are asserted directly rather than re-derived,
 * so a future edit that silently drops one is a red CI run, not a shipped
 * regression discovered on the npm page.
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(HERE, "..");
const REPO_ROOT = resolve(PACKAGE_ROOT, "../..");

function read(path: string): string {
  return readFileSync(path, "utf8");
}

describe("packaging — LICENSE/README stay in sync with the repo root", () => {
  it("packages/unused/LICENSE is byte-identical to the repo-root LICENSE", () => {
    expect(read(join(PACKAGE_ROOT, "LICENSE"))).toBe(read(join(REPO_ROOT, "LICENSE")));
  });

  it("packages/unused/README.md is byte-identical to the repo-root README.md (the npm-displayed README)", () => {
    expect(read(join(PACKAGE_ROOT, "README.md"))).toBe(read(join(REPO_ROOT, "README.md")));
  });
});

interface PackageJson {
  readonly name: string;
  readonly engines?: { readonly node?: string };
  readonly homepage?: string;
  readonly repository?: { readonly url?: string };
  readonly keywords?: readonly string[];
  readonly bin?: Record<string, string>;
  readonly exports?: Record<string, unknown>;
  readonly files?: readonly string[];
  readonly scripts?: Record<string, string>;
  readonly dependencies?: Record<string, string>;
}

describe("packaging — package.json metadata (T9.1 acceptance)", () => {
  const pkg = JSON.parse(read(join(PACKAGE_ROOT, "package.json"))) as PackageJson;

  it("declares the Node >=22 engines floor (ADR 0008)", () => {
    expect(pkg.engines?.node).toBe(">=22");
  });

  it("names the ninthwave-io GitHub org and unused.dev (ADR 0008/T9.1)", () => {
    expect(pkg.homepage).toBe("https://unused.dev");
    expect(pkg.repository?.url).toContain("github.com/ninthwave-io/unused");
  });

  it("has non-empty keywords for npm discoverability", () => {
    expect(pkg.keywords?.length).toBeGreaterThan(0);
    expect(pkg.keywords).toContain("dead-code");
  });

  it("points bin `unused` at the compiled CLI entry", () => {
    expect(pkg.bin?.["unused"]).toBe("./dist/cli/index.js");
  });

  it("exposes a programmatic `.` export pointing at dist/index", () => {
    const exp = pkg.exports?.["."] as { types?: string; default?: string } | undefined;
    expect(exp?.default).toBe("./dist/index.js");
    expect(exp?.types).toBe("./dist/index.d.ts");
  });

  it("files allowlist excludes test output and includes schemas/README/LICENSE", () => {
    const files = pkg.files ?? [];
    expect(files).toContain("dist");
    expect(files).toContain("schemas");
    expect(files).toContain("README.md");
    expect(files).toContain("LICENSE");
    expect(files.some((f) => f.includes("*.test."))).toBe(true);
  });

  it("prepublishOnly runs build + ci (T9.1)", () => {
    const script = pkg.scripts?.["prepublishOnly"] ?? "";
    expect(script).toMatch(/\brun build\b/);
    expect(script).toMatch(/\brun ci\b/);
  });

  it("ships the YAML parser used by Task and workflow discovery as a runtime dependency", () => {
    expect(pkg.dependencies?.["yaml"]).toMatch(/^\^?2\./);
  });
});
