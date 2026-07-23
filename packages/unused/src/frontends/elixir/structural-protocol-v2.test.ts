import { createHash } from "node:crypto";
import fs, {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  computeDeletionPlan,
  computePartitionedReachability,
  emitClaims,
  whyAlive,
} from "../../core/analysis/index.js";
import { emitElixirIR } from "./emit.js";
import type {
  ElixirStructuralFile,
  ElixirStructuralSummary,
  FunctionRecord,
  ModuleRecord,
  Partition,
  TraceEvent,
  TraceResult,
} from "./events.js";
import { parseTestTraceOutput } from "./runner.js";
import {
  mergeTraceResults,
  stableTraceResult,
  validateProductionTraceOwnership,
  validateTestTraceOwnership,
} from "./trace-merge.js";
import { decodeTraceRecord } from "./trace-protocol.js";

const temporaryRoots: string[] = [];
afterAll(() => {
  for (const root of temporaryRoots) rmSync(root, { recursive: true, force: true });
});

function structuralWire(
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    k: "structure_file",
    file: "lib/neutral.ex",
    partition: "prod",
    digest: "a".repeat(64),
    bytes: 1,
    status: "complete",
    reason: null,
    ast_nodes: 1,
    max_depth: 1,
    carriers: [],
    facts: [],
    ...overrides,
  };
}

function moduleRecord(file: string, mod: string, partition: Partition): ModuleRecord {
  return {
    k: "module",
    mod,
    file,
    line: 1,
    behaviours: [],
    protocol: false,
    impl: false,
    partition,
  };
}

function functionRecord(file: string, mod: string, partition: Partition): FunctionRecord {
  return {
    k: "function",
    mod,
    name: "live",
    arity: 0,
    file,
    line: 1,
    defaultTargetArity: null,
    partition,
  };
}

function wireFunctionRecord(file: string, mod: string, partition: Partition) {
  const { defaultTargetArity, ...record } = functionRecord(file, mod, partition);
  return { ...record, default_target_arity: defaultTargetArity };
}

function eventRecord(
  eventId: number,
  file: string,
  mod: string,
  partition: Partition,
  column: number,
): TraceEvent {
  return {
    k: "event",
    eventId,
    kind: "remote",
    callKind: "function",
    file,
    line: 1,
    column,
    from_mod: mod,
    from_fun: "live/0",
    to_mod: "Neutral.Target",
    name: "run",
    arity: 1,
    dyn: false,
    partition,
  };
}

function structuralFile(
  file: string,
  mod: string,
  partition: Partition,
  eventIds: readonly number[],
  eventColumns: readonly number[] = eventIds.map((eventId) => (eventId === 0 ? 3 : 17)),
): ElixirStructuralFile {
  return {
    k: "structure_file",
    file,
    partition,
    digest: "a".repeat(64),
    bytes: 1,
    status: "complete",
    reason: null,
    astNodes: 2,
    maxDepth: 2,
    carriers: [{ id: 0, mod, fun: "live/0", defLine: 1, body: { sl: 1, sc: 1, el: 1, ec: 64 } }],
    facts: eventIds.map((eventId, index) => ({
      carrier: 0,
      role: "call-argument" as const,
      from: { sl: 1, sc: 1, el: 1, ec: 2 },
      to: {
        sl: 1,
        sc: eventColumns[index] ?? 3,
        el: 1,
        ec: (eventColumns[index] ?? 3) + 13,
      },
      eventId,
      argument: 0,
      resolution: "exact" as const,
    })),
  };
}

function structuralSummary(
  partition: Partition,
  files: readonly ElixirStructuralFile[],
  rawEvents = 0,
): ElixirStructuralSummary {
  const facts = files.flatMap((file) => file.facts);
  const roles: Record<string, number> = {};
  for (const fact of facts) roles[fact.role] = (roles[fact.role] ?? 0) + 1;
  return {
    k: "structure_summary",
    partition,
    rawEvents,
    elapsedUs: 1,
    eventIndexUs: 1,
    fileExtractionUs: 1,
    emitUs: 1,
    files: files.length,
    completeFiles: files.filter((file) => file.status === "complete").length,
    incompleteFiles: files.filter((file) => file.status === "incomplete").length,
    bytes: files.reduce((total, file) => total + file.bytes, 0),
    astNodes: files.reduce((total, file) => total + file.astNodes, 0),
    maxDepth: Math.max(0, ...files.map((file) => file.maxDepth)),
    carriers: files.reduce((total, file) => total + file.carriers.length, 0),
    facts: facts.length,
    exactFacts: facts.filter((fact) => fact.resolution === "exact").length,
    opaqueFacts: facts.filter((fact) => fact.resolution === "opaque").length,
    roles,
  };
}

function structuralSummaryWire(summary: ElixirStructuralSummary): Record<string, unknown> {
  return {
    k: "structure_summary",
    partition: summary.partition,
    events: summary.rawEvents,
    elapsed_us: summary.elapsedUs,
    event_index_us: summary.eventIndexUs,
    file_extraction_us: summary.fileExtractionUs,
    emit_us: summary.emitUs,
    files: summary.files,
    complete_files: summary.completeFiles,
    incomplete_files: summary.incompleteFiles,
    bytes: summary.bytes,
    ast_nodes: summary.astNodes,
    max_depth: summary.maxDepth,
    carriers: summary.carriers,
    facts: summary.facts,
    exact_facts: summary.exactFacts,
    opaque_facts: summary.opaqueFacts,
    roles: summary.roles,
  };
}

function structuralFileWire(file: ElixirStructuralFile): Record<string, unknown> {
  return {
    k: "structure_file",
    file: file.file,
    partition: file.partition,
    digest: file.digest,
    bytes: file.bytes,
    status: file.status,
    reason: file.reason,
    ast_nodes: file.astNodes,
    max_depth: file.maxDepth,
    carriers: file.carriers.map((carrier) => ({
      id: carrier.id,
      mod: carrier.mod,
      fun: carrier.fun,
      def_line: carrier.defLine,
      body: carrier.body,
    })),
    facts: file.facts.map((fact) => ({
      carrier: fact.carrier,
      role: fact.role,
      from: fact.from,
      to: fact.to,
      event_id: fact.eventId,
      argument: fact.argument,
      resolution: fact.resolution,
    })),
  };
}

function trace(
  file: string,
  mod: string,
  partition: Partition,
  events: readonly TraceEvent[],
  structure: ElixirStructuralFile,
): TraceResult {
  return {
    events,
    modules: [moduleRecord(file, mod, partition)],
    functions: [functionRecord(file, mod, partition)],
    structuralFiles: [structure],
    appMod: null,
    deps: [],
    compileOk: true,
    testPartition: "complete",
  };
}

describe("Elixir structural protocol v2 decoding", () => {
  it.each([
    ["source bytes", { bytes: 8 * 1024 * 1024 + 1 }],
    ["AST visits", { ast_nodes: 500_001 }],
    ["depth", { max_depth: 257 }],
    ["carriers", { carriers: new Array(20_001).fill(null) }],
    ["facts", { facts: new Array(500_001).fill(null) }],
  ])("refuses an oversized %s declaration before decoding its arrays", (_label, override) => {
    expect(decodeTraceRecord(structuralWire(override), "production")).toBeNull();
  });

  it("requires incomplete records to carry only zero counters and empty payloads", () => {
    const incomplete = {
      digest: "0".repeat(64),
      bytes: 0,
      status: "incomplete",
      reason: "limit",
      ast_nodes: 0,
      max_depth: 0,
      carriers: [],
      facts: [],
    };
    expect(decodeTraceRecord(structuralWire(incomplete), "production")).not.toBeNull();
    expect(
      decodeTraceRecord(structuralWire({ ...incomplete, ast_nodes: 1 }), "production"),
    ).toBeNull();
  });

  it("bounds callable arity and identity/path lengths", () => {
    const base = {
      k: "event",
      id: 0,
      kind: "remote",
      call_kind: "function",
      file: "lib/neutral.ex",
      line: 1,
      column: 1,
      from_mod: "Neutral",
      from_fun: "live/0",
      to_mod: "Neutral.Target",
      name: "run",
      arity: 0,
      dyn: false,
      partition: "prod",
    };
    expect(decodeTraceRecord({ ...base, arity: 1_025 }, "production")).toBeNull();
    expect(decodeTraceRecord({ ...base, file: "x".repeat(4_097) }, "production")).toBeNull();
    expect(decodeTraceRecord({ ...base, to_mod: "x".repeat(1_025) }, "production")).toBeNull();
  });

  it("requires file-local carrier IDs to be dense and zero-based", () => {
    expect(
      decodeTraceRecord(
        structuralWire({
          carriers: [
            {
              id: 1,
              mod: "Neutral",
              fun: "live/0",
              def_line: 1,
              body: { sl: 1, sc: 1, el: 1, ec: 2 },
            },
          ],
        }),
        "production",
      ),
    ).toBeNull();
  });

  it("accepts only the closed runtime-MFA fact shape", () => {
    const fact = {
      carrier: 0,
      role: "runtime-mfa",
      from: { sl: 1, sc: 1, el: 1, ec: 32 },
      to: { sl: 1, sc: 3, el: 1, ec: 19 },
      event_id: 0,
      argument: null,
      resolution: "exact",
    };
    const carrier = {
      id: 0,
      mod: "Neutral",
      fun: "live/0",
      def_line: 1,
      body: { sl: 1, sc: 1, el: 1, ec: 64 },
    };
    expect(
      decodeTraceRecord(structuralWire({ carriers: [carrier], facts: [fact] }), "production"),
    ).not.toBeNull();
    for (const override of [
      { event_id: null },
      { argument: 0 },
      { resolution: "opaque" },
      { to: null },
    ]) {
      expect(
        decodeTraceRecord(
          structuralWire({ carriers: [carrier], facts: [{ ...fact, ...override }] }),
          "production",
        ),
      ).toBeNull();
    }
  });

  it("accepts only an exact second-argument use-dispatcher fact", () => {
    const fact = {
      carrier: 0,
      role: "use-dispatcher",
      from: { sl: 1, sc: 1, el: 1, ec: 32 },
      to: { sl: 1, sc: 3, el: 1, ec: 19 },
      event_id: 0,
      argument: 1,
      resolution: "exact",
    };
    const carrier = {
      id: 0,
      mod: "Neutral",
      fun: "__using__/1",
      def_line: 1,
      body: { sl: 1, sc: 1, el: 1, ec: 64 },
    };
    expect(
      decodeTraceRecord(structuralWire({ carriers: [carrier], facts: [fact] }), "production"),
    ).not.toBeNull();
    for (const override of [
      { event_id: null },
      { argument: 0 },
      { resolution: "opaque" },
      { to: null },
    ]) {
      expect(
        decodeTraceRecord(
          structuralWire({ carriers: [carrier], facts: [{ ...fact, ...override }] }),
          "production",
        ),
      ).toBeNull();
    }
  });
});

describe("Elixir structural ownership and spans", () => {
  it("binds runtime-MFA facts to an exact alias event", () => {
    const root = mkdtempSync(join(tmpdir(), "unused-structure-runtime-mfa-"));
    temporaryRoots.push(root);
    const file = "lib/neutral.ex";
    const content = " ".repeat(63);
    mkdirSync(join(root, "lib"));
    writeFileSync(join(root, file), content);
    const event: TraceEvent = {
      k: "event",
      eventId: 0,
      kind: "alias",
      callKind: null,
      file,
      line: 1,
      column: 3,
      from_mod: "Neutral",
      from_fun: "live/0",
      to_mod: "Neutral.Callback",
      dyn: false,
      partition: "prod",
    };
    const structure: ElixirStructuralFile = {
      ...structuralFile(file, "Neutral", "prod", []),
      digest: createHash("sha256").update(content).digest("hex"),
      bytes: Buffer.byteLength(content),
      facts: [
        {
          carrier: 0,
          role: "runtime-mfa",
          from: { sl: 1, sc: 1, el: 1, ec: 32 },
          to: { sl: 1, sc: 3, el: 1, ec: 19 },
          eventId: 0,
          argument: null,
          resolution: "exact",
        },
      ],
    };
    expect(
      validateProductionTraceOwnership(
        trace(file, "Neutral", "prod", [event], structure),
        ["lib"],
        root,
      ).structuralFiles,
    ).toHaveLength(1);
    expect(() =>
      validateProductionTraceOwnership(
        trace(file, "Neutral", "prod", [{ ...event, kind: "remote" }], structure),
        ["lib"],
        root,
      ),
    ).toThrow(/invalid structural event ownership/);
  });

  it("binds use-dispatcher facts only to the exact dynamic apply event", () => {
    const root = mkdtempSync(join(tmpdir(), "unused-structure-use-dispatcher-"));
    temporaryRoots.push(root);
    const file = "lib/neutral.ex";
    const content = " ".repeat(63);
    mkdirSync(join(root, "lib"));
    writeFileSync(join(root, file), content);
    const event: TraceEvent = {
      ...eventRecord(0, file, "Neutral", "prod", 3),
      from_fun: "__using__/1",
      name: "apply",
      arity: 3,
      dyn: true,
      to_mod: "Kernel",
    };
    const structure: ElixirStructuralFile = {
      ...structuralFile(file, "Neutral", "prod", []),
      digest: createHash("sha256").update(content).digest("hex"),
      bytes: Buffer.byteLength(content),
      carriers: [
        {
          id: 0,
          mod: "Neutral",
          fun: "__using__/1",
          defLine: 1,
          body: { sl: 1, sc: 1, el: 1, ec: 64 },
        },
      ],
      facts: [
        {
          carrier: 0,
          role: "use-dispatcher",
          from: { sl: 1, sc: 1, el: 1, ec: 32 },
          to: { sl: 1, sc: 3, el: 1, ec: 19 },
          eventId: 0,
          argument: 1,
          resolution: "exact",
        },
      ],
    };
    const result: TraceResult = {
      ...trace(file, "Neutral", "prod", [event], structure),
      functions: [{ ...functionRecord(file, "Neutral", "prod"), name: "__using__", arity: 1 }],
    };
    expect(validateProductionTraceOwnership(result, ["lib"], root).structuralFiles).toHaveLength(1);
    expect(() =>
      validateProductionTraceOwnership(
        { ...result, events: [{ ...event, dyn: false }] },
        ["lib"],
        root,
      ),
    ).toThrow(/invalid structural event ownership/);
  });

  it("rejects a pre-canonical exact-event stream before ownership validation", () => {
    const file = "lib/neutral.ex";
    const event = eventRecord(0, file, "Neutral", "prod", 3);
    expect(() =>
      validateProductionTraceOwnership(
        {
          ...trace(file, "Neutral", "prod", [event], structuralFile(file, "Neutral", "prod", [])),
          structuralEvents: [{ ...event, file: "../spoofed.ex" }],
        },
        ["lib"],
      ),
    ).toThrow(/pre-canonical structural event state/);
  });

  it("validates a long combining-Unicode line in one grapheme pass", () => {
    const root = mkdtempSync(join(tmpdir(), "unused-structure-v2-"));
    temporaryRoots.push(root);
    const file = "lib/neutral.ex";
    const content = "e\u0301".repeat(100_000);
    mkdirSync(join(root, "lib"));
    writeFileSync(join(root, file), content);
    const structure: ElixirStructuralFile = {
      ...structuralFile(file, "Neutral", "prod", []),
      digest: createHash("sha256").update(content).digest("hex"),
      bytes: Buffer.byteLength(content),
      carriers: [
        {
          id: 0,
          mod: "Neutral",
          fun: "live/0",
          defLine: 1,
          body: { sl: 1, sc: 1, el: 1, ec: 100_001 },
        },
      ],
    };
    const started = performance.now();
    expect(
      validateProductionTraceOwnership(trace(file, "Neutral", "prod", [], structure), ["lib"], root)
        .structuralFiles,
    ).toHaveLength(1);
    expect(performance.now() - started).toBeLessThan(2_000);
  });

  it("refuses a structural source symbolic link without following it", () => {
    const root = mkdtempSync(join(tmpdir(), "unused-structure-linked-source-"));
    temporaryRoots.push(root);
    mkdirSync(join(root, "lib"));
    const file = "lib/neutral.ex";
    const content = " ".repeat(63);
    const target = join(root, "lib", "target.ex");
    writeFileSync(target, content);
    symlinkSync(target, join(root, file));
    const structure: ElixirStructuralFile = {
      ...structuralFile(file, "Neutral", "prod", []),
      digest: createHash("sha256").update(content).digest("hex"),
      bytes: Buffer.byteLength(content),
    };
    expect(() =>
      validateProductionTraceOwnership(
        trace(file, "Neutral", "prod", [], structure),
        ["lib"],
        root,
      ),
    ).toThrow(/structural source validation failed/);
  });

  it("refuses structural source growth after descriptor validation", () => {
    const root = mkdtempSync(join(tmpdir(), "unused-structure-grown-source-"));
    temporaryRoots.push(root);
    mkdirSync(join(root, "lib"));
    const file = "lib/neutral.ex";
    const path = join(root, file);
    const content = " ".repeat(63);
    writeFileSync(path, content);
    const structure: ElixirStructuralFile = {
      ...structuralFile(file, "Neutral", "prod", []),
      digest: createHash("sha256").update(content).digest("hex"),
      bytes: Buffer.byteLength(content),
    };
    const originalRead = fs.readSync;
    let grown = false;
    fs.readSync = ((
      descriptor: number,
      buffer: NodeJS.ArrayBufferView,
      offset: number,
      length: number,
      position: number | null,
    ): number => {
      if (!grown) {
        grown = true;
        appendFileSync(path, " ");
      }
      return originalRead(descriptor, buffer, offset, length, position);
    }) as typeof fs.readSync;
    syncBuiltinESMExports();
    try {
      expect(() =>
        validateProductionTraceOwnership(
          trace(file, "Neutral", "prod", [], structure),
          ["lib"],
          root,
        ),
      ).toThrow(/structural source changed after compilation/);
    } finally {
      fs.readSync = originalRead;
      syncBuiltinESMExports();
    }
  });

  it("refuses a structural source swapped after its descriptor opens", () => {
    const root = mkdtempSync(join(tmpdir(), "unused-structure-swapped-source-"));
    temporaryRoots.push(root);
    mkdirSync(join(root, "lib"));
    const file = "lib/neutral.ex";
    const path = join(root, file);
    const openedPath = join(root, "lib", "opened.ex");
    const replacement = join(root, "lib", "replacement.ex");
    const content = " ".repeat(63);
    writeFileSync(path, content);
    writeFileSync(replacement, content);
    const structure: ElixirStructuralFile = {
      ...structuralFile(file, "Neutral", "prod", []),
      digest: createHash("sha256").update(content).digest("hex"),
      bytes: Buffer.byteLength(content),
    };
    const originalFstat = fs.fstatSync;
    let swapped = false;
    fs.fstatSync = ((descriptor: number) => {
      const stat = originalFstat(descriptor);
      if (!swapped) {
        swapped = true;
        renameSync(path, openedPath);
        symlinkSync(replacement, path);
      }
      return stat;
    }) as typeof fs.fstatSync;
    syncBuiltinESMExports();
    try {
      expect(() =>
        validateProductionTraceOwnership(
          trace(file, "Neutral", "prod", [], structure),
          ["lib"],
          root,
        ),
      ).toThrow(/structural source validation failed/);
    } finally {
      fs.fstatSync = originalFstat;
      syncBuiltinESMExports();
    }
  });

  it("requires an explicit complete-or-incomplete bundle for every owned file", () => {
    const production = trace("lib/one.ex", "Neutral.One", "prod", [], {
      ...structuralFile("lib/one.ex", "Neutral.One", "prod", []),
      digest: "0".repeat(64),
      bytes: 0,
      status: "incomplete",
      reason: "parse",
      astNodes: 0,
      maxDepth: 0,
      carriers: [],
    });
    expect(() =>
      validateProductionTraceOwnership(
        {
          ...production,
          modules: [...production.modules, moduleRecord("lib/two.ex", "Neutral.Two", "prod")],
        },
        ["lib"],
      ),
    ).toThrow(/incomplete structural source inventory/);
  });

  it("drops only an invalid optional test overlay and retains test semantics", () => {
    const prodFile = "lib/neutral.ex";
    const testFile = "test/neutral_test.exs";
    const production = trace(prodFile, "Neutral", "prod", [], {
      ...structuralFile(prodFile, "Neutral", "prod", []),
      digest: "0".repeat(64),
      bytes: 0,
      status: "incomplete",
      reason: "parse",
      astNodes: 0,
      maxDepth: 0,
      carriers: [],
    });
    const event = eventRecord(0, testFile, "Neutral.Test", "test", 1);
    const result = validateTestTraceOwnership(
      production,
      {
        events: [event],
        modules: [moduleRecord(testFile, "Neutral.Test", "test")],
        functions: [functionRecord(testFile, "Neutral.Test", "test")],
        structuralFiles: [structuralFile(testFile, "Neutral.Test", "test", [0])],
        testPartition: "complete",
      },
      { productionFiles: [prodFile], testFiles: [testFile], testOnlyRoots: ["test"] },
    );
    expect(result.structuralPartition).toBe("incomplete");
    expect(result.structuralFiles).toEqual([]);
    expect(result.events).toEqual([event]);
    expect(result.modules).toHaveLength(1);
    expect(result.functions).toHaveLength(1);
    expect(result.testPartition).toBe("complete");
  });

  it("keeps a well-formed test partition when only its structural wire record is malformed", () => {
    const file = "test/neutral_test.exs";
    const lines = [
      { k: "phase", protocol: 2, phase: "test", status: "started" },
      { k: "owner", mod: "Neutral.Test", file, partition: "test" },
      moduleRecord(file, "Neutral.Test", "test"),
      wireFunctionRecord(file, "Neutral.Test", "test"),
      {
        k: "event",
        id: 0,
        kind: "remote",
        call_kind: "function",
        file,
        line: 1,
        column: 1,
        from_mod: "Neutral.Test",
        from_fun: "live/0",
        to_mod: "Neutral.Target",
        name: "run",
        arity: 0,
        dyn: false,
        partition: "test",
      },
      structuralWire({ file, partition: "test", bytes: 8 * 1024 * 1024 + 1 }),
      { k: "phase", protocol: 2, phase: "test", status: "complete" },
    ];
    const parsed = parseTestTraceOutput(lines.map((line) => JSON.stringify(line)).join("\n"));
    expect(parsed.testPartition).toBe("complete");
    expect(parsed.structuralPartition).toBe("incomplete");
    expect(parsed.modules).toHaveLength(1);
    expect(parsed.functions).toHaveLength(1);
    expect(parsed.events).toHaveLength(1);
    expect(parsed.structuralFiles).toEqual([]);
  });

  it.each(["missing", "duplicate", "mismatched", "malformed", "invalid-reference"])(
    "drops a %s test structural summary/bundle without dropping test semantics",
    (failure) => {
      const file = "test/neutral_test.exs";
      const mod = "Neutral.Test";
      const event = eventRecord(0, file, mod, "test", 3);
      const structure = structuralFile(file, mod, "test", [0]);
      const summary = structuralSummary("test", [structure], 1);
      let structuralRecords: readonly Record<string, unknown>[] = [
        structuralFileWire(structure),
        structuralSummaryWire(summary),
      ];
      if (failure === "missing") structuralRecords = [structuralFileWire(structure)];
      if (failure === "duplicate") {
        structuralRecords = [
          structuralFileWire(structure),
          structuralSummaryWire(summary),
          structuralSummaryWire(summary),
        ];
      }
      if (failure === "mismatched") {
        structuralRecords = [
          structuralFileWire(structure),
          structuralSummaryWire({ ...summary, facts: summary.facts + 1 }),
        ];
      }
      if (failure === "malformed") {
        structuralRecords = [
          structuralFileWire(structure),
          { ...structuralSummaryWire(summary), extra: true },
        ];
      }
      if (failure === "invalid-reference") {
        structuralRecords = [
          structuralFileWire({
            ...structure,
            facts: structure.facts.map((fact) => ({ ...fact, eventId: 99 })),
          }),
          structuralSummaryWire(summary),
        ];
      }
      const lines = [
        { k: "phase", protocol: 2, phase: "test", status: "started" },
        { k: "owner", mod, file, partition: "test" },
        moduleRecord(file, mod, "test"),
        wireFunctionRecord(file, mod, "test"),
        {
          k: "event",
          id: event.eventId,
          kind: event.kind,
          call_kind: event.callKind,
          file: event.file,
          line: event.line,
          column: event.column,
          from_mod: event.from_mod,
          from_fun: event.from_fun,
          to_mod: event.to_mod,
          name: event.name,
          arity: event.arity,
          dyn: event.dyn,
          partition: event.partition,
        },
        ...structuralRecords,
        { k: "phase", protocol: 2, phase: "test", status: "complete" },
      ];
      const parsed = parseTestTraceOutput(lines.map((line) => JSON.stringify(line)).join("\n"));
      expect(parsed).toMatchObject({
        testPartition: "complete",
        structuralPartition: "incomplete",
        structuralFiles: [],
      });
      expect(parsed.events).toHaveLength(1);
      expect(parsed.modules).toHaveLength(1);
      expect(parsed.functions).toHaveLength(1);
      expect(parsed.structuralSummary).toBeUndefined();
    },
  );

  it("retains a valid test structural summary as a separately labelled partition", () => {
    const prodFile = "lib/neutral.ex";
    const testFile = "test/neutral_test.exs";
    const prodStructure = {
      ...structuralFile(prodFile, "Neutral", "prod", []),
      status: "incomplete" as const,
      reason: "parse" as const,
      digest: "0".repeat(64),
      bytes: 0,
      astNodes: 0,
      maxDepth: 0,
      carriers: [],
      facts: [],
    };
    const production = {
      ...trace(prodFile, "Neutral", "prod", [], prodStructure),
      structuralSummary: structuralSummary("prod", [prodStructure]),
    };
    const testStructure = {
      ...structuralFile(testFile, "Neutral.Test", "test", []),
      status: "incomplete" as const,
      reason: "parse" as const,
      digest: "0".repeat(64),
      bytes: 0,
      astNodes: 0,
      maxDepth: 0,
      carriers: [],
      facts: [],
    };
    const testSummary = structuralSummary("test", [testStructure]);
    const merged = mergeTraceResults(production, {
      events: [],
      modules: [moduleRecord(testFile, "Neutral.Test", "test")],
      functions: [functionRecord(testFile, "Neutral.Test", "test")],
      structuralFiles: [testStructure],
      structuralSummary: testSummary,
      structuralPartition: "complete",
      testPartition: "complete",
    });
    expect(merged.structuralSummary?.partition).toBe("prod");
    expect(merged.structuralTestSummary).toEqual(testSummary);
  });

  it("drops a production re-emission mismatch without discarding test-only semantics", () => {
    const root = mkdtempSync(join(tmpdir(), "unused-structure-merge-"));
    temporaryRoots.push(root);
    mkdirSync(join(root, "lib"));
    mkdirSync(join(root, "test"));
    const prodFile = "lib/neutral.ex";
    const testFile = "test/neutral_test.exs";
    writeFileSync(join(root, prodFile), "x");
    writeFileSync(join(root, testFile), "x");
    const digest = createHash("sha256").update("x").digest("hex");
    const emptyStructure = (
      file: string,
      partition: Partition,
      astNodes: number,
    ): ElixirStructuralFile => ({
      k: "structure_file",
      file,
      partition,
      digest,
      bytes: 1,
      status: "complete",
      reason: null,
      astNodes,
      maxDepth: 1,
      carriers: [],
      facts: [],
    });
    const production = {
      ...trace(prodFile, "Neutral", "prod", [], emptyStructure(prodFile, "prod", 1)),
    };
    const productionModule = production.modules[0];
    const productionFunction = production.functions[0];
    if (productionModule === undefined || productionFunction === undefined) {
      throw new Error("expected the neutral production owner");
    }
    const testEvent = eventRecord(0, testFile, "Neutral.Test", "test", 1);
    const result = validateTestTraceOwnership(
      production,
      {
        events: [testEvent],
        modules: [
          { ...productionModule, partition: "test" },
          moduleRecord(testFile, "Neutral.Test", "test"),
        ],
        functions: [
          { ...productionFunction, partition: "test" },
          functionRecord(testFile, "Neutral.Test", "test"),
        ],
        structuralFiles: [emptyStructure(prodFile, "test", 2), emptyStructure(testFile, "test", 1)],
        testPartition: "complete",
      },
      { productionFiles: [prodFile], testFiles: [testFile], testOnlyRoots: ["test"] },
      root,
    );
    expect(result.structuralPartition).toBe("incomplete");
    expect(result.structuralFiles).toEqual([]);
    expect(result.events).toEqual([testEvent]);
    expect(result.modules.map((module) => module.mod)).toEqual(["Neutral.Test"]);
    expect(result.functions.map((fn) => fn.mod)).toEqual(["Neutral.Test"]);
    expect(result.testPartition).toBe("complete");
  });
});

describe("Elixir structural event identity", () => {
  it("preserves same-line same-callee structural identities without duplicating semantic events", () => {
    const file = "lib/neutral.ex";
    const events = [
      eventRecord(0, file, "Neutral", "prod", 3),
      eventRecord(1, file, "Neutral", "prod", 17),
    ];
    const result = mergeTraceResults(
      trace(file, "Neutral", "prod", events, structuralFile(file, "Neutral", "prod", [0, 1])),
      { events: [], modules: [], functions: [], structuralFiles: [], testPartition: "complete" },
    );
    expect(result.events).toHaveLength(1);
    expect(result.events[0]).not.toHaveProperty("column");
    expect(result.structuralEvents?.map((event) => event.column)).toEqual([17, 3]);
    expect(new Set(result.structuralFiles?.[0]?.facts.map((fact) => fact.eventId)).size).toBe(2);
  });

  it("coalesces duplicate compiler events and their remapped facts", () => {
    const file = "lib/neutral.ex";
    const events = [
      eventRecord(0, file, "Neutral", "prod", 3),
      eventRecord(1, file, "Neutral", "prod", 3),
    ];
    const result = mergeTraceResults(
      trace(
        file,
        "Neutral",
        "prod",
        events,
        structuralFile(file, "Neutral", "prod", [0, 1], [3, 3]),
      ),
      { events: [], modules: [], functions: [], structuralFiles: [], testPartition: "complete" },
    );
    expect(result.events).toHaveLength(1);
    expect(result.structuralEvents).toHaveLength(1);
    expect(result.structuralFiles?.[0]?.facts).toHaveLength(1);
    expect(result.structuralFiles?.[0]?.facts[0]?.eventId).toBe(
      result.structuralEvents?.[0]?.eventId,
    );
  });

  it("remaps colliding production and test wire IDs to distinct canonical events", () => {
    const prodFile = "lib/neutral.ex";
    const testFile = "test/neutral_test.exs";
    const production = trace(
      prodFile,
      "Neutral",
      "prod",
      [eventRecord(0, prodFile, "Neutral", "prod", 3)],
      structuralFile(prodFile, "Neutral", "prod", [0]),
    );
    const testEvent = eventRecord(0, testFile, "Neutral.Test", "test", 3);
    const result = mergeTraceResults(production, {
      events: [testEvent],
      modules: [moduleRecord(testFile, "Neutral.Test", "test")],
      functions: [functionRecord(testFile, "Neutral.Test", "test")],
      structuralFiles: [structuralFile(testFile, "Neutral.Test", "test", [0])],
      testPartition: "complete",
    });
    expect(result.events).toHaveLength(2);
    expect(result.structuralEvents).toHaveLength(2);
    const byPartition = new Map(
      result.structuralEvents?.map((event) => [event.partition, event.eventId]),
    );
    expect(byPartition.get("prod")).not.toBe(byPartition.get("test"));
    for (const file of result.structuralFiles ?? []) {
      expect(file.facts[0]?.eventId).toBe(byPartition.get(file.partition));
    }
  });

  it("accepts an exact pipeline argument whose compiler coordinate is inside the call span", () => {
    const root = mkdtempSync(join(tmpdir(), "unused-structure-pipeline-"));
    temporaryRoots.push(root);
    mkdirSync(join(root, "lib"));
    const file = "lib/neutral.ex";
    const content = " ".repeat(63);
    writeFileSync(join(root, file), content);
    const event = eventRecord(0, file, "Neutral", "prod", 17);
    const structure: ElixirStructuralFile = {
      ...structuralFile(file, "Neutral", "prod", [0]),
      digest: createHash("sha256").update(content).digest("hex"),
      bytes: Buffer.byteLength(content),
      facts: [
        {
          ...(structuralFile(file, "Neutral", "prod", [0]).facts[0] as NonNullable<
            ElixirStructuralFile["facts"][number]
          >),
          role: "pipeline-argument",
          to: { sl: 1, sc: 1, el: 1, ec: 32 },
        },
      ],
    };
    expect(
      validateProductionTraceOwnership(
        trace(file, "Neutral", "prod", [event], structure),
        ["lib"],
        root,
      ).structuralFiles,
    ).toHaveLength(1);
  });

  it("rejects a pipeline fact that references a left-operand call at pipeline start", () => {
    const root = mkdtempSync(join(tmpdir(), "unused-structure-left-pipeline-event-"));
    temporaryRoots.push(root);
    mkdirSync(join(root, "lib"));
    const file = "lib/neutral.ex";
    const content = " ".repeat(63);
    writeFileSync(join(root, file), content);
    const event = eventRecord(0, file, "Neutral", "prod", 1);
    const original = structuralFile(file, "Neutral", "prod", [0]);
    const structure: ElixirStructuralFile = {
      ...original,
      digest: createHash("sha256").update(content).digest("hex"),
      bytes: Buffer.byteLength(content),
      facts: original.facts.map((fact) => ({
        ...fact,
        role: "pipeline-argument",
        from: { sl: 1, sc: 1, el: 1, ec: 8 },
        to: { sl: 1, sc: 1, el: 1, ec: 32 },
      })),
    };
    expect(() =>
      validateProductionTraceOwnership(
        trace(file, "Neutral", "prod", [event], structure),
        ["lib"],
        root,
      ),
    ).toThrow(/structural event ownership/);
  });

  it("drops a test structural overlay whose pipeline fact joins to its left operand", () => {
    const file = "test/neutral_test.exs";
    const mod = "Neutral.Test";
    const event = eventRecord(0, file, mod, "test", 1);
    const original = structuralFile(file, mod, "test", [0]);
    const structure: ElixirStructuralFile = {
      ...original,
      facts: original.facts.map((fact) => ({
        ...fact,
        role: "pipeline-argument",
        from: { sl: 1, sc: 1, el: 1, ec: 8 },
        to: { sl: 1, sc: 1, el: 1, ec: 32 },
      })),
    };
    const lines = [
      { k: "phase", protocol: 2, phase: "test", status: "started" },
      { k: "owner", mod, file, partition: "test" },
      moduleRecord(file, mod, "test"),
      wireFunctionRecord(file, mod, "test"),
      {
        k: "event",
        id: event.eventId,
        kind: event.kind,
        call_kind: event.callKind,
        file: event.file,
        line: event.line,
        column: event.column,
        from_mod: event.from_mod,
        from_fun: event.from_fun,
        to_mod: event.to_mod,
        name: event.name,
        arity: event.arity,
        dyn: event.dyn,
        partition: event.partition,
      },
      structuralFileWire(structure),
      structuralSummaryWire(structuralSummary("test", [structure], 1)),
      { k: "phase", protocol: 2, phase: "test", status: "complete" },
    ];
    expect(
      parseTestTraceOutput(lines.map((line) => JSON.stringify(line)).join("\n")),
    ).toMatchObject({
      testPartition: "complete",
      structuralPartition: "incomplete",
      structuralFiles: [],
    });
  });

  it.each([
    ["non-dense carrier", { carrierId: 1 }],
    ["zero event column", { column: 0 }],
    ["argument equal to arity", { argument: 1 }],
    ["nested event inside an ordinary call span", { column: 17, targetEnd: 32 }],
    ["event outside target span", { column: 63, targetEnd: 32 }],
  ])("rejects an exact join with a %s", (_label, change) => {
    const mutation = change as {
      readonly carrierId?: number;
      readonly column?: number;
      readonly argument?: number;
      readonly targetEnd?: number;
    };
    const root = mkdtempSync(join(tmpdir(), "unused-structure-invalid-join-"));
    temporaryRoots.push(root);
    mkdirSync(join(root, "lib"));
    const file = "lib/neutral.ex";
    const content = " ".repeat(63);
    writeFileSync(join(root, file), content);
    const event = eventRecord(0, file, "Neutral", "prod", mutation.column ?? 3);
    const original = structuralFile(file, "Neutral", "prod", [0]);
    const structure: ElixirStructuralFile = {
      ...original,
      digest: createHash("sha256").update(content).digest("hex"),
      bytes: Buffer.byteLength(content),
      carriers: original.carriers.map((carrier) => ({
        ...carrier,
        id: mutation.carrierId ?? carrier.id,
      })),
      facts: original.facts.map((fact) => ({
        ...fact,
        carrier: mutation.carrierId ?? fact.carrier,
        argument: mutation.argument ?? fact.argument,
        to:
          mutation.targetEnd === undefined || fact.to === null
            ? fact.to
            : { ...fact.to, ec: mutation.targetEnd },
      })),
    };
    expect(() =>
      validateProductionTraceOwnership(
        trace(file, "Neutral", "prod", [event], structure),
        ["lib"],
        root,
      ),
    ).toThrow(/structural/);
  });

  it("keeps base and v2 graph, claims, hazards, why evidence, and deletion plans identical", () => {
    const file = "lib/neutral.ex";
    const events = [
      { ...eventRecord(0, file, "Neutral", "prod", 3), dyn: true },
      {
        ...eventRecord(1, file, "Neutral", "prod", 17),
        callKind: "macro" as const,
        dyn: true,
      },
    ];
    const v2 = stableTraceResult(
      trace(file, "Neutral", "prod", events, structuralFile(file, "Neutral", "prod", [0, 1])),
    );
    const {
      eventId: _eventId,
      column: _column,
      callKind: _callKind,
      ...baseEvent
    } = events[0] as TraceEvent;
    const base = stableTraceResult({
      ...trace(file, "Neutral", "prod", [baseEvent], structuralFile(file, "Neutral", "prod", [])),
      structuralFiles: [],
    });
    expect(v2.events).toEqual(base.events);
    expect(v2.events).toHaveLength(1);
    expect(v2.structuralEvents).toHaveLength(2);
    expect(base.structuralEvents).toHaveLength(0);
    expect(v2.structuralEvents?.map((event) => event.callKind)).toEqual(["macro", "function"]);
    expect(new Set(v2.structuralFiles?.[0]?.facts.map((fact) => fact.eventId)).size).toBe(2);
    const analyze = (traceResult: TraceResult) => {
      const graph = emitElixirIR({ traceResult, configReferencedModules: new Set() });
      const reachability = computePartitionedReachability(graph);
      const claims = emitClaims({
        graph,
        reachability,
        provenance: {
          analyzer: "elixir-reference-graph",
          version: "0.1.0",
          generatedAt: "1970-01-01T00:00:00.000Z",
        },
        language: "ex",
      });
      const why = whyAlive({ graph, reachability, claims, query: "Neutral.live/0" });
      const deletionPlan =
        why.outcome === "alive" || why.outcome === "dead"
          ? computeDeletionPlan({ graph, reachability, subject: why.subject })
          : why;
      return { claims, hazards: graph.hazards(), why, deletionPlan };
    };
    expect(analyze(v2)).toEqual(analyze(base));
  });
});
