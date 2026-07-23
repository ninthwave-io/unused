import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { computeDeletionPlan, whyAlive } from "../../core/analysis/index.js";
import { isMixAvailable } from "../../testing/corpus/elixir-corpus.js";
import { analyzeProjectAutoWithGraph } from "../dispatch.js";
import { analyzeElixirProjectWithGraph } from "./analyze.js";
import { runTracer } from "./runner.js";
import { extractElixirRuntimeConventions } from "./runtime-references.js";

const fixture = (name: string): string =>
  fileURLToPath(new URL(`../../../../../fixtures/elixir/${name}`, import.meta.url));
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe.skipIf(!isMixAvailable())("real Elixir dynamic-hazard roles", () => {
  it("accounts for every literal guarded use-helper invocation without an opaque cap", async () => {
    const root = fixture("dynamic-use-helpers");
    const trace = runTracer(root);
    expect(
      trace.events
        .filter(
          (event) =>
            event.file.endsWith("controller.ex") && event.line === 2 && event.name === "__using__",
        )
        .map((event) => event.to_mod)
        .sort(),
    ).toEqual(["NeutralUse.NestedFirst", "NeutralUse.NestedSecond", "NeutralUse.Web"]);
    const analysis = await analyzeElixirProjectWithGraph(root, {
      now: new Date(0),
    });
    expect(
      analysis.graph
        .hazards()
        .filter(
          (hazard) =>
            hazard.hazardClass === "elixir-dynamic-dispatch" ||
            hazard.hazardClass === "elixir-computed-atom-escape",
        ),
    ).toEqual([]);

    const selected = whyAlive({
      graph: analysis.graph,
      reachability: analysis.reachability,
      claims: analysis.result.claims,
      query: "NeutralUse.Web.controller/0",
      hazardEvaluations: [analysis.hazardEvaluation],
    });
    expect(selected).toMatchObject({ outcome: "alive", entrypointKind: "production" });
    if (selected.outcome !== "alive") throw new Error("expected selected helper to be alive");
    expect(
      computeDeletionPlan({
        graph: analysis.graph,
        reachability: analysis.reachability,
        subject: selected.subject,
        hazardEvaluations: [analysis.hazardEvaluation],
      }),
    ).toMatchObject({ supported: false });

    const dead = whyAlive({
      graph: analysis.graph,
      reachability: analysis.reachability,
      claims: analysis.result.claims,
      query: "NeutralUse.Web.genuinely_unused/0",
      hazardEvaluations: [analysis.hazardEvaluation],
    });
    expect(dead).toMatchObject({ outcome: "dead", confidence: "high" });
    if (dead.outcome !== "dead") throw new Error("expected unused helper");
    expect(
      computeDeletionPlan({
        graph: analysis.graph,
        reachability: analysis.reachability,
        subject: dead.subject,
        hazardEvaluations: [analysis.hazardEvaluation],
      }),
    ).toMatchObject({ supported: true });

    const sameFileDecoy = whyAlive({
      graph: analysis.graph,
      reachability: analysis.reachability,
      claims: analysis.result.claims,
      query: "NeutralUse.Decoy.controller/0",
      hazardEvaluations: [analysis.hazardEvaluation],
    });
    expect(sameFileDecoy).toMatchObject({ outcome: "dead", confidence: "high" });
  }, 60_000);

  it("keeps computed-argument __MODULE__ dispatch local to its owner module", async () => {
    const analysis = await analyzeElixirProjectWithGraph(fixture("dynamic-local-dispatch"), {
      now: new Date(0),
    });
    const hazards = analysis.graph
      .hazards()
      .filter((hazard) => hazard.hazardClass === "elixir-dynamic-dispatch");
    expect(hazards).toEqual([
      expect.objectContaining({
        carrierSymbol: expect.stringContaining("NeutralLocal.Dispatch.dispatch/2"),
        effect: {
          scope: {
            kind: "symbols",
            ids: expect.arrayContaining([
              expect.stringContaining("NeutralLocal.Dispatch.possible_action/1"),
            ]),
          },
          worlds: ["production"],
        },
      }),
    ]);
    const scope = hazards[0]?.effect?.scope;
    expect(
      scope?.kind === "symbols" &&
        scope.ids.some((symbol) => symbol.includes("NeutralLocal.Unrelated")),
    ).toBe(false);

    const possible = whyAlive({
      graph: analysis.graph,
      reachability: analysis.reachability,
      claims: analysis.result.claims,
      query: "NeutralLocal.Dispatch.possible_action/1",
      hazardEvaluations: [analysis.hazardEvaluation],
    });
    expect(possible).toMatchObject({ outcome: "dead", confidence: "medium" });
    if (possible.outcome !== "dead") throw new Error("expected local dynamic candidate");
    expect(
      computeDeletionPlan({
        graph: analysis.graph,
        reachability: analysis.reachability,
        subject: possible.subject,
        hazardEvaluations: [analysis.hazardEvaluation],
      }),
    ).toMatchObject({ supported: false });

    const unrelated = whyAlive({
      graph: analysis.graph,
      reachability: analysis.reachability,
      claims: analysis.result.claims,
      query: "lib/neutral_local/unrelated.ex",
      hazardEvaluations: [analysis.hazardEvaluation],
    });
    expect(unrelated).toMatchObject({ outcome: "dead", confidence: "high" });
    if (unrelated.outcome !== "dead") throw new Error("expected unrelated dead module");
    expect(
      computeDeletionPlan({
        graph: analysis.graph,
        reachability: analysis.reachability,
        subject: unrelated.subject,
        hazardEvaluations: [analysis.hazardEvaluation],
      }),
    ).toMatchObject({ supported: true });
  }, 60_000);

  it("keeps a runtime-selected module boundary-wide for why and deletion", async () => {
    const analysis = await analyzeElixirProjectWithGraph(fixture("dynamic-global-dispatch"), {
      now: new Date(0),
    });
    const hazards = analysis.graph
      .hazards()
      .filter((hazard) => hazard.hazardClass === "elixir-dynamic-dispatch");
    expect(hazards).toEqual([
      expect.objectContaining({
        carrierSymbol: expect.stringContaining("NeutralGlobal.Dispatch.dispatch/3"),
      }),
    ]);
    expect(hazards[0]?.effect).toEqual({
      scope: { kind: "unit" },
      worlds: ["production"],
    });

    const unrelated = whyAlive({
      graph: analysis.graph,
      reachability: analysis.reachability,
      claims: analysis.result.claims,
      query: "lib/neutral_global/unrelated.ex",
      hazardEvaluations: [analysis.hazardEvaluation],
    });
    expect(unrelated).toMatchObject({ outcome: "dead", confidence: "medium" });
    if (unrelated.outcome !== "dead") throw new Error("expected globally uncertain dead module");
    expect(
      computeDeletionPlan({
        graph: analysis.graph,
        reachability: analysis.reachability,
        subject: unrelated.subject,
        hazardEvaluations: [analysis.hazardEvaluation],
      }),
    ).toMatchObject({ supported: false, stages: [] });
  }, 60_000);

  it("treats direct Map-key atom production as data and masks inert text", async () => {
    const root = fixture("atom-map-key-safe");
    const trace = runTracer(root);
    expect(trace.events.filter((event) => event.dyn)).toHaveLength(4);
    expect(
      trace.events
        .filter((event) => event.from_fun === "rebuild/1" && event.to_mod === "Enum")
        .map((event) => `${event.name}/${event.arity}`),
    ).toEqual(expect.arrayContaining(["map/2", "into/2"]));
    const analysis = await analyzeElixirProjectWithGraph(root, { now: new Date(0) });
    expect(
      analysis.graph
        .hazards()
        .filter(
          (hazard) =>
            hazard.hazardClass === "elixir-dynamic-dispatch" ||
            hazard.hazardClass === "elixir-computed-atom-escape",
        ),
    ).toEqual([]);
    const rebuilt = whyAlive({
      graph: analysis.graph,
      reachability: analysis.reachability,
      claims: analysis.result.claims,
      query: "NeutralAtomKey.Lookup.rebuild/1",
      hazardEvaluations: [analysis.hazardEvaluation],
    });
    expect(rebuilt).toMatchObject({ outcome: "alive", entrypointKind: "production" });
    if (rebuilt.outcome !== "alive") throw new Error("expected map rebuild to be alive");
    expect(
      computeDeletionPlan({
        graph: analysis.graph,
        reachability: analysis.reachability,
        subject: rebuilt.subject,
        hazardEvaluations: [analysis.hazardEvaluation],
      }),
    ).toMatchObject({ supported: false });
    const dead = whyAlive({
      graph: analysis.graph,
      reachability: analysis.reachability,
      claims: analysis.result.claims,
      query: "NeutralAtomKey.Lookup.genuinely_unused/0",
      hazardEvaluations: [analysis.hazardEvaluation],
    });
    expect(dead).toMatchObject({ outcome: "dead", confidence: "high" });
    if (dead.outcome !== "dead") throw new Error("expected dead Map-key sibling");
    expect(
      computeDeletionPlan({
        graph: analysis.graph,
        reachability: analysis.reachability,
        subject: dead.subject,
        hazardEvaluations: [analysis.hazardEvaluation],
      }),
    ).toMatchObject({ supported: true });
  }, 60_000);

  it("keeps guarded assigned atoms in compiler-confirmed Enum map values as data", async () => {
    const root = fixture("atom-assigned-data-safe");
    const trace = runTracer(root);
    expect(
      trace.events.filter(
        (event) =>
          event.dyn &&
          event.from_fun === "normalize_entries/2" &&
          event.to_mod === "String" &&
          event.name === "to_existing_atom" &&
          event.arity === 1,
      ),
    ).toHaveLength(1);
    expect(
      trace.functions.some(
        (candidate) =>
          candidate.mod === "NeutralAtomData.Normalizer" && candidate.name === "normalize_entries",
      ),
    ).toBe(false);

    const analysis = await analyzeElixirProjectWithGraph(root, { now: new Date(0) });
    expect(
      analysis.graph
        .hazards()
        .filter(
          (hazard) =>
            hazard.hazardClass === "elixir-dynamic-dispatch" ||
            hazard.hazardClass === "elixir-computed-atom-escape",
        ),
    ).toEqual([]);
    const dead = whyAlive({
      graph: analysis.graph,
      reachability: analysis.reachability,
      claims: analysis.result.claims,
      query: "NeutralAtomData.Normalizer.genuinely_unused/0",
      hazardEvaluations: [analysis.hazardEvaluation],
    });
    expect(dead).toMatchObject({ outcome: "dead", confidence: "high" });
    if (dead.outcome !== "dead") throw new Error("expected unrelated dead normalizer export");
    expect(
      computeDeletionPlan({
        graph: analysis.graph,
        reachability: analysis.reachability,
        subject: dead.subject,
        hazardEvaluations: [analysis.hazardEvaluation],
      }),
    ).toMatchObject({ supported: true });
  }, 60_000);

  it("keeps clause-guarded inline atoms in rescued Map.put values as data", async () => {
    const root = fixture("atom-inline-map-put-safe");
    const trace = runTracer(root);
    expect(
      trace.events.filter(
        (event) =>
          event.dyn &&
          event.from_fun === "normalize_kind/2" &&
          event.to_mod === "String" &&
          event.name === "to_existing_atom" &&
          event.arity === 1,
      ),
    ).toHaveLength(1);
    expect(
      trace.functions.some(
        (candidate) =>
          candidate.mod === "NeutralRequestData.Normalizer" && candidate.name === "normalize_kind",
      ),
    ).toBe(false);

    const analysis = await analyzeElixirProjectWithGraph(root, { now: new Date(0) });
    expect(
      analysis.graph
        .hazards()
        .filter(
          (hazard) =>
            hazard.hazardClass === "elixir-dynamic-dispatch" ||
            hazard.hazardClass === "elixir-computed-atom-escape",
        ),
    ).toEqual([]);
    const alive = whyAlive({
      graph: analysis.graph,
      reachability: analysis.reachability,
      claims: analysis.result.claims,
      query: "NeutralRequestData.Normalizer.normalize/1",
      hazardEvaluations: [analysis.hazardEvaluation],
    });
    expect(alive).toMatchObject({ outcome: "alive", entrypointKind: "production" });
    if (alive.outcome !== "alive") throw new Error("expected request normalizer to be alive");
    expect(
      computeDeletionPlan({
        graph: analysis.graph,
        reachability: analysis.reachability,
        subject: alive.subject,
        hazardEvaluations: [analysis.hazardEvaluation],
      }),
    ).toMatchObject({ supported: false });
    const dead = whyAlive({
      graph: analysis.graph,
      reachability: analysis.reachability,
      claims: analysis.result.claims,
      query: "NeutralRequestData.Normalizer.genuinely_unused/0",
      hazardEvaluations: [analysis.hazardEvaluation],
    });
    expect(dead).toMatchObject({ outcome: "dead", confidence: "high" });
    if (dead.outcome !== "dead") throw new Error("expected unrelated dead request export");
    expect(
      computeDeletionPlan({
        graph: analysis.graph,
        reachability: analysis.reachability,
        subject: dead.subject,
        hazardEvaluations: [analysis.hazardEvaluation],
      }),
    ).toMatchObject({ supported: true });
  }, 60_000);

  it("keeps exact Map.fetch success-tuple binders in rescued Map.put values as data", async () => {
    const root = fixture("atom-fetch-map-put-safe");
    const trace = runTracer(root);
    expect(
      trace.events.filter(
        (event) =>
          event.dyn &&
          event.from_fun === "normalize_params/1" &&
          event.to_mod === "String" &&
          event.name === "to_existing_atom" &&
          event.arity === 1,
      ),
    ).toHaveLength(1);
    expect(
      trace.functions.some(
        (candidate) =>
          candidate.mod === "NeutralFetchData.Normalizer" && candidate.name === "normalize_params",
      ),
    ).toBe(false);

    const analysis = await analyzeElixirProjectWithGraph(root, { now: new Date(0) });
    expect(
      analysis.graph
        .hazards()
        .filter(
          (hazard) =>
            hazard.hazardClass === "elixir-dynamic-dispatch" ||
            hazard.hazardClass === "elixir-computed-atom-escape",
        ),
    ).toEqual([]);
    const alive = whyAlive({
      graph: analysis.graph,
      reachability: analysis.reachability,
      claims: analysis.result.claims,
      query: "NeutralFetchData.Normalizer.normalize/1",
      hazardEvaluations: [analysis.hazardEvaluation],
    });
    expect(alive).toMatchObject({ outcome: "alive", entrypointKind: "production" });
    if (alive.outcome !== "alive")
      throw new Error("expected fetched request normalizer to be alive");
    expect(
      computeDeletionPlan({
        graph: analysis.graph,
        reachability: analysis.reachability,
        subject: alive.subject,
        hazardEvaluations: [analysis.hazardEvaluation],
      }),
    ).toMatchObject({ supported: false });
    const dead = whyAlive({
      graph: analysis.graph,
      reachability: analysis.reachability,
      claims: analysis.result.claims,
      query: "NeutralFetchData.Normalizer.genuinely_unused/0",
      hazardEvaluations: [analysis.hazardEvaluation],
    });
    expect(dead).toMatchObject({ outcome: "dead", confidence: "high" });
    if (dead.outcome !== "dead") throw new Error("expected unrelated dead fetched export");
    expect(
      computeDeletionPlan({
        graph: analysis.graph,
        reachability: analysis.reachability,
        subject: dead.subject,
        hazardEvaluations: [analysis.hazardEvaluation],
      }),
    ).toMatchObject({ supported: true });
  }, 60_000);

  it("keeps invocation-sink, tuple, intervening, and mixed atom flows opaque", async () => {
    const analysis = await analyzeElixirProjectWithGraph(fixture("atom-dynamic-receiver"), {
      now: new Date(0),
    });
    const invocationHazards = analysis.graph
      .hazards()
      .filter((hazard) => hazard.hazardClass === "elixir-dynamic-dispatch");
    expect(invocationHazards.map((hazard) => hazard.carrierSymbol).sort()).toEqual([
      expect.stringContaining("assigned/2"),
      expect.stringContaining("assigned_apply/2"),
      expect.stringContaining("assigned_capture/2"),
      expect.stringContaining("assigned_mfa/2"),
      expect.stringContaining("immediate/1"),
      expect.stringContaining("mfa_pipeline/1"),
      expect.stringContaining("mixed/2"),
    ]);
    const escapeHazards = analysis.graph
      .hazards()
      .filter((hazard) => hazard.hazardClass === "elixir-computed-atom-escape");
    expect(escapeHazards.map((hazard) => hazard.carrierSymbol).sort()).toEqual([
      expect.stringContaining("inline_dynamic_key/3"),
      expect.stringContaining("intervening_pipeline/1"),
      expect.stringContaining("nested_pipeline/1"),
      expect.stringContaining("sequenced_pipeline/1"),
      expect.stringContaining("tuple_only/2"),
    ]);
    for (const hazard of escapeHazards) {
      expect(hazard.effect).toEqual({ scope: { kind: "unit" }, worlds: ["production"] });
    }
    expect(
      invocationHazards.find((hazard) => hazard.carrierSymbol?.includes("assigned_apply/2"))
        ?.effect,
    ).toEqual({
      scope: {
        kind: "symbols",
        ids: [expect.stringContaining("NeutralAtomFlow.Target.run/0")],
      },
      worlds: ["production"],
    });
    for (const hazard of invocationHazards.filter(
      (candidate) => !candidate.carrierSymbol?.includes("assigned_apply/2"),
    )) {
      expect(hazard.effect).toEqual({ scope: { kind: "unit" }, worlds: ["production"] });
    }
    const dead = whyAlive({
      graph: analysis.graph,
      reachability: analysis.reachability,
      claims: analysis.result.claims,
      query: "lib/neutral_atom_flow/target.ex",
      hazardEvaluations: [analysis.hazardEvaluation],
    });
    expect(dead).toMatchObject({ outcome: "dead", confidence: "medium" });
    if (dead.outcome !== "dead") throw new Error("expected conservatively dead target");
    expect(
      computeDeletionPlan({
        graph: analysis.graph,
        reachability: analysis.reachability,
        subject: dead.subject,
        hazardEvaluations: [analysis.hazardEvaluation],
      }),
    ).toMatchObject({ supported: false });
  }, 60_000);

  it("keeps an indexed apply role bounded through why and deletion", async () => {
    const analysis = await analyzeElixirProjectWithGraph(fixture("atom-role-summaries"), {
      now: new Date(0),
    });
    const invocationHazards = analysis.graph
      .hazards()
      .filter((hazard) => hazard.hazardClass === "elixir-dynamic-dispatch");
    expect(invocationHazards).toEqual([
      expect.objectContaining({
        carrierSymbol: expect.stringContaining("NeutralAtomRoles.Flows.invoke/1"),
      }),
    ]);
    const escapeHazards = analysis.graph
      .hazards()
      .filter((hazard) => hazard.hazardClass === "elixir-computed-atom-escape");
    expect(escapeHazards).toEqual([]);

    for (const name of ["map_explicit", "map_piped"]) {
      expect(
        whyAlive({
          graph: analysis.graph,
          reachability: analysis.reachability,
          claims: analysis.result.claims,
          query: `NeutralAtomRoles.Flows.${name}/2`,
          hazardEvaluations: [analysis.hazardEvaluation],
        }),
      ).toMatchObject({ outcome: "alive" });
    }

    const invoked = whyAlive({
      graph: analysis.graph,
      reachability: analysis.reachability,
      claims: analysis.result.claims,
      query: "NeutralAtomRoles.Target.action/0",
      hazardEvaluations: [analysis.hazardEvaluation],
    });
    expect(invoked).toMatchObject({ outcome: "dead", confidence: "medium" });
    if (invoked.outcome !== "dead") throw new Error("expected dynamic invocation candidate");
    expect(invoked.hazards).toContainEqual(
      expect.objectContaining({
        hazardClass: "elixir-dynamic-dispatch",
        worlds: ["production"],
        site: "lib/neutral_atom_roles/flows.ex:10",
      }),
    );
    expect(
      computeDeletionPlan({
        graph: analysis.graph,
        reachability: analysis.reachability,
        subject: invoked.subject,
        hazardEvaluations: [analysis.hazardEvaluation],
      }),
    ).toMatchObject({
      supported: false,
      unsupportedReason: expect.stringContaining(
        "active elixir-dynamic-dispatch hazard at lib/neutral_atom_roles/flows.ex:10",
      ),
    });

    const unrelated = whyAlive({
      graph: analysis.graph,
      reachability: analysis.reachability,
      claims: analysis.result.claims,
      query: "NeutralAtomRoles.Flows.genuinely_unused/0",
      hazardEvaluations: [analysis.hazardEvaluation],
    });
    expect(unrelated).toMatchObject({ outcome: "dead", confidence: "high", hazards: [] });
    if (unrelated.outcome !== "dead") throw new Error("expected unrelated invocation control");
    expect(
      computeDeletionPlan({
        graph: analysis.graph,
        reachability: analysis.reachability,
        subject: unrelated.subject,
        hazardEvaluations: [analysis.hazardEvaluation],
      }),
    ).toMatchObject({ supported: true });
  }, 60_000);

  it("explains and refuses an isolated returned-value escape", async () => {
    const analysis = await analyzeElixirProjectWithGraph(fixture("atom-role-escape"), {
      now: new Date(0),
    });
    const escaped = whyAlive({
      graph: analysis.graph,
      reachability: analysis.reachability,
      claims: analysis.result.claims,
      query: "NeutralAtomEscape.Flow.genuinely_unused/0",
      hazardEvaluations: [analysis.hazardEvaluation],
    });
    expect(
      analysis.graph
        .hazards()
        .filter((hazard) => hazard.hazardClass === "elixir-computed-atom-escape")
        .map((hazard) => hazard.carrierSymbol)
        .sort(),
    ).toEqual([
      expect.stringContaining("NeutralAtomEscape.Flow.enum_callback_input/1"),
      expect.stringContaining("NeutralAtomEscape.Flow.escaped_value/2"),
      expect.stringContaining("NeutralAtomEscape.Flow.keyword_callback_input/1"),
      expect.stringContaining("NeutralAtomEscape.Flow.map_callback_input/1"),
    ]);
    expect(escaped).toMatchObject({ outcome: "dead", confidence: "medium" });
    if (escaped.outcome !== "dead") throw new Error("expected isolated escape candidate");
    expect(escaped.hazards).toContainEqual(
      expect.objectContaining({
        hazardClass: "elixir-computed-atom-escape",
        worlds: ["production"],
        site: "lib/neutral_atom_escape/flow.ex:3",
      }),
    );
    expect(
      computeDeletionPlan({
        graph: analysis.graph,
        reachability: analysis.reachability,
        subject: escaped.subject,
        hazardEvaluations: [analysis.hazardEvaluation],
      }),
    ).toMatchObject({
      supported: false,
      stages: [],
      unsupportedReason: expect.stringContaining(
        "computed atom escapes analysis at lib/neutral_atom_escape/flow.ex:3 in production",
      ),
    });
  }, 60_000);

  it("leaves an unrelated dead control deletable after an indexed data sink", async () => {
    const analysis = await analyzeElixirProjectWithGraph(fixture("atom-role-data-safe"), {
      now: new Date(0),
    });
    expect(
      analysis.graph
        .hazards()
        .filter(
          (hazard) =>
            hazard.hazardClass === "elixir-dynamic-dispatch" ||
            hazard.hazardClass === "elixir-computed-atom-escape",
        ),
    ).toEqual([]);
    const dead = whyAlive({
      graph: analysis.graph,
      reachability: analysis.reachability,
      claims: analysis.result.claims,
      query: "NeutralAtomData.Flow.genuinely_unused/0",
      hazardEvaluations: [analysis.hazardEvaluation],
    });
    expect(dead).toMatchObject({ outcome: "dead", confidence: "high", hazards: [] });
    if (dead.outcome !== "dead") throw new Error("expected isolated dead data-role control");
    expect(
      computeDeletionPlan({
        graph: analysis.graph,
        reachability: analysis.reachability,
        subject: dead.subject,
        hazardEvaluations: [analysis.hazardEvaluation],
      }),
    ).toMatchObject({ supported: true });
  }, 60_000);

  it("keeps a private computed-atom data flow bounded and deletable", async () => {
    const root = fixture("atom-role-private-flow");
    const trace = runTracer(root);
    expect(extractElixirRuntimeConventions(root, trace).atomFlowStats).toMatchObject({
      privateFunctions: 2,
      privateSummaries: 3,
      privateCallEdges: 2,
      privateModuleScaffoldingEvents: 12,
      privateModuleMetadataEvents: 3,
      privateModuleTypespecEvents: 3,
      privateModuleDeclarationConstructs: 3,
      privateModuleLiteralAttributeConstructs: 1,
      privateModuleSigilAttributeConstructs: 8,
      privateModuleUseRejections: 1,
      privateModuleHookRejections: 0,
      privateModuleGeneratedRejections: 0,
      privateModuleCustomRejections: 0,
      privateModuleDeclarationRejections: 0,
      privateModuleAttributeRejections: 0,
      privateModuleSigilRejections: 0,
      privateModuleUnknownEventRejections: 0,
      privateModuleAmbiguousEventRejections: 1,
    });
    const analysis = await analyzeElixirProjectWithGraph(root, {
      now: new Date(0),
    });
    expect(
      analysis.graph
        .hazards()
        .filter((hazard) => hazard.file.includes("neutral_private_flow/safe.ex")),
    ).toEqual([]);

    const unrelated = whyAlive({
      graph: analysis.graph,
      reachability: analysis.reachability,
      claims: analysis.result.claims,
      query: "NeutralPrivateFlow.Safe.genuinely_unused/0",
      hazardEvaluations: [analysis.hazardEvaluation],
    });
    expect(unrelated).toMatchObject({ outcome: "dead", confidence: "high", hazards: [] });
    if (unrelated.outcome !== "dead") throw new Error("expected private-flow dead control");
    expect(
      computeDeletionPlan({
        graph: analysis.graph,
        reachability: analysis.reachability,
        subject: unrelated.subject,
        hazardEvaluations: [analysis.hazardEvaluation],
      }),
    ).toMatchObject({ supported: true });
  }, 60_000);

  it("explains and refuses private return and invocation boundaries", async () => {
    const analysis = await analyzeElixirProjectWithGraph(fixture("atom-role-private-unsafe"), {
      now: new Date(0),
    });
    const risky = whyAlive({
      graph: analysis.graph,
      reachability: analysis.reachability,
      claims: analysis.result.claims,
      query: "NeutralPrivateUnsafe.Flow.risky_unused/0",
      hazardEvaluations: [analysis.hazardEvaluation],
    });
    expect(risky).toMatchObject({ outcome: "dead", confidence: "medium" });
    if (risky.outcome !== "dead") throw new Error("expected private-boundary dead control");
    expect(risky.hazards).toEqual([
      expect.objectContaining({
        hazardClass: "elixir-computed-atom-escape",
        site: "lib/neutral_private_unsafe/flow.ex:7",
        worlds: ["production"],
      }),
      expect.objectContaining({
        hazardClass: "elixir-dynamic-dispatch",
        site: "lib/neutral_private_unsafe/flow.ex:8",
        worlds: ["production"],
      }),
    ]);
    expect(
      computeDeletionPlan({
        graph: analysis.graph,
        reachability: analysis.reachability,
        subject: risky.subject,
        hazardEvaluations: [analysis.hazardEvaluation],
      }),
    ).toMatchObject({ supported: false, stages: [] });
  }, 60_000);

  it("keeps exact same-module public parameter flows bounded and deletable", async () => {
    const root = fixture("atom-role-public-flow");
    const trace = runTracer(root);
    expect(extractElixirRuntimeConventions(root, trace).atomFlowStats).toMatchObject({
      privateFunctions: 0,
      privateSummaries: 0,
      privateCallEdges: 0,
      publicSummaryFunctions: 4,
      publicSummaries: 7,
      publicCallEdges: 2,
      publicSummaryMatches: 2,
      publicOpaqueFunctions: 0,
      joinedProducerOutcomes: 2,
      dataSinks: 2,
      invocationSinks: 0,
      escapes: 0,
    });
    const analysis = await analyzeElixirProjectWithGraph(root, { now: new Date(0) });
    expect(
      analysis.graph
        .hazards()
        .filter((hazard) => hazard.file.includes("neutral_public_flow/safe.ex")),
    ).toEqual([]);

    const direct = whyAlive({
      graph: analysis.graph,
      reachability: analysis.reachability,
      claims: analysis.result.claims,
      query: "NeutralPublicFlow.Safe.direct?/2",
      hazardEvaluations: [analysis.hazardEvaluation],
    });
    expect(direct).toMatchObject({ outcome: "alive" });

    const unrelated = whyAlive({
      graph: analysis.graph,
      reachability: analysis.reachability,
      claims: analysis.result.claims,
      query: "NeutralPublicFlow.Safe.genuinely_unused/0",
      hazardEvaluations: [analysis.hazardEvaluation],
    });
    expect(unrelated).toMatchObject({ outcome: "dead", confidence: "high", hazards: [] });
    if (unrelated.outcome !== "dead") throw new Error("expected public-flow dead control");
    expect(
      computeDeletionPlan({
        graph: analysis.graph,
        reachability: analysis.reachability,
        subject: unrelated.subject,
        hazardEvaluations: [analysis.hazardEvaluation],
      }),
    ).toMatchObject({ supported: true });
  }, 60_000);

  it("explains and refuses public invocation, result, and ambiguous boundaries", async () => {
    const root = fixture("atom-role-public-unsafe");
    const trace = runTracer(root);
    expect(extractElixirRuntimeConventions(root, trace).atomFlowStats).toMatchObject({
      privateFunctions: 0,
      privateSummaries: 0,
      privateCallEdges: 0,
      publicSummaryFunctions: 5,
      publicSummaries: 5,
      publicCallEdges: 2,
      publicSummaryMatches: 1,
      publicOpaqueFunctions: 0,
      joinedProducerOutcomes: 3,
      dataSinks: 0,
      invocationSinks: 1,
      escapes: 2,
    });
    const analysis = await analyzeElixirProjectWithGraph(root, { now: new Date(0) });
    const risky = whyAlive({
      graph: analysis.graph,
      reachability: analysis.reachability,
      claims: analysis.result.claims,
      query: "NeutralPublicUnsafe.Flow.risky_unused/0",
      hazardEvaluations: [analysis.hazardEvaluation],
    });
    expect(risky).toMatchObject({ outcome: "dead", confidence: "medium" });
    if (risky.outcome !== "dead") throw new Error("expected public-boundary dead control");
    expect(risky.hazards).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          hazardClass: "elixir-computed-atom-escape",
          site: "lib/neutral_public_unsafe/flow.ex:4",
          worlds: ["production"],
        }),
        expect.objectContaining({
          hazardClass: "elixir-computed-atom-escape",
          site: "lib/neutral_public_unsafe/flow.ex:8",
          worlds: ["production"],
        }),
        expect.objectContaining({
          hazardClass: "elixir-dynamic-dispatch",
          site: "lib/neutral_public_unsafe/flow.ex:7",
          worlds: ["production"],
        }),
      ]),
    );
    expect(
      computeDeletionPlan({
        graph: analysis.graph,
        reachability: analysis.reachability,
        subject: risky.subject,
        hazardEvaluations: [analysis.hazardEvaluation],
      }),
    ).toMatchObject({ supported: false, stages: [] });
  }, 60_000);

  it("keeps exact cross-module public parameter flows bounded and deletable", async () => {
    const root = fixture("atom-role-cross-module-flow");
    const trace = runTracer(root);
    const extraction = extractElixirRuntimeConventions(root, trace);
    expect(
      extraction.dynamicDispatches
        .flatMap((fact) =>
          fact.factKind === "computed-atom" && fact.file === "lib/neutral_cross_flow/flow.ex"
            ? [{ fromFun: fact.fromFun ?? "", flow: fact.flow }]
            : [],
        )
        .sort((left, right) => left.fromFun.localeCompare(right.fromFun)),
    ).toEqual([
      { fromFun: "direct?/2", flow: "data" },
      { fromFun: "imported?/2", flow: "data" },
      { fromFun: "pass?/2", flow: "data" },
      { fromFun: "wrapped?/2", flow: "data" },
    ]);
    expect(extraction.atomFlowStats).toMatchObject({
      publicSummaryFunctions: 8,
      publicSummaries: 15,
      publicCallEdges: 1,
      publicSummaryMatches: 1,
      crossModuleSummaryFunctions: 8,
      crossModuleCallEdges: 9,
      crossModuleSummaryMatches: 3,
      crossModuleCanonicalIdentityRejections: 0,
      crossModuleBoundaryEscapes: 0,
      crossModuleOpaqueFunctions: 0,
      joinedProducerOutcomes: 4,
      dataSinks: 4,
      invocationSinks: 0,
      escapes: 0,
    });

    const analysis = await analyzeElixirProjectWithGraph(root, { now: new Date(0) });
    expect(
      analysis.graph
        .hazards()
        .filter((hazard) => hazard.file.includes("neutral_cross_flow/flow.ex")),
    ).toEqual([]);
    const direct = whyAlive({
      graph: analysis.graph,
      reachability: analysis.reachability,
      claims: analysis.result.claims,
      query: "NeutralCrossFlow.Flow.direct?/2",
      hazardEvaluations: [analysis.hazardEvaluation],
    });
    expect(direct).toMatchObject({ outcome: "alive", entrypointKind: "production" });

    const unrelated = whyAlive({
      graph: analysis.graph,
      reachability: analysis.reachability,
      claims: analysis.result.claims,
      query: "NeutralCrossFlow.Flow.genuinely_unused/0",
      hazardEvaluations: [analysis.hazardEvaluation],
    });
    expect(unrelated).toMatchObject({ outcome: "dead", confidence: "high", hazards: [] });
    if (unrelated.outcome !== "dead") throw new Error("expected cross-module dead control");
    expect(
      computeDeletionPlan({
        graph: analysis.graph,
        reachability: analysis.reachability,
        subject: unrelated.subject,
        hazardEvaluations: [analysis.hazardEvaluation],
      }),
    ).toMatchObject({ supported: true });
  }, 60_000);

  it("explains and refuses unsafe cross-module public parameter flows", async () => {
    const root = fixture("atom-role-cross-module-unsafe");
    const trace = runTracer(root);
    expect(extractElixirRuntimeConventions(root, trace).atomFlowStats).toMatchObject({
      publicSummaryFunctions: 7,
      publicSummaries: 7,
      publicCallEdges: 0,
      publicSummaryMatches: 0,
      crossModuleSummaryFunctions: 7,
      crossModuleCallEdges: 3,
      crossModuleSummaryMatches: 2,
      crossModuleCanonicalIdentityRejections: 1,
      crossModuleBoundaryEscapes: 1,
      crossModuleOpaqueFunctions: 0,
      joinedProducerOutcomes: 4,
      dataSinks: 0,
      invocationSinks: 1,
      escapes: 3,
    });
    const analysis = await analyzeElixirProjectWithGraph(root, { now: new Date(0) });
    const risky = whyAlive({
      graph: analysis.graph,
      reachability: analysis.reachability,
      claims: analysis.result.claims,
      query: "NeutralCrossUnsafe.Flow.genuinely_unused/0",
      hazardEvaluations: [analysis.hazardEvaluation],
    });
    expect(risky).toMatchObject({ outcome: "dead", confidence: "medium" });
    if (risky.outcome !== "dead") throw new Error("expected cross-module unsafe dead control");
    expect(risky.hazards).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          hazardClass: "elixir-dynamic-dispatch",
          site: "lib/neutral_cross_unsafe/target.ex:2",
          worlds: ["production"],
        }),
        expect.objectContaining({
          hazardClass: "elixir-computed-atom-escape",
          site: "lib/neutral_cross_unsafe/flow.ex:3",
          worlds: ["production"],
        }),
        expect.objectContaining({
          hazardClass: "elixir-computed-atom-escape",
          site: "lib/neutral_cross_unsafe/target.ex:4",
          worlds: ["production"],
        }),
        expect.objectContaining({
          hazardClass: "elixir-computed-atom-escape",
          site: "lib/neutral_cross_unsafe/flow.ex:5",
          worlds: ["production"],
        }),
      ]),
    );
    expect(
      computeDeletionPlan({
        graph: analysis.graph,
        reachability: analysis.reachability,
        subject: risky.subject,
        hazardEvaluations: [analysis.hazardEvaluation],
      }),
    ).toMatchObject({ supported: false, stages: [] });
  }, 60_000);

  it.each([
    "dynamic-use-helpers",
    "dynamic-local-dispatch",
    "dynamic-global-dispatch",
    "atom-map-key-safe",
    "atom-assigned-data-safe",
    "atom-inline-map-put-safe",
    "atom-fetch-map-put-safe",
    "atom-dynamic-receiver",
    "atom-role-summaries",
    "atom-role-data-safe",
    "atom-role-escape",
    "atom-role-private-flow",
    "atom-role-private-unsafe",
    "atom-role-public-flow",
    "atom-role-public-unsafe",
    "atom-role-cross-module-flow",
    "atom-role-cross-module-unsafe",
  ])(
    "preserves Elixir claims after mixed-plugin composition: %s",
    async (name) => {
      const direct = await analyzeElixirProjectWithGraph(fixture(name), { now: new Date(0) });
      const mixedRoot = await mixedFixture(name);
      const mixed = await analyzeProjectAutoWithGraph(mixedRoot, { now: new Date(0) });
      const projectPrefix = "apps/beam/";
      const directClaims = direct.result.claims
        .map((claim) => ({
          kind: claim.subject.kind,
          name: claim.subject.name,
          file: claim.subject.loc.file,
          confidence: claim.confidence,
        }))
        .sort((left, right) =>
          `${left.file}\0${left.name ?? ""}`.localeCompare(`${right.file}\0${right.name ?? ""}`),
        );
      const mixedClaims = mixed.result.claims
        .filter((claim) => claim.language === "ex")
        .map((claim) => ({
          kind: claim.subject.kind,
          name: claim.subject.name?.startsWith(projectPrefix)
            ? claim.subject.name.slice(projectPrefix.length)
            : claim.subject.name,
          file: claim.subject.loc.file.slice(projectPrefix.length),
          confidence: claim.confidence,
        }))
        .sort((left, right) =>
          `${left.file}\0${left.name ?? ""}`.localeCompare(`${right.file}\0${right.name ?? ""}`),
        );
      expect(mixedClaims).toEqual(directClaims);
    },
    120_000,
  );
});

async function mixedFixture(name: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "unused-elixir-hazard-mixed-"));
  temporaryRoots.push(root);
  const beam = join(root, "apps", "beam");
  await mkdir(beam, { recursive: true });
  await cp(fixture(name), beam, {
    recursive: true,
    filter: (path) => !["_build", "deps", ".elixir_ls"].includes(basename(path)),
  });
  await mkdir(join(root, "src"));
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({ name: "neutral-mixed", private: true, type: "module", main: "src/index.ts" }),
  );
  await writeFile(join(root, "src", "index.ts"), "export const neutral = true;\n");
  return root;
}
