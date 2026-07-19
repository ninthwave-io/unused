/**
 * Unit tests for the tracer output parser and refusal contract (ADR 0011).
 * These run WITHOUT an Elixir toolchain — they exercise `parseTraceOutput` over
 * synthetic JSON-lines, so the frontend's parsing/refusal logic is covered in
 * the TS-only CI job. End-to-end tracer runs are gated in `gates.elixir.test.ts`.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { ElixirCompileError, ElixirToolchainError, parseTraceOutput, runTracer } from "./runner.js";

/** A minimal well-formed trace: one module, one function, compile ok. */
const OK_LINES = [
  JSON.stringify({ k: "meta", compile_ok: true }),
  JSON.stringify({ k: "app_mod", mod: "App.Application" }),
  JSON.stringify({ k: "deps", names: ["phoenix", "ecto"] }),
  JSON.stringify({
    k: "module",
    mod: "App.Core",
    file: "lib/app/core.ex",
    line: 1,
    behaviours: [],
    protocol: false,
    impl: false,
    partition: "prod",
  }),
  JSON.stringify({
    k: "function",
    mod: "App.Core",
    name: "greet",
    arity: 1,
    file: "lib/app/core.ex",
    line: 2,
    partition: "prod",
  }),
  JSON.stringify({
    k: "event",
    kind: "remote",
    file: "lib/app/application.ex",
    line: 5,
    from_mod: "App.Application",
    from_fun: "start/2",
    to_mod: "App.Core",
    name: "greet",
    arity: 1,
    dyn: false,
    partition: "prod",
  }),
].join("\n");

describe("parseTraceOutput", () => {
  it("parses events, modules, functions, app callback and deps", () => {
    const result = parseTraceOutput(OK_LINES);
    expect(result.appMod).toBe("App.Application");
    expect(result.deps).toEqual(["phoenix", "ecto"]);
    expect(result.modules).toHaveLength(1);
    expect(result.functions).toHaveLength(1);
    expect(result.events).toHaveLength(1);
    expect(result.events[0]?.to_mod).toBe("App.Core");
    expect(result.compileOk).toBe(true);
  });

  it("ignores blank and non-JSON noise lines", () => {
    const withNoise = `${OK_LINES}\n\n  \nwarning: leaked stderr line\n`;
    const result = parseTraceOutput(withNoise);
    expect(result.modules).toHaveLength(1);
  });

  it("refuses (throws) when the tracer reported a compile error", () => {
    const lines = [
      JSON.stringify({ k: "compile_error", count: 3 }),
      JSON.stringify({ k: "meta", compile_ok: false }),
    ].join("\n");
    expect(() => parseTraceOutput(lines)).toThrow(ElixirCompileError);
  });

  it("refuses when compile_ok is false even without an explicit compile_error record", () => {
    const lines = JSON.stringify({ k: "meta", compile_ok: false });
    expect(() => parseTraceOutput(lines)).toThrow(ElixirCompileError);
  });

  it("refuses when no modules were found (empty output)", () => {
    const lines = JSON.stringify({ k: "meta", compile_ok: true });
    expect(() => parseTraceOutput(lines)).toThrow(/no compiled modules/);
  });
});

describe("runTracer — toolchain-absent refusal", () => {
  const tmpDirs: string[] = [];
  afterAll(() => {
    for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
  });

  it("throws ElixirToolchainError (ENOENT) when the build tool is not found", () => {
    const dir = mkdtempSync(join(tmpdir(), "unused-ex-runner-"));
    tmpDirs.push(dir);
    writeFileSync(join(dir, "mix.exs"), "defmodule X.MixProject do\nend\n");
    // A command that cannot exist forces the ENOENT path deterministically,
    // without depending on whether `mix` is installed in the test environment.
    expect(() => runTracer(dir, { command: "unused-no-such-build-tool-xyz" })).toThrow(
      ElixirToolchainError,
    );
    expect(() => runTracer(dir, { command: "unused-no-such-build-tool-xyz" })).toThrow(
      /was not found on PATH/,
    );
  });
});

describe("parseTraceOutput — test partition tag", () => {
  it("carries the test partition tag through", () => {
    const lines = [
      OK_LINES,
      JSON.stringify({
        k: "module",
        mod: "App.CoreTest",
        file: "test/core_test.exs",
        line: 1,
        behaviours: [],
        protocol: false,
        impl: false,
        partition: "test",
      }),
    ].join("\n");
    const result = parseTraceOutput(lines);
    const testMod = result.modules.find((m) => m.partition === "test");
    expect(testMod?.mod).toBe("App.CoreTest");
  });
});
