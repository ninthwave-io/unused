/**
 * Conservative extraction for two Elixir runtime-reference conventions that
 * the compiler tracer cannot express as ordinary call edges:
 *
 *  - an MFA value `{Module, :function, init}` consumed later by a runtime that
 *    may add request/context arguments before applying the callback;
 *  - `use WebModule, :helper` where `WebModule.__using__/1` dispatches through
 *    `apply(__MODULE__, which, [])`.
 *
 * Both recognisers require literal module/function atoms. They only emit edges
 * to functions the compiler reported, so arbitrary atoms never manufacture IR.
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
  readonly convention: "runtime-mfa" | "use-helper";
}

const MODULE = String.raw`[A-Z][A-Za-z0-9_]*(?:\.[A-Z][A-Za-z0-9_]*)*`;
const FUNCTION = `[a-z_][A-Za-z0-9_]*[!?]?`;
const MFA_RE = new RegExp(
  String.raw`\{\s*(${MODULE})\s*,\s*:(${FUNCTION})\s*,\s*([^}\n]+?)\s*\}`,
  "gu",
);
const USE_RE = new RegExp(String.raw`\buse\s+(${MODULE})\s*,\s*:(${FUNCTION})\b`, "gu");
const APPLY_SELF_RE = /\bapply\s*\(\s*__MODULE__\s*,\s*[a-z_][A-Za-z0-9_]*\s*,\s*\[\s*\]\s*\)/u;

/** Extract independently provable runtime references from traced project files. */
export function extractElixirRuntimeReferences(
  projectDir: string,
  traceResult: TraceResult,
): ElixirRuntimeReference[] {
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
  return references;
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
