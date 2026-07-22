/**
 * Conservative extraction for Elixir runtime-reference conventions that
 * the compiler tracer cannot express as ordinary call edges:
 *
 *  - an MFA value `{Module, :function, init}` consumed later by a runtime that
 *    may add request/context arguments before applying the callback;
 *  - `use WebModule, :helper` where `WebModule.__using__/1` dispatches through
 *    `apply(__MODULE__, which, [])`.
 *
 *  - `apply/3` with literal arguments becomes an exact edge; when only the
 *    module or function is literal, its candidate symbols are bounded for a
 *    targeted confidence cap. Syntax outside the deliberately small recognizer
 *    remains opaque and retains the whole-unit fallback.
 *
 * Literal recognisers only emit edges or targets for functions the compiler
 * reported, so arbitrary atoms never manufacture IR.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { FunctionRecord, ModuleRecord, TraceEvent, TraceResult } from "./events.js";

export interface ElixirRuntimeReference {
  readonly fromMod: string;
  readonly fromFun?: string;
  readonly toMod: string;
  readonly toName: string;
  readonly toArity: number;
  readonly file: string;
  readonly line: number;
  readonly convention: "runtime-mfa" | "use-helper" | "dynamic-apply";
}

export interface ElixirDynamicDispatch {
  readonly fromMod: string;
  readonly fromFun?: string;
  readonly file: string;
  readonly line: number;
  readonly kind: "exact" | "bounded" | "opaque";
  /** Exact compiler event identity; avoids conflating same-line carriers. */
  readonly eventKey: string;
  /** Compiler-confirmed public functions that a bounded call may select. */
  readonly targets: readonly FunctionRecord[];
}

export interface ElixirRuntimeConventions {
  readonly references: readonly ElixirRuntimeReference[];
  readonly dynamicDispatches: readonly ElixirDynamicDispatch[];
}

const MODULE = String.raw`[A-Z][A-Za-z0-9_]*(?:\.[A-Z][A-Za-z0-9_]*)*`;
const FUNCTION = `[a-z_][A-Za-z0-9_]*[!?]?`;
const MFA_RE = new RegExp(
  String.raw`\{\s*(${MODULE})\s*,\s*:(${FUNCTION})\s*,\s*([^}\n]+?)\s*\}`,
  "gu",
);
const USE_RE = new RegExp(String.raw`\buse\s+(${MODULE})\s*,\s*:(${FUNCTION})\b`, "gu");
const USING_SELECTOR_RE =
  /\bdefmacro\s+__using__\s*\(\s*([a-z_][A-Za-z0-9_]*)\s*\)(?:\s+when\b[^\n]*)?\s+do\b/gu;
const SIMPLE_APPLY_RE = new RegExp(
  String.raw`\b(?:(?:Kernel|:erlang)\.)?apply\s*\(\s*(${MODULE}|__MODULE__|[a-z_][A-Za-z0-9_]*)\s*,\s*(:${FUNCTION}|[a-z_][A-Za-z0-9_]*)\s*,\s*(\[\s*(?:[A-Za-z0-9_:.!?-]+\s*(?:,\s*[A-Za-z0-9_:.!?-]+\s*)*)?\])\s*\)`,
  "gu",
);
const ATOM_PRODUCER_RE = /\bString\.(to_atom|to_existing_atom)\s*\(/gu;
const MAP_CALL_RE =
  /\bMap\.(fetch!|fetch|get|get_lazy|has_key\?|delete|put|put_new|put_new_lazy|replace|replace!|update|update!)\s*\(/gu;

interface SourceIndex {
  readonly content: string;
  readonly code: string;
  readonly lineStarts: readonly number[];
  readonly closeByOpen: ReadonlyMap<number, number>;
  readonly parentByOpen: ReadonlyMap<number, number>;
  readonly commasByOpen: ReadonlyMap<number, readonly number[]>;
  readonly usingSignatures: readonly { readonly line: number; readonly selector: string }[];
}

/** Extract independently provable runtime references from traced project files. */
export function extractElixirRuntimeReferences(
  projectDir: string,
  traceResult: TraceResult,
): ElixirRuntimeReference[] {
  return [...extractElixirRuntimeConventions(projectDir, traceResult).references];
}

/** Extract exact runtime edges and bounded/opaque dynamic-dispatch facts once. */
export function extractElixirRuntimeConventions(
  projectDir: string,
  traceResult: TraceResult,
): ElixirRuntimeConventions {
  const functionsByModuleName = indexFunctions(traceResult.functions);
  const contents = readProjectSources(projectDir, traceResult);
  const sources = new Map(
    [...contents].map(([file, content]) => [file, indexSource(content)] as const),
  );
  const ownerIndex = indexOwners(traceResult);
  const parsedBySite = indexParsedApplies(sources);
  const usingSelectorsByCarrier = indexUsingSelectorsByCarrier(traceResult.events, sources);
  const dispatchModules = indexUseDispatcherModules(
    traceResult.events,
    parsedBySite,
    usingSelectorsByCarrier,
  );
  const useEventsBySite = indexUseEventsBySite(traceResult.events);
  const useFactCountsBySite = indexUseFactCountsBySite(sources);

  const references: ElixirRuntimeReference[] = [];
  const seen = new Set<string>();
  for (const [file, source] of sources) {
    const searchable = source.code;
    for (const match of searchable.matchAll(MFA_RE)) {
      const toMod = match[1];
      const toName = match[2];
      if (toMod === undefined || toName === undefined || match[3] === undefined) continue;
      const line = lineAt(source.lineStarts, match.index ?? 0);
      const owner = resolveOwner(ownerIndex, file, line, toMod);
      if (owner === null) continue;
      const targets = functionsByModuleName.get(`${toMod}\0${toName}`) ?? [];
      for (const target of targets) {
        addReference(references, seen, {
          ...owner,
          toMod,
          toName,
          toArity: target.arity,
          file,
          line,
          convention: "runtime-mfa",
        });
      }
    }

    for (const match of searchable.matchAll(USE_RE)) {
      const toName = match[2];
      if (match[1] === undefined || toName === undefined) continue;
      const line = lineAt(source.lineStarts, match.index ?? 0);
      const siteEvents = useEventsBySite.get(dispatchSiteKey(file, line)) ?? [];
      if (
        siteEvents.length !== 1 ||
        useFactCountsBySite.get(dispatchSiteKey(file, line)) !== 1 ||
        siteEvents[0] === undefined
      )
        continue;
      const useEvent = siteEvents[0];
      const toMod = useEvent.to_mod;
      if (!dispatchModules.has(toMod)) continue;
      const targets = (functionsByModuleName.get(`${toMod}\0${toName}`) ?? []).filter(
        (candidate) => candidate.arity === 0,
      );
      if (targets.length !== 1) continue;
      addReference(references, seen, {
        ...ownerFromEvent(useEvent),
        toMod,
        toName,
        toArity: 0,
        file,
        line,
        convention: "use-helper",
      });
    }
  }

  const dynamicDispatches = extractDynamicDispatches(
    traceResult,
    sources,
    parsedBySite,
    usingSelectorsByCarrier,
    functionsByModuleName,
    references,
    seen,
  );
  return { references, dynamicDispatches };
}

function indexParsedApplies(
  sources: ReadonlyMap<string, SourceIndex>,
): ReadonlyMap<string, ParsedApply[]> {
  const parsedBySite = new Map<string, ParsedApply[]>();
  for (const [file, source] of sources) {
    for (const match of source.code.matchAll(SIMPLE_APPLY_RE)) {
      const moduleExpr = match[1];
      const functionExpr = match[2];
      const argsExpr = match[3];
      if (moduleExpr === undefined || functionExpr === undefined || argsExpr === undefined)
        continue;
      const line = lineAt(source.lineStarts, match.index ?? 0);
      append(parsedBySite, dispatchSiteKey(file, line), {
        moduleExpr,
        functionExpr,
        arity: listArity(argsExpr),
      });
    }
  }
  return parsedBySite;
}

function indexUseDispatcherModules(
  events: readonly TraceEvent[],
  parsedBySite: ReadonlyMap<string, ParsedApply[]>,
  usingSelectorsByCarrier: ReadonlyMap<string, number>,
): ReadonlySet<string> {
  const modules = new Set<string>();
  for (const event of events) {
    if (!event.dyn || !isApply3Event(event) || event.from_mod === null) continue;
    if (event.from_fun !== "__using__/1") continue;
    const calls = parsedBySite.get(dispatchSiteKey(event.file, event.line)) ?? [];
    if (calls.length !== 1 || calls[0] === undefined) continue;
    const call = calls[0];
    if (
      call.moduleExpr !== "__MODULE__" ||
      call.functionExpr.startsWith(":") ||
      call.arity !== 0 ||
      usingSelectorsByCarrier.get(usingSelectorCarrierKey(event, call.functionExpr)) !== 1
    ) {
      continue;
    }
    modules.add(event.from_mod);
  }
  return modules;
}

function indexUsingSelectorsByCarrier(
  events: readonly TraceEvent[],
  sources: ReadonlyMap<string, SourceIndex>,
): ReadonlyMap<string, number> {
  const definitionEventsBySite = new Map<string, TraceEvent[]>();
  for (const event of events) {
    if (
      event.name === "defmacro" &&
      event.arity === 2 &&
      event.from_mod !== null &&
      event.from_fun === undefined
    ) {
      append(
        definitionEventsBySite,
        partitionSiteKey(event.file, event.line, event.partition),
        event,
      );
    }
  }
  const result = new Map<string, number>();
  for (const [file, source] of sources) {
    for (const signature of source.usingSignatures) {
      for (const partition of ["prod", "test"] as const) {
        const definitionEvents =
          definitionEventsBySite.get(partitionSiteKey(file, signature.line, partition)) ?? [];
        if (definitionEvents.length !== 1 || definitionEvents[0] === undefined) continue;
        const key = usingSelectorCarrierKey(definitionEvents[0], signature.selector);
        result.set(key, (result.get(key) ?? 0) + 1);
      }
    }
  }
  return result;
}

function usingSelectorCarrierKey(event: TraceEvent, selector: string): string {
  return [event.file, event.from_mod ?? "", selector, event.partition].join("\0");
}

function partitionSiteKey(file: string, line: number, partition: TraceEvent["partition"]): string {
  return `${file}\0${line}\0${partition}`;
}

function indexUseEventsBySite(events: readonly TraceEvent[]): ReadonlyMap<string, TraceEvent[]> {
  const result = new Map<string, TraceEvent[]>();
  for (const event of events) {
    if (event.name !== "__using__" || event.arity !== 1 || event.from_mod === null) continue;
    append(result, dispatchSiteKey(event.file, event.line), event);
  }
  return result;
}

function indexUseFactCountsBySite(
  sources: ReadonlyMap<string, SourceIndex>,
): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  for (const [file, source] of sources) {
    for (const match of source.code.matchAll(USE_RE)) {
      const key = dispatchSiteKey(file, lineAt(source.lineStarts, match.index ?? 0));
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return counts;
}

function extractDynamicDispatches(
  traceResult: TraceResult,
  sources: ReadonlyMap<string, SourceIndex>,
  parsedBySite: ReadonlyMap<string, ParsedApply[]>,
  usingSelectorsByCarrier: ReadonlyMap<string, number>,
  functionsByModuleName: ReadonlyMap<string, FunctionRecord[]>,
  references: ElixirRuntimeReference[],
  seenReferences: Set<string>,
): ElixirDynamicDispatch[] {
  const functionsByModule = new Map<string, FunctionRecord[]>();
  for (const fn of traceResult.functions) {
    const bucket = functionsByModule.get(fn.mod);
    if (bucket === undefined) functionsByModule.set(fn.mod, [fn]);
    else bucket.push(fn);
  }
  const aliasTargetsByCarrierSite = indexAliasTargets(traceResult.events);

  const dynamicEventsBySite = indexDynamicEventsBySite(traceResult.events);
  const safeAtomEvents = safeAtomProducerEvents(traceResult.events, sources);
  const exactUseDispatchEvents = exactUseDispatcherEvents(
    traceResult,
    references,
    parsedBySite,
    functionsByModuleName,
    usingSelectorsByCarrier,
  );

  const dispatches: ElixirDynamicDispatch[] = [];
  for (const event of traceResult.events) {
    if (!event.dyn) continue;
    const owner = ownerFromEvent(event);
    const eventKey = dynamicEventKey(event);
    const siteEvents = dynamicEventsBySite.get(dispatchSiteKey(event.file, event.line)) ?? [];
    if (safeAtomEvents.has(event)) {
      dispatches.push({
        ...owner,
        file: event.file,
        line: event.line,
        kind: "exact",
        eventKey,
        targets: [],
      });
      continue;
    }
    const exactUseTargets = exactUseDispatchEvents.get(event);
    if (exactUseTargets !== undefined) {
      dispatches.push({
        ...owner,
        file: event.file,
        line: event.line,
        kind: "exact",
        eventKey,
        targets: exactUseTargets,
      });
      continue;
    }
    const parsed = parsedBySite.get(dispatchSiteKey(event.file, event.line));
    const isApply3 =
      event.name === "apply" &&
      event.arity === 3 &&
      (event.to_mod === "Kernel" || event.to_mod === ":erlang");
    if (!isApply3 || siteEvents.length !== 1 || parsed?.length !== 1 || parsed[0] === undefined) {
      dispatches.push({
        ...owner,
        file: event.file,
        line: event.line,
        kind: "opaque",
        eventKey,
        targets: [],
      });
      continue;
    }

    const call = parsed[0];
    const targetModule = resolveTargetModule(
      call.moduleExpr,
      event,
      functionsByModule,
      aliasTargetsByCarrierSite,
    );
    const targetFunction = call.functionExpr.startsWith(":") ? call.functionExpr.slice(1) : null;
    const targets = candidateFunctions(
      traceResult.functions,
      functionsByModule,
      functionsByModuleName,
      targetModule,
      targetFunction,
      call.arity,
    );

    if (targetModule !== null && targetFunction !== null && call.arity !== null) {
      const target = targets[0];
      if (target !== undefined) {
        addReference(references, seenReferences, {
          ...owner,
          toMod: target.mod,
          toName: target.name,
          toArity: target.arity,
          file: event.file,
          line: event.line,
          convention: "dynamic-apply",
        });
      }
      dispatches.push({
        ...owner,
        file: event.file,
        line: event.line,
        kind: "exact",
        eventKey,
        targets,
      });
      continue;
    }

    if (targetModule !== null || (targetFunction !== null && call.arity !== null)) {
      dispatches.push({
        ...owner,
        file: event.file,
        line: event.line,
        kind: "bounded",
        eventKey,
        targets,
      });
      continue;
    }
    dispatches.push({
      ...owner,
      file: event.file,
      line: event.line,
      kind: "opaque",
      eventKey,
      targets: [],
    });
  }
  return dispatches;
}

function indexDynamicEventsBySite(events: readonly TraceEvent[]): Map<string, TraceEvent[]> {
  const index = new Map<string, TraceEvent[]>();
  for (const event of events) {
    if (!event.dyn) continue;
    append(index, dispatchSiteKey(event.file, event.line), event);
  }
  return index;
}

/**
 * A function-scoped atom producer is harmless only when its complete value is
 * the direct key argument of a compiler-confirmed `Map` operation. Every
 * unsupported flow stays dynamic: receiver dispatch, assignment, return,
 * pipeline, and same-line ambiguity all deliberately fail this proof.
 */
function safeAtomProducerEvents(
  events: readonly TraceEvent[],
  sources: ReadonlyMap<string, SourceIndex>,
): ReadonlySet<TraceEvent> {
  const sourceFacts = new Map<string, AtomProducerFact[]>();
  for (const [file, source] of sources) {
    const mapCalls = indexMapCalls(source);
    for (const match of source.code.matchAll(ATOM_PRODUCER_RE)) {
      const name = match[1];
      if (name === undefined) continue;
      const start = match.index ?? 0;
      const open = start + match[0].length - 1;
      const close = source.closeByOpen.get(open);
      if (close === undefined) continue;
      const line = lineAt(source.lineStarts, start);
      const safeMap = directMapKeyConsumer(source, mapCalls, start, open, close);
      append(sourceFacts, atomSiteKey(file, line, name), {
        file,
        line,
        name,
        ...(safeMap === null ? {} : { safeMap }),
      });
    }
  }

  const eventFacts = new Map<string, TraceEvent[]>();
  const ordinaryEventsByCarrier = new Map<string, TraceEvent[]>();
  for (const event of events) {
    append(ordinaryEventsByCarrier, carrierSiteKey(event), event);
    if (
      event.dyn &&
      event.to_mod === "String" &&
      event.arity === 1 &&
      (event.name === "to_atom" || event.name === "to_existing_atom")
    ) {
      append(eventFacts, atomSiteKey(event.file, event.line, event.name), event);
    }
  }

  const safe = new Set<TraceEvent>();
  for (const [key, facts] of sourceFacts) {
    const matchingEvents = eventFacts.get(key) ?? [];
    // The tracer has line but not column provenance. Never guess which role a
    // same-line event belongs to, even when two source expressions look safe.
    if (facts.length !== 1 || matchingEvents.length !== 1) continue;
    const fact = facts[0];
    const event = matchingEvents[0];
    if (fact?.safeMap === undefined || event === undefined) continue;
    const safeMap = fact.safeMap;
    const mapCarrierSite = [
      fact.file,
      safeMap.line,
      event.from_mod ?? "",
      event.from_fun ?? "",
    ].join("\0");
    const compilerCalls = (ordinaryEventsByCarrier.get(mapCarrierSite) ?? []).filter(
      (candidate) =>
        candidate.to_mod === "Map" &&
        candidate.name === safeMap.name &&
        candidate.arity === safeMap.arity,
    );
    if (compilerCalls.length === 1) safe.add(event);
  }
  return safe;
}

interface AtomProducerFact {
  readonly file: string;
  readonly line: number;
  readonly name: string;
  readonly safeMap?: { readonly name: string; readonly arity: number; readonly line: number };
}

interface MapCall {
  readonly name: string;
  readonly arity: number;
  readonly open: number;
  readonly keyArgument: number;
  readonly line: number;
}

function indexMapCalls(source: SourceIndex): ReadonlyMap<number, MapCall> {
  const calls = new Map<number, MapCall>();
  for (const match of source.code.matchAll(MAP_CALL_RE)) {
    const name = match[1];
    if (name === undefined) continue;
    const open = (match.index ?? 0) + match[0].length - 1;
    const close = source.closeByOpen.get(open);
    if (close === undefined) continue;
    const commas = source.commasByOpen.get(open) ?? [];
    calls.set(open, {
      name,
      arity: commas.length + 1,
      open,
      keyArgument: 1,
      line: lineAt(source.lineStarts, match.index ?? 0),
    });
  }
  return calls;
}

function directMapKeyConsumer(
  source: SourceIndex,
  mapCalls: ReadonlyMap<number, MapCall>,
  producerStart: number,
  producerOpen: number,
  producerClose: number,
): { readonly name: string; readonly arity: number; readonly line: number } | null {
  const parentOpen = source.parentByOpen.get(producerOpen);
  if (parentOpen === undefined) return null;
  const mapCall = mapCalls.get(parentOpen);
  if (mapCall === undefined) return null;
  const parentClose = source.closeByOpen.get(parentOpen);
  if (parentClose === undefined) return null;
  const commas = source.commasByOpen.get(parentOpen) ?? [];
  const starts = [parentOpen + 1, ...commas.map((comma) => comma + 1)];
  const ends = [...commas, parentClose];
  const argumentStart = starts[mapCall.keyArgument];
  const argumentEnd = ends[mapCall.keyArgument];
  if (argumentStart === undefined || argumentEnd === undefined) return null;
  const trimmedStart = skipWhitespaceForward(source.code, argumentStart, argumentEnd);
  const trimmedEnd = skipWhitespaceBackward(source.code, argumentEnd, argumentStart);
  if (trimmedStart !== producerStart || trimmedEnd !== producerClose + 1) return null;
  return { name: mapCall.name, arity: mapCall.arity, line: mapCall.line };
}

/**
 * Consume a self-apply dispatcher only when every compiler-observed invocation
 * is accounted for by one literal `use Module, :helper` fact. This makes the
 * finite observed helper set exact while preserving the fallback for computed
 * selectors and same-line/cardinality ambiguity.
 */
function exactUseDispatcherEvents(
  traceResult: TraceResult,
  references: readonly ElixirRuntimeReference[],
  parsedBySite: ReadonlyMap<string, ParsedApply[]>,
  functionsByModuleName: ReadonlyMap<string, FunctionRecord[]>,
  usingSelectorsByCarrier: ReadonlyMap<string, number>,
): ReadonlyMap<TraceEvent, readonly FunctionRecord[]> {
  const useReferencesByModule = new Map<string, ElixirRuntimeReference[]>();
  for (const reference of references) {
    if (reference.convention === "use-helper")
      append(useReferencesByModule, reference.toMod, reference);
  }
  const useEventsByModule = new Map<string, TraceEvent[]>();
  for (const event of traceResult.events) {
    if (event.name === "__using__" && event.arity === 1)
      append(useEventsByModule, event.to_mod, event);
  }
  const dispatcherEventsByModule = new Map<string, TraceEvent[]>();
  for (const event of traceResult.events) {
    if (isApply3Event(event) && event.from_mod !== null && event.from_fun === "__using__/1")
      append(dispatcherEventsByModule, event.from_mod, event);
  }
  const exact = new Map<TraceEvent, readonly FunctionRecord[]>();
  for (const [dispatcherModule, dispatcherEvents] of dispatcherEventsByModule) {
    if (dispatcherEvents.length !== 1 || dispatcherEvents[0] === undefined) continue;
    const event = dispatcherEvents[0];
    const parsed = parsedBySite.get(dispatchSiteKey(event.file, event.line)) ?? [];
    if (parsed.length !== 1) continue;
    const call = parsed[0];
    if (
      call === undefined ||
      call.moduleExpr !== "__MODULE__" ||
      call.functionExpr.startsWith(":") ||
      call.arity !== 0
    ) {
      continue;
    }
    if (usingSelectorsByCarrier.get(usingSelectorCarrierKey(event, call.functionExpr)) !== 1)
      continue;

    const useEvents = useEventsByModule.get(dispatcherModule) ?? [];
    const useReferences = useReferencesByModule.get(dispatcherModule) ?? [];
    if (useEvents.length === 0 || useEvents.length !== useReferences.length) continue;
    const eventsByCarrierSite = groupBy(useEvents, useCarrierSiteKey);
    const referencesByCarrierSite = groupBy(useReferences, referenceCarrierSiteKey);
    if (eventsByCarrierSite.size !== referencesByCarrierSite.size) continue;
    let accounted = true;
    for (const [key, siteEvents] of eventsByCarrierSite) {
      if (siteEvents.length !== 1 || referencesByCarrierSite.get(key)?.length !== 1) {
        accounted = false;
        break;
      }
    }
    if (!accounted) continue;
    const targets: FunctionRecord[] = [];
    for (const reference of useReferences) {
      const candidates = (
        functionsByModuleName.get(`${reference.toMod}\0${reference.toName}`) ?? []
      ).filter((candidate) => candidate.arity === reference.toArity);
      if (candidates.length !== 1 || candidates[0] === undefined) {
        accounted = false;
        break;
      }
      targets.push(candidates[0]);
    }
    if (accounted) exact.set(event, targets);
  }
  return exact;
}

function isApply3Event(event: TraceEvent): boolean {
  return (
    event.name === "apply" &&
    event.arity === 3 &&
    (event.to_mod === "Kernel" || event.to_mod === ":erlang")
  );
}

interface ParsedApply {
  readonly moduleExpr: string;
  readonly functionExpr: string;
  readonly arity: number | null;
}

function candidateFunctions(
  allFunctions: readonly FunctionRecord[],
  functionsByModule: ReadonlyMap<string, FunctionRecord[]>,
  functionsByModuleName: ReadonlyMap<string, FunctionRecord[]>,
  module: string | null,
  name: string | null,
  arity: number | null,
): FunctionRecord[] {
  if (module !== null && name !== null) {
    return (functionsByModuleName.get(`${module}\0${name}`) ?? []).filter(
      (fn) => arity === null || fn.arity === arity,
    );
  }
  const candidates = module === null ? allFunctions : (functionsByModule.get(module) ?? []);
  return candidates.filter(
    (fn) => (name === null || fn.name === name) && (arity === null || fn.arity === arity),
  );
}

function moduleToken(value: string): boolean {
  return /^[A-Z][A-Za-z0-9_]*(?:\.[A-Z][A-Za-z0-9_]*)*$/u.test(value);
}

function resolveTargetModule(
  expression: string,
  event: TraceEvent,
  functionsByModule: ReadonlyMap<string, FunctionRecord[]>,
  aliasTargetsByCarrierSite: ReadonlyMap<string, ReadonlySet<string>>,
): string | null {
  if (expression === "__MODULE__") return event.from_mod;
  if (!moduleToken(expression)) return null;

  // An alias may spell a project module differently at the source site. The
  // compiler tracer supplies the expanded module atom on an alias event; only
  // accept a unique project-module candidate. This compiler expansion must
  // take precedence even when the source token also happens to name a project
  // module: a local `alias Other, as: Direct` shadows the top-level `Direct`.
  // Ambiguity falls back to the conservative cross-unit name/arity set below.
  const expanded = aliasTargetsByCarrierSite.get(aliasCarrierSiteKey(event)) ?? new Set();
  if (expanded.size === 1) {
    const target = [...expanded][0];
    return target !== undefined && functionsByModule.has(target) ? target : null;
  }
  if (expanded.size > 1) return null;
  return functionsByModule.has(expression) ? expression : null;
}

function indexAliasTargets(
  events: readonly TraceEvent[],
): ReadonlyMap<string, ReadonlySet<string>> {
  const index = new Map<string, Set<string>>();
  for (const event of events) {
    if (event.kind !== "alias") continue;
    const key = aliasCarrierSiteKey(event);
    const targets = index.get(key);
    if (targets === undefined) index.set(key, new Set([event.to_mod]));
    else targets.add(event.to_mod);
  }
  return index;
}

function aliasCarrierSiteKey(event: TraceEvent): string {
  return [event.file, event.line, event.from_mod ?? "", event.from_fun ?? "", event.partition].join(
    "\0",
  );
}

function listArity(value: string): number | null {
  const body = value.slice(1, -1).trim();
  return body === "" ? 0 : body.split(",").length;
}

function dispatchSiteKey(file: string, line: number): string {
  return `${file}\0${line}`;
}

export function dynamicEventKey(event: TraceEvent): string {
  return [
    event.file,
    event.line,
    event.from_mod ?? "",
    event.from_fun ?? "",
    event.kind,
    event.to_mod,
    event.name ?? "",
    event.arity ?? "",
    event.partition,
  ].join("\0");
}

function carrierSiteKey(event: TraceEvent): string {
  return [event.file, event.line, event.from_mod ?? "", event.from_fun ?? ""].join("\0");
}

function atomSiteKey(file: string, line: number, name: string): string {
  return `${file}\0${line}\0${name}`;
}

function useCarrierSiteKey(event: TraceEvent): string {
  return [event.file, event.line, event.from_mod ?? "", event.from_fun ?? "", event.to_mod].join(
    "\0",
  );
}

function referenceCarrierSiteKey(reference: ElixirRuntimeReference): string {
  return [
    reference.file,
    reference.line,
    reference.fromMod,
    reference.fromFun ?? "",
    reference.toMod,
  ].join("\0");
}

function indexFunctions(functions: readonly FunctionRecord[]): Map<string, FunctionRecord[]> {
  const index = new Map<string, FunctionRecord[]>();
  for (const fn of functions) {
    const key = `${fn.mod}\0${fn.name}`;
    const bucket = index.get(key);
    if (bucket === undefined) index.set(key, [fn]);
    else bucket.push(fn);
  }
  return index;
}

function readProjectSources(projectDir: string, traceResult: TraceResult): Map<string, string> {
  const files = new Set<string>();
  for (const mod of traceResult.modules) files.add(mod.file);
  for (const fn of traceResult.functions) files.add(fn.file);
  const contents = new Map<string, string>();
  for (const file of files) {
    try {
      contents.set(file, readFileSync(join(projectDir, file), "utf8"));
    } catch {
      // The tracer can report generated sources that are not readable later.
    }
  }
  return contents;
}

interface OwnerIndex {
  readonly bySiteTarget: ReadonlyMap<
    string,
    readonly Pick<ElixirRuntimeReference, "fromMod" | "fromFun">[]
  >;
  readonly modulesByFile: ReadonlyMap<string, readonly ModuleRecord[]>;
}

function indexOwners(traceResult: TraceResult): OwnerIndex {
  const ownersBySiteTarget = new Map<
    string,
    Map<string, Pick<ElixirRuntimeReference, "fromMod" | "fromFun">>
  >();
  for (const event of traceResult.events) {
    if (event.from_mod === null) continue;
    const key = ownerSiteTargetKey(event.file, event.line, event.to_mod);
    const owner = ownerFromEvent(event);
    const ownerKey = `${owner.fromMod}\0${owner.fromFun ?? ""}`;
    const bucket = ownersBySiteTarget.get(key);
    if (bucket === undefined) ownersBySiteTarget.set(key, new Map([[ownerKey, owner]]));
    else bucket.set(ownerKey, owner);
  }
  const bySiteTarget = new Map(
    [...ownersBySiteTarget].map(([key, owners]) => [key, [...owners.values()]] as const),
  );
  const modulesByFile = new Map<string, ModuleRecord[]>();
  for (const mod of traceResult.modules) append(modulesByFile, mod.file, mod);
  return { bySiteTarget, modulesByFile };
}

function resolveOwner(
  index: OwnerIndex,
  file: string,
  line: number,
  referencedModule: string,
): Pick<ElixirRuntimeReference, "fromMod" | "fromFun"> | null {
  const owners = index.bySiteTarget.get(ownerSiteTargetKey(file, line, referencedModule)) ?? [];
  if (owners.length === 1 && owners[0] !== undefined) return owners[0];
  const modules = index.modulesByFile.get(file) ?? [];
  if (modules.length !== 1 || modules[0] === undefined) return null;
  return { fromMod: modules[0].mod };
}

function ownerSiteTargetKey(file: string, line: number, referencedModule: string): string {
  return `${file}\0${line}\0${referencedModule}`;
}

function ownerFromEvent(event: TraceEvent): Pick<ElixirRuntimeReference, "fromMod" | "fromFun"> {
  return {
    fromMod: event.from_mod ?? "",
    ...(event.from_fun !== undefined ? { fromFun: event.from_fun } : {}),
  };
}

function lineAt(starts: readonly number[], index: number): number {
  let low = 0;
  let high = starts.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if ((starts[middle] ?? 0) <= index) low = middle + 1;
    else high = middle;
  }
  return Math.max(1, low);
}

function indexSource(content: string): SourceIndex {
  const code = maskElixirLiterals(content);
  const lineStarts = [0];
  for (let index = 0; index < content.length; index += 1) {
    if (content.charCodeAt(index) === 10) lineStarts.push(index + 1);
  }
  const closeByOpen = new Map<number, number>();
  const parentByOpen = new Map<number, number>();
  const commasByOpen = new Map<number, number[]>();
  const usingSignatures: Array<{ line: number; selector: string }> = [];
  for (const match of code.matchAll(USING_SELECTOR_RE)) {
    const selector = match[1];
    if (selector !== undefined) {
      usingSignatures.push({
        line: lineAt(lineStarts, match.index ?? 0),
        selector,
      });
    }
  }
  const stack: Array<{ open: number; close: string; commas: number[] }> = [];
  for (let index = 0; index < code.length; index += 1) {
    const char = code[index] as string;
    const close = char === "(" ? ")" : char === "[" ? "]" : char === "{" ? "}" : null;
    if (close !== null) {
      const parent = stack.at(-1);
      if (parent !== undefined) parentByOpen.set(index, parent.open);
      stack.push({ open: index, close, commas: [] });
      continue;
    }
    if (char === ",") {
      stack.at(-1)?.commas.push(index);
      continue;
    }
    if (char !== ")" && char !== "]" && char !== "}") continue;
    const frame = stack.at(-1);
    if (frame?.close !== char) {
      stack.length = 0;
      continue;
    }
    stack.pop();
    closeByOpen.set(frame.open, index);
    commasByOpen.set(frame.open, frame.commas);
  }
  return {
    content,
    code,
    lineStarts,
    closeByOpen,
    parentByOpen,
    commasByOpen,
    usingSignatures,
  };
}

/** Preserve byte/line coordinates while hiding inert Elixir lexical bodies. */
function maskElixirLiterals(content: string): string {
  const output = content.split("");
  const mask = (index: number): void => {
    if (output[index] !== "\n" && output[index] !== "\r") output[index] = " ";
  };
  for (let index = 0; index < content.length; index += 1) {
    const char = content[index] as string;
    if (char === "#") {
      while (index < content.length && content[index] !== "\n") {
        mask(index);
        index += 1;
      }
      index -= 1;
      continue;
    }
    if (
      char === "?" &&
      index + 1 < content.length &&
      !/\s/u.test(content[index + 1] as string) &&
      (index === 0 || !/[A-Za-z0-9_!?]/u.test(content[index - 1] as string))
    ) {
      mask(index);
      index += 1;
      mask(index);
      if (content[index] === "\\" && index + 1 < content.length) {
        index += 1;
        mask(index);
      }
      continue;
    }
    if (content.startsWith('"""', index) || content.startsWith("'''", index)) {
      const delimiter = content.slice(index, index + 3);
      const end = content.indexOf(delimiter, index + 3);
      const stop = end < 0 ? content.length : end + 3;
      while (index < stop) {
        mask(index);
        index += 1;
      }
      index -= 1;
      continue;
    }
    if (char === '"' || char === "'") {
      const quote = char;
      mask(index);
      for (index += 1; index < content.length; index += 1) {
        const current = content[index] as string;
        mask(index);
        if (current === "\\") {
          index += 1;
          if (index < content.length) mask(index);
        } else if (current === quote) {
          break;
        }
      }
      continue;
    }
    if (char === "~" && /[A-Za-z]/u.test(content[index + 1] ?? "")) {
      const delimiterIndex = index + 2;
      const triple =
        content.startsWith('"""', delimiterIndex) || content.startsWith("'''", delimiterIndex);
      const opener = triple
        ? content.slice(delimiterIndex, delimiterIndex + 3)
        : content[delimiterIndex];
      if (opener === undefined) continue;
      const closer =
        opener === "("
          ? ")"
          : opener === "["
            ? "]"
            : opener === "{"
              ? "}"
              : opener === "<"
                ? ">"
                : opener;
      let stop = delimiterIndex + opener.length;
      let depth = opener === closer ? 0 : 1;
      while (stop < content.length) {
        if (content.startsWith(closer, stop)) {
          depth -= 1;
          stop += closer.length;
          if (depth <= 0) break;
          continue;
        }
        if (opener !== closer && content.startsWith(opener, stop)) {
          depth += 1;
          stop += opener.length;
          continue;
        }
        if (content[stop] === "\\") stop += 2;
        else stop += 1;
      }
      while (index < stop) {
        mask(index);
        index += 1;
      }
      while (index < content.length && /[A-Za-z]/u.test(content[index] as string)) {
        mask(index);
        index += 1;
      }
      index -= 1;
    }
  }
  return output.join("");
}

function skipWhitespaceForward(content: string, start: number, end: number): number {
  let index = start;
  while (index < end && /\s/u.test(content[index] as string)) index += 1;
  return index;
}

function skipWhitespaceBackward(content: string, end: number, start: number): number {
  let index = end;
  while (index > start && /\s/u.test(content[index - 1] as string)) index -= 1;
  return index;
}

function append<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const bucket = map.get(key);
  if (bucket === undefined) map.set(key, [value]);
  else bucket.push(value);
}

function groupBy<T>(values: readonly T[], keyOf: (value: T) => string): Map<string, T[]> {
  const result = new Map<string, T[]>();
  for (const value of values) append(result, keyOf(value), value);
  return result;
}

function addReference(
  out: ElixirRuntimeReference[],
  seen: Set<string>,
  reference: ElixirRuntimeReference,
): void {
  const key = `${reference.fromMod}\0${reference.fromFun ?? ""}\0${reference.toMod}\0${reference.toName}\0${reference.toArity}\0${reference.file}\0${reference.line}`;
  if (seen.has(key)) return;
  seen.add(key);
  out.push(reference);
}
