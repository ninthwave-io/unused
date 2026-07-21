import { describe, expect, it } from "vitest";
import { renderHelp } from "./help.js";

describe("renderHelp", () => {
  const text = renderHelp();

  it("documents every implemented flag", () => {
    for (const flag of [
      "--json",
      "--sarif <file>",
      "--filter <kind>",
      "--min-confidence <level>",
      "--all",
      "--show-suppressed",
      "--no-color",
      "--performance",
      "--config <path>",
      "--cwd <dir>",
      "--help, -h",
    ]) {
      expect(text).toContain(flag);
    }
  });

  it("documents the stable exit-code contract, including check's gate failure (T7.2)", () => {
    expect(text).toMatch(/\b0\b.*success/);
    expect(text).toMatch(/\b1\b.*gate failure/);
    expect(text).toMatch(/\b2\b.*analysis error/);
    expect(text).toMatch(/\b3\b.*usage error/);
  });

  it("documents check/baseline/why/mcp/report/badge as real commands (T7.1/T7.2/T8.2/T8.3/T9.3)", () => {
    for (const cmd of [
      "unused check",
      "unused baseline",
      "unused why",
      "unused mcp",
      "unused report",
      "unused badge",
    ]) {
      expect(text).toContain(cmd);
    }
    expect(text).toMatch(/^ {2}unused check\b/m);
    expect(text).toMatch(/^ {2}unused baseline\b/m);
    expect(text).toMatch(/^ {2}unused why\b/m);
    expect(text).toMatch(/^ {2}unused mcp\b/m);
    expect(text).toMatch(/^ {2}unused report\b/m);
    expect(text).toMatch(/^ {2}unused badge\b/m);
  });

  it("documents --md/--html on `unused report` and the .unused/ artifact paths", () => {
    expect(text).toContain("--md");
    expect(text).toContain("--html");
    expect(text).toContain(".unused/report.md");
    expect(text).toContain(".unused/report.html");
    expect(text).toContain(".unused/badge.json");
  });

  it("includes at least one runnable example for every documented flag/command category", () => {
    expect(text).toContain("unused --json > report.json");
    expect(text).toContain("unused --sarif unused.sarif");
    expect(text).toContain("unused --filter export --min-confidence high");
    expect(text).toContain("unused baseline");
    expect(text).toContain("unused check");
    expect(text).toContain("unused report --html");
    expect(text).toContain("unused badge");
  });

  it("ends with the docs pointer", () => {
    expect(text.trim().endsWith("docs: unused.dev")).toBe(true);
  });
});
