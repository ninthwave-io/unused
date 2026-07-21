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
import type { FunctionRecord, TraceEvent, TraceResult } from "./events.js";

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
const APPLY_SELF_RE = /\bapply\s*\(\s*__MODULE__\s*,\s*[a-z_][A-Za-z0-9_]*\s*,\s*\[\s*\]\s*\)/u;
const SIMPLE_APPLY_RE = new RegExp(
  String.raw`\b(?:(?:Kernel|:erlang)\.)?apply\s*\(\s*(${MODULE}|__MODULE__|[a-z_][A-Za-z0-9_]*)\s*,\s*(:${FUNCTION}|[a-z_][A-Za-z0-9_]*)\s*,\s*(\[\s*(?:[A-Za-z0-9_:.!?-]+\s*(?:,\s*[A-Za-z0-9_:.!?-]+\s*)*)?\])\s*\)`,
  "gu",
);

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
  const dispatchModules = new Set<string>();
  for (const mod of traceResult.modules) {
    const content = contents.get(mod.file);
    if (content !== undefined && APPLY_SELF_RE.test(withoutComments(content))) {
      dispatchModules.add(mod.mod);
    }
  }

  const references: ElixirRuntimeReference[] = [];
  const seen = new Set<string>();
  for (const [file, content] of contents) {
    const searchable = withoutComments(content);
    for (const match of searchable.matchAll(MFA_RE)) {
      const toMod = match[1];
      const toName = match[2];
      if (toMod === undefined || toName === undefined || match[3] === undefined) continue;
      const line = lineAt(searchable, match.index ?? 0);
      const owner = resolveOwner(traceResult, file, line, toMod);
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
      const toMod = match[1];
      const toName = match[2];
      if (toMod === undefined || toName === undefined || !dispatchModules.has(toMod)) continue;
      const target = (functionsByModuleName.get(`${toMod}\0${toName}`) ?? []).find(
        (candidate) => candidate.arity === 0,
      );
      if (target === undefined) continue;
      const line = lineAt(searchable, match.index ?? 0);
      const owner = resolveOwner(traceResult, file, line, toMod);
      if (owner === null) continue;
      addReference(references, seen, {
        ...owner,
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
    contents,
    functionsByModuleName,
    references,
    seen,
  );
  return { references, dynamicDispatches };
}

function extractDynamicDispatches(
  traceResult: TraceResult,
  contents: ReadonlyMap<string, string>,
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

  const parsedBySite = new Map<string, ParsedApply[]>();
  for (const [file, content] of contents) {
    const searchable = withoutComments(content);
    for (const match of searchable.matchAll(SIMPLE_APPLY_RE)) {
      const moduleExpr = match[1];
      const functionExpr = match[2];
      const argsExpr = match[3];
      if (moduleExpr === undefined || functionExpr === undefined || argsExpr === undefined)
        continue;
      const line = lineAt(searchable, match.index ?? 0);
      const parsed: ParsedApply = { moduleExpr, functionExpr, arity: listArity(argsExpr) };
      const key = dispatchSiteKey(file, line);
      const bucket = parsedBySite.get(key);
      if (bucket === undefined) parsedBySite.set(key, [parsed]);
      else bucket.push(parsed);
    }
  }

  const dispatches: ElixirDynamicDispatch[] = [];
  for (const event of traceResult.events) {
    if (!event.dyn) continue;
    const owner = ownerFromEvent(event);
    const parsed = parsedBySite.get(dispatchSiteKey(event.file, event.line));
    const isApply3 =
      event.name === "apply" &&
      event.arity === 3 &&
      (event.to_mod === "Kernel" || event.to_mod === ":erlang");
    if (!isApply3 || parsed?.length !== 1 || parsed[0] === undefined) {
      dispatches.push({
        ...owner,
        file: event.file,
        line: event.line,
        kind: "opaque",
        targets: [],
      });
      continue;
    }

    const call = parsed[0];
    const targetModule = resolveTargetModule(
      call.moduleExpr,
      event,
      traceResult.events,
      functionsByModule,
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
      dispatches.push({ ...owner, file: event.file, line: event.line, kind: "exact", targets });
      continue;
    }

    if (targetModule !== null || (targetFunction !== null && call.arity !== null)) {
      dispatches.push({ ...owner, file: event.file, line: event.line, kind: "bounded", targets });
      continue;
    }
    dispatches.push({ ...owner, file: event.file, line: event.line, kind: "opaque", targets: [] });
  }
  return dispatches;
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
  events: readonly TraceEvent[],
  functionsByModule: ReadonlyMap<string, FunctionRecord[]>,
): string | null {
  if (expression === "__MODULE__") return event.from_mod;
  if (!moduleToken(expression)) return null;
  if (functionsByModule.has(expression)) return expression;

  // An alias may spell a project module differently at the source site. The
  // compiler tracer supplies the expanded module atom on an alias event; only
  // accept a unique project-module candidate. Ambiguity falls back to the
  // conservative cross-unit name/arity candidate set below.
  const expanded = new Set(
    events
      .filter(
        (candidate) =>
          candidate.kind === "alias" &&
          candidate.file === event.file &&
          candidate.line === event.line &&
          candidate.from_mod === event.from_mod &&
          functionsByModule.has(candidate.to_mod),
      )
      .map((candidate) => candidate.to_mod),
  );
  return expanded.size === 1 ? ([...expanded][0] ?? null) : null;
}

function listArity(value: string): number | null {
  const body = value.slice(1, -1).trim();
  return body === "" ? 0 : body.split(",").length;
}

function dispatchSiteKey(file: string, line: number): string {
  return `${file}\0${line}`;
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

function resolveOwner(
  traceResult: TraceResult,
  file: string,
  line: number,
  referencedModule: string,
): Pick<ElixirRuntimeReference, "fromMod" | "fromFun"> | null {
  const event = traceResult.events.find(
    (candidate) =>
      candidate.file === file &&
      candidate.line === line &&
      candidate.to_mod === referencedModule &&
      candidate.from_mod !== null,
  );
  if (event?.from_mod !== undefined && event.from_mod !== null) return ownerFromEvent(event);
  const modules = traceResult.modules.filter((candidate) => candidate.file === file);
  if (modules.length !== 1 || modules[0] === undefined) return null;
  return { fromMod: modules[0].mod };
}

function ownerFromEvent(event: TraceEvent): Pick<ElixirRuntimeReference, "fromMod" | "fromFun"> {
  return {
    fromMod: event.from_mod ?? "",
    ...(event.from_fun !== undefined ? { fromFun: event.from_fun } : {}),
  };
}

function lineAt(content: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i += 1) if (content.charCodeAt(i) === 10) line += 1;
  return line;
}

function withoutComments(content: string): string {
  return content.replace(/#[^\n]*/gu, (comment) => " ".repeat(comment.length));
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
