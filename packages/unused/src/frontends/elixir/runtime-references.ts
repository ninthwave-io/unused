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
import {
  createElixirAtomRoleSummaryLookup,
  type ElixirAtomRoleSummary,
  type ElixirAtomRoleSummaryLookup,
  type ElixirAtomRoleSummaryProvider,
} from "./atom-role-summaries.js";
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

interface ElixirDynamicFactBase {
  readonly fromMod: string;
  readonly fromFun?: string;
  readonly file: string;
  readonly line: number;
  readonly kind: "exact" | "bounded" | "opaque";
  readonly world: "production" | "test";
  /** Exact compiler event identity; avoids conflating same-line carriers. */
  readonly eventKey: string;
  /** Compiler-confirmed public functions that a bounded call may select. */
  readonly targets: readonly FunctionRecord[];
}

/** A known atom-producing call and the bounded disposition of its result. */
export interface ElixirComputedAtomFact extends ElixirDynamicFactBase {
  readonly factKind: "computed-atom";
  readonly flow: "data" | "delegated-invocation" | "escape";
  readonly kind: "exact" | "opaque";
}

/** A runtime operation that actually selects executable code. */
export interface ElixirDynamicInvocationFact extends ElixirDynamicFactBase {
  readonly factKind: "dynamic-invocation";
}

export type ElixirDynamicDispatch = ElixirComputedAtomFact | ElixirDynamicInvocationFact;

export interface ElixirRuntimeConventions {
  readonly references: readonly ElixirRuntimeReference[];
  readonly dynamicDispatches: readonly ElixirDynamicDispatch[];
  readonly atomFlowStats: Readonly<ElixirAtomFlowStats>;
}

export interface ElixirAtomFlowStats {
  readonly sources: number;
  readonly sourceBytes: number;
  readonly producers: number;
  readonly roleEdges: number;
  readonly queueVisits: number;
  readonly summaryMatches: number;
  readonly dataSinks: number;
  readonly invocationSinks: number;
  readonly escapes: number;
  /** Compiler atom-producer events joined to one exact source outcome. */
  readonly joinedProducerOutcomes: number;
  /** Compiler atom-producer events that retained the opaque fallback. */
  readonly unjoinedOpaqueFallbacks: number;
  /** Outcomes where the legacy data predicate and indexed data result differ. */
  readonly legacyIndexedDisagreements: number;
}

type MutableAtomFlowStats = { -readonly [K in keyof ElixirAtomFlowStats]: number };

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
const ASSIGNMENT_RE = /([a-z_][A-Za-z0-9_]*)\s*=\s*/uy;
const LOCAL_IDENTIFIER_RE = /[a-z_][A-Za-z0-9_]*/uy;
const FUNCTION_DEFINITION_RE = /^([ \t]*)defp?\s+[a-z_][A-Za-z0-9_]*[!?]?\b/gmu;
const EXACT_BINARY_GUARD_RE = /^when\s+is_binary\s*\(\s*([a-z_][A-Za-z0-9_]*)\s*\)\s+do\s*$/u;
const CLAUSE_GUARD_RE = /^(.+?)\s+when\s+(.+)$/u;
const SIMPLE_BINDER_RE = /^[a-z_][A-Za-z0-9_]*$/u;
const OK_TUPLE_BINDER_RE = /^\{\s*:ok\s*,\s*([a-z_][A-Za-z0-9_]*)\s*\}$/u;
const LITERAL_ATOM_RE = /^:[a-z_][A-Za-z0-9_]*[!?]?$/u;
const ROLE_CALL_RE = new RegExp(
  String.raw`(?:(?:\b(${MODULE})|\b(Atom|Enum|Keyword|Map|MapSet))\s*\.\s*)?(${FUNCTION})\s*\(`,
  "gu",
);

interface IdentifierOccurrence {
  readonly start: number;
  readonly end: number;
  readonly parentOpen?: number;
}

interface FunctionRange {
  readonly start: number;
  readonly end: number;
  readonly headerEnd: number;
  readonly indent: number;
  readonly parent?: number;
  readonly binaryGuards: ReadonlySet<string>;
}

interface BlockRange {
  readonly open: number;
  readonly close: number;
  readonly parent?: number;
}

interface BlockIndex {
  readonly closeByOpen: ReadonlyMap<number, number>;
  readonly ranges: readonly BlockRange[];
  readonly arrowsByOpen: ReadonlyMap<number, readonly number[]>;
}

interface SourceIndex {
  readonly content: string;
  readonly code: string;
  readonly lineStarts: readonly number[];
  readonly closeByOpen: ReadonlyMap<number, number>;
  readonly parentByOpen: ReadonlyMap<number, number>;
  readonly commasByOpen: ReadonlyMap<number, readonly number[]>;
  readonly identifiersByName: ReadonlyMap<string, readonly IdentifierOccurrence[]>;
  readonly interpolationStarts: readonly number[];
  readonly atomProducerStarts: readonly number[];
  readonly blockRanges: readonly BlockRange[];
  readonly arrowsByBlockOpen: ReadonlyMap<number, readonly number[]>;
  readonly rescuesByBlockOpen: ReadonlyMap<number, readonly number[]>;
  readonly functionRanges: readonly FunctionRange[];
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
  summaryProviders: readonly ElixirAtomRoleSummaryProvider[] = [],
): ElixirRuntimeConventions {
  const atomFlowStats: MutableAtomFlowStats = {
    sources: 0,
    sourceBytes: 0,
    producers: 0,
    roleEdges: 0,
    queueVisits: 0,
    summaryMatches: 0,
    dataSinks: 0,
    invocationSinks: 0,
    escapes: 0,
    joinedProducerOutcomes: 0,
    unjoinedOpaqueFallbacks: 0,
    legacyIndexedDisagreements: 0,
  };
  const functionsByModuleName = indexFunctions(traceResult.functions);
  const atomRoleSummaryLookup = createElixirAtomRoleSummaryLookup(
    applicableAtomRoleSummaries(traceResult, summaryProviders),
  );
  const contents = readProjectSources(projectDir, traceResult);
  const sources = new Map(
    [...contents].map(([file, content]) => [file, indexSource(content)] as const),
  );
  atomFlowStats.sources = sources.size;
  atomFlowStats.sourceBytes = [...contents.values()].reduce(
    (total, content) => total + content.length,
    0,
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
    atomFlowStats,
    atomRoleSummaryLookup,
  );
  return { references, dynamicDispatches, atomFlowStats };
}

function applicableAtomRoleSummaries(
  traceResult: TraceResult,
  providers: readonly ElixirAtomRoleSummaryProvider[],
): readonly ElixirAtomRoleSummary[] {
  const summaries: ElixirAtomRoleSummary[] = [];
  const providerIds = new Set<string>();
  for (const provider of providers) {
    if (providerIds.has(provider.id)) {
      throw new Error(`duplicate Elixir atom role summary provider: ${provider.id}`);
    }
    providerIds.add(provider.id);
    if (!traceResult.deps.includes(provider.dependency)) continue;
    for (const summary of provider.summaries) {
      if (
        summary.origin.pluginId !== provider.id ||
        summary.origin.dependency !== provider.dependency
      ) {
        throw new Error(`Elixir atom role summary is not owned by provider ${provider.id}`);
      }
      summaries.push(summary);
    }
  }
  return summaries;
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
  atomFlowStats: MutableAtomFlowStats,
  atomRoleSummaryLookup: ElixirAtomRoleSummaryLookup,
): ElixirDynamicDispatch[] {
  const candidateIndex = indexFunctionCandidates(traceResult.functions, functionsByModuleName);
  const functionsByModule = candidateIndex.byModule;
  const aliasTargetsByCarrierSite = indexAliasTargets(traceResult.events);

  const dynamicEventsBySite = indexDynamicEventsBySite(traceResult.events);
  const atomProducerRoles = classifyAtomProducerEvents(
    traceResult,
    sources,
    atomFlowStats,
    atomRoleSummaryLookup,
  );
  const safeAtomEvents = atomProducerRoles.data;
  const directAtomInvocationEvents = atomProducerRoles.invocation;
  const delegatedAtomInvocationEvents = atomProducerRoles.delegatedInvocation;
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
    if (delegatedAtomInvocationEvents.has(event)) {
      dispatches.push({
        ...owner,
        file: event.file,
        line: event.line,
        factKind: "computed-atom",
        flow: "delegated-invocation",
        kind: "exact",
        world: event.partition === "test" ? "test" : "production",
        eventKey,
        targets: [],
      });
      continue;
    }
    if (safeAtomEvents.has(event)) {
      dispatches.push({
        ...owner,
        file: event.file,
        line: event.line,
        factKind: "computed-atom",
        flow: "data",
        kind: "exact",
        world: event.partition === "test" ? "test" : "production",
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
        factKind: "dynamic-invocation",
        kind: "exact",
        world: event.partition === "test" ? "test" : "production",
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
          factKind: "dynamic-invocation",
          kind: "opaque",
          world: event.partition === "test" ? "test" : "production",
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
        factKind: "dynamic-invocation",
        kind: "bounded",
        world: event.partition === "test" ? "test" : "production",
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
      const atomProducer = isAtomProducerEvent(event);
      const directInvocation = directAtomInvocationEvents.has(event);
      dispatches.push({
        ...owner,
        file: event.file,
        line: event.line,
        ...(atomProducer && !directInvocation
          ? { factKind: "computed-atom" as const, flow: "escape" as const }
          : { factKind: "dynamic-invocation" as const }),
        kind: "opaque",
        world: event.partition === "test" ? "test" : "production",
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
        factKind: "dynamic-invocation",
        kind: "exact",
        world: event.partition === "test" ? "test" : "production",
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
        factKind: "dynamic-invocation",
        kind: "bounded",
        world: event.partition === "test" ? "test" : "production",
        eventKey,
        targets,
      });
      continue;
    }
    dispatches.push({
      ...owner,
      file: event.file,
      line: event.line,
      factKind: "dynamic-invocation",
      kind: "opaque",
      world: event.partition === "test" ? "test" : "production",
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

type AtomFlowDisposition = "data" | "invocation" | "escape";

interface IndexedRoleCall {
  readonly module: string | null;
  readonly name: string;
  readonly arity: number;
  readonly start: number;
  readonly open: number;
  readonly close: number;
  readonly line: number;
  readonly piped: boolean;
  readonly sourceCardinality: number;
}

interface AtomFlowResult {
  readonly disposition: AtomFlowDisposition;
  readonly requiredCalls: readonly IndexedRoleCall[];
  /** A compiler-confirmed dynamic call will emit the invocation hazard itself. */
  readonly delegatedInvocation?: true;
}

interface AtomRoleIndex {
  readonly callsByOpen: ReadonlyMap<number, IndexedRoleCall>;
  readonly pipelineCalls: readonly IndexedRoleCall[];
}

interface AtomFlowContext {
  readonly producerEvent: TraceEvent;
  readonly eventsBySourceCall: ReadonlyMap<string, readonly TraceEvent[]>;
  readonly summaryLookup: ElixirAtomRoleSummaryLookup;
  readonly projectModules: ReadonlySet<string>;
  readonly stats: MutableAtomFlowStats;
  /** Reviewed migration adapter for legacy exact terminal proofs only. */
  readonly legacyTerminal: boolean;
}

const ATOM_FLOW_DATA = 1 << 0;
const ATOM_FLOW_INVOCATION = 1 << 1;
const ATOM_FLOW_ESCAPE = 1 << 2;
const ATOM_FLOW_DELEGATED_INVOCATION = 1 << 3;
const ATOM_FLOW_LEGACY_DATA = 1 << 4;

interface AtomFlowNode {
  readonly key: string;
  readonly context: AtomFlowContext;
  readonly kind: "value" | "assignment";
  readonly start: number;
  readonly end: number;
  readonly parentOpen?: number;
  readonly name?: string;
  readonly incoming: Set<string>;
  readonly outgoing: Set<string>;
  terminal: number;
  outcome: number;
}

interface AtomFlowGraph {
  readonly source: SourceIndex;
  readonly roles: AtomRoleIndex;
  readonly nodes: Map<string, AtomFlowNode>;
  readonly pending: AtomFlowNode[];
  readonly stats: MutableAtomFlowStats;
}

/**
 * Build the bounded call-role index once per compiler-owned source. Calls not
 * present in the declarative registry remain indexed so an enclosing unknown
 * call cannot be skipped in favour of a known outer data sink.
 */
function indexAtomRoles(source: SourceIndex): AtomRoleIndex {
  const pending: Array<Omit<IndexedRoleCall, "sourceCardinality">> = [];
  const cardinality = new Map<string, number>();
  for (const match of source.code.matchAll(ROLE_CALL_RE)) {
    const name = match[3];
    if (name === undefined) continue;
    const start = match.index ?? 0;
    const open = start + match[0].length - 1;
    const close = source.closeByOpen.get(open);
    if (close === undefined) continue;
    const module = match[1] ?? match[2] ?? null;
    const explicitArity = callArity(source, open);
    const pipe = precedingPipe(source.code, start);
    const piped = pipe !== null;
    const arity = explicitArity + (piped ? 1 : 0);
    const line = lineAt(source.lineStarts, start);
    const key = `${containingFunctionRange(source.functionRanges, start)?.start ?? -1}\0${line}\0${name}\0${arity}`;
    cardinality.set(key, (cardinality.get(key) ?? 0) + 1);
    pending.push({
      module,
      name,
      arity,
      start,
      open,
      close,
      line,
      piped,
    });
  }
  const calls = pending.map((call) => ({
    ...call,
    sourceCardinality:
      cardinality.get(
        `${containingFunctionRange(source.functionRanges, call.start)?.start ?? -1}\0${call.line}\0${call.name}\0${call.arity}`,
      ) ?? 0,
  }));
  return {
    callsByOpen: new Map(calls.map((call) => [call.open, call])),
    pipelineCalls: calls.filter((call) => call.piped),
  };
}

function callArity(source: SourceIndex, open: number): number {
  const close = source.closeByOpen.get(open);
  if (close === undefined) return 0;
  const start = skipWhitespaceForward(source.code, open + 1, close);
  if (start === close) return 0;
  return (source.commasByOpen.get(open)?.length ?? 0) + 1;
}

function precedingPipe(code: string, callStart: number): number | null {
  const before = skipWhitespaceBackward(code, callStart, 0);
  if (before < 2 || code.slice(before - 2, before) !== "|>") return null;
  return before - 2;
}

function atomFlowContextKey(context: AtomFlowContext): string {
  const event = context.producerEvent;
  return [
    event.file,
    event.from_mod ?? "",
    event.from_fun ?? "",
    event.partition,
    context.legacyTerminal ? "legacy" : "indexed",
  ].join("\0");
}

function ensureAtomValueNode(
  graph: AtomFlowGraph,
  producerStart: number,
  producerEnd: number,
  parentOpen: number | undefined,
  context: AtomFlowContext,
): string {
  const key = `${atomFlowContextKey(context)}\0v\0${producerStart}\0${producerEnd}\0${parentOpen ?? -1}`;
  if (!graph.nodes.has(key)) {
    const node: AtomFlowNode = {
      key,
      context,
      kind: "value",
      start: producerStart,
      end: producerEnd,
      ...(parentOpen === undefined ? {} : { parentOpen }),
      incoming: new Set(),
      outgoing: new Set(),
      terminal: 0,
      outcome: 0,
    };
    graph.nodes.set(key, node);
    graph.pending.push(node);
  }
  return key;
}

function ensureAtomAssignmentNode(
  graph: AtomFlowGraph,
  assignment: { readonly name: string; readonly start: number; readonly end: number },
  context: AtomFlowContext,
): string {
  const key = `${atomFlowContextKey(context)}\0a\0${assignment.start}\0${assignment.end}\0${assignment.name}`;
  if (!graph.nodes.has(key)) {
    const node: AtomFlowNode = {
      key,
      context,
      kind: "assignment",
      start: assignment.start,
      end: assignment.end,
      name: assignment.name,
      incoming: new Set(),
      outgoing: new Set(),
      terminal: 0,
      outcome: 0,
    };
    graph.nodes.set(key, node);
    graph.pending.push(node);
  }
  return key;
}

function addAtomFlowEdge(graph: AtomFlowGraph, from: AtomFlowNode, toKey: string): void {
  if (from.outgoing.has(toKey)) return;
  from.outgoing.add(toKey);
  graph.nodes.get(toKey)?.incoming.add(from.key);
  graph.stats.roleEdges += 1;
}

function expressionAssignment(
  source: SourceIndex,
  expressionStart: number,
  expressionEnd: number,
): { readonly name: string; readonly start: number; readonly end: number } | null {
  const line = lineAt(source.lineStarts, expressionStart);
  const lineStart = source.lineStarts[line - 1] ?? 0;
  const lineEnd = source.lineStarts[line] ?? source.code.length;
  const expressionEndLine = lineAt(source.lineStarts, Math.max(expressionStart, expressionEnd - 1));
  const expressionLineEnd = source.lineStarts[expressionEndLine] ?? source.code.length;
  const assignmentStart = skipWhitespaceForward(source.code, lineStart, expressionStart);
  ASSIGNMENT_RE.lastIndex = assignmentStart;
  const match = ASSIGNMENT_RE.exec(source.code);
  const name = match?.[1];
  if (
    name !== undefined &&
    ASSIGNMENT_RE.lastIndex === expressionStart &&
    skipWhitespaceForward(source.code, expressionEnd, expressionLineEnd) === expressionLineEnd
  ) {
    return { name, start: assignmentStart, end: expressionEnd };
  }
  const prefix = source.code.slice(lineStart, expressionStart);
  const withAssignment = /\b([a-z_][A-Za-z0-9_]*)\s*=\s*$/u.exec(prefix);
  const withName = withAssignment?.[1];
  const suffixStart = skipWhitespaceForward(source.code, expressionEnd, lineEnd);
  const suffixEnd = skipWhitespaceBackward(source.code, lineEnd, suffixStart);
  if (
    withName === undefined ||
    !/^\s*with\b/u.test(prefix) ||
    source.code.slice(suffixStart, suffixEnd) !== "do"
  ) {
    return null;
  }
  return {
    name: withName,
    start: lineStart + (withAssignment?.index ?? 0),
    end: expressionEnd,
  };
}

function isAssignmentAt(code: string, _start: number, end: number): boolean {
  const next = skipWhitespaceForward(code, end, code.length);
  return (
    code[next] === "=" && code[next + 1] !== "=" && code[next + 1] !== ">" && code[next + 1] !== "~"
  );
}

function expandAtomFlowGraph(graph: AtomFlowGraph): void {
  let pendingIndex = 0;
  while (pendingIndex < graph.pending.length) {
    const node = graph.pending[pendingIndex];
    pendingIndex += 1;
    if (node === undefined) continue;
    graph.stats.queueVisits += 1;
    if (node.kind === "assignment") expandAtomAssignmentNode(graph, node);
    else expandAtomValueNode(graph, node);
  }
}

function expandAtomAssignmentNode(graph: AtomFlowGraph, node: AtomFlowNode): void {
  const { source } = graph;
  const name = node.name;
  const range = containingFunctionRange(source.functionRanges, node.start);
  if (name === undefined || range === null) {
    node.terminal |= ATOM_FLOW_ESCAPE;
    return;
  }
  const interpolation = lowerBoundNumber(source.interpolationStarts, node.end);
  if ((source.interpolationStarts[interpolation] ?? Number.POSITIVE_INFINITY) < range.end) {
    node.terminal |= ATOM_FLOW_ESCAPE;
    return;
  }
  const occurrences = source.identifiersByName.get(name) ?? [];
  let uses = 0;
  let index = lowerBoundOccurrence(occurrences, node.end);
  while (index < occurrences.length) {
    const occurrence = occurrences[index];
    index += 1;
    if (occurrence === undefined || occurrence.start >= range.end) break;
    if (isAssignmentAt(source.code, occurrence.start, occurrence.end)) {
      node.terminal |= ATOM_FLOW_ESCAPE;
      break;
    }
    if (isMapFieldAtomKey(source, occurrence)) continue;
    uses += 1;
    const useKey = ensureAtomValueNode(
      graph,
      occurrence.start,
      occurrence.end,
      occurrence.parentOpen,
      node.context,
    );
    addAtomFlowEdge(graph, node, useKey);
  }
  if (uses === 0) node.terminal |= ATOM_FLOW_ESCAPE;
}

function expandAtomValueNode(graph: AtomFlowGraph, node: AtomFlowNode): void {
  const { source, roles } = graph;
  const after = skipWhitespaceForward(source.code, node.end, source.code.length);
  if (/^\.[a-z_][A-Za-z0-9_]*[!?]?\s*\(/u.test(source.code.slice(after, after + 96))) {
    node.terminal |= ATOM_FLOW_INVOCATION;
    return;
  }
  if (isExactLiteralAtomAllowlist(source, after)) {
    node.terminal |= ATOM_FLOW_DATA;
    return;
  }

  const parentOpen = node.parentOpen;
  if (parentOpen !== undefined) {
    const call = roles.callsByOpen.get(parentOpen);
    if (call !== undefined) {
      expandAtomCallRole(graph, node, call);
      return;
    }
    if (isMfaSelectorPosition(source, parentOpen, node.start, node.end)) {
      node.terminal |= ATOM_FLOW_INVOCATION;
      return;
    }
    const close = source.closeByOpen.get(parentOpen);
    if (close === undefined) {
      node.terminal |= ATOM_FLOW_ESCAPE;
      return;
    }
    const containerKey = ensureAtomValueNode(
      graph,
      containerExpressionStart(source.code, parentOpen),
      close + 1,
      source.parentByOpen.get(parentOpen),
      node.context,
    );
    addAtomFlowEdge(graph, node, containerKey);
    return;
  }

  const pipeline = immediatePipelineCall(source, roles, node.end);
  if (pipeline !== null) {
    expandAtomCallRole(graph, node, pipeline, 0);
    return;
  }
  const assignment = expressionAssignment(source, node.start, node.end);
  if (assignment !== null) {
    if (assignment.name === "_") {
      node.terminal |= ATOM_FLOW_DATA;
      return;
    }
    addAtomFlowEdge(graph, node, ensureAtomAssignmentNode(graph, assignment, node.context));
    return;
  }
  node.terminal |= node.context.legacyTerminal ? ATOM_FLOW_LEGACY_DATA : ATOM_FLOW_ESCAPE;
}

function expandAtomCallRole(
  graph: AtomFlowGraph,
  node: AtomFlowNode,
  call: IndexedRoleCall,
  knownArgument?: number,
): void {
  const argument =
    knownArgument ?? containingCallArgument(graph.source, call, node.start, node.end);
  if (argument === null) {
    node.terminal |= ATOM_FLOW_ESCAPE;
    return;
  }
  // The argument-to-call-role relation is an indexed graph edge even when it
  // terminates at a data, invocation, or escape sink rather than another
  // value node.
  graph.stats.roleEdges += 1;
  const invocation = invocationCallEvent(call, argument, node.context);
  if (invocation !== undefined) {
    node.terminal |= invocation.dyn ? ATOM_FLOW_DELEGATED_INVOCATION : ATOM_FLOW_INVOCATION;
    return;
  }
  const summary = resolveRoleSummary(call, node.context);
  if (summary === undefined) {
    node.terminal |= ATOM_FLOW_ESCAPE;
    return;
  }
  const callbackRole = summary.callbackResults?.[argument];
  if (callbackRole !== undefined) {
    if (!callbackContainsValue(graph.source, call, argument, node.start, node.end)) {
      const range = explicitArgumentRange(graph.source, call, argument);
      node.terminal |=
        range?.start === node.start && range.end === node.end
          ? ATOM_FLOW_INVOCATION
          : ATOM_FLOW_ESCAPE;
      return;
    }
    addAtomCallResultEdge(graph, node, call);
    return;
  }
  const role = summary.arguments[argument] ?? "escape";
  if (role === "consume-data") node.terminal |= ATOM_FLOW_DATA;
  else if (role === "invocation-selector") node.terminal |= ATOM_FLOW_INVOCATION;
  else if (role === "propagate-to-result") addAtomCallResultEdge(graph, node, call);
  else node.terminal |= ATOM_FLOW_ESCAPE;
}

function addAtomCallResultEdge(
  graph: AtomFlowGraph,
  node: AtomFlowNode,
  call: IndexedRoleCall,
): void {
  const resultKey = ensureAtomValueNode(
    graph,
    call.start,
    call.close + 1,
    graph.source.parentByOpen.get(call.open),
    node.context,
  );
  addAtomFlowEdge(graph, node, resultKey);
}

function solveAtomFlowGraph(graph: AtomFlowGraph): void {
  expandAtomFlowGraph(graph);
  const queue: AtomFlowNode[] = [];
  for (const node of graph.nodes.values()) {
    node.outcome = node.terminal;
    if (node.outcome !== 0) queue.push(node);
  }
  let queueIndex = 0;
  while (queueIndex < queue.length) {
    const node = queue[queueIndex];
    queueIndex += 1;
    if (node === undefined) continue;
    graph.stats.queueVisits += 1;
    for (const predecessorKey of node.incoming) {
      const predecessor = graph.nodes.get(predecessorKey);
      if (predecessor === undefined) continue;
      const next = predecessor.outcome | node.outcome;
      if (next === predecessor.outcome) continue;
      predecessor.outcome = next;
      queue.push(predecessor);
    }
  }
}

function atomFlowResult(graph: AtomFlowGraph, rootKey: string): AtomFlowResult {
  const outcome = graph.nodes.get(rootKey)?.outcome ?? ATOM_FLOW_ESCAPE;
  if ((outcome & ATOM_FLOW_INVOCATION) !== 0) {
    return { disposition: "invocation", requiredCalls: [] };
  }
  if ((outcome & ATOM_FLOW_ESCAPE) !== 0) {
    return { disposition: "escape", requiredCalls: [] };
  }
  if ((outcome & ATOM_FLOW_DELEGATED_INVOCATION) !== 0) {
    return { disposition: "invocation", requiredCalls: [], delegatedInvocation: true };
  }
  if ((outcome & ATOM_FLOW_DATA) !== 0) return { disposition: "data", requiredCalls: [] };
  return { disposition: "escape", requiredCalls: [] };
}

function hasLegacyDataFallback(graph: AtomFlowGraph, rootKey: string): boolean {
  const outcome = graph.nodes.get(rootKey)?.outcome ?? 0;
  return (
    (outcome & ATOM_FLOW_LEGACY_DATA) !== 0 &&
    (outcome & (ATOM_FLOW_INVOCATION | ATOM_FLOW_ESCAPE | ATOM_FLOW_DELEGATED_INVOCATION)) === 0
  );
}

function containerExpressionStart(code: string, open: number): number {
  if (code[open - 1] === "%") return open - 1;
  let index = open;
  while (index > 0 && /[A-Za-z0-9_.]/u.test(code[index - 1] ?? "")) index -= 1;
  return code[index - 1] === "%" ? index - 1 : open;
}

function isExactLiteralAtomAllowlist(source: SourceIndex, afterValue: number): boolean {
  const suffix = source.code.slice(afterValue, Math.min(source.code.length, afterValue + 16));
  const operator = /^(?:not\s+)?in\s*/u.exec(suffix);
  if (operator === null) return false;
  const open = afterValue + operator[0].length;
  if (source.code[open] !== "[") return false;
  const close = source.closeByOpen.get(open);
  const commas = source.commasByOpen.get(open) ?? [];
  if (close === undefined) return false;
  const bounds = [open, ...commas, close];
  if (bounds.length < 2) return false;
  for (let index = 0; index + 1 < bounds.length; index += 1) {
    const left = bounds[index];
    const right = bounds[index + 1];
    if (left === undefined || right === undefined) return false;
    const start = skipWhitespaceForward(source.code, left + 1, right);
    const end = skipWhitespaceBackward(source.code, right, left + 1);
    if (!LITERAL_ATOM_RE.test(source.code.slice(start, end))) return false;
  }
  return true;
}

function containingCallArgument(
  source: SourceIndex,
  call: IndexedRoleCall,
  valueStart: number,
  valueEnd: number,
): number | null {
  const explicit = call.arity - (call.piped ? 1 : 0);
  const argument = lowerBoundNumber(source.commasByOpen.get(call.open) ?? [], valueStart);
  if (argument >= explicit) return null;
  const range = callArgumentRange(source, call.open, argument);
  return range !== null && range.start <= valueStart && valueEnd <= range.end
    ? argument + (call.piped ? 1 : 0)
    : null;
}

function explicitArgumentRange(
  source: SourceIndex,
  call: IndexedRoleCall,
  logicalArgument: number,
): { readonly start: number; readonly end: number } | null {
  const explicitArgument = logicalArgument - (call.piped ? 1 : 0);
  return explicitArgument < 0 ? null : callArgumentRange(source, call.open, explicitArgument);
}

function invocationCallEvent(
  call: IndexedRoleCall,
  argument: number,
  context: AtomFlowContext,
): TraceEvent | undefined {
  const event = resolveSourceCallEvent(call, context);
  const invocation =
    ((event?.to_mod === "Kernel" || event?.to_mod === ":erlang") &&
      event.name === "apply" &&
      event.arity === 3 &&
      (argument === 0 || argument === 1)) ||
    (event?.to_mod === "Function" &&
      event.name === "capture" &&
      event.arity === 3 &&
      (argument === 0 || argument === 1));
  return invocation ? event : undefined;
}

function resolveRoleSummary(
  call: IndexedRoleCall,
  context: AtomFlowContext,
): ElixirAtomRoleSummary | undefined {
  const event = resolveSourceCallEvent(call, context);
  if (event?.name === undefined || event.arity === undefined) return undefined;
  const summary = context.summaryLookup(event.to_mod, event.name, event.arity);
  if (summary === undefined) return undefined;
  if (context.projectModules.has(summary.module)) return undefined;
  context.stats.summaryMatches += 1;
  return summary;
}

function resolveSourceCallEvent(
  call: IndexedRoleCall,
  context: AtomFlowContext,
): TraceEvent | undefined {
  if (call.sourceCardinality !== 1) return undefined;
  const events = context.eventsBySourceCall.get(
    roleSourceCallKey(
      context.producerEvent.file,
      call.line,
      context.producerEvent,
      call.name,
      call.arity,
    ),
  );
  return events?.length === 1 ? events[0] : undefined;
}

function isMfaSelectorPosition(
  source: SourceIndex,
  open: number,
  valueStart: number,
  valueEnd: number,
): boolean {
  if (source.code[open] !== "{" || (source.commasByOpen.get(open)?.length ?? 0) !== 2) return false;
  const third = callArgumentRange(source, open, 2);
  if (third === null || source.code[third.start] !== "[") return false;
  for (const argument of [0, 1]) {
    const range = callArgumentRange(source, open, argument);
    if (range !== null && range.start <= valueStart && valueEnd <= range.end) return true;
  }
  return false;
}

function callbackContainsValue(
  source: SourceIndex,
  call: IndexedRoleCall,
  logicalArgument: number,
  valueStart: number,
  valueEnd: number,
): boolean {
  const explicitArgument = logicalArgument - (call.piped ? 1 : 0);
  if (explicitArgument < 0) return false;
  const range = callArgumentRange(source, call.open, explicitArgument);
  if (range === null || range.start > valueStart || valueEnd > range.end) return false;
  const block = containingBlockRange(source.blockRanges, valueStart);
  if (
    block === null ||
    block.open !== range.start ||
    source.code.slice(block.open, block.open + 2) !== "fn" ||
    block.close + 3 > range.end
  ) {
    return false;
  }
  const arrows = source.arrowsByBlockOpen.get(block.open) ?? [];
  const nextArrowIndex = lowerBoundNumber(arrows, valueStart);
  const arrow = arrows[nextArrowIndex - 1];
  let clauseEnd = block.close;
  if (arrow === undefined) return false;
  const nextArrow = arrows[nextArrowIndex];
  if (nextArrow !== undefined) {
    const nextLine = lineAt(source.lineStarts, nextArrow);
    const nextLineStart = source.lineStarts[nextLine - 1] ?? 0;
    const nextClauseStart = skipHorizontalWhitespaceForward(source.code, nextLineStart);
    // Support an exact ordinary one-line next clause head. Multiline or
    // same-line clause heads remain conservative until their pattern spans
    // are indexed explicitly.
    if (nextClauseStart >= nextArrow) return false;
    clauseEnd = nextClauseStart;
  }
  return skipWhitespaceForward(source.code, valueEnd, clauseEnd) === clauseEnd;
}

function immediatePipelineCall(
  source: SourceIndex,
  roles: AtomRoleIndex,
  valueEnd: number,
): IndexedRoleCall | null {
  const after = skipWhitespaceForward(source.code, valueEnd, source.code.length);
  if (source.code.slice(after, after + 2) !== "|>") return null;
  const callStart = skipWhitespaceForward(source.code, after + 2, source.code.length);
  let low = 0;
  let high = roles.pipelineCalls.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if ((roles.pipelineCalls[middle]?.start ?? Number.POSITIVE_INFINITY) < callStart)
      low = middle + 1;
    else high = middle;
  }
  const call = roles.pipelineCalls[low];
  return call?.start === callStart ? call : null;
}

function roleSourceCallKey(
  file: string,
  line: number,
  carrier: TraceEvent,
  name: string,
  arity: number,
): string {
  return [
    file,
    line,
    carrier.from_mod ?? "",
    carrier.from_fun ?? "",
    carrier.partition,
    name,
    arity,
  ].join("\0");
}

/**
 * A function-scoped atom producer is harmless only when its complete value is
 * either a direct key argument of a compiler-confirmed `Map` operation or the
 * complete tuple key returned by a proven `Enum.map` → `Enum.into(%{})`
 * rebuild. Receiver dispatch, assignment, arbitrary tuples, intervening or
 * unproven pipelines, and same-line ambiguity deliberately fail this proof.
 */
function classifyAtomProducerEvents(
  traceResult: TraceResult,
  sources: ReadonlyMap<string, SourceIndex>,
  stats: MutableAtomFlowStats,
  summaryLookup: ElixirAtomRoleSummaryLookup,
): {
  readonly data: ReadonlySet<TraceEvent>;
  readonly invocation: ReadonlySet<TraceEvent>;
  readonly delegatedInvocation: ReadonlySet<TraceEvent>;
} {
  const events = traceResult.events;
  const projectModules = new Set(traceResult.modules.map((module) => module.mod));
  const eventsBySourceCall = indexRoleEvents(events);
  const sourceFacts = new Map<string, AtomProducerFact[]>();
  for (const [file, source] of sources) {
    const roleIndex = indexAtomRoles(source);
    const mapCalls = indexMapCalls(source);
    const enumMapCalls = indexEnumMapCalls(source);
    const enumCallByMapOpen = new Map<number, EnumMapCall | null>();
    const mapIntoPipelines = indexEnumMapIntoPipelines(source, enumMapCalls.values());
    for (const match of source.code.matchAll(ATOM_PRODUCER_RE)) {
      const name = match[1];
      if (name === undefined) continue;
      const start = match.index ?? 0;
      const open = start + match[0].length - 1;
      const close = source.closeByOpen.get(open);
      if (close === undefined) continue;
      stats.producers += 1;
      const line = lineAt(source.lineStarts, start);
      const safeMap = directMapKeyConsumer(source, mapCalls, start, open, close);
      const safeMapInto = directEnumMapIntoKeyConsumer(
        source,
        mapIntoPipelines,
        start,
        open,
        close,
      );
      const safeAssignedMapValues = assignedEnumMapValueConsumer(
        source,
        enumMapCalls,
        enumCallByMapOpen,
        start,
        open,
        close,
      );
      const safeInlineMapPutValue = inlineMapPutValueConsumer(source, mapCalls, start, open, close);
      append(sourceFacts, atomSiteKey(file, line, name), {
        file,
        line,
        name,
        source,
        roleIndex,
        producerStart: start,
        producerOpen: open,
        producerClose: close,
        directInvocation: isDirectAtomInvocationConsumer(source, start, open, close),
        ...(safeMap === null ? {} : { safeMap }),
        ...(safeMapInto === null ? {} : { safeMapInto }),
        ...(safeAssignedMapValues === null ? {} : { safeAssignedMapValues }),
        ...(safeInlineMapPutValue === null ? {} : { safeInlineMapPutValue }),
      });
    }
  }

  const eventFacts = new Map<string, TraceEvent[]>();
  for (const event of events) {
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
  const invocation = new Set<TraceEvent>();
  const delegatedInvocation = new Set<TraceEvent>();
  const graphs = new Map<string, AtomFlowGraph>();
  const roots: Array<{
    readonly graph: AtomFlowGraph;
    readonly rootKey: string;
    readonly event: TraceEvent;
    readonly directInvocation: boolean;
    readonly legacyTerminal: boolean;
  }> = [];
  const joinedEvents = new Set<TraceEvent>();
  for (const [key, facts] of sourceFacts) {
    const matchingEvents = eventFacts.get(key) ?? [];
    // The tracer has line but not column provenance. Never guess which role a
    // same-line event belongs to, even when two source expressions look safe.
    // One source occurrence may be compiled in both production and test; join
    // each exact carrier/partition independently and reject duplicates within
    // that identity rather than conflating the partitions.
    if (facts.length !== 1) continue;
    const fact = facts[0];
    if (fact === undefined) continue;
    let graph = graphs.get(fact.file);
    if (graph === undefined) {
      graph = {
        source: fact.source,
        roles: fact.roleIndex,
        nodes: new Map(),
        pending: [],
        stats,
      };
      graphs.set(fact.file, graph);
    }
    for (const carrierEvents of groupBy(matchingEvents, atomProducerCarrierKey).values()) {
      if (carrierEvents.length !== 1) continue;
      const event = carrierEvents[0];
      if (event === undefined) continue;
      const context: AtomFlowContext = {
        producerEvent: event,
        eventsBySourceCall,
        summaryLookup,
        projectModules,
        stats,
        legacyTerminal: legacyExactTerminal(fact, event, eventsBySourceCall, summaryLookup),
      };
      const rootKey = ensureAtomValueNode(
        graph,
        fact.producerStart,
        fact.producerClose + 1,
        fact.source.parentByOpen.get(fact.producerOpen),
        context,
      );
      roots.push({
        graph,
        rootKey,
        event,
        directInvocation: fact.directInvocation,
        legacyTerminal: context.legacyTerminal,
      });
      joinedEvents.add(event);
    }
  }
  for (const eventsAtSite of eventFacts.values()) {
    for (const event of eventsAtSite) {
      if (!joinedEvents.has(event)) stats.unjoinedOpaqueFallbacks += 1;
    }
  }
  for (const graph of graphs.values()) solveAtomFlowGraph(graph);
  for (const root of roots) {
    const indexedFlow = atomFlowResult(root.graph, root.rootKey);
    stats.joinedProducerOutcomes += 1;
    if ((indexedFlow.disposition === "data") !== root.legacyTerminal) {
      stats.legacyIndexedDisagreements += 1;
    }
    const flow =
      indexedFlow.disposition === "escape" && hasLegacyDataFallback(root.graph, root.rootKey)
        ? { ...indexedFlow, disposition: "data" as const }
        : indexedFlow;
    const { event } = root;
    if (flow.disposition === "invocation" || root.directInvocation) {
      stats.invocationSinks += 1;
      if (flow.delegatedInvocation === true) delegatedInvocation.add(event);
      else invocation.add(event);
      continue;
    }
    if (flow.disposition === "data") {
      stats.dataSinks += 1;
      safe.add(event);
      continue;
    }
    stats.escapes += 1;
  }
  return { data: safe, invocation, delegatedInvocation };
}

function atomProducerCarrierKey(event: TraceEvent): string {
  return [event.file, event.from_mod ?? "", event.from_fun ?? "", event.partition].join("\0");
}

function indexRoleEvents(
  events: readonly TraceEvent[],
): ReadonlyMap<string, readonly TraceEvent[]> {
  const index = new Map<string, TraceEvent[]>();
  for (const event of events) {
    if (event.name === undefined || event.arity === undefined) continue;
    append(index, roleSourceCallKey(event.file, event.line, event, event.name, event.arity), event);
  }
  return index;
}

function legacyExactTerminal(
  fact: AtomProducerFact,
  event: TraceEvent,
  eventsBySourceCall: ReadonlyMap<string, readonly TraceEvent[]>,
  summaryLookup: ElixirAtomRoleSummaryLookup,
): boolean {
  const exact = (line: number, toMod: string, name: string, arity: number): boolean => {
    const events = eventsBySourceCall.get(roleSourceCallKey(fact.file, line, event, name, arity));
    return events?.length === 1 && events[0]?.to_mod === toMod;
  };
  if (fact.safeMap !== undefined) {
    return (
      summaryLookup("Map", fact.safeMap.name, fact.safeMap.arity)?.arguments[1] ===
        "consume-data" && exact(fact.safeMap.line, "Map", fact.safeMap.name, fact.safeMap.arity)
    );
  }
  if (fact.safeMapInto !== undefined) {
    return (
      exact(fact.safeMapInto.mapLine, "Enum", "map", 2) &&
      exact(fact.safeMapInto.intoLine, "Enum", "into", 2)
    );
  }
  if (fact.safeAssignedMapValues !== undefined) {
    return (
      exact(fact.safeAssignedMapValues.guardLine, "Kernel", "is_binary", 1) &&
      fact.safeAssignedMapValues.mapLines.every((line) => exact(line, "Enum", "map", 2))
    );
  }
  if (fact.safeInlineMapPutValue !== undefined) {
    return (
      exact(fact.safeInlineMapPutValue.guardLine, "Kernel", "is_binary", 1) &&
      exact(fact.safeInlineMapPutValue.mapLine, "Map", "put", 3)
    );
  }
  return false;
}

function isDirectAtomInvocationConsumer(
  source: SourceIndex,
  producerStart: number,
  producerOpen: number,
  producerClose: number,
): boolean {
  const after = skipWhitespaceForward(source.code, producerClose + 1, source.code.length);
  const receiverSuffix = source.code.slice(after, Math.min(source.code.length, after + 96));
  if (/^\.[a-z_][A-Za-z0-9_]*[!?]?\s*\(/u.test(receiverSuffix)) return true;

  const parentOpen = source.parentByOpen.get(producerOpen);
  if (parentOpen === undefined) return false;
  const first = callArgumentRange(source, parentOpen, 0);
  const second = callArgumentRange(source, parentOpen, 1);
  const third = callArgumentRange(source, parentOpen, 2);
  const commaCount = source.commasByOpen.get(parentOpen)?.length ?? 0;
  const isComplete = (range: { readonly start: number; readonly end: number } | null): boolean =>
    range?.start === producerStart && range.end === producerClose + 1;

  if (source.code[parentOpen] === "{") {
    return (
      commaCount === 2 &&
      third !== null &&
      source.code[third.start] === "[" &&
      ((isComplete(first) &&
        second !== null &&
        LITERAL_ATOM_RE.test(source.code.slice(second.start, second.end))) ||
        isComplete(second))
    );
  }

  const prefix = source.code.slice(Math.max(0, parentOpen - 48), parentOpen);
  if (/Function\s*\.\s*capture\s*$/u.test(prefix)) {
    return commaCount === 2 && (isComplete(first) || isComplete(second));
  }
  if (/(?:Kernel\s*\.\s*|:erlang\s*\.\s*|\b)apply\s*$/u.test(prefix)) {
    return commaCount === 2 && (isComplete(first) || isComplete(second));
  }
  return false;
}

function isAtomProducerEvent(event: TraceEvent): event is TraceEvent & { readonly name: string } {
  return (
    event.dyn &&
    event.to_mod === "String" &&
    event.arity === 1 &&
    (event.name === "to_atom" || event.name === "to_existing_atom")
  );
}

interface AtomProducerFact {
  readonly file: string;
  readonly line: number;
  readonly name: string;
  readonly source: SourceIndex;
  readonly roleIndex: AtomRoleIndex;
  readonly producerStart: number;
  readonly producerOpen: number;
  readonly producerClose: number;
  readonly directInvocation: boolean;
  readonly safeMap?: { readonly name: string; readonly arity: number; readonly line: number };
  readonly safeMapInto?: { readonly mapLine: number; readonly intoLine: number };
  readonly safeAssignedMapValues?: {
    readonly guardLine: number;
    readonly mapLines: readonly number[];
  };
  readonly safeInlineMapPutValue?: {
    readonly guardLine: number;
    readonly mapLine: number;
  };
}

interface EnumMapIntoPipeline {
  readonly bodyStart: number;
  readonly bodyEnd: number;
  readonly resultStart: number;
  readonly mapLine: number;
  readonly intoLine: number;
}

interface EnumMapCall {
  readonly open: number;
  readonly close: number;
  readonly line: number;
}

interface MapCall {
  readonly name: string;
  readonly arity: number;
  readonly start: number;
  readonly open: number;
  readonly keyArgument: number;
  readonly line: number;
}

/**
 * Prove the separate inline request-normalization role:
 *
 *   raw when is_binary(raw) ->
 *     try do
 *       {:ok, Map.put(map, :literal_key, String.to_existing_atom(raw))}
 *     rescue
 *       ...
 *     end
 *
 * The clause binder/guard, lexical case-or-with clause, matching try/rescue,
 * success tuple, Map.put value position, and producer input are all exact.
 * Any wrapper or additional use fails closed instead of borrowing the broader
 * assignment proof below.
 */
function inlineMapPutValueConsumer(
  source: SourceIndex,
  mapCalls: ReadonlyMap<number, MapCall>,
  producerStart: number,
  producerOpen: number,
  producerClose: number,
): { readonly guardLine: number; readonly mapLine: number } | null {
  const inputStart = skipWhitespaceForward(source.code, producerOpen + 1, producerClose);
  const inputEnd = skipWhitespaceBackward(source.code, producerClose, inputStart);
  LOCAL_IDENTIFIER_RE.lastIndex = inputStart;
  const input = LOCAL_IDENTIFIER_RE.exec(source.code);
  const inputName = input?.[0];
  if (inputName === undefined || LOCAL_IDENTIFIER_RE.lastIndex !== inputEnd) return null;

  const mapOpen = source.parentByOpen.get(producerOpen);
  if (mapOpen === undefined) return null;
  const mapCall = mapCalls.get(mapOpen);
  if (mapCall === undefined || mapCall.name !== "put" || mapCall.arity !== 3) return null;
  const valueRange = callArgumentRange(source, mapOpen, 2);
  if (
    valueRange === null ||
    valueRange.start !== producerStart ||
    valueRange.end !== producerClose + 1
  ) {
    return null;
  }
  const keyRange = callArgumentRange(source, mapOpen, 1);
  if (keyRange === null || !LITERAL_ATOM_RE.test(source.code.slice(keyRange.start, keyRange.end)))
    return null;

  const tupleOpen = source.parentByOpen.get(mapOpen);
  if (tupleOpen === undefined || source.code[tupleOpen] !== "{") return null;
  const mapClose = source.closeByOpen.get(mapOpen);
  const tupleClose = source.closeByOpen.get(tupleOpen);
  const tupleCommas = source.commasByOpen.get(tupleOpen) ?? [];
  if (
    mapClose === undefined ||
    tupleClose === undefined ||
    tupleCommas.length !== 1 ||
    tupleCommas[0] === undefined
  )
    return null;
  const tupleComma = tupleCommas[0];
  const statusStart = skipWhitespaceForward(source.code, tupleOpen + 1, tupleComma);
  const statusEnd = skipWhitespaceBackward(source.code, tupleComma, tupleOpen + 1);
  const payloadStart = skipWhitespaceForward(source.code, tupleComma + 1, tupleClose);
  const payloadEnd = skipWhitespaceBackward(source.code, tupleClose, tupleComma + 1);
  if (
    source.code.slice(statusStart, statusEnd) !== ":ok" ||
    payloadStart !== mapCall.start ||
    payloadEnd !== mapClose + 1
  ) {
    return null;
  }

  const tryRange = containingBlockRange(source.blockRanges, producerStart);
  if (tryRange === null) return null;
  const tryStart = exactTryStart(source, tryRange.open);
  if (tryStart === null || tryRange.parent === undefined) return null;
  const clauseRange = source.blockRanges[tryRange.parent];
  if (clauseRange === undefined || !isCaseOrWithBlock(source, clauseRange.open)) return null;
  const rescues = source.rescuesByBlockOpen.get(tryRange.open) ?? [];
  if (rescues.length !== 1 || rescues[0] === undefined) return null;
  const rescueStart = rescues[0];
  if (rescueStart <= tupleClose) return null;
  if (
    skipWhitespaceForward(source.code, tryRange.open + 2, rescueStart) !== tupleOpen ||
    skipWhitespaceBackward(source.code, rescueStart, tryRange.open + 2) !== tupleClose + 1
  ) {
    return null;
  }

  const producerIndex = lowerBoundNumber(source.atomProducerStarts, tryRange.open + 2);
  if (
    source.atomProducerStarts[producerIndex] !== producerStart ||
    (source.atomProducerStarts[producerIndex + 1] ?? Number.POSITIVE_INFINITY) < rescueStart
  ) {
    return null;
  }
  const interpolationIndex = lowerBoundNumber(source.interpolationStarts, tryRange.open + 2);
  if ((source.interpolationStarts[interpolationIndex] ?? Number.POSITIVE_INFINITY) < rescueStart)
    return null;

  const arrows = source.arrowsByBlockOpen.get(clauseRange.open) ?? [];
  const nextArrowIndex = lowerBoundNumber(arrows, tryStart);
  const arrow = arrows[nextArrowIndex - 1];
  if (arrow === undefined || skipWhitespaceForward(source.code, arrow + 2, tryStart) !== tryStart)
    return null;
  const nextArrow = arrows[nextArrowIndex];
  const clauseEnd =
    nextArrow === undefined
      ? clauseRange.close
      : (source.lineStarts[lineAt(source.lineStarts, nextArrow) - 1] ?? nextArrow);
  if (skipWhitespaceForward(source.code, tryRange.close + 3, clauseEnd) !== clauseEnd) return null;

  const headerLine = lineAt(source.lineStarts, arrow);
  const headerStart = source.lineStarts[headerLine - 1] ?? 0;
  const header = source.code.slice(headerStart, arrow).trim();
  const clause = CLAUSE_GUARD_RE.exec(header);
  const binder = clause?.[1] === undefined ? null : exactClauseBinder(clause[1]);
  const guard = clause?.[2];
  if (binder === null || guard === undefined || binder !== inputName) return null;
  if (!positiveBinaryConjunct(guard, binder)) return null;
  if (hasIdentifierBetween(source.identifiersByName.get(inputName) ?? [], arrow + 2, inputStart)) {
    return null;
  }
  return { guardLine: headerLine, mapLine: mapCall.line };
}

function exactClauseBinder(pattern: string): string | null {
  const candidate = SIMPLE_BINDER_RE.test(pattern)
    ? pattern
    : OK_TUPLE_BINDER_RE.exec(pattern)?.[1];
  return candidate === undefined || candidate === "_" ? null : candidate;
}

function callArgumentRange(
  source: SourceIndex,
  open: number,
  argument: number,
): { readonly start: number; readonly end: number } | null {
  const close = source.closeByOpen.get(open);
  const commas = source.commasByOpen.get(open) ?? [];
  if (close === undefined || argument > commas.length) return null;
  const rawStart = argument === 0 ? open + 1 : (commas[argument - 1] ?? close) + 1;
  const rawEnd = commas[argument] ?? close;
  const start = skipWhitespaceForward(source.code, rawStart, rawEnd);
  const end = skipWhitespaceBackward(source.code, rawEnd, rawStart);
  return start < end ? { start, end } : null;
}

function exactTryStart(source: SourceIndex, doOpen: number): number | null {
  const line = lineAt(source.lineStarts, doOpen);
  const lineStart = source.lineStarts[line - 1] ?? 0;
  const keywordEnd = skipWhitespaceBackward(source.code, doOpen, lineStart);
  let keywordStart = keywordEnd;
  while (keywordStart > lineStart && /[A-Za-z_]/u.test(source.code[keywordStart - 1] ?? ""))
    keywordStart -= 1;
  if (
    source.code.slice(keywordStart, keywordEnd) !== "try" ||
    skipWhitespaceForward(source.code, lineStart, keywordStart) !== keywordStart
  ) {
    return null;
  }
  return keywordStart;
}

function isCaseOrWithBlock(source: SourceIndex, doOpen: number): boolean {
  const line = lineAt(source.lineStarts, doOpen);
  const lineStart = source.lineStarts[line - 1] ?? 0;
  const headerStart = skipWhitespaceForward(source.code, lineStart, doOpen);
  const headerEnd = skipWhitespaceBackward(source.code, doOpen, headerStart);
  return /^(?:case|with)\b[^;\n]+$/u.test(source.code.slice(headerStart, headerEnd));
}

function positiveBinaryConjunct(guard: string, binder: string): boolean {
  if (/\b(?:or|xor|not)\b|\|\||!/u.test(guard)) return false;
  const conjuncts = guard.split(/\band\b|&&/u);
  const exact = `is_binary(${binder})`;
  return conjuncts.some((conjunct) => {
    let normalized = conjunct.replace(/\s+/gu, "").trim();
    while (normalized.startsWith("(") && normalized.endsWith(")"))
      normalized = normalized.slice(1, -1);
    return normalized === exact;
  });
}

function containingBlockRange(ranges: readonly BlockRange[], position: number): BlockRange | null {
  let low = 0;
  let high = ranges.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if ((ranges[middle]?.open ?? Number.POSITIVE_INFINITY) <= position) low = middle + 1;
    else high = middle;
  }
  let index = low - 1;
  while (index >= 0) {
    const candidate = ranges[index];
    if (candidate === undefined) return null;
    if (candidate.open < position && position < candidate.close) return candidate;
    index = candidate.parent ?? -1;
  }
  return null;
}

/**
 * Prove a deliberately narrow local data flow:
 *
 *   atom = String.to_existing_atom(binary_guarded_variable)
 *   Enum.map(values, fn value -> %{value: value, kind: atom} end)
 *
 * Every later reference to the assigned variable in the same function must be
 * the complete value of a map field inside an indexed Enum.map call. Receiver,
 * apply/capture/MFA, key, reassignment, and ambiguous roles all fail closed.
 */
function assignedEnumMapValueConsumer(
  source: SourceIndex,
  enumMapCalls: ReadonlyMap<number, EnumMapCall>,
  enumCallByMapOpen: Map<number, EnumMapCall | null>,
  producerStart: number,
  producerOpen: number,
  producerClose: number,
): { readonly guardLine: number; readonly mapLines: readonly number[] } | null {
  const argumentStart = skipWhitespaceForward(source.code, producerOpen + 1, producerClose);
  const argumentEnd = skipWhitespaceBackward(source.code, producerClose, argumentStart);
  LOCAL_IDENTIFIER_RE.lastIndex = argumentStart;
  const argument = LOCAL_IDENTIFIER_RE.exec(source.code);
  if (
    argument === null ||
    LOCAL_IDENTIFIER_RE.lastIndex !== argumentEnd ||
    argument[0] === undefined
  ) {
    return null;
  }

  const line = lineAt(source.lineStarts, producerStart);
  const lineStart = source.lineStarts[line - 1] ?? 0;
  const lineEnd = source.lineStarts[line] ?? source.code.length;
  const assignmentStart = skipWhitespaceForward(source.code, lineStart, producerStart);
  ASSIGNMENT_RE.lastIndex = assignmentStart;
  const assignment = ASSIGNMENT_RE.exec(source.code);
  const assignedVariable = assignment?.[1];
  if (
    assignedVariable === undefined ||
    ASSIGNMENT_RE.lastIndex !== producerStart ||
    skipWhitespaceForward(source.code, producerClose + 1, lineEnd) !== lineEnd
  ) {
    return null;
  }

  const range = containingFunctionRange(source.functionRanges, producerStart);
  if (range === null || !range.binaryGuards.has(argument[0])) return null;
  const interpolationIndex = lowerBoundNumber(source.interpolationStarts, producerClose + 1);
  if ((source.interpolationStarts[interpolationIndex] ?? Number.POSITIVE_INFINITY) < range.end)
    return null;
  if (
    hasIdentifierBetween(
      source.identifiersByName.get(argument[0]) ?? [],
      range.headerEnd,
      argumentStart,
    )
  ) {
    return null;
  }
  if (!hasFunctionLevelRescue(source, range, producerClose)) return null;

  const occurrences = source.identifiersByName.get(assignedVariable) ?? [];
  let occurrenceIndex = lowerBoundOccurrence(occurrences, producerClose + 1);
  const mapLines = new Set<number>();
  let references = 0;
  while (occurrenceIndex < occurrences.length) {
    const occurrence = occurrences[occurrenceIndex];
    if (occurrence === undefined || occurrence.start >= range.end) break;
    occurrenceIndex += 1;
    if (isMapFieldAtomKey(source, occurrence)) continue;
    references += 1;
    const enumCall = enumMapValueCall(source, enumMapCalls, enumCallByMapOpen, occurrence);
    if (enumCall === null) return null;
    mapLines.add(enumCall.line);
  }
  if (references === 0 || mapLines.size === 0) return null;
  return {
    guardLine: lineAt(source.lineStarts, range.start),
    mapLines: [...mapLines].sort((left, right) => left - right),
  };
}

function containingFunctionRange(
  ranges: readonly FunctionRange[],
  position: number,
): FunctionRange | null {
  let low = 0;
  let high = ranges.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if ((ranges[middle]?.start ?? Number.POSITIVE_INFINITY) <= position) low = middle + 1;
    else high = middle;
  }
  let index = low - 1;
  while (index >= 0) {
    const candidate = ranges[index];
    if (candidate === undefined) return null;
    if (position < candidate.end) return candidate;
    index = candidate.parent ?? -1;
  }
  return null;
}

function hasFunctionLevelRescue(source: SourceIndex, range: FunctionRange, after: number): boolean {
  const rescues = source.identifiersByName.get("rescue") ?? [];
  let index = lowerBoundOccurrence(rescues, after);
  while (index < rescues.length) {
    const rescue = rescues[index];
    if (rescue === undefined || rescue.start >= range.end) return false;
    const line = lineAt(source.lineStarts, rescue.start);
    const lineStart = source.lineStarts[line - 1] ?? 0;
    const lineEnd = source.lineStarts[line] ?? source.code.length;
    if (
      skipWhitespaceForward(source.code, lineStart, rescue.start) === rescue.start &&
      rescue.start - lineStart === range.indent &&
      skipWhitespaceForward(source.code, rescue.end, lineEnd) === lineEnd &&
      !hasIdentifierBetween(source.identifiersByName.get("try") ?? [], range.start, rescue.start)
    ) {
      return true;
    }
    index += 1;
  }
  return false;
}

function hasIdentifierBetween(
  occurrences: readonly IdentifierOccurrence[],
  start: number,
  end: number,
): boolean {
  const index = lowerBoundOccurrence(occurrences, start);
  return (occurrences[index]?.start ?? Number.POSITIVE_INFINITY) < end;
}

function lowerBoundOccurrence(
  occurrences: readonly IdentifierOccurrence[],
  position: number,
): number {
  let low = 0;
  let high = occurrences.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if ((occurrences[middle]?.start ?? Number.POSITIVE_INFINITY) < position) low = middle + 1;
    else high = middle;
  }
  return low;
}

function isMapFieldAtomKey(source: SourceIndex, occurrence: IdentifierOccurrence): boolean {
  if (
    occurrence.parentOpen === undefined ||
    source.code[occurrence.parentOpen] !== "{" ||
    source.code[occurrence.parentOpen - 1] !== "%"
  ) {
    return false;
  }
  const mapClose = source.closeByOpen.get(occurrence.parentOpen);
  if (mapClose === undefined) return false;
  const next = skipWhitespaceForward(source.code, occurrence.end, mapClose);
  return source.code[next] === ":";
}

function enumMapValueCall(
  source: SourceIndex,
  enumMapCalls: ReadonlyMap<number, EnumMapCall>,
  enumCallByMapOpen: Map<number, EnumMapCall | null>,
  occurrence: IdentifierOccurrence,
): EnumMapCall | null {
  const mapOpen = occurrence.parentOpen;
  if (mapOpen === undefined || source.code[mapOpen] !== "{" || source.code[mapOpen - 1] !== "%") {
    return null;
  }
  const mapClose = source.closeByOpen.get(mapOpen);
  if (mapClose === undefined) return null;
  const commas = source.commasByOpen.get(mapOpen) ?? [];
  const commaIndex = lowerBoundNumber(commas, occurrence.start);
  const fieldStart = commaIndex === 0 ? mapOpen + 1 : (commas[commaIndex - 1] ?? mapOpen) + 1;
  const fieldEnd = commas[commaIndex] ?? mapClose;
  let colon = -1;
  for (let index = fieldStart; index < occurrence.start; index += 1) {
    if (source.code[index] === ":") colon = index;
  }
  if (
    colon < 0 ||
    skipWhitespaceForward(source.code, colon + 1, occurrence.start) !== occurrence.start ||
    skipWhitespaceBackward(source.code, fieldEnd, occurrence.end) !== occurrence.end
  ) {
    return null;
  }

  if (enumCallByMapOpen.has(mapOpen)) return enumCallByMapOpen.get(mapOpen) ?? null;
  let childOpen = mapOpen;
  while (true) {
    const parentOpen = source.parentByOpen.get(childOpen);
    if (parentOpen === undefined) {
      enumCallByMapOpen.set(mapOpen, null);
      return null;
    }
    const enumCall = enumMapCalls.get(parentOpen);
    if (enumCall !== undefined) {
      enumCallByMapOpen.set(mapOpen, enumCall);
      return enumCall;
    }
    childOpen = parentOpen;
  }
}

function lowerBoundNumber(values: readonly number[], target: number): number {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if ((values[middle] ?? Number.POSITIVE_INFINITY) < target) low = middle + 1;
    else high = middle;
  }
  return low;
}

function indexEnumMapCalls(source: SourceIndex): ReadonlyMap<number, EnumMapCall> {
  const calls = new Map<number, EnumMapCall>();
  for (const match of source.code.matchAll(ENUM_MAP_CALL_RE)) {
    const open = (match.index ?? 0) + match[0].length - 1;
    const close = source.closeByOpen.get(open);
    if (close === undefined) continue;
    calls.set(open, {
      open,
      close,
      line: lineAt(source.lineStarts, match.index ?? 0),
    });
  }
  return calls;
}

function indexEnumMapIntoPipelines(
  source: SourceIndex,
  calls: Iterable<EnumMapCall>,
): readonly EnumMapIntoPipeline[] {
  const pipelines: EnumMapIntoPipeline[] = [];
  for (const call of calls) {
    const mapOpen = call.open;
    const mapClose = call.close;
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
      mapLine: call.line,
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
    const start = match.index ?? 0;
    if (/[A-Za-z0-9_.]/u.test(source.code[start - 1] ?? "")) continue;
    const open = start + match[0].length - 1;
    const close = source.closeByOpen.get(open);
    if (close === undefined) continue;
    const commas = source.commasByOpen.get(open) ?? [];
    calls.set(open, {
      name,
      arity: commas.length + 1,
      start,
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
  const blockIndex = indexBlockStructure(code);
  const fnOpenAt = new Set<number>();
  const fnCloseAt = new Map<number, number>();
  for (const range of blockIndex.ranges) {
    if (code.slice(range.open, range.open + 2) !== "fn" || range.close <= range.open) continue;
    fnOpenAt.add(range.open);
    fnCloseAt.set(range.close, (fnCloseAt.get(range.close) ?? 0) + 1);
  }
  const closeByOpen = new Map<number, number>();
  const parentByOpen = new Map<number, number>();
  const commasByOpen = new Map<number, number[]>();
  const identifiersByName = new Map<string, IdentifierOccurrence[]>();
  const interpolationStarts: number[] = [];
  const atomProducerStarts: number[] = [];
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
  for (let start = content.indexOf("#{"); start >= 0; start = content.indexOf("#{", start + 2))
    interpolationStarts.push(start);
  for (const match of code.matchAll(ATOM_PRODUCER_RE)) {
    const producerStart = match.index ?? 0;
    atomProducerStarts.push(producerStart);
  }
  const stack: Array<{ open: number; close: string; commas: number[]; fnDepth: number }> = [];
  let fnDepth = 0;
  for (let index = 0; index < code.length; index += 1) {
    fnDepth -= fnCloseAt.get(index) ?? 0;
    if (fnOpenAt.has(index)) fnDepth += 1;
    const char = code[index] as string;
    const close = char === "(" ? ")" : char === "[" ? "]" : char === "{" ? "}" : null;
    if (close !== null) {
      const parent = stack.at(-1);
      if (parent !== undefined) parentByOpen.set(index, parent.open);
      stack.push({ open: index, close, commas: [], fnDepth });
      continue;
    }
    if (char === ",") {
      const frame = stack.at(-1);
      if (frame !== undefined && frame.fnDepth === fnDepth) frame.commas.push(index);
      continue;
    }
    if (/[a-z_]/u.test(char) && !/[A-Za-z0-9_]/u.test(code[index - 1] ?? "")) {
      let end = index + 1;
      while (/[A-Za-z0-9_]/u.test(code[end] ?? "")) end += 1;
      const name = code.slice(index, end);
      const parentOpen = stack.at(-1)?.open;
      append(identifiersByName, name, {
        start: index,
        end,
        ...(parentOpen === undefined ? {} : { parentOpen }),
      });
      index = end - 1;
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
  const rescuesByBlockOpen = new Map<number, number[]>();
  for (const rescue of identifiersByName.get("rescue") ?? []) {
    const block = containingBlockRange(blockIndex.ranges, rescue.start);
    if (block !== null) append(rescuesByBlockOpen, block.open, rescue.start);
  }
  return {
    content,
    code,
    lineStarts,
    closeByOpen,
    parentByOpen,
    commasByOpen,
    identifiersByName,
    interpolationStarts,
    atomProducerStarts,
    blockRanges: blockIndex.ranges,
    arrowsByBlockOpen: blockIndex.arrowsByOpen,
    rescuesByBlockOpen,
    functionRanges: indexFunctionRanges(code, blockIndex.closeByOpen),
    usingSignatures,
  };
}

function indexBlockStructure(code: string): BlockIndex {
  const closeByOpen = new Map<number, number>();
  const records: Array<{ open: number; close?: number; parent?: number }> = [];
  const arrowsByOpen = new Map<number, number[]>();
  const stack: number[] = [];
  for (const match of code.matchAll(/\b(?:do|end|fn)\b|->/gu)) {
    const token = match[0];
    const start = match.index ?? 0;
    if (token === "->") {
      const current = stack.at(-1);
      const open = current === undefined ? undefined : records[current]?.open;
      if (open !== undefined) append(arrowsByOpen, open, start);
      continue;
    }
    const previous = code[start - 1];
    if (previous === ":" || previous === ".") continue;
    const next = skipHorizontalWhitespaceForward(code, start + token.length);
    if (code[next] === ":") continue;
    if (token === "end") {
      const rangeIndex = stack.pop();
      const record = rangeIndex === undefined ? undefined : records[rangeIndex];
      if (record !== undefined) {
        record.close = start;
        closeByOpen.set(record.open, start);
      }
      continue;
    }
    const parent = stack.at(-1);
    records.push({ open: start, ...(parent === undefined ? {} : { parent }) });
    stack.push(records.length - 1);
  }
  return {
    closeByOpen,
    ranges: records.map((record) => ({
      open: record.open,
      close: record.close ?? record.open,
      ...(record.parent === undefined ? {} : { parent: record.parent }),
    })),
    arrowsByOpen,
  };
}

function indexFunctionRanges(
  code: string,
  blockCloseByOpen: ReadonlyMap<number, number>,
): readonly FunctionRange[] {
  const ranges: FunctionRange[] = [];
  for (const match of code.matchAll(FUNCTION_DEFINITION_RE)) {
    const start = match.index ?? 0;
    const indent = match[1]?.length ?? 0;
    const newline = code.indexOf("\n", start);
    const headerEnd = newline < 0 ? code.length : newline;
    const header = code.slice(start, headerEnd);
    const oneLine = /,\s*do\s*:/u.test(header);
    let functionDo: number | null = null;
    for (const doMatch of header.matchAll(/\bdo\b/gu)) functionDo = start + (doMatch.index ?? 0);
    const end = oneLine
      ? headerEnd
      : functionDo === null
        ? start
        : (blockCloseByOpen.get(functionDo) ?? start);
    const binaryGuards = new Set<string>();
    const guardStart = /\bwhen\b/u.exec(header)?.index;
    const guard = guardStart === undefined ? "" : header.slice(guardStart).trim();
    const variable = EXACT_BINARY_GUARD_RE.exec(guard)?.[1];
    if (variable !== undefined) binaryGuards.add(variable);
    ranges.push({
      start,
      end,
      headerEnd,
      indent,
      binaryGuards,
    });
  }

  const stack: number[] = [];
  return ranges.map((range, index) => {
    while (stack.length > 0) {
      const parent = stack.at(-1);
      if (parent !== undefined && (ranges[parent]?.end ?? -1) > range.start) break;
      stack.pop();
    }
    const parent = stack.at(-1);
    stack.push(index);
    return parent === undefined ? range : { ...range, parent };
  });
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

function skipHorizontalWhitespaceForward(content: string, start: number): number {
  let index = start;
  while (content[index] === " " || content[index] === "\t") index += 1;
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
