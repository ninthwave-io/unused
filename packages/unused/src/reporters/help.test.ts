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
      "--config <path>",
      "--cwd <dir>",
      "--help, -h",
    ]) {
      expect(text).toContain(flag);
    }
  });

  it("documents the stable exit-code contract without claiming exit 1 is emitted by this build", () => {
    expect(text).toMatch(/\b0\b.*success/);
    expect(text).toMatch(/\b2\b.*analysis error/);
    expect(text).toMatch(/\b3\b.*usage error/);
    expect(text).toMatch(/1 is reserved/);
  });

  it("does not document unimplemented subcommands as runnable examples (baseline/why/mcp/report/badge, and `unused check` beyond the exit-code footnote)", () => {
    for (const cmd of [
      "unused baseline",
      "unused why",
      "unused mcp",
      "unused report",
      "unused badge",
    ]) {
      expect(text).not.toContain(cmd);
    }
    // "unused check" appears exactly once, in the exit-code footnote
    // explaining why exit 1 is reserved but never emitted — never as an
    // indented, runnable EXAMPLES-style invocation.
    expect(text.match(/unused check/g)?.length).toBe(1);
    expect(text).not.toMatch(/^ {2}unused check\b/m);
  });

  it("includes at least one runnable example for every documented flag category", () => {
    expect(text).toContain("unused --json > report.json");
    expect(text).toContain("unused --sarif unused.sarif");
    expect(text).toContain("unused --filter export --min-confidence high");
  });

  it("ends with the docs pointer", () => {
    expect(text.trim().endsWith("docs: unused.dev")).toBe(true);
  });
});
