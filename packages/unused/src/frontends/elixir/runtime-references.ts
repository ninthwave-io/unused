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
const APPLY_PREFIX_RE = new RegExp(
  String.raw`(?:\bKernel\s*\.\s*|:erlang\s*\.\s*|\b)apply\s*\(\s*(${MODULE}|__MODULE__|[a-z_][A-Za-z0-9_]*)\s*,\s*(:${FUNCTION}|[a-z_][A-Za-z0-9_]*)\s*,`,
  "gu",
);
const STATIC_LIST_ELEMENT_RE =
  /(?:[A-Za-z_][A-Za-z0-9_.]*[!?]?|:[A-Za-z_][A-Za-z0-9_]*[!?]?|[-+]?\d[\d_.]*)/uy;
const ANY_APPLY_RE = /(?:\bKernel\s*\.\s*|:erlang\s*\.\s*|\b)apply\s*\(/gu;
const ATOM_PRODUCER_RE = /\bString\.(to_atom|to_existing_atom)\s*\(/gu;
const PHOENIX_CONTROLLER = "Phoenix.Controller";
const MAP_CALL_RE =
  /\bMap\.(fetch!|fetch|get|get_lazy|has_key\?|delete|put|put_new|put_new_lazy|replace|replace!|update|update!)\s*\(/gu;
const ENUM_MAP_CALL_RE = /\bEnum\.map\s*\(/gu;
const NEXT_FN_TUPLE_CLAUSE_RE =
  /\{\s*[a-z_][A-Za-z0-9_]*\s*,\s*[a-z_][A-Za-z0-9_]*\s*\}(?:\s+when\b[^\n]*?)?\s*->/uy;
const FN_TUPLE_CLAUSE_HEAD_RE =
  /^\{\s*[a-z_][A-Za-z0-9_]*\s*,\s*[a-z_][A-Za-z0-9_]*\s*\}(?:\s+when\b[^\n]*?)?\s*$/u;

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
  const sourceApplyCountsBySite = indexSourceApplyCountsBySite(sources);
  const usingSelectorsByCarrier = indexUsingSelectorsByCarrier(traceResult.events, sources);
  const dispatchModules = indexUseDispatcherModules(
    traceResult.events,
    parsedBySite,
    usingSelectorsByCarrier,
  );
  const useEventsBySite = indexUseEventsBySite(traceResult.events);
  const useFactCountsBySite = indexUseFactCountsBySite(sources);
  const aliasTargetsByCarrierSite = indexAliasTargets(traceResult.events);

  const references: ElixirRuntimeReference[] = [];
  const seen = new Set<string>();
  const provenUseEvents: TraceEvent[] = [];
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
      const sourceModule = match[1];
      const toName = match[2];
      if (sourceModule === undefined || toName === undefined) continue;
      const line = lineAt(source.lineStarts, match.index ?? 0);
      const siteEvents = useEventsBySite.get(dispatchSiteKey(file, line)) ?? [];
      if (useFactCountsBySite.get(dispatchSiteKey(file, line)) !== 1) continue;
      const dispatcherEvents = siteEvents.filter((event) => dispatchModules.has(event.to_mod));
      const literalMatches = dispatcherEvents.filter((event) => event.to_mod === sourceModule);
      // A selected helper may expand to nested `use` calls that the compiler
      // attributes to the outer source line. Prefer the literal outer module;
      // retain the existing unique compiler-expansion path for aliases. More
      // than one viable dispatcher stays conservative.
      const aliasMatch =
        dispatcherEvents.length === 1 && dispatcherEvents[0] !== undefined
          ? compilerConfirmedAlias(dispatcherEvents[0], aliasTargetsByCarrierSite)
          : false;
      const useEvent =
        literalMatches.length === 1
          ? literalMatches[0]
          : aliasMatch
            ? dispatcherEvents[0]
            : undefined;
      if (useEvent === undefined) continue;
      const toMod = useEvent.to_mod;
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
      provenUseEvents.push(useEvent);
    }
  }

  const dynamicDispatches = extractDynamicDispatches(
    traceResult,
    sources,
    parsedBySite,
    sourceApplyCountsBySite,
    usingSelectorsByCarrier,
    functionsByModuleName,
    references,
    seen,
    provenUseEvents,
  );
  return { references, dynamicDispatches };
}

function indexParsedApplies(
  sources: ReadonlyMap<string, SourceIndex>,
): ReadonlyMap<string, ParsedApply[]> {
  const parsedBySite = new Map<string, ParsedApply[]>();
  for (const [file, source] of sources) {
    for (const match of source.code.matchAll(APPLY_PREFIX_RE)) {
      const moduleExpr = match[1];
      const functionExpr = match[2];
      if (moduleExpr === undefined || functionExpr === undefined) continue;
      const callOpen = (match.index ?? 0) + match[0].indexOf("(");
      const callClose = source.closeByOpen.get(callOpen);
      const commas = source.commasByOpen.get(callOpen) ?? [];
      if (callClose === undefined || commas.length !== 2 || commas[1] === undefined) continue;
      const argsStart = skipWhitespaceForward(source.code, commas[1] + 1, callClose);
      const argsEnd = skipWhitespaceBackward(source.code, callClose, argsStart);
      const arity = staticProperListArity(source, argsStart, argsEnd);
      const line = lineAt(source.lineStarts, match.index ?? 0);
      append(parsedBySite, dispatchSiteKey(file, line), {
        moduleExpr,
        functionExpr,
        arity,
      });
    }
  }
  return parsedBySite;
}

/**
 * Recover an apply arity only from a closed proper list whose top-level
 * elements cannot hide commas in syntax the lightweight delimiter index does
 * not model. Anything richer remains dynamic instead of filtering candidates.
 */
function staticProperListArity(source: SourceIndex, start: number, end: number): number | null {
  if (source.code[start] !== "[" || source.closeByOpen.get(start) !== end - 1) return null;
  if (skipWhitespaceForward(source.content, start + 1, end - 1) === end - 1) return 0;

  const close = end - 1;
  const commas = source.commasByOpen.get(start) ?? [];
  const boundaries = [start + 1, ...commas.map((comma) => comma + 1), close];
  for (let index = 0; index + 1 < boundaries.length; index += 1) {
    const segmentStart = skipWhitespaceForward(source.code, boundaries[index] ?? close, close);
    const segmentEnd = skipWhitespaceBackward(
      source.code,
      (boundaries[index + 1] ?? close) - (index < commas.length ? 1 : 0),
      segmentStart,
    );
    if (!isStaticallySeparatedListElement(source, segmentStart, segmentEnd)) return null;
  }
  return commas.length + 1;
}

function isStaticallySeparatedListElement(
  source: SourceIndex,
  start: number,
  end: number,
): boolean {
  if (start >= end) return false;
  STATIC_LIST_ELEMENT_RE.lastIndex = start;
  if (STATIC_LIST_ELEMENT_RE.exec(source.code) !== null && STATIC_LIST_ELEMENT_RE.lastIndex === end)
    return true;

  const opener = source.code[start];
  if (
    (opener === "[" || opener === "{" || opener === "(") &&
    source.closeByOpen.get(start) === end - 1
  ) {
    return true;
  }
  return (
    opener === "%" &&
    source.code[start + 1] === "{" &&
    source.closeByOpen.get(start + 1) === end - 1
  );
}

function indexSourceApplyCountsBySite(
  sources: ReadonlyMap<string, SourceIndex>,
): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  for (const [file, source] of sources) {
    for (const match of source.code.matchAll(ANY_APPLY_RE)) {
      const key = dispatchSiteKey(file, lineAt(source.lineStarts, match.index ?? 0));
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return counts;
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
  sourceApplyCountsBySite: ReadonlyMap<string, number>,
  usingSelectorsByCarrier: ReadonlyMap<string, number>,
  functionsByModuleName: ReadonlyMap<string, FunctionRecord[]>,
  references: ElixirRuntimeReference[],
  seenReferences: Set<string>,
  provenUseEvents: readonly TraceEvent[],
): ElixirDynamicDispatch[] {
  const candidateIndex = indexFunctionCandidates(traceResult.functions, functionsByModuleName);
  const functionsByModule = candidateIndex.byModule;
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
  const provenUseSites = new Set(provenUseEvents.map(generatedUseSiteKey));
  const phoenixActionUseSites = indexPhoenixActionUseSites(traceResult);

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
    if (
      isApply3 &&
      (parsed === undefined || parsed.length === 0) &&
      event.from_mod !== null &&
      event.from_fun === "action/2" &&
      (sourceApplyCountsBySite.get(dispatchSiteKey(event.file, event.line)) ?? 0) === 0 &&
      provenUseSites.has(generatedUseSiteKey(event)) &&
      phoenixActionUseSites.get(generatedUseSiteKey(event)) === 1
    ) {
      const ownerFunctions = functionsByModule.get(event.from_mod) ?? [];
      const carriers = ownerFunctions.filter(
        (candidate) =>
          candidate.partition === event.partition &&
          candidate.name === "action" &&
          candidate.arity === 2,
      );
      if (carriers.length !== 1 || carriers[0] === undefined) {
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
      const carrier = carriers[0];
      // Phoenix.Controller generates action/2 as the reflective carrier. A
      // module-level convention edge activates it whenever the proven owner
      // module is live, without pretending the generated function was called
      // directly in source.
      addReference(references, seenReferences, {
        fromMod: event.from_mod,
        toMod: carrier.mod,
        toName: carrier.name,
        toArity: carrier.arity,
        file: event.file,
        line: event.line,
        convention: "dynamic-apply",
      });
      const targets = ownerFunctions.filter(
        (candidate) =>
          candidate.partition === event.partition &&
          candidate.arity === 2 &&
          candidate.name !== "action" &&
          !candidate.name.startsWith("__"),
      );
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
    if (
      !isApply3 ||
      siteEvents.length !== 1 ||
      sourceApplyCountsBySite.get(dispatchSiteKey(event.file, event.line)) !== 1 ||
      parsed?.length !== 1 ||
      parsed[0] === undefined
    ) {
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
    const targets = candidateFunctions(candidateIndex, targetModule, targetFunction, call.arity);

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
 * either a direct key argument of a compiler-confirmed `Map` operation or the
 * complete tuple key returned by a proven `Enum.map` → `Enum.into(%{})`
 * rebuild. Receiver dispatch, assignment, arbitrary tuples, intervening or
 * unproven pipelines, and same-line ambiguity deliberately fail this proof.
 */
function safeAtomProducerEvents(
  events: readonly TraceEvent[],
  sources: ReadonlyMap<string, SourceIndex>,
): ReadonlySet<TraceEvent> {
  const sourceFacts = new Map<string, AtomProducerFact[]>();
  for (const [file, source] of sources) {
    const mapCalls = indexMapCalls(source);
    const mapIntoPipelines = indexEnumMapIntoPipelines(source);
    for (const match of source.code.matchAll(ATOM_PRODUCER_RE)) {
      const name = match[1];
      if (name === undefined) continue;
      const start = match.index ?? 0;
      const open = start + match[0].length - 1;
      const close = source.closeByOpen.get(open);
      if (close === undefined) continue;
      const line = lineAt(source.lineStarts, start);
      const safeMap = directMapKeyConsumer(source, mapCalls, start, open, close);
      const safeMapInto = directEnumMapIntoKeyConsumer(
        source,
        mapIntoPipelines,
        start,
        open,
        close,
      );
      append(sourceFacts, atomSiteKey(file, line, name), {
        file,
        line,
        name,
        ...(safeMap === null ? {} : { safeMap }),
        ...(safeMapInto === null ? {} : { safeMapInto }),
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
    if (fact === undefined || event === undefined) continue;
    if (fact.safeMap !== undefined) {
      const safeMap = fact.safeMap;
      const mapCarrierSite = carrierAt(fact.file, safeMap.line, event);
      const compilerCalls = (ordinaryEventsByCarrier.get(mapCarrierSite) ?? []).filter(
        (candidate) =>
          candidate.to_mod === "Map" &&
          candidate.name === safeMap.name &&
          candidate.arity === safeMap.arity,
      );
      if (compilerCalls.length === 1) safe.add(event);
      continue;
    }
    if (fact.safeMapInto === undefined) continue;
    const mapCalls = (
      ordinaryEventsByCarrier.get(carrierAt(fact.file, fact.safeMapInto.mapLine, event)) ?? []
    ).filter(
      (candidate) =>
        candidate.to_mod === "Enum" && candidate.name === "map" && candidate.arity === 2,
    );
    const intoCalls = (
      ordinaryEventsByCarrier.get(carrierAt(fact.file, fact.safeMapInto.intoLine, event)) ?? []
    ).filter(
      (candidate) =>
        candidate.to_mod === "Enum" && candidate.name === "into" && candidate.arity === 2,
    );
    if (mapCalls.length === 1 && intoCalls.length === 1) safe.add(event);
  }
  return safe;
}

interface AtomProducerFact {
  readonly file: string;
  readonly line: number;
  readonly name: string;
  readonly safeMap?: { readonly name: string; readonly arity: number; readonly line: number };
  readonly safeMapInto?: { readonly mapLine: number; readonly intoLine: number };
}

interface EnumMapIntoPipeline {
  readonly bodyStart: number;
  readonly bodyEnd: number;
  readonly resultStart: number;
  readonly mapLine: number;
  readonly intoLine: number;
}

interface MapCall {
  readonly name: string;
  readonly arity: number;
  readonly open: number;
  readonly keyArgument: number;
  readonly line: number;
}

function carrierAt(file: string, line: number, event: TraceEvent): string {
  return [file, line, event.from_mod ?? "", event.from_fun ?? ""].join("\0");
}

function indexEnumMapIntoPipelines(source: SourceIndex): readonly EnumMapIntoPipeline[] {
  const pipelines: EnumMapIntoPipeline[] = [];
  for (const match of source.code.matchAll(ENUM_MAP_CALL_RE)) {
    const mapStart = match.index ?? 0;
    const mapOpen = mapStart + match[0].length - 1;
    const mapClose = source.closeByOpen.get(mapOpen);
    if (mapClose === undefined) continue;
    const fnStart = skipWhitespaceForward(source.code, mapOpen + 1, mapClose);
    if (
      !source.code.startsWith("fn", fnStart) ||
      /[A-Za-z0-9_]/u.test(source.code[fnStart + 2] ?? "")
    )
      continue;
    const endExclusive = skipWhitespaceBackward(source.code, mapClose, fnStart + 2);
    const bodyEnd = endExclusive - 3;
    if (
      bodyEnd < fnStart + 2 ||
      source.code.slice(bodyEnd, endExclusive) !== "end" ||
      /[A-Za-z0-9_]/u.test(source.code[bodyEnd - 1] ?? "")
    ) {
      continue;
    }
    const intoStart = immediateEmptyMapInto(source, mapClose);
    if (intoStart === null) continue;
    const clauseHeadStart = skipWhitespaceForward(source.code, fnStart + 2, bodyEnd);
    const clauseLine = lineAt(source.lineStarts, clauseHeadStart);
    const clauseLimit = Math.min(source.lineStarts[clauseLine] ?? bodyEnd, bodyEnd);
    const arrow = findArrow(source.code, clauseHeadStart, clauseLimit);
    if (arrow === null) continue;
    if (!FN_TUPLE_CLAUSE_HEAD_RE.test(source.code.slice(clauseHeadStart, arrow))) continue;
    pipelines.push({
      bodyStart: fnStart + 2,
      bodyEnd,
      resultStart: skipWhitespaceForward(source.code, arrow + 2, bodyEnd),
      mapLine: lineAt(source.lineStarts, mapStart),
      intoLine: lineAt(source.lineStarts, intoStart),
    });
  }
  return pipelines;
}

function findArrow(content: string, start: number, end: number): number | null {
  for (let index = start; index + 1 < end; index += 1) {
    if (content[index] === "-" && content[index + 1] === ">") return index;
  }
  return null;
}

function immediateEmptyMapInto(source: SourceIndex, mapClose: number): number | null {
  let index = skipWhitespaceForward(source.code, mapClose + 1, source.code.length);
  if (!source.code.startsWith("|>", index)) return null;
  index = skipWhitespaceForward(source.code, index + 2, source.code.length);
  const intoStart = index;
  if (!source.code.startsWith("Enum.into", index)) return null;
  index = skipWhitespaceForward(source.code, index + "Enum.into".length, source.code.length);
  if (source.code[index] !== "(") return null;
  const intoOpen = index;
  const intoClose = source.closeByOpen.get(intoOpen);
  if (intoClose === undefined) return null;
  index = skipWhitespaceForward(source.code, intoOpen + 1, intoClose);
  if (!source.code.startsWith("%{", index)) return null;
  const mapOpen = index + 1;
  const emptyMapClose = source.closeByOpen.get(mapOpen);
  if (emptyMapClose === undefined || emptyMapClose >= intoClose) return null;
  if (skipWhitespaceForward(source.code, mapOpen + 1, emptyMapClose) !== emptyMapClose) return null;
  return skipWhitespaceForward(source.code, emptyMapClose + 1, intoClose) === intoClose
    ? intoStart
    : null;
}

function directEnumMapIntoKeyConsumer(
  source: SourceIndex,
  pipelines: readonly EnumMapIntoPipeline[],
  producerStart: number,
  producerOpen: number,
  producerClose: number,
): { readonly mapLine: number; readonly intoLine: number } | null {
  const tupleOpen = source.parentByOpen.get(producerOpen);
  if (tupleOpen === undefined || source.code[tupleOpen] !== "{") return null;
  const tupleClose = source.closeByOpen.get(tupleOpen);
  const tupleCommas = source.commasByOpen.get(tupleOpen) ?? [];
  if (tupleClose === undefined || tupleCommas.length !== 1 || tupleCommas[0] === undefined)
    return null;
  const keyEnd = tupleCommas[0];
  if (
    skipWhitespaceForward(source.code, tupleOpen + 1, keyEnd) !== producerStart ||
    skipWhitespaceBackward(source.code, keyEnd, tupleOpen + 1) !== producerClose + 1
  ) {
    return null;
  }

  const pipeline = containingPipeline(pipelines, tupleOpen, tupleClose);
  if (pipeline === null || pipeline.resultStart !== tupleOpen) return null;
  const afterTuple = skipWhitespaceForward(source.code, tupleClose + 1, pipeline.bodyEnd + 1);
  if (afterTuple !== pipeline.bodyEnd) {
    NEXT_FN_TUPLE_CLAUSE_RE.lastIndex = afterTuple;
    const nextClause = NEXT_FN_TUPLE_CLAUSE_RE.exec(source.code);
    if (
      nextClause === null ||
      nextClause.index !== afterTuple ||
      NEXT_FN_TUPLE_CLAUSE_RE.lastIndex > pipeline.bodyEnd
    ) {
      return null;
    }
  }
  return { mapLine: pipeline.mapLine, intoLine: pipeline.intoLine };
}

function containingPipeline(
  pipelines: readonly EnumMapIntoPipeline[],
  start: number,
  end: number,
): EnumMapIntoPipeline | null {
  let low = 0;
  let high = pipelines.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if ((pipelines[middle]?.bodyStart ?? Number.POSITIVE_INFINITY) <= start) low = middle + 1;
    else high = middle;
  }
  const candidate = pipelines[low - 1];
  return candidate !== undefined && end <= candidate.bodyEnd ? candidate : null;
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

interface FunctionCandidateIndex {
  readonly all: readonly FunctionRecord[];
  readonly byModule: ReadonlyMap<string, FunctionRecord[]>;
  readonly byName: ReadonlyMap<string, FunctionRecord[]>;
  readonly byArity: ReadonlyMap<number, FunctionRecord[]>;
  readonly byModuleName: ReadonlyMap<string, FunctionRecord[]>;
  readonly byModuleArity: ReadonlyMap<string, FunctionRecord[]>;
  readonly byNameArity: ReadonlyMap<string, FunctionRecord[]>;
  readonly byModuleNameArity: ReadonlyMap<string, FunctionRecord[]>;
}

function indexFunctionCandidates(
  functions: readonly FunctionRecord[],
  byModuleName: ReadonlyMap<string, FunctionRecord[]>,
): FunctionCandidateIndex {
  const byModule = new Map<string, FunctionRecord[]>();
  const byName = new Map<string, FunctionRecord[]>();
  const byArity = new Map<number, FunctionRecord[]>();
  const byModuleArity = new Map<string, FunctionRecord[]>();
  const byNameArity = new Map<string, FunctionRecord[]>();
  const byModuleNameArity = new Map<string, FunctionRecord[]>();
  for (const fn of functions) {
    append(byModule, fn.mod, fn);
    append(byName, fn.name, fn);
    append(byArity, fn.arity, fn);
    append(byModuleArity, `${fn.mod}\0${fn.arity}`, fn);
    append(byNameArity, `${fn.name}\0${fn.arity}`, fn);
    append(byModuleNameArity, `${fn.mod}\0${fn.name}\0${fn.arity}`, fn);
  }
  return {
    all: functions,
    byModule,
    byName,
    byArity,
    byModuleName,
    byModuleArity,
    byNameArity,
    byModuleNameArity,
  };
}

function candidateFunctions(
  index: FunctionCandidateIndex,
  module: string | null,
  name: string | null,
  arity: number | null,
): readonly FunctionRecord[] {
  if (module !== null && name !== null && arity !== null)
    return index.byModuleNameArity.get(`${module}\0${name}\0${arity}`) ?? [];
  if (module !== null && name !== null) return index.byModuleName.get(`${module}\0${name}`) ?? [];
  if (module !== null && arity !== null)
    return index.byModuleArity.get(`${module}\0${arity}`) ?? [];
  if (name !== null && arity !== null) return index.byNameArity.get(`${name}\0${arity}`) ?? [];
  if (module !== null) return index.byModule.get(module) ?? [];
  if (name !== null) return index.byName.get(name) ?? [];
  if (arity !== null) return index.byArity.get(arity) ?? [];
  return index.all;
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

function compilerConfirmedAlias(
  event: TraceEvent,
  aliasTargetsByCarrierSite: ReadonlyMap<string, ReadonlySet<string>>,
): boolean {
  const targets = aliasTargetsByCarrierSite.get(aliasCarrierSiteKey(event));
  return targets?.size === 1 && targets.has(event.to_mod);
}

function aliasCarrierSiteKey(event: TraceEvent): string {
  return [event.file, event.line, event.from_mod ?? "", event.from_fun ?? "", event.partition].join(
    "\0",
  );
}

function dispatchSiteKey(file: string, line: number): string {
  return `${file}\0${line}`;
}

function generatedUseSiteKey(event: TraceEvent): string {
  return `${event.file}\0${event.line}\0${event.from_mod ?? ""}\0${event.partition}`;
}

function indexPhoenixActionUseSites(traceResult: TraceResult): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  if (!traceResult.deps.includes("phoenix")) return counts;
  if (traceResult.modules.some((record) => record.mod === PHOENIX_CONTROLLER)) return counts;
  for (const event of traceResult.events) {
    if (
      event.name !== "__using__" ||
      event.arity !== 1 ||
      event.to_mod !== PHOENIX_CONTROLLER ||
      event.from_mod === null
    ) {
      continue;
    }
    const key = generatedUseSiteKey(event);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
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
