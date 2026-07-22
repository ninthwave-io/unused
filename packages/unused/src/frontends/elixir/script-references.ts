/**
 * Conservative static facts for tracked Elixir scripts outside Mix compilation.
 *
 * Visible `.exs` files are real source even when `mix compile` never loads them.
 * They remain ordinary, unrooted, claimable file nodes. Literal aliases, remote
 * calls, and MFA tuples add provenance-bearing inbound edges to compiler-known
 * project symbols, so deleting only their target is never advertised as safe.
 */

import { lstatSync, readFileSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import {
  entrypointId,
  fileId,
  type HazardAnnotation,
  type IREdge,
  type IRNode,
  symbolId,
} from "../../core/ir/index.js";
import type { GraphContribution } from "../plugins/types.js";
import { githubActionsRunRoots, taskfileCommandRoots } from "../ts/convention-references.js";
import type { FunctionRecord, TraceResult } from "./events.js";

export interface ElixirScriptFacts {
  readonly contribution: GraphContribution;
  readonly files: readonly string[];
  readonly fileLineCounts: ReadonlyMap<string, number>;
  readonly referenceCount: number;
  readonly resolutionAttempts: number;
}

const MODULE = String.raw`[A-Z][A-Za-z0-9_]*(?:\.[A-Z][A-Za-z0-9_]*)*`;
const MODULE_OR_ALIAS = String.raw`[A-Z][A-Za-z0-9_]*(?:\.[A-Z][A-Za-z0-9_]*)*`;
const FUNCTION = "[a-z_][A-Za-z0-9_]*[!?]?";
const WORD_OPERATORS = new Set(["and", "in", "not", "or", "when"]);
const MODULE_TOKEN_RE = new RegExp(String.raw`\b(${MODULE})\b`, "gu");
const ALIAS_RE = new RegExp(String.raw`\balias\s+(${MODULE})(?:\s*,\s*as:\s*(${MODULE}))?`, "gu");
const GROUPED_ALIAS_RE = new RegExp(String.raw`\balias\s+(${MODULE})\.\{([^}\n]+)\}`, "gu");
const REMOTE_CALL_HEAD_RE = new RegExp(String.raw`\b(${MODULE_OR_ALIAS})\.(${FUNCTION})\b`, "gu");
const REMOTE_BARE_CALL_RE = new RegExp(
  String.raw`\b(${MODULE_OR_ALIAS})\.(${FUNCTION})[ \t]+([^\r\n]+)`,
  "gu",
);
const REMOTE_ZERO_CALL_RE = new RegExp(
  String.raw`\b(${MODULE_OR_ALIAS})\.(${FUNCTION})\b[ \t]*(?=$|#|[,}\]])`,
  "gmu",
);
const CAPTURE_RE = new RegExp(
  String.raw`&\s*(${MODULE_OR_ALIAS})\.(${FUNCTION})\s*\/\s*([0-9]+)`,
  "gu",
);
const MFA_RE = new RegExp(
  String.raw`\{\s*(${MODULE_OR_ALIAS})\s*,\s*:(${FUNCTION})\s*,\s*([^}\n]+)\}`,
  "gu",
);
const DEFMODULE_RE = new RegExp(String.raw`\bdefmodule\s+(${MODULE})\s+do\b`, "gu");
const LITERAL_FILE_RE =
  /\bCode\.(?:require_file|eval_file)\s*\(\s*(["'])([^"'\r\n]+)\1\s*(?:,\s*(__DIR__))?\s*\)/gu;
const LITERAL_BARE_FILE_RE =
  /\bCode\.(?:require_file|eval_file)[ \t]+(["'])([^"'\r\n]+)\1\s*(?:,\s*(__DIR__))?/gu;
const OPAQUE_SCRIPT_RE =
  /\b(?:apply|Module\.concat|Code\.(?:require_file|eval_file|eval_string))(?:\s*\(|[ \t]+)/u;
const MIX_INSTALL_RE = /\bMix\.install(?:\s*\(|[ \t]+)/u;

interface KnownModule {
  readonly mod: string;
  readonly file: string;
  readonly line: number;
}

interface ScriptSource {
  readonly content: string;
  readonly code: string;
  readonly structuredCode: string;
  readonly literals: string;
  readonly starts: readonly number[];
}

/** Extract O(total script bytes + literal references × log(lines)) bounded facts. */
export function extractElixirScriptFacts(
  projectDir: string,
  visibleElixirSourceFiles: readonly string[],
  traceResult: TraceResult,
): ElixirScriptFacts {
  const functionsByModuleName = indexFunctions(traceResult.functions);
  const functionsByModule = new Map<string, FunctionRecord[]>();
  for (const fn of traceResult.functions) {
    const bucket = functionsByModule.get(fn.mod);
    if (bucket === undefined) functionsByModule.set(fn.mod, [fn]);
    else bucket.push(fn);
  }
  const tracedFiles = new Set([
    ...traceResult.modules.map((record) => record.file),
    ...traceResult.functions.map((record) => record.file),
  ]);
  const files = visibleElixirSourceFiles
    .map((path) => projectRelativePath(projectDir, path))
    .filter((path): path is string => path !== null)
    .filter((path) => isStandaloneScript(path, tracedFiles))
    .sort(compare);

  const nodes: IRNode[] = [];
  const edges: IREdge[] = [];
  const hazards: HazardAnnotation[] = [];
  const lineCounts = new Map<string, number>();
  const seenFiles = new Set<string>();
  const seenEdges = new Set<string>();
  let resolutionAttempts = 0;
  const contents = new Map<string, ScriptSource>();
  const scriptModules: KnownModule[] = [];
  for (const file of files) {
    if (contents.has(file)) continue;
    const content = readFileSync(resolve(projectDir, ...file.split("/")), "utf8");
    const code = maskCommentsAndStrings(content);
    const structuredCode = maskCommentsAndStrings(content, true);
    const starts = lineStarts(content);
    contents.set(file, {
      content,
      code,
      structuredCode,
      literals: withoutComments(content),
      starts,
    });
    for (const match of code.matchAll(DEFMODULE_RE)) {
      const mod = match[1];
      if (mod !== undefined) {
        scriptModules.push({ mod, file, line: lineAt(starts, match.index ?? 0) });
      }
    }
  }
  const moduleByName = new Map<string, KnownModule>(
    traceResult.modules.map((record) => [record.mod, record]),
  );
  for (const mod of scriptModules) {
    if (!moduleByName.has(mod.mod)) moduleByName.set(mod.mod, mod);
  }
  const modulesByFile = new Map<string, KnownModule[]>();
  for (const mod of scriptModules) {
    const bucket = modulesByFile.get(mod.file);
    if (bucket === undefined) modulesByFile.set(mod.file, [mod]);
    else bucket.push(mod);
  }
  const scriptFileSet = new Set(contents.keys());
  for (const file of files) {
    if (seenFiles.has(file)) continue;
    seenFiles.add(file);
    const source = contents.get(file);
    if (source === undefined) continue;
    const { content, code, structuredCode, literals, starts } = source;
    nodes.push({ kind: "file", id: fileId(file), path: file });
    lineCounts.set(fileId(file), countLines(content));
    for (const mod of modulesByFile.get(file) ?? []) {
      const id = symbolId(file, mod.mod);
      nodes.push({
        kind: "symbol",
        id,
        file,
        exportedName: mod.mod,
        isDefault: false,
        typeOnly: false,
        local: true,
        span: siteAt(file, mod.line).span,
      });
      edges.push({
        kind: "exports",
        from: fileId(file),
        to: id,
        name: mod.mod,
        site: siteAt(file, mod.line),
      });
      edges.push({
        kind: "contains",
        from: fileId(file),
        to: id,
        name: mod.mod,
        site: siteAt(file, mod.line),
      });
    }
    const aliases = collectAliases(code);
    const referencedModules = new Set<string>();
    const addModuleReference = (
      moduleName: string,
      index: number,
      referenceKind: "static" | "runtime-resolved" = "static",
    ): void => {
      resolutionAttempts += 1;
      const resolvedModule = resolveModuleName(moduleName, aliases, moduleByName);
      const target = moduleByName.get(resolvedModule);
      if (target === undefined) return;
      referencedModules.add(resolvedModule);
      addEdge(edges, seenEdges, file, starts, index, referenceKind, target, target.mod);
    };
    const addFunctionReference = (
      moduleName: string,
      functionName: string,
      arity: number | null,
      index: number,
      referenceKind: "static" | "runtime-resolved",
    ): void => {
      resolutionAttempts += 1;
      const resolvedModule = resolveModuleName(moduleName, aliases, moduleByName);
      const candidates = functionsByModuleName.get(`${resolvedModule}\0${functionName}`) ?? [];
      const targets = arity === null ? candidates : candidates.filter((fn) => fn.arity === arity);
      if (targets.length === 0) {
        addModuleReference(moduleName, index, referenceKind);
        return;
      }
      for (const target of targets) {
        addEdge(
          edges,
          seenEdges,
          file,
          starts,
          index,
          referenceKind,
          target,
          `${target.mod}.${target.name}/${target.arity}`,
        );
      }
    };

    for (const match of code.matchAll(MODULE_TOKEN_RE)) {
      const moduleName = match[1];
      if (moduleName !== undefined) addModuleReference(moduleName, match.index ?? 0);
    }
    for (const call of collectParenthesizedRemoteCalls(structuredCode)) {
      addFunctionReference(call.moduleName, call.functionName, call.arity, call.index, "static");
    }
    for (const match of code.matchAll(REMOTE_BARE_CALL_RE)) {
      const moduleName = match[1];
      const functionName = match[2];
      const args = match[3];
      if (moduleName === undefined || functionName === undefined || args === undefined) continue;
      addFunctionReference(
        moduleName,
        functionName,
        expressionListArity(args),
        match.index ?? 0,
        "static",
      );
    }
    for (const match of code.matchAll(REMOTE_ZERO_CALL_RE)) {
      const moduleName = match[1];
      const functionName = match[2];
      if (moduleName === undefined || functionName === undefined) continue;
      addFunctionReference(moduleName, functionName, 0, match.index ?? 0, "static");
    }
    for (const match of code.matchAll(CAPTURE_RE)) {
      const moduleName = match[1];
      const functionName = match[2];
      const arity = Number(match[3]);
      if (moduleName === undefined || functionName === undefined || !Number.isSafeInteger(arity)) {
        continue;
      }
      addFunctionReference(moduleName, functionName, arity, match.index ?? 0, "static");
    }
    for (const match of code.matchAll(MFA_RE)) {
      const moduleName = match[1];
      const functionName = match[2];
      if (moduleName === undefined || functionName === undefined) continue;
      addFunctionReference(moduleName, functionName, null, match.index ?? 0, "runtime-resolved");
    }

    let opaqueCode = code;
    for (const match of [
      ...literals.matchAll(LITERAL_FILE_RE),
      ...literals.matchAll(LITERAL_BARE_FILE_RE),
    ]) {
      if (code[match.index ?? 0] === " ") continue;
      const target = match[2];
      if (target === undefined) continue;
      const targetFile = resolveScriptFile(
        projectDir,
        file,
        target,
        match[3] === "__DIR__",
        scriptFileSet,
      );
      if (targetFile !== null) {
        const line = lineAt(starts, match.index ?? 0);
        const key = `${file}\0${line}\0side-effect\0${fileId(targetFile)}`;
        if (!seenEdges.has(key)) {
          seenEdges.add(key);
          edges.push({
            kind: "references",
            referenceKind: "side-effect",
            from: fileId(file),
            to: fileId(targetFile),
            name: "*",
            site: siteAt(file, line, match.index ?? 0),
          });
        }
      }
      const start = match.index ?? 0;
      opaqueCode =
        opaqueCode.slice(0, start) +
        " ".repeat(match[0].length) +
        opaqueCode.slice(start + match[0].length);
    }

    const rootReason = standaloneRootReason(projectDir, file, content, code, traceResult.deps);
    if (rootReason !== null) {
      nodes.push({
        kind: "entrypoint",
        id: entrypointId("config", file),
        entryKind: "config",
        file,
        reason: rootReason,
      });
    }
    const opaque = OPAQUE_SCRIPT_RE.test(opaqueCode);
    if ((modulesByFile.get(file)?.length ?? 0) > 0 || opaque) {
      hazards.push({
        file: fileId(file),
        hazardClass: "elixir-script-opaque",
        detail:
          (modulesByFile.get(file)?.length ?? 0) > 0
            ? "standalone script defines module surfaces outside compiler tracing"
            : "standalone script contains dynamic invocation outside literal extraction",
        site: siteAt(file, 1),
      });
    }
    if (rootReason !== null) {
      const affectedSymbols = [...referencedModules]
        .flatMap((moduleName) =>
          (functionsByModule.get(moduleName) ?? []).map((fn) =>
            symbolId(fn.file, `${fn.mod}.${fn.name}/${fn.arity}`),
          ),
        )
        .sort(compare);
      if (affectedSymbols.length > 0) {
        hazards.push({
          file: fileId(file),
          hazardClass: "elixir-dynamic-dispatch",
          detail:
            "rooted standalone script may use referenced module functions through syntax outside exact extraction",
          site: siteAt(file, 1),
          affectedSymbols,
        });
      }
      if (opaque) {
        hazards.push({
          file: fileId(file),
          hazardClass: "elixir-dynamic-dispatch",
          detail: "rooted standalone script contains opaque dynamic invocation",
          site: siteAt(file, 1),
        });
      }
    }
  }

  edges.sort(compareEdges);
  return {
    contribution: { nodes, edges, hazards },
    files: [...seenFiles],
    fileLineCounts: lineCounts,
    referenceCount: edges.length,
    resolutionAttempts,
  };
}

/** Exact workflow/Taskfile commands root only the scripts they name. */
export async function extractElixirScriptCommandRoots(
  repositoryRoot: string,
  analyzedScriptFiles: ReadonlySet<string>,
  useGitignore = true,
): Promise<GraphContribution> {
  if (analyzedScriptFiles.size === 0) return {};
  const hits = [
    ...(await githubActionsRunRoots(repositoryRoot, analyzedScriptFiles, useGitignore)),
    ...(await taskfileCommandRoots(repositoryRoot, analyzedScriptFiles, useGitignore)),
  ];
  const byFile = new Map(hits.map((hit) => [hit.file, hit]));
  return {
    nodes: [...byFile.values()]
      .sort((a, b) => compare(a.file, b.file))
      .map((hit) => ({
        kind: "entrypoint" as const,
        id: entrypointId("config", hit.file),
        entryKind: "config" as const,
        file: hit.file,
        reason: hit.reason,
      })),
  };
}

function addEdge(
  edges: IREdge[],
  seen: Set<string>,
  sourceFile: string,
  sourceLineStarts: readonly number[],
  sourceIndex: number,
  referenceKind: "static" | "runtime-resolved",
  target: KnownModule | FunctionRecord,
  targetName: string,
): void {
  const targetFile = target.file;
  const targetId = symbolId(targetFile, targetName);
  const line = lineAt(sourceLineStarts, sourceIndex);
  const key = `${sourceFile}\0${line}\0${referenceKind}\0${targetId}`;
  if (seen.has(key)) return;
  seen.add(key);
  edges.push({
    kind: "references",
    referenceKind,
    from: fileId(sourceFile),
    to: targetId,
    name: targetName,
    site: {
      file: sourceFile,
      span: { start: sourceIndex, end: sourceIndex, startLine: line, endLine: line },
    },
  });
}

function collectAliases(content: string): Map<string, string> {
  const aliases = new Map<string, string>();
  for (const match of content.matchAll(ALIAS_RE)) {
    const target = match[1];
    if (target === undefined) continue;
    const explicit = match[2];
    const local = explicit ?? target.slice(target.lastIndexOf(".") + 1);
    aliases.set(local, target);
  }
  for (const match of content.matchAll(GROUPED_ALIAS_RE)) {
    const prefix = match[1];
    const members = match[2];
    if (prefix === undefined || members === undefined) continue;
    for (const member of members.split(",").map((value) => value.trim())) {
      if (/^[A-Z][A-Za-z0-9_]*$/u.test(member)) aliases.set(member, `${prefix}.${member}`);
    }
  }
  return aliases;
}

function resolveModuleName(
  sourceName: string,
  aliases: ReadonlyMap<string, string>,
  modules: ReadonlyMap<string, KnownModule>,
): string {
  if (modules.has(sourceName)) return sourceName;
  const [head, ...tail] = sourceName.split(".");
  if (head === undefined) return sourceName;
  const target = aliases.get(head);
  return target === undefined ? sourceName : [target, ...tail].join(".");
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

function isStandaloneScript(path: string, tracedFiles: ReadonlySet<string>): boolean {
  if (!path.endsWith(".exs") || tracedFiles.has(path) || path === "mix.exs") return false;
  return !path.startsWith("config/") && !path.startsWith("test/");
}

function projectRelativePath(projectDir: string, path: string): string | null {
  const rel = relative(resolve(projectDir), resolve(path)).split(sep).join("/");
  if (rel === "" || rel === ".." || rel.startsWith("../") || rel.startsWith("/")) return null;
  return rel;
}

function resolveScriptFile(
  projectDir: string,
  sourceFile: string,
  target: string,
  relativeToSource: boolean,
  scripts: ReadonlySet<string>,
): string | null {
  const base = relativeToSource
    ? resolve(projectDir, ...dirname(sourceFile).split("/"))
    : resolve(projectDir);
  const candidate = projectRelativePath(projectDir, resolve(base, target));
  return candidate !== null && scripts.has(candidate) ? candidate : null;
}

function standaloneRootReason(
  projectDir: string,
  file: string,
  content: string,
  code: string,
  deps: readonly string[],
): string | null {
  if (executable(projectDir, file)) return "elixir:executable-script";
  if (/^#![^\r\n]*(?:\belixir\b|\bmix\b)/u.test(content)) return "elixir:shebang-script";
  if (MIX_INSTALL_RE.test(code)) return "elixir:mix-install-script";
  if (file.endsWith("/.formatter.exs") || file === ".formatter.exs") {
    return "elixir:formatter-config";
  }
  if (file.endsWith("/.iex.exs") || file === ".iex.exs") return "elixir:iex-config";
  const hasEcto = deps.includes("ecto") || deps.includes("ecto_sql");
  if (hasEcto && /^priv\/(?:.+\/)?migrations\/[^/]+\.exs$/u.test(file)) {
    return "elixir:ecto-migration";
  }
  if (
    (hasEcto || deps.includes("phoenix")) &&
    /^priv\/(?:.+\/)?seeds(?:_[A-Za-z0-9_-]+)?\.exs$/u.test(file)
  ) {
    return "elixir:ecto-seeds";
  }
  return null;
}

function executable(projectDir: string, file: string): boolean {
  try {
    const info = lstatSync(resolve(projectDir, ...file.split("/")));
    return info.isFile() && !info.isSymbolicLink() && (info.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

function expressionListArity(content: string): number | null {
  if (content.trim() === "") return 0;
  let depth = 0;
  let arity = 1;
  let quote: string | null = null;
  for (let index = 0; index < content.length; index += 1) {
    const char = content[index] as string;
    if (quote !== null) {
      if (char === "\\") index += 1;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === "(" || char === "[" || char === "{") depth += 1;
    else if (char === ")" || char === "]" || char === "}") depth -= 1;
    else if (char === "," && depth === 0) arity += 1;
    if (depth < 0) return null;
  }
  return depth === 0 && quote === null ? arity : null;
}

interface ParenthesizedRemoteCall {
  readonly moduleName: string;
  readonly functionName: string;
  readonly arity: number | null;
  readonly index: number;
}

/**
 * Scan masked source once for literal `Module.function(...)` heads. Matching
 * arguments is delimiter/block aware, so multiline bodies and nested
 * anonymous functions preserve exact arity without a recursive regex or a
 * rescan per call.
 */
function collectParenthesizedRemoteCalls(code: string): ParenthesizedRemoteCall[] {
  const calls: ParenthesizedRemoteCall[] = [];
  const arities = indexParenthesizedArities(code);
  for (const match of code.matchAll(REMOTE_CALL_HEAD_RE)) {
    const moduleName = match[1];
    const functionName = match[2];
    if (moduleName === undefined || functionName === undefined) continue;
    const index = match.index ?? 0;
    const open = index + match[0].length;
    if (code[open] !== "(") continue;
    calls.push({
      moduleName,
      functionName,
      arity: arities.get(open) ?? null,
      index,
    });
  }
  return calls;
}

interface DelimiterFrame {
  readonly open: number;
  readonly close: string;
  arity: number;
  blockDepth: number;
  hasContent: boolean;
  argumentShape: "empty" | "identifier" | "other" | "keyword";
  keywordValueStarted: boolean;
  pendingWhitespace: boolean;
  trailingKeywordArguments: number;
  ambiguousNoParenSyntax: boolean;
  mayConsumeFollowingComma: boolean;
  expectingOperatorOperand: boolean;
}

/** One delimiter/block pass for every parenthesized call candidate in a file. */
function indexParenthesizedArities(code: string): ReadonlyMap<number, number | null> {
  const arities = new Map<number, number | null>();
  const stack: DelimiterFrame[] = [];
  for (let index = 0; index < code.length; index += 1) {
    const char = code[index] as string;
    if (/\s/u.test(char)) {
      markFrameWhitespace(stack);
      continue;
    }
    if (code.startsWith("<<<", index) || code.startsWith(">>>", index)) {
      const frame = stack.at(-1);
      if (frame !== undefined) markFrameOperator(frame);
      index += 2;
      continue;
    }
    if (code.startsWith("<<", index)) {
      markFrameContent(stack);
      stack.push(newDelimiterFrame(index, ">>"));
      index += 1;
      continue;
    }
    if (code.startsWith(">>", index)) {
      if (stack.at(-1)?.close !== ">>") stack.length = 0;
      else stack.pop();
      index += 1;
      continue;
    }
    const expectedClose = char === "(" ? ")" : char === "[" ? "]" : char === "{" ? "}" : null;
    if (expectedClose !== null) {
      markFrameContent(stack);
      stack.push(newDelimiterFrame(index, expectedClose));
      if (char === "(") arities.set(index, null);
      continue;
    }
    if (char === ")" || char === "]" || char === "}") {
      const frame = stack.at(-1);
      if (frame?.close !== char) {
        stack.length = 0;
        continue;
      }
      stack.pop();
      if (char === ")" && frame.blockDepth === 0) {
        arities.set(frame.open, completedFrameArity(frame));
      }
      continue;
    }
    const operatorLength = symbolicOperatorLength(code, index);
    if (code.startsWith("::", index) || code.startsWith("..", index) || operatorLength > 0) {
      const frame = stack.at(-1);
      if (frame !== undefined) markFrameOperator(frame);
      if (code.startsWith("::", index) || code.startsWith("..", index)) index += 1;
      else index += operatorLength - 1;
      continue;
    }
    if (isIdentifierStart(char)) {
      let end = index + 1;
      while (end < code.length && isIdentifierContinue(code[end] as string)) end += 1;
      const word = code.slice(index, end);
      const frame = stack.at(-1);
      if (frame !== undefined) {
        const wasInBlock = frame.blockDepth > 0;
        const previous = previousNonWhitespace(code, index);
        const next = nextNonWhitespace(code, end);
        if (word === "fn" || word === "end" || word === "do") {
          const isBlockKeyword = previous !== ":" && previous !== "." && next !== ":";
          if (word === "fn" && isBlockKeyword) frame.blockDepth += 1;
          else if (word === "end" && isBlockKeyword && frame.blockDepth > 0) {
            frame.blockDepth -= 1;
          } else if (word === "do" && isBlockKeyword) frame.blockDepth += 1;
        }
        if (!wasInBlock) {
          if (
            WORD_OPERATORS.has(word) &&
            previous !== "." &&
            previous !== ":" &&
            code[end] !== ":"
          ) {
            markFrameOperator(frame);
          } else {
            markFrameIdentifier(frame);
          }
        }
        frame.hasContent = true;
      }
      index = end - 1;
      continue;
    }
    const frame = stack.at(-1);
    if (frame !== undefined) {
      if (char === "," && frame.blockDepth === 0) {
        if (frame.mayConsumeFollowingComma) frame.ambiguousNoParenSyntax = true;
        completeFrameArgument(frame);
        frame.arity += 1;
      } else if (
        char === ":" &&
        frame.blockDepth === 0 &&
        frame.argumentShape === "identifier" &&
        !frame.pendingWhitespace &&
        code[index + 1] !== ":"
      ) {
        frame.argumentShape = "keyword";
        frame.keywordValueStarted = false;
        frame.hasContent = true;
      } else {
        markFrameOther(frame);
      }
    }
  }
  return arities;
}

function newDelimiterFrame(open: number, close: string): DelimiterFrame {
  return {
    open,
    close,
    arity: 1,
    blockDepth: 0,
    hasContent: false,
    argumentShape: "empty",
    keywordValueStarted: false,
    pendingWhitespace: false,
    trailingKeywordArguments: 0,
    ambiguousNoParenSyntax: false,
    mayConsumeFollowingComma: false,
    expectingOperatorOperand: false,
  };
}

function completedFrameArity(frame: DelimiterFrame): number | null {
  if (!frame.hasContent) return 0;
  completeFrameArgument(frame);
  if (frame.ambiguousNoParenSyntax) return null;
  return frame.arity - Math.max(0, frame.trailingKeywordArguments - 1);
}

function completeFrameArgument(frame: DelimiterFrame): void {
  if (frame.argumentShape === "keyword") frame.trailingKeywordArguments += 1;
  else frame.trailingKeywordArguments = 0;
  frame.argumentShape = "empty";
  frame.keywordValueStarted = false;
  frame.pendingWhitespace = false;
  frame.mayConsumeFollowingComma = false;
  frame.expectingOperatorOperand = false;
}

function markFrameWhitespace(stack: readonly DelimiterFrame[]): void {
  const frame = stack.at(-1);
  if (frame !== undefined && frame.blockDepth === 0 && frame.argumentShape !== "empty") {
    frame.pendingWhitespace = true;
  }
}

function markFrameIdentifier(frame: DelimiterFrame): void {
  markFrameToken(frame, frame.argumentShape === "empty" ? "identifier" : "other");
}

function markFrameOther(frame: DelimiterFrame): void {
  if (frame.blockDepth > 0) {
    frame.hasContent = true;
    return;
  }
  markFrameToken(frame, "other");
}

function markFrameToken(frame: DelimiterFrame, nextShape: "identifier" | "other"): void {
  const followsOperator = frame.expectingOperatorOperand;
  frame.expectingOperatorOperand = false;
  if (frame.argumentShape === "keyword") {
    if (frame.pendingWhitespace && frame.keywordValueStarted && !followsOperator) {
      frame.mayConsumeFollowingComma = true;
    }
    frame.keywordValueStarted = true;
  } else {
    if (frame.pendingWhitespace && frame.argumentShape !== "empty" && !followsOperator) {
      frame.mayConsumeFollowingComma = true;
    }
    frame.argumentShape = nextShape;
  }
  frame.pendingWhitespace = false;
  frame.hasContent = true;
}

function markFrameOperator(frame: DelimiterFrame): void {
  if (frame.blockDepth > 0) {
    frame.hasContent = true;
    return;
  }
  if (frame.argumentShape === "keyword") frame.keywordValueStarted = true;
  else frame.argumentShape = "other";
  frame.pendingWhitespace = false;
  frame.expectingOperatorOperand = true;
  frame.hasContent = true;
}

function symbolicOperatorLength(content: string, index: number): number {
  const char = content[index];
  if (char === ".") return 1;
  if (char === "&") {
    if (content.startsWith("&&&", index)) return 3;
    if (content.startsWith("&&", index)) return 2;
    return 1;
  }
  return Number(
    char === "+" ||
      char === "-" ||
      char === "*" ||
      char === "/" ||
      char === "=" ||
      char === "<" ||
      char === ">" ||
      char === "|" ||
      char === "^" ||
      char === "!" ||
      char === "~" ||
      char === "\\",
  );
}

function markFrameContent(stack: readonly DelimiterFrame[]): void {
  const frame = stack.at(-1);
  if (frame !== undefined) markFrameOther(frame);
}

function isIdentifierStart(char: string): boolean {
  return /[A-Za-z_]/u.test(char);
}

function isIdentifierContinue(char: string): boolean {
  return /[A-Za-z0-9_!?]/u.test(char);
}

function nextNonWhitespace(content: string, start: number): string | undefined {
  let index = start;
  while (index < content.length && /\s/u.test(content[index] as string)) index += 1;
  return content[index];
}

function previousNonWhitespace(content: string, start: number): string | undefined {
  let index = start - 1;
  while (index >= 0 && /\s/u.test(content[index] as string)) index -= 1;
  return content[index];
}

/** Remove comments while preserving strings, byte offsets, and line numbers. */
function withoutComments(content: string): string {
  const output = content.split("");
  let quote: string | null = null;
  let heredoc: string | null = null;
  for (let index = 0; index < content.length; index += 1) {
    if (heredoc !== null) {
      if (content.startsWith(heredoc, index)) {
        index += heredoc.length - 1;
        heredoc = null;
      }
      continue;
    }
    if (quote !== null) {
      const char = content[index];
      if (char === "\\") index += 1;
      else if (char === quote) quote = null;
      continue;
    }
    if (content.startsWith('"""', index) || content.startsWith("'''", index)) {
      heredoc = content.slice(index, index + 3);
      index += 2;
      continue;
    }
    const char = content[index];
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char !== "#") continue;
    while (index < content.length && content[index] !== "\n") {
      output[index] = " ";
      index += 1;
    }
  }
  return output.join("");
}

/** Mask comments and string/heredoc bodies while preserving offsets and lines. */
function maskCommentsAndStrings(content: string, preserveLiteralSentinels = false): string {
  const output = content.split("");
  let quote: string | null = null;
  let quoteStart = -1;
  let heredoc: string | null = null;
  for (let index = 0; index < content.length; index += 1) {
    if (heredoc !== null) {
      if (content.startsWith(heredoc, index)) {
        for (let offset = 0; offset < heredoc.length; offset += 1) output[index + offset] = " ";
        index += heredoc.length - 1;
        heredoc = null;
      } else if (content[index] !== "\n" && content[index] !== "\r") {
        output[index] = " ";
      }
      continue;
    }
    if (quote !== null) {
      const char = content[index];
      if (char !== "\n" && char !== "\r") output[index] = " ";
      if (char === "\\") {
        index += 1;
        if (content[index] !== "\n" && content[index] !== "\r") output[index] = " ";
      } else if (char === quote) {
        if (preserveLiteralSentinels && nextNonWhitespace(content, index + 1) === ":") {
          output[quoteStart] = " ";
          output[index] = "q";
        }
        quote = null;
        quoteStart = -1;
      }
      continue;
    }
    if (content.startsWith('"""', index) || content.startsWith("'''", index)) {
      heredoc = content.slice(index, index + 3);
      output[index] = preserveLiteralSentinels ? "@" : " ";
      output[index + 1] = " ";
      output[index + 2] = " ";
      index += 2;
      continue;
    }
    const char = content[index];
    if (char === '"' || char === "'") {
      quote = char;
      quoteStart = index;
      output[index] = preserveLiteralSentinels ? "@" : " ";
      continue;
    }
    if (char !== "#") continue;
    while (index < content.length && content[index] !== "\n") {
      output[index] = " ";
      index += 1;
    }
  }
  return output.join("");
}

function lineStarts(content: string): number[] {
  const starts = [0];
  for (let index = 0; index < content.length; index += 1) {
    if (content.charCodeAt(index) === 10) starts.push(index + 1);
  }
  return starts;
}

function siteAt(file: string, line: number, start = 0) {
  return { file, span: { start, end: start, startLine: line, endLine: line } };
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

function countLines(content: string): number {
  if (content.length === 0) return 1;
  let lines = 1;
  for (let index = 0; index < content.length; index += 1) {
    if (content.charCodeAt(index) === 10) lines += 1;
  }
  return content.endsWith("\n") ? lines - 1 : lines;
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareEdges(a: IREdge, b: IREdge): number {
  return (
    compare(a.site.file, b.site.file) ||
    a.site.span.start - b.site.span.start ||
    compare(a.referenceKind ?? "", b.referenceKind ?? "") ||
    compare(a.to, b.to)
  );
}
