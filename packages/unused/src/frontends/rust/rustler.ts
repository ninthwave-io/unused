/** Source-only extraction of the public Rustler registration convention. */

import type { Site } from "../../core/ir/index.js";

export interface RustlerNifFunction {
  readonly file: string;
  readonly name: string;
  readonly arity: number;
  readonly site: Site;
}

export interface RustlerRegistration {
  readonly file: string;
  /** Elixir module without the runtime `Elixir.` atom prefix. */
  readonly module: string;
  readonly site: Site;
}

export interface RustlerRustExtraction {
  readonly nifs: readonly RustlerNifFunction[];
  readonly registrations: readonly RustlerRegistration[];
  /** Sites using a Rustler surface that this bounded extractor cannot prove. */
  readonly ambiguousSites: readonly Site[];
}

const NIF_ATTRIBUTE_RE = /^[\t ]*#\[\s*(?:rustler::)?nif\b([^\]]*)\]/gmu;
const INIT_RE = /\brustler::init!\s*\(\s*"Elixir\.([A-Z][A-Za-z0-9_.]*)"/gu;
const ANY_INIT_RE = /\brustler::init!\s*\(/gu;

/**
 * Extract only literal, independently verifiable Rustler facts. This is not a
 * Rust parser: unsupported attribute arguments and computed init modules are
 * returned as ambiguity sites so callers can degrade toward alive.
 */
export function extractRustlerRustSource(file: string, source: string): RustlerRustExtraction {
  const code = maskRustComments(source);
  const nifs: RustlerNifFunction[] = [];
  const registrations: RustlerRegistration[] = [];
  const ambiguousSites: Site[] = [];
  const literalInitOffsets = new Set<number>();

  for (const match of code.matchAll(INIT_RE)) {
    if (match.index === undefined || match[1] === undefined) continue;
    literalInitOffsets.add(match.index);
    registrations.push({ file, module: match[1], site: siteAt(file, source, match.index) });
  }
  for (const match of code.matchAll(ANY_INIT_RE)) {
    if (match.index !== undefined && !literalInitOffsets.has(match.index)) {
      ambiguousSites.push(siteAt(file, source, match.index));
    }
  }

  for (const attribute of code.matchAll(NIF_ATTRIBUTE_RE)) {
    if (attribute.index === undefined) continue;
    const options = attribute[1]?.trim() ?? "";
    // Scheduling changes execution placement, not exported identity. Every
    // other argument is held back until its name/arity semantics are modelled.
    if (options !== "" && !/^\(\s*schedule\s*=\s*"(?:DirtyCpu|DirtyIo)"\s*\)$/u.test(options)) {
      ambiguousSites.push(siteAt(file, source, attribute.index));
      continue;
    }
    const signature = functionSignatureAfter(code, attribute.index + attribute[0].length);
    if (signature === null) {
      ambiguousSites.push(siteAt(file, source, attribute.index));
      continue;
    }
    nifs.push({
      file,
      name: signature.name,
      arity: countTopLevelArguments(signature.parameters),
      site: siteAt(file, source, attribute.index),
    });
  }

  ambiguousSites.sort((a, b) => a.span.start - b.span.start);
  return { nifs, registrations, ambiguousSites };
}

function functionSignatureAfter(
  source: string,
  offset: number,
): { readonly name: string; readonly parameters: string } | null {
  const tail = source.slice(offset);
  const declaration =
    /^\s*(?:#\[[^\]]*\]\s*)*(?:pub(?:\([^)]*\))?\s+)?(?:(?:async|const|unsafe)\s+)*fn\s+([A-Za-z_][A-Za-z0-9_]*)\s*/u.exec(
      tail,
    );
  if (declaration === null || declaration[1] === undefined) return null;
  const open = offset + declaration[0].length;
  if (source[open] !== "(") return null;
  const close = findBalancedClose(source, open, "(", ")");
  if (close === null) return null;
  return { name: declaration[1], parameters: source.slice(open + 1, close) };
}

function findBalancedClose(
  source: string,
  openOffset: number,
  open: string,
  close: string,
): number | null {
  let depth = 0;
  let quote: '"' | "'" | null = null;
  for (let index = openOffset; index < source.length; index += 1) {
    const char = source[index];
    if (quote !== null) {
      if (char === "\\") index += 1;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === open) depth += 1;
    else if (char === close && --depth === 0) return index;
  }
  return null;
}

function countTopLevelArguments(parameters: string): number {
  if (parameters.trim() === "") return 0;
  let count = 1;
  let round = 0;
  let square = 0;
  let angle = 0;
  let quote: '"' | "'" | null = null;
  for (let index = 0; index < parameters.length; index += 1) {
    const char = parameters[index];
    if (quote !== null) {
      if (char === "\\") index += 1;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") quote = char;
    else if (char === "(") round += 1;
    else if (char === ")") round -= 1;
    else if (char === "[") square += 1;
    else if (char === "]") square -= 1;
    else if (char === "<") angle += 1;
    else if (char === ">") angle = Math.max(0, angle - 1);
    else if (char === "," && round === 0 && square === 0 && angle === 0) count += 1;
  }
  return parameters.trimEnd().endsWith(",") ? count - 1 : count;
}

/** Blank comments without shifting offsets or destroying string literals. */
function maskRustComments(source: string): string {
  const chars = [...source];
  let blockDepth = 0;
  let lineComment = false;
  let quote: '"' | "'" | null = null;
  for (let index = 0; index < chars.length; index += 1) {
    const char = chars[index];
    const next = chars[index + 1];
    if (lineComment) {
      if (char === "\n") lineComment = false;
      else chars[index] = " ";
      continue;
    }
    if (blockDepth > 0) {
      if (char === "/" && next === "*") {
        chars[index] = chars[index + 1] = " ";
        blockDepth += 1;
        index += 1;
      } else if (char === "*" && next === "/") {
        chars[index] = chars[index + 1] = " ";
        blockDepth -= 1;
        index += 1;
      } else if (char !== "\n") chars[index] = " ";
      continue;
    }
    if (quote !== null) {
      if (char === "\\") index += 1;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") quote = char;
    else if (char === "/" && next === "/") {
      chars[index] = chars[index + 1] = " ";
      lineComment = true;
      index += 1;
    } else if (char === "/" && next === "*") {
      chars[index] = chars[index + 1] = " ";
      blockDepth = 1;
      index += 1;
    }
  }
  return chars.join("");
}

function siteAt(file: string, source: string, start: number): Site {
  const startLine = 1 + countNewlines(source, start);
  return { file, span: { start, end: start, startLine, endLine: startLine } };
}

function countNewlines(source: string, end: number): number {
  let count = 0;
  for (let index = 0; index < end; index += 1) if (source.charCodeAt(index) === 10) count += 1;
  return count;
}
