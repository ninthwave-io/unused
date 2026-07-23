/**
 * Unit tests for the tracer output parser and refusal contract (ADR 0011).
 * These run WITHOUT an Elixir toolchain — they exercise `parseTraceOutput` over
 * synthetic JSON-lines, so the frontend's parsing/refusal logic is covered in
 * the TS-only CI job. End-to-end tracer runs are gated in `gates.elixir.test.ts`.
 */

import fs, {
  appendFileSync,
  mkdtempSync,
  renameSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  readBoundedTraceLines,
  resolveTestOnlyRoots,
  type TestInventory,
} from "./mix-isolation.js";
import {
  ElixirCompileError,
  ElixirToolchainError,
  mergeTraceResults,
  parseTestTraceOutput,
  parseTraceOutput,
  runTracer,
} from "./runner.js";
import {
  stableTraceResult,
  validateProductionTraceOwnership,
  validateTestTraceOwnership,
} from "./trace-merge.js";

function ownerLine(mod: string, file: string, partition: "prod" | "test" = "prod"): string {
  return JSON.stringify({ k: "owner", mod, file, partition });
}

function incompleteStructureLine(file: string, partition: "prod" | "test" = "prod"): string {
  return JSON.stringify({
    k: "structure_file",
    file,
    partition,
    digest: "0".repeat(64),
    bytes: 0,
    status: "incomplete",
    reason: "parse",
    ast_nodes: 0,
    max_depth: 0,
    carriers: [],
    facts: [],
  });
}

function structuralSummaryLine(
  partition: "prod" | "test",
  files = 0,
  incompleteFiles = 0,
  events = 0,
): string {
  return JSON.stringify({
    k: "structure_summary",
    partition,
    events,
    elapsed_us: 0,
    event_index_us: 0,
    file_extraction_us: 0,
    emit_us: 0,
    files,
    complete_files: files - incompleteFiles,
    incomplete_files: incompleteFiles,
    bytes: 0,
    ast_nodes: 0,
    max_depth: 0,
    carriers: 0,
    facts: 0,
    exact_facts: 0,
    opaque_facts: 0,
    roles: {},
  });
}

/** A minimal well-formed trace: one module, one function, compile ok. */
const OK_LINES = [
  JSON.stringify({ k: "phase", protocol: 2, phase: "production", status: "started" }),
  JSON.stringify({ k: "meta", compile_ok: true }),
  JSON.stringify({ k: "app_mod", mod: "App.Application" }),
  JSON.stringify({ k: "deps", names: ["phoenix", "ecto"] }),
  ownerLine("App.Core", "lib/app/core.ex"),
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
    id: 0,
    kind: "remote",
    call_kind: "function",
    file: "lib/app/application.ex",
    line: 5,
    column: 1,
    from_mod: "App.Application",
    from_fun: "start/2",
    to_mod: "App.Core",
    name: "greet",
    arity: 1,
    dyn: false,
    partition: "prod",
  }),
  incompleteStructureLine("lib/app/core.ex"),
  structuralSummaryLine("prod", 1, 1, 1),
  JSON.stringify({ k: "phase", protocol: 2, phase: "production", status: "complete" }),
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

  it("refuses malformed non-JSON phase output", () => {
    const withNoise = `${OK_LINES}\n\n  \nwarning: leaked stderr line\n`;
    expect(() => parseTraceOutput(withNoise)).toThrow(/malformed phase protocol/);
  });

  it("accepts repeated same-file ownership facts", () => {
    const lines = OK_LINES.split("\n");
    lines.splice(4, 0, ownerLine("App.Core", "lib/app/core.ex"));
    expect(parseTraceOutput(lines.join("\n")).modules).toHaveLength(1);
  });

  it.each([
    ["missing", (lines: string[]) => lines.filter((line) => !line.includes('"k":"owner"'))],
    [
      "conflicting",
      (lines: string[]) => {
        const changed = [...lines];
        changed.splice(4, 0, ownerLine("App.Core", "lib/app/other.ex"));
        return changed;
      },
    ],
    [
      "extra",
      (lines: string[]) => {
        const changed = [...lines];
        changed.splice(4, 0, ownerLine("App.Extra", "lib/app/extra.ex"));
        return changed;
      },
    ],
    [
      "mismatched",
      (lines: string[]) =>
        lines.map((line) =>
          line.includes('"k":"owner"') ? ownerLine("App.Core", "lib/app/other.ex") : line,
        ),
    ],
  ])("refuses %s compiler-time module ownership", (_label, mutate) => {
    expect(() => parseTraceOutput(mutate(OK_LINES.split("\n")).join("\n"))).toThrow(
      /conflicting or incomplete module ownership/,
    );
  });

  it("canonicalizes behaviour order and duplicates at the protocol boundary", () => {
    const lines = OK_LINES.split("\n");
    const moduleIndex = lines.findIndex((line) => line.includes('"k":"module"'));
    const module = JSON.parse(lines[moduleIndex] ?? "{}") as { behaviours?: unknown };
    module.behaviours = ["Zulu.Behaviour", "Alpha.Behaviour", "Zulu.Behaviour"];
    lines[moduleIndex] = JSON.stringify(module);
    expect(parseTraceOutput(lines.join("\n")).modules[0]?.behaviours).toEqual([
      "Alpha.Behaviour",
      "Zulu.Behaviour",
    ]);
  });

  it("is stable across non-phase record permutations", () => {
    const lines = OK_LINES.split("\n");
    const permuted = [lines[0] ?? "", ...lines.slice(1, -1).reverse(), lines.at(-1) ?? ""];
    expect(stableTraceResult(parseTraceOutput(permuted.join("\n")))).toEqual(
      stableTraceResult(parseTraceOutput(OK_LINES)),
    );
  });

  it("validates 4,000 owner/reflection pairs within a bounded parser budget", () => {
    const middle: string[] = [
      JSON.stringify({ k: "meta", compile_ok: true }),
      JSON.stringify({ k: "deps", names: [] }),
    ];
    for (let index = 0; index < 4_000; index += 1) {
      const mod = `Neutral.Scale.Module${index}`;
      const file = `lib/neutral_scale/module_${index}.ex`;
      middle.push(ownerLine(mod, file));
      middle.push(
        JSON.stringify({
          k: "module",
          mod,
          file,
          line: 1,
          behaviours: [],
          protocol: false,
          impl: false,
          partition: "prod",
        }),
      );
    }
    const raw = [
      JSON.stringify({ k: "phase", protocol: 2, phase: "production", status: "started" }),
      ...middle,
      structuralSummaryLine("prod"),
      JSON.stringify({ k: "phase", protocol: 2, phase: "production", status: "complete" }),
    ].join("\n");
    const started = performance.now();
    expect(parseTraceOutput(raw).modules).toHaveLength(4_000);
    expect(performance.now() - started).toBeLessThan(2_000);
  });

  it.each([
    ["JSON null", "null"],
    ["unknown record", JSON.stringify({ k: "future_record" })],
    [
      "owner with an extra key",
      JSON.stringify({
        k: "owner",
        mod: "App.Core",
        file: "lib/app/core.ex",
        partition: "prod",
        line: 1,
      }),
    ],
    [
      "foreign partition",
      JSON.stringify({
        k: "module",
        mod: "App.Foreign",
        file: "test/foreign.exs",
        line: 1,
        behaviours: [],
        protocol: false,
        impl: false,
        partition: "test",
      }),
    ],
  ])("refuses %s records instead of casting them", (_label, record) => {
    const lines = OK_LINES.replace(
      JSON.stringify({ k: "phase", protocol: 2, phase: "production", status: "complete" }),
      `${record}\n${JSON.stringify({ k: "phase", protocol: 2, phase: "production", status: "complete" })}`,
    );
    expect(() => parseTraceOutput(lines)).toThrow(/malformed phase protocol/);
  });

  it.each([
    ["a callable event without a name", { name: undefined }],
    ["a callable event without an arity", { arity: undefined }],
    ["an alias event with a name", { kind: "alias", name: "greet", arity: undefined }],
    ["a struct event with an arity", { kind: "struct", name: undefined, arity: 1 }],
  ])("refuses %s", (_label, changes) => {
    const lines = OK_LINES.split("\n");
    const eventIndex = lines.findIndex((line) => line.includes('"k":"event"'));
    const event = JSON.parse(lines[eventIndex] ?? "{}") as Record<string, unknown>;
    Object.assign(event, changes);
    for (const [key, value] of Object.entries(changes)) {
      if (value === undefined) delete event[key];
    }
    lines[eventIndex] = JSON.stringify(event);
    expect(() => parseTraceOutput(lines.join("\n"))).toThrow(/malformed phase protocol/);
  });

  it.each([
    ["missing meta", (lines: string[]) => lines.filter((line) => !line.includes('"k":"meta"'))],
    [
      "duplicate meta",
      (lines: string[]) => [
        lines[0] ?? "",
        JSON.stringify({ k: "meta", compile_ok: true }),
        ...lines.slice(1),
      ],
    ],
    ["missing deps", (lines: string[]) => lines.filter((line) => !line.includes('"k":"deps"'))],
    [
      "duplicate deps",
      (lines: string[]) => [
        lines[0] ?? "",
        JSON.stringify({ k: "deps", names: [] }),
        ...lines.slice(1),
      ],
    ],
    [
      "missing structural summary",
      (lines: string[]) => lines.filter((line) => !line.includes('"k":"structure_summary"')),
    ],
    [
      "duplicate structural summary",
      (lines: string[]) => {
        const summary = lines.find((line) => line.includes('"k":"structure_summary"')) ?? "";
        return [lines[0] ?? "", summary, ...lines.slice(1)];
      },
    ],
    ["missing terminal", (lines: string[]) => lines.slice(0, -1)],
    ["duplicate terminal", (lines: string[]) => [...lines, lines.at(-1) ?? ""]],
  ])("refuses a %s record sequence", (_label, mutate) => {
    expect(() => parseTraceOutput(mutate(OK_LINES.split("\n")).join("\n"))).toThrow(
      /malformed phase protocol/,
    );
  });

  it("refuses a structural summary that understates raw compiler event work", () => {
    const lines = OK_LINES.split("\n").map((line) => {
      if (!line.includes('"k":"structure_summary"')) return line;
      return JSON.stringify({ ...JSON.parse(line), events: 0 });
    });
    expect(() => parseTraceOutput(lines.join("\n"))).toThrow(/inconsistent structural counters/);
  });

  it("bounds an incomplete test child without rejecting complete production facts", () => {
    const result = parseTestTraceOutput(
      [
        JSON.stringify({ k: "phase", protocol: 2, phase: "test", status: "started" }),
        JSON.stringify({ k: "test_compile_error" }),
        JSON.stringify({ k: "phase", protocol: 2, phase: "test", status: "incomplete" }),
      ].join("\n"),
    );
    expect(result.testPartition).toBe("incomplete");
    expect(result.testPartitionReason).toBe("compile");
    expect(result.modules).toHaveLength(0);
  });

  it.each([
    "null",
    JSON.stringify({ k: "unknown" }),
    JSON.stringify({ k: "meta", compile_ok: true }),
  ])("discards malformed/foreign test record %s without throwing", (record) => {
    const result = parseTestTraceOutput(
      [
        JSON.stringify({ k: "phase", protocol: 2, phase: "test", status: "started" }),
        record,
        JSON.stringify({ k: "phase", protocol: 2, phase: "test", status: "complete" }),
      ].join("\n"),
    );
    expect(result).toMatchObject({ testPartition: "incomplete", events: [], modules: [] });
  });

  it("refuses (throws) when the tracer reported a compile error", () => {
    const lines = [
      JSON.stringify({ k: "phase", protocol: 2, phase: "production", status: "started" }),
      JSON.stringify({ k: "compile_error", count: 3 }),
      JSON.stringify({ k: "meta", compile_ok: false }),
      JSON.stringify({ k: "phase", protocol: 2, phase: "production", status: "incomplete" }),
    ].join("\n");
    expect(() => parseTraceOutput(lines)).toThrow(ElixirCompileError);
  });

  it("refuses when compile_ok is false even without an explicit compile_error record", () => {
    const lines = [
      JSON.stringify({ k: "phase", protocol: 2, phase: "production", status: "started" }),
      JSON.stringify({ k: "meta", compile_ok: false }),
      JSON.stringify({ k: "phase", protocol: 2, phase: "production", status: "incomplete" }),
    ].join("\n");
    expect(() => parseTraceOutput(lines)).toThrow(ElixirCompileError);
  });

  it("refuses when no modules were found (empty output)", () => {
    const lines = [
      JSON.stringify({ k: "phase", protocol: 2, phase: "production", status: "started" }),
      JSON.stringify({ k: "meta", compile_ok: true }),
      JSON.stringify({ k: "deps", names: [] }),
      structuralSummaryLine("prod"),
      JSON.stringify({ k: "phase", protocol: 2, phase: "production", status: "complete" }),
    ].join("\n");
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
      JSON.stringify({ k: "phase", protocol: 2, phase: "test", status: "started" }),
      ownerLine("App.CoreTest", "test/core_test.exs", "test"),
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
      JSON.stringify({ k: "phase", protocol: 2, phase: "test", status: "complete" }),
    ].join("\n");
    const result = parseTestTraceOutput(lines);
    const testMod = result.modules.find((m) => m.partition === "test");
    expect(testMod?.mod).toBe("App.CoreTest");
  });

  it("discards records when the complete terminal is missing or duplicated", () => {
    const module = JSON.stringify({
      k: "module",
      mod: "App.CoreTest",
      file: "test/core_test.exs",
      line: 1,
      behaviours: [],
      protocol: false,
      impl: false,
      partition: "test",
    });
    const owner = ownerLine("App.CoreTest", "test/core_test.exs", "test");
    const missing = parseTestTraceOutput(
      [
        JSON.stringify({ k: "phase", protocol: 2, phase: "test", status: "started" }),
        owner,
        module,
      ].join("\n"),
    );
    const duplicated = parseTestTraceOutput(
      [
        JSON.stringify({ k: "phase", protocol: 2, phase: "test", status: "started" }),
        owner,
        module,
        JSON.stringify({ k: "phase", protocol: 2, phase: "test", status: "complete" }),
        JSON.stringify({ k: "phase", protocol: 2, phase: "test", status: "complete" }),
      ].join("\n"),
    );
    expect(missing).toMatchObject({ testPartition: "incomplete", events: [], modules: [] });
    expect(duplicated).toMatchObject({ testPartition: "incomplete", events: [], modules: [] });
  });

  it.each([
    ["callable event without a name", { name: undefined }],
    ["callable event without an arity", { arity: undefined }],
    ["alias event with a name", { kind: "alias", name: "value", arity: undefined }],
    ["struct event with an arity", { kind: "struct", name: undefined, arity: 0 }],
  ])("makes the partition partial for a %s", (_label, changes) => {
    const event: Record<string, unknown> = {
      k: "event",
      kind: "remote",
      file: "test/core_test.exs",
      line: 2,
      from_mod: "App.CoreTest",
      to_mod: "App.Core",
      name: "value",
      arity: 0,
      dyn: false,
      partition: "test",
      ...changes,
    };
    for (const [key, value] of Object.entries(changes)) {
      if (value === undefined) delete event[key];
    }
    const result = parseTestTraceOutput(
      [
        JSON.stringify({ k: "phase", protocol: 2, phase: "test", status: "started" }),
        JSON.stringify(event),
        JSON.stringify({ k: "phase", protocol: 2, phase: "test", status: "complete" }),
      ].join("\n"),
    );
    expect(result).toMatchObject({ testPartition: "incomplete", events: [] });
  });

  it("merges and exact-deduplicates shuffled facts deterministically", () => {
    const production = parseTraceOutput(OK_LINES);
    const first = parseTestTraceOutput(
      [
        JSON.stringify({ k: "phase", protocol: 2, phase: "test", status: "started" }),
        ownerLine("App.SecondTest", "test/second_test.exs", "test"),
        ownerLine("App.FirstTest", "test/first_test.exs", "test"),
        JSON.stringify({
          k: "module",
          mod: "App.SecondTest",
          file: "test/second_test.exs",
          line: 2,
          behaviours: [],
          protocol: false,
          impl: false,
          partition: "test",
        }),
        JSON.stringify({
          k: "module",
          mod: "App.FirstTest",
          file: "test/first_test.exs",
          line: 1,
          behaviours: [],
          protocol: false,
          impl: false,
          partition: "test",
        }),
        JSON.stringify({ k: "phase", protocol: 2, phase: "test", status: "complete" }),
      ].join("\n"),
    );
    const second = { ...first, modules: [...first.modules].reverse() };
    expect(mergeTraceResults(production, first)).toEqual(mergeTraceResults(production, second));
  });

  it("makes a complete test trace ownership-incomplete when owner facts disagree", () => {
    const result = parseTestTraceOutput(
      [
        JSON.stringify({ k: "phase", protocol: 2, phase: "test", status: "started" }),
        ownerLine("App.CoreTest", "test/other_test.exs", "test"),
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
        JSON.stringify({ k: "phase", protocol: 2, phase: "test", status: "complete" }),
      ].join("\n"),
    );
    expect(result).toEqual({
      events: [],
      modules: [],
      functions: [],
      structuralFiles: [],
      structuralPartition: "incomplete",
      testPartition: "incomplete",
      testPartitionReason: "ownership",
    });
  });
});

describe("test-phase compatibility filtering", () => {
  const inventory: TestInventory = {
    productionFiles: ["lib/app/core.ex"],
    testOnlyRoots: ["test/support"],
    testFiles: ["test/core_test.exs"],
  };
  const production = parseTraceOutput(OK_LINES);
  const firstEvent = production.events[0];
  const firstModule = production.modules[0];
  const firstFunction = production.functions[0];
  if (firstEvent === undefined || firstModule === undefined || firstFunction === undefined) {
    throw new Error("expected the complete synthetic production trace");
  }
  const productionCoreEvent = {
    ...firstEvent,
    file: "lib/app/core.ex",
    from_mod: "App.Core",
    from_fun: "greet/1",
  };
  const compatibleProduction = { ...production, events: [productionCoreEvent] };
  const reemittedModule = { ...firstModule, partition: "test" as const };
  const reemittedFunction = { ...firstFunction, partition: "test" as const };

  it.each(["lib/app/core.ex", "neutral_generated"])(
    "accepts and removes an owned production duplicate without provenance from %s",
    (file) => {
      const result = validateTestTraceOwnership(
        compatibleProduction,
        {
          modules: [reemittedModule],
          functions: [reemittedFunction],
          events: [
            {
              ...productionCoreEvent,
              file,
              partition: "test",
            },
          ],
          testPartition: "complete",
        },
        inventory,
      );
      expect(result).toMatchObject({
        events: [],
        modules: [],
        functions: [],
        testPartition: "complete",
      });
    },
  );

  it.each([
    "/neutral/compiler/generated.ex",
    "generated/neutral",
    "neutral_generated.ex",
    "test/core_test.exs",
  ])("rejects an exact production duplicate with invalid source %s", (file) => {
    expect(
      validateTestTraceOwnership(
        compatibleProduction,
        {
          modules: [reemittedModule],
          functions: [reemittedFunction],
          events: [{ ...productionCoreEvent, file, partition: "test" }],
          testPartition: "complete",
        },
        inventory,
      ),
    ).toMatchObject({ testPartition: "incomplete", testPartitionReason: "ownership" });
  });

  it("discards exact non-owner raw-source duplicates independent of source shape and order", () => {
    const first = {
      ...productionCoreEvent,
      file: "/neutral/compiler/application.ex",
      partition: "prod" as const,
    };
    const second = {
      ...productionCoreEvent,
      file: "deps/neutral_macro.ex",
      to_mod: "Kernel",
      partition: "prod" as const,
    };
    const validatedProduction = validateProductionTraceOwnership(
      { ...production, events: [first, second] },
      ["lib"],
    );

    expect(
      validateTestTraceOwnership(
        validatedProduction,
        {
          modules: [reemittedModule],
          functions: [reemittedFunction],
          events: [
            { ...second, partition: "test" },
            { ...first, partition: "test" },
          ],
          testPartition: "complete",
        },
        inventory,
      ),
    ).toMatchObject({ events: [], modules: [], functions: [], testPartition: "complete" });
  });

  it.each([
    ["external", "/neutral/compiler/application.ex", "/neutral/compiler/spoofed.ex"],
    ["safe repository-relative", "generated/shared_macro.ex", "generated/spoofed_macro.ex"],
    ["test-inventory substitution", "generated/shared_macro.ex", "test/core_test.exs"],
    ["extensionful substitution", "/neutral/compiler/application.ex", "neutral_generated.ex"],
  ])(
    "rejects a duplicate whose %s raw source does not match production provenance",
    (_label, productionFile, testFile) => {
      const rawProductionEvent = {
        ...productionCoreEvent,
        file: productionFile,
        partition: "prod" as const,
      };
      const validatedProduction = validateProductionTraceOwnership(
        { ...production, events: [rawProductionEvent] },
        ["lib"],
      );
      expect(
        validateTestTraceOwnership(
          validatedProduction,
          {
            modules: [reemittedModule],
            functions: [reemittedFunction],
            events: [{ ...rawProductionEvent, file: testFile, partition: "test" }],
            testPartition: "complete",
          },
          inventory,
        ),
      ).toMatchObject({ testPartition: "incomplete", testPartitionReason: "ownership" });
    },
  );

  const semanticChanges: ReadonlyArray<
    readonly [
      string,
      {
        readonly to_mod?: string;
        readonly name?: string;
        readonly dyn?: boolean;
        readonly from_mod?: string | null;
      },
    ]
  > = [
    ["target", { to_mod: "App.Novel" }],
    ["name", { name: "novel" }],
    ["dynamic-dispatch marker", { dyn: true }],
    ["ownerless source", { from_mod: null }],
    ["unknown owner", { from_mod: "App.Unknown" }],
  ];
  it.each(semanticChanges)(
    "rejects changed %s semantics despite exact non-owner raw-source provenance",
    (_label, change) => {
      const rawProductionEvent = {
        ...productionCoreEvent,
        file: "generated/shared_macro.ex",
        partition: "prod" as const,
      };
      const validatedProduction = validateProductionTraceOwnership(
        { ...production, events: [rawProductionEvent] },
        ["lib"],
      );
      expect(
        validateTestTraceOwnership(
          validatedProduction,
          {
            modules: [reemittedModule],
            functions: [reemittedFunction],
            events: [{ ...rawProductionEvent, ...change, partition: "test" }],
            testPartition: "complete",
          },
          inventory,
        ),
      ).toMatchObject({ testPartition: "incomplete", testPartitionReason: "ownership" });
    },
  );

  it("does not let an ordinary owner-sourced production event authorize a non-owner duplicate", () => {
    const validatedProduction = validateProductionTraceOwnership(compatibleProduction, ["lib"]);
    expect(
      validateTestTraceOwnership(
        validatedProduction,
        {
          modules: [reemittedModule],
          functions: [reemittedFunction],
          events: [
            { ...productionCoreEvent, file: "generated/shared_macro.ex", partition: "test" },
          ],
          testPartition: "complete",
        },
        inventory,
      ),
    ).toMatchObject({ testPartition: "incomplete", testPartitionReason: "ownership" });
  });

  it("makes the test partition partial for a novel function in a production-owned module", () => {
    expect(
      validateTestTraceOwnership(
        compatibleProduction,
        {
          modules: [reemittedModule],
          functions: [{ ...reemittedFunction, name: "test_only_helper" }],
          events: [],
          testPartition: "complete",
        },
        inventory,
      ),
    ).toMatchObject({
      testPartition: "incomplete",
      testPartitionReason: "ownership",
      events: [],
      modules: [],
      functions: [],
    });
  });

  it("accepts an additive MIX_ENV=test edge from a compatible production-owned module", () => {
    const event = {
      ...productionCoreEvent,
      to_mod: "App.TestTarget",
      partition: "test" as const,
    };
    expect(
      validateTestTraceOwnership(
        compatibleProduction,
        {
          modules: [reemittedModule],
          functions: [reemittedFunction],
          events: [event],
          testPartition: "complete",
        },
        inventory,
      ),
    ).toMatchObject({ events: [event], modules: [], functions: [], testPartition: "complete" });
  });

  it("rejects an additive production-owned edge without a compatible re-emitted module", () => {
    expect(
      validateTestTraceOwnership(
        compatibleProduction,
        {
          modules: [],
          functions: [],
          events: [
            {
              ...productionCoreEvent,
              to_mod: "App.TestTarget",
              partition: "test",
            },
          ],
          testPartition: "complete",
        },
        inventory,
      ),
    ).toMatchObject({ testPartition: "incomplete", testPartitionReason: "ownership" });
  });

  it("accepts an ownerless event only from an exact test inventory source", () => {
    const event = {
      ...productionCoreEvent,
      file: "test/core_test.exs",
      from_mod: null,
      to_mod: "App.TestTarget",
      partition: "test" as const,
    };
    expect(
      validateTestTraceOwnership(
        compatibleProduction,
        { modules: [], functions: [], events: [event], testPartition: "complete" },
        inventory,
      ),
    ).toMatchObject({ events: [event], modules: [], functions: [], testPartition: "complete" });
  });

  it("normalizes an extensionless compiler pseudo-source through its unique reflected owner", () => {
    const event = {
      ...productionCoreEvent,
      file: "neutral_generated",
      to_mod: "App.TestTarget",
      partition: "test" as const,
    };
    expect(
      validateTestTraceOwnership(
        compatibleProduction,
        {
          modules: [reemittedModule],
          functions: [reemittedFunction],
          events: [event],
          testPartition: "complete",
        },
        inventory,
      ),
    ).toEqual({
      events: [{ ...event, file: "lib/app/core.ex" }],
      modules: [],
      functions: [],
      structuralFiles: [],
      structuralPartition: "incomplete",
      testPartition: "complete",
    });
  });

  it.each([
    [
      "ownerless pseudo-source",
      { ...productionCoreEvent, file: "neutral_generated", from_mod: null },
    ],
    [
      "unknown owner",
      { ...productionCoreEvent, file: "neutral_generated", from_mod: "App.Unknown" },
    ],
    ["extensionful spoof", { ...productionCoreEvent, file: "neutral_generated.ex" }],
    ["allowed-file spoof", { ...productionCoreEvent, file: "test/core_test.exs" }],
  ])("rejects an additive event with an %s", (_label, event) => {
    expect(
      validateTestTraceOwnership(
        compatibleProduction,
        {
          modules: [reemittedModule],
          functions: [reemittedFunction],
          events: [{ ...event, to_mod: "App.TestTarget", partition: "test" }],
          testPartition: "complete",
        },
        inventory,
      ),
    ).toMatchObject({ testPartition: "incomplete", testPartitionReason: "ownership" });
  });

  it("rejects a direct test-module ownership collision", () => {
    const module = {
      ...firstModule,
      mod: "App.TestOnly",
      file: "test/first_test.exs",
      partition: "test" as const,
    };
    expect(
      validateTestTraceOwnership(
        production,
        {
          modules: [module, { ...module, file: "test/second_test.exs" }],
          functions: [],
          events: [],
          testPartition: "complete",
        },
        { ...inventory, testFiles: ["test/first_test.exs", "test/second_test.exs"] },
      ),
    ).toMatchObject({ testPartition: "incomplete", testPartitionReason: "ownership" });
  });

  const invalidTestPaths = [
    "/absolute/test.exs",
    "../outside_test.exs",
    "test/../outside_test.exs",
    "test/./core_test.exs",
    "test//core_test.exs",
    "test/support-lookalike/helper.ex",
    ".",
    "test\\support\\helper.ex",
    "test\\..\\outside.ex",
    "C:\\outside.ex",
  ];

  it.each(["module", "function", "event"] as const)(
    "rejects every non-canonical or prefix-lookalike path on a %s fact",
    (factKind) => {
      for (const file of invalidTestPaths) {
        const module = {
          ...firstModule,
          mod: "App.TestOnly",
          file: factKind === "module" ? file : "test/core_test.exs",
          partition: "test" as const,
        };
        const fn = {
          ...firstFunction,
          mod: module.mod,
          file: factKind === "function" ? file : module.file,
          partition: "test" as const,
        };
        const event = {
          ...firstEvent,
          file: factKind === "event" ? file : module.file,
          from_mod: module.mod,
          partition: "test" as const,
        };
        const result = validateTestTraceOwnership(
          production,
          {
            modules: [module],
            functions: factKind === "module" ? [] : [fn],
            events: factKind === "event" ? [event] : [],
            testPartition: "complete",
          },
          inventory,
        );
        expect(result).toMatchObject({
          testPartition: "incomplete",
          testPartitionReason: "ownership",
          modules: [],
          functions: [],
          events: [],
        });
      }
    },
  );

  it("accepts a root compiler source path without weakening path validation", () => {
    expect(validateProductionTraceOwnership(production, ["."])).toEqual(production);
  });
});

describe("bounded trace reads", () => {
  const dirs: string[] = [];
  afterAll(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });

  it("refuses a sparse trace larger than the read limit before allocating it", () => {
    const dir = mkdtempSync(join(tmpdir(), "unused-ex-bounded-trace-"));
    dirs.push(dir);
    const path = join(dir, "trace.jsonl");
    writeFileSync(path, "");
    truncateSync(path, 256 * 1024 * 1024 + 1);
    expect(() => readBoundedTraceLines(path)).toThrow(/bounded read limit/);
  });

  it("streams UTF-8 JSONL safely across a fixed chunk boundary", () => {
    const dir = mkdtempSync(join(tmpdir(), "unused-ex-streamed-trace-"));
    dirs.push(dir);
    const path = join(dir, "trace.jsonl");
    const first = `${"x".repeat(64 * 1024 - 1)}é`;
    writeFileSync(path, `${first}\nsecond\n`);
    expect([...readBoundedTraceLines(path)]).toEqual([first, "second"]);
  });

  it("assembles one multi-chunk record without rescanning prior chunks", () => {
    const dir = mkdtempSync(join(tmpdir(), "unused-ex-multichunk-trace-"));
    dirs.push(dir);
    const path = join(dir, "trace.jsonl");
    const record = "x".repeat(64 * 1024 * 4 + 17);
    writeFileSync(path, `${record}\n`);
    expect([...readBoundedTraceLines(path)]).toEqual([record]);
  });

  it("keeps one opened descriptor when the path is swapped before iteration", () => {
    const dir = mkdtempSync(join(tmpdir(), "unused-ex-swapped-trace-"));
    dirs.push(dir);
    const path = join(dir, "trace.jsonl");
    const openedPath = join(dir, "opened.jsonl");
    const replacement = join(dir, "replacement.jsonl");
    writeFileSync(path, "original\n");
    writeFileSync(replacement, "replacement\n");
    const lines = readBoundedTraceLines(path, 64);
    renameSync(path, openedPath);
    symlinkSync(replacement, path);
    expect([...lines]).toEqual(["original"]);
  });

  it("refuses a symbolic-link trace replacement deterministically", () => {
    const dir = mkdtempSync(join(tmpdir(), "unused-ex-linked-trace-"));
    dirs.push(dir);
    const path = join(dir, "trace.jsonl");
    const target = join(dir, "target.jsonl");
    writeFileSync(target, "target\n");
    symlinkSync(target, path);
    expect(() => readBoundedTraceLines(path, 64)).toThrow(/not a regular file/);
  });

  it("refuses growth beyond the bound after opening and before iteration", () => {
    const dir = mkdtempSync(join(tmpdir(), "unused-ex-grown-trace-"));
    dirs.push(dir);
    const path = join(dir, "trace.jsonl");
    writeFileSync(path, "one\n");
    const lines = readBoundedTraceLines(path, 8);
    appendFileSync(path, "two-three\n");
    expect(() => [...lines]).toThrow(/bounded read limit/);
  });

  it("fatally refuses malformed UTF-8 split across the chunk boundary", () => {
    const dir = mkdtempSync(join(tmpdir(), "unused-ex-invalid-utf8-trace-"));
    dirs.push(dir);
    const path = join(dir, "trace.jsonl");
    writeFileSync(
      path,
      Buffer.concat([Buffer.alloc(64 * 1024 - 1, 0x61), Buffer.from([0xc3, 0x28, 0x0a])]),
    );
    expect(() => [...readBoundedTraceLines(path)]).toThrow(/invalid UTF-8/);
  });

  it("closes the descriptor when a consuming parser throws after its first line", () => {
    const dir = mkdtempSync(join(tmpdir(), "unused-ex-early-parser-trace-"));
    dirs.push(dir);
    const path = join(dir, "trace.jsonl");
    writeFileSync(path, "first\nsecond\n");
    const originalClose = fs.closeSync;
    let closes = 0;
    fs.closeSync = (descriptor: number): void => {
      closes += 1;
      originalClose(descriptor);
    };
    syncBuiltinESMExports();
    try {
      const lines = readBoundedTraceLines(path);
      expect(() => {
        for (const _line of lines) throw new Error("synthetic parser refusal");
      }).toThrow(/synthetic parser refusal/);
      expect(closes).toBe(1);
    } finally {
      fs.closeSync = originalClose;
      syncBuiltinESMExports();
    }
  });

  it("can explicitly close an eagerly bound iterable without starting iteration", () => {
    const dir = mkdtempSync(join(tmpdir(), "unused-ex-unstarted-trace-"));
    dirs.push(dir);
    const path = join(dir, "trace.jsonl");
    writeFileSync(path, "first\n");
    const originalClose = fs.closeSync;
    let closes = 0;
    fs.closeSync = (descriptor: number): void => {
      closes += 1;
      originalClose(descriptor);
    };
    syncBuiltinESMExports();
    try {
      const lines = readBoundedTraceLines(path);
      lines.close();
      lines.close();
      expect(closes).toBe(1);
      expect([...lines]).toEqual([]);
    } finally {
      fs.closeSync = originalClose;
      syncBuiltinESMExports();
    }
  });
});

describe("effective test source roots", () => {
  it("accepts sorted non-overlapping custom roots", () => {
    expect(resolveTestOnlyRoots(["lib"], ["test/support", "lib", "neutral_helpers"])).toEqual([
      "neutral_helpers",
      "test/support",
    ]);
  });

  it.each([
    [["lib"], ["lib", "lib/generated"]],
    [["lib/generated"], ["lib/generated", "lib"]],
  ])("rejects a production/test root overlap", (production, test) => {
    expect(resolveTestOnlyRoots(production, test)).toBeNull();
  });
});
