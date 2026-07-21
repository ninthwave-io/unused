/** Source-only extraction of the public Elixir-side Rustler convention. */

import type { Site } from "../../core/ir/index.js";

export interface ElixirRustlerStub {
  readonly file: string;
  readonly module: string;
  readonly name: string;
  readonly arity: number;
  readonly site: Site;
}

export interface ElixirRustlerModule {
  readonly file: string;
  readonly module: string;
  readonly crate?: string;
  readonly site: Site;
  readonly stubs: readonly ElixirRustlerStub[];
}

export interface ElixirRustlerExtraction {
  readonly modules: readonly ElixirRustlerModule[];
  readonly ambiguousSites: readonly Site[];
}

const MODULE_RE = /^[\t ]*defmodule\s+([A-Z][A-Za-z0-9_.]*)\s+do\b/gmu;
const USE_RE = /^[\t ]*use\s+Rustler\b/gmu;
const DEF_RE = /^[\t ]*def\s+([a-z_][A-Za-z0-9_!?]*)\s*\(/gmu;

/** Extract literal Rustler loader modules and their generated-style NIF stubs. */
export function extractElixirRustlerSource(file: string, source: string): ElixirRustlerExtraction {
  const code = maskElixirComments(source);
  const moduleStarts = [...code.matchAll(MODULE_RE)].flatMap((match) =>
    match.index === undefined || match[1] === undefined
      ? []
      : [{ module: match[1], offset: match.index }],
  );
  const uses = [...code.matchAll(USE_RE)];
  const modules: ElixirRustlerModule[] = [];
  const ambiguousSites: Site[] = [];

  for (const use of uses) {
    if (use.index === undefined) continue;
    const owner = nearestModule(moduleStarts, use.index);
    if (owner === undefined) {
      ambiguousSites.push(siteAt(file, source, use.index));
      continue;
    }
    const nextModule = moduleStarts.find((candidate) => candidate.offset > use.index)?.offset;
    const moduleEnd = nextModule ?? code.length;
    const optionsEnd = nextDeclarationOffset(code, use.index + use[0].length, moduleEnd);
    const options = code.slice(use.index + use[0].length, optionsEnd);
    const crateMatch = /\bcrate:\s*(?::([a-z][a-z0-9_]*)|"([A-Za-z0-9_-]+)")/u.exec(options);
    const stubs = extractStubs(file, owner.module, source, code, use.index, moduleEnd);
    modules.push({
      file,
      module: owner.module,
      ...(crateMatch?.[1] === undefined && crateMatch?.[2] === undefined
        ? {}
        : { crate: crateMatch[1] ?? crateMatch[2] }),
      site: siteAt(file, source, use.index),
      stubs,
    });
  }

  return { modules, ambiguousSites };
}

function extractStubs(
  file: string,
  module: string,
  source: string,
  code: string,
  start: number,
  end: number,
): ElixirRustlerStub[] {
  const stubs: ElixirRustlerStub[] = [];
  DEF_RE.lastIndex = start;
  for (let match = DEF_RE.exec(code); match !== null; match = DEF_RE.exec(code)) {
    if (match.index >= end) break;
    if (match[1] === undefined) continue;
    const open = code.indexOf("(", match.index);
    const close = open < 0 ? null : findBalancedClose(code, open);
    if (close === null || close >= end) continue;
    const nextDef = nextMatchOffset(code, DEF_RE, close + 1, end);
    const bodyEnd = nextDef ?? end;
    const body = code.slice(close + 1, bodyEnd);
    if (!/:erlang\.nif_error\s*\(\s*:nif_not_loaded\s*\)/u.test(body)) continue;
    stubs.push({
      file,
      module,
      name: match[1],
      arity: countTopLevelArguments(code.slice(open + 1, close)),
      site: siteAt(file, source, match.index),
    });
  }
  DEF_RE.lastIndex = 0;
  return stubs;
}

function nearestModule(
  modules: readonly { readonly module: string; readonly offset: number }[],
  offset: number,
): { readonly module: string; readonly offset: number } | undefined {
  let owner: { readonly module: string; readonly offset: number } | undefined;
  for (const candidate of modules) {
    if (candidate.offset > offset) break;
    owner = candidate;
  }
  return owner;
}

function nextDeclarationOffset(source: string, start: number, end: number): number {
  const match = /^[\t ]*(?:def|defp|defmacro|@|use|alias|import|require)\b/gmu;
  match.lastIndex = start;
  const found = match.exec(source);
  return found?.index === undefined || found.index >= end ? end : found.index;
}

function nextMatchOffset(source: string, regex: RegExp, start: number, end: number): number | null {
  const isolated = new RegExp(regex.source, regex.flags);
  isolated.lastIndex = start;
  const found = isolated.exec(source);
  return found?.index === undefined || found.index >= end ? null : found.index;
}

function findBalancedClose(source: string, open: number): number | null {
  let depth = 0;
  let quote: '"' | "'" | null = null;
  for (let index = open; index < source.length; index += 1) {
    const char = source[index];
    if (quote !== null) {
      if (char === "\\") index += 1;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") quote = char;
    else if (char === "(") depth += 1;
    else if (char === ")" && --depth === 0) return index;
  }
  return null;
}

function countTopLevelArguments(parameters: string): number {
  if (parameters.trim() === "") return 0;
  let count = 1;
  let round = 0;
  let square = 0;
  let curly = 0;
  for (const char of parameters) {
    if (char === "(") round += 1;
    else if (char === ")") round -= 1;
    else if (char === "[") square += 1;
    else if (char === "]") square -= 1;
    else if (char === "{") curly += 1;
    else if (char === "}") curly -= 1;
    else if (char === "," && round === 0 && square === 0 && curly === 0) count += 1;
  }
  return parameters.trimEnd().endsWith(",") ? count - 1 : count;
}

function maskElixirComments(source: string): string {
  return source
    .split("\n")
    .map((line) => {
      let quote: '"' | "'" | null = null;
      for (let index = 0; index < line.length; index += 1) {
        const char = line[index];
        if (quote !== null) {
          if (char === "\\") index += 1;
          else if (char === quote) quote = null;
        } else if (char === '"' || char === "'") quote = char;
        else if (char === "#") return `${line.slice(0, index)}${" ".repeat(line.length - index)}`;
      }
      return line;
    })
    .join("\n");
}

function siteAt(file: string, source: string, start: number): Site {
  let line = 1;
  for (let index = 0; index < start; index += 1) if (source.charCodeAt(index) === 10) line += 1;
  return { file, span: { start, end: start, startLine: line, endLine: line } };
}
