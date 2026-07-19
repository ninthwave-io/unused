/**
 * Unit tests for Elixir IR emission + the core claim pipeline (ADR 0011),
 * driven by synthetic {@link TraceResult}s so they run WITHOUT an Elixir
 * toolchain (TS-only CI coverage). They assert the end-to-end contract: emit IR
 * → partitioned reachability → claims, including every hazard keep-alive/cap.
 */

import { describe, expect, it } from "vitest";
import { computePartitionedReachability, emitClaims } from "../../core/analysis/index.js";
import type { Claim } from "../../core/claims/types.js";
import { emitElixirIR } from "./emit.js";
import type { FunctionRecord, ModuleRecord, TraceEvent, TraceResult } from "./events.js";

// --- builders --------------------------------------------------------------

function mod(name: string, file: string, extra: Partial<ModuleRecord> = {}): ModuleRecord {
  return {
    k: "module",
    mod: name,
    file,
    line: 1,
    behaviours: [],
    protocol: false,
    impl: false,
    partition: "prod",
    ...extra,
  };
}

function fn(name: string, arity: number, ownerFile: string, ownerMod: string): FunctionRecord {
  return { k: "function", mod: ownerMod, name, arity, file: ownerFile, line: 2, partition: "prod" };
}

function callEvent(
  fromMod: string,
  fromFun: string | undefined,
  toMod: string,
  name: string | undefined,
  arity: number | undefined,
  extra: Partial<TraceEvent> = {},
): TraceEvent {
  return {
    k: "event",
    kind: name === undefined ? "alias" : "remote",
    file: "lib/app/application.ex",
    line: 5,
    from_mod: fromMod,
    ...(fromFun !== undefined ? { from_fun: fromFun } : {}),
    to_mod: toMod,
    ...(name !== undefined ? { name } : {}),
    ...(arity !== undefined ? { arity } : {}),
    dyn: false,
    partition: "prod",
    ...extra,
  };
}

/** Run the full frontend-core pipeline over a synthetic trace and return claims. */
function claimsFor(
  traceResult: TraceResult,
  configReferencedModules: ReadonlySet<string> = new Set(),
): Claim[] {
  const graph = emitElixirIR({ traceResult, configReferencedModules });
  const reachability = computePartitionedReachability(graph);
  return emitClaims({
    graph,
    reachability,
    provenance: {
      analyzer: "elixir-reference-graph",
      version: "0.1.0",
      generatedAt: "1970-01-01T00:00:00.000Z",
    },
    language: "ex",
  });
}

function claim(claims: readonly Claim[], name: string): Claim | undefined {
  return claims.find((c) => c.subject.name === name);
}

// --- scenario 1: clean (no dynamic dispatch) -------------------------------

const CLEAN: TraceResult = {
  appMod: "App.Application",
  deps: [],
  compileOk: true,
  modules: [
    mod("App.Application", "lib/app/application.ex"),
    mod("App.Core", "lib/app/core.ex"),
    mod("App.Worker", "lib/app/worker.ex", { behaviours: ["GenServer"] }),
    mod("App.Orphan", "lib/app/orphan.ex"),
    mod("App.Repo", "lib/app/repo.ex"),
  ],
  functions: [
    fn("start", 2, "lib/app/application.ex", "App.Application"),
    fn("greet", 1, "lib/app/core.ex", "App.Core"),
    fn("dead", 1, "lib/app/core.ex", "App.Core"),
    fn("handle_call", 3, "lib/app/worker.ex", "App.Worker"),
    fn("start_link", 1, "lib/app/worker.ex", "App.Worker"),
    fn("thing", 0, "lib/app/orphan.ex", "App.Orphan"),
    fn("query", 1, "lib/app/repo.ex", "App.Repo"),
  ],
  events: [
    callEvent("App.Application", "start/2", "App.Core", "greet", 1),
    callEvent("App.Application", "start/2", "App.Core", undefined, undefined), // alias
    callEvent("App.Application", "start/2", "App.Worker", undefined, undefined), // supervision child
  ],
};

describe("emitElixirIR — clean scenario", () => {
  const claims = claimsFor(CLEAN, new Set(["App.Repo"]));

  it("flags a clean dead public function at high confidence", () => {
    const c = claim(claims, "App.Core.dead/1");
    expect(c?.verdict).toBe("unused");
    expect(c?.confidence).toBe("high");
    expect(c?.subject.kind).toBe("export");
  });

  it("flags an unreferenced module as a dead file at high confidence", () => {
    const c = claim(claims, "lib/app/orphan.ex");
    expect(c?.subject.kind).toBe("file");
    expect(c?.verdict).toBe("unused");
    expect(c?.confidence).toBe("high");
  });

  it("keeps a reached public function alive (no claim)", () => {
    expect(claim(claims, "App.Core.greet/1")).toBeUndefined();
  });

  it("keeps behaviour callbacks alive (elixir-behaviour-callback suppresses them)", () => {
    expect(claim(claims, "App.Worker.handle_call/3")).toBeUndefined();
    expect(claim(claims, "App.Worker.start_link/1")).toBeUndefined();
  });

  it("keeps a supervision-tree child module alive (aliased in the children list)", () => {
    expect(claim(claims, "App.Worker")).toBeUndefined();
    expect(claims.some((c) => c.subject.loc.file === "lib/app/worker.ex")).toBe(false);
  });

  it("keeps a config-referenced module alive (config root)", () => {
    expect(claims.some((c) => c.subject.loc.file === "lib/app/repo.ex")).toBe(false);
  });

  it('stamps the Elixir language slot into claim ids (kind prefix + "ex" slot)', () => {
    const c = claim(claims, "App.Core.dead/1");
    // ids are `exp_<hash>`; the hash includes the "ex" language slot, so an
    // Elixir export claim can never collide with a TS one for the same name.
    expect(c?.id.startsWith("exp_")).toBe(true);
  });
});

// --- scenario 2: dynamic dispatch caps the unit to medium ------------------

const DYNAMIC: TraceResult = {
  appMod: "App.Application",
  deps: [],
  compileOk: true,
  modules: [
    mod("App.Application", "lib/app/application.ex"),
    mod("App.Handlers", "lib/app/handlers.ex"),
    mod("App.Router", "lib/app/router.ex"),
  ],
  functions: [
    fn("start", 2, "lib/app/application.ex", "App.Application"),
    fn("ping", 0, "lib/app/handlers.ex", "App.Handlers"),
    fn("dead_handler", 0, "lib/app/handlers.ex", "App.Handlers"),
    fn("dispatch", 1, "lib/app/router.ex", "App.Router"),
  ],
  events: [
    callEvent("App.Application", "start/2", "App.Handlers", "ping", 0),
    callEvent("App.Application", "start/2", "App.Router", "dispatch", 1),
    // the apply/3 site — target module is Kernel (not a project module), so no
    // edge, but the `dyn` flag raises the elixir-dynamic-dispatch hazard.
    callEvent("App.Router", "dispatch/1", "Kernel", "apply", 3, {
      dyn: true,
      file: "lib/app/router.ex",
    }),
  ],
};

describe("emitElixirIR — dynamic dispatch", () => {
  const claims = claimsFor(DYNAMIC);

  it("caps a dead function to medium when the unit performs apply/3", () => {
    const c = claim(claims, "App.Handlers.dead_handler/0");
    expect(c?.verdict).toBe("unused");
    expect(c?.confidence).toBe("medium");
  });

  it("still keeps a statically-called function alive", () => {
    expect(claim(claims, "App.Handlers.ping/0")).toBeUndefined();
  });
});

// --- scenario 3: no production entrypoint => no claims ---------------------

describe("emitElixirIR — no production entrypoint", () => {
  it("proves nothing when there is no application callback / mix task / phoenix root", () => {
    const noRoot: TraceResult = {
      appMod: null,
      deps: [],
      compileOk: true,
      modules: [mod("Lib.Thing", "lib/lib/thing.ex")],
      functions: [fn("do_it", 0, "lib/lib/thing.ex", "Lib.Thing")],
      events: [],
    };
    expect(claimsFor(noRoot)).toHaveLength(0);
  });
});
