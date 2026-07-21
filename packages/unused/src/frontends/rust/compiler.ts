/** Stable Cargo JSON diagnostic extraction for compiler-confirmed dead functions. */

import { isAbsolute, relative, resolve, sep } from "node:path";
import type { Site } from "../../core/ir/index.js";
import type { CargoWorkspace } from "./metadata.js";
import { CargoCompileError, runCargo } from "./runner.js";

export interface CompilerDeadFunction {
  readonly name: string;
  readonly file: string;
  readonly site: Site;
}

export interface CollectCompilerFactsOptions {
  readonly cargoCommand?: string;
}

/**
 * Return only diagnostics present in both default and all-features all-target
 * compilations. A feature-specific use therefore removes a default-only dead
 * warning from the claimable intersection.
 */
export function collectCompilerDeadFunctions(
  workspace: CargoWorkspace,
  options: CollectCompilerFactsOptions = {},
): CompilerDeadFunction[] {
  const base = ["check", "--workspace", "--all-targets", "--message-format=json"] as const;
  const defaultFacts = compile(workspace, base, options.cargoCommand);
  const allFeatureFacts = compile(workspace, [...base, "--all-features"], options.cargoCommand);
  const allFeatureKeys = new Set(allFeatureFacts.map(factKey));
  return defaultFacts.filter((fact) => allFeatureKeys.has(factKey(fact))).sort(bySite);
}

function compile(
  workspace: CargoWorkspace,
  args: readonly string[],
  cargoCommand: string | undefined,
): CompilerDeadFunction[] {
  const { stdout } = runCargo(workspace.workspaceRoot, args, cargoCommand, "compile");
  const facts: CompilerDeadFunction[] = [];
  let sawBuildFinished = false;
  for (const [index, line] of stdout.split(/\r?\n/u).entries()) {
    if (line.trim() === "") continue;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch (error) {
      throw new CargoCompileError(`Cargo emitted malformed JSON on line ${index + 1}`, {
        cause: error,
      });
    }
    const message = asRecord(raw);
    if (valueAt(message, "reason") === "build-finished") {
      if (valueAt(message, "success") !== true) {
        throw new CargoCompileError("Cargo reported an unsuccessful build");
      }
      sawBuildFinished = true;
      continue;
    }
    const fact = deadFunctionFromMessage(message, workspace);
    if (fact !== null) facts.push(fact);
  }
  if (!sawBuildFinished) throw new CargoCompileError("Cargo JSON omitted build-finished");
  return dedupe(facts);
}

function deadFunctionFromMessage(
  record: Record<string, unknown>,
  workspace: CargoWorkspace,
): CompilerDeadFunction | null {
  if (valueAt(record, "reason") !== "compiler-message") return null;
  const packageId = valueAt(record, "package_id");
  if (typeof packageId !== "string" || !workspace.workspaceMemberIds.has(packageId)) return null;
  const diagnostic = asRecordOrNull(valueAt(record, "message"));
  if (diagnostic === null) return null;
  const code = asRecordOrNull(valueAt(diagnostic, "code"));
  if (code === null || valueAt(code, "code") !== "dead_code") return null;
  const text = valueAt(diagnostic, "message");
  if (typeof text !== "string") return null;
  const match = /^function `([^`]+)` is never used$/u.exec(text);
  if (match?.[1] === undefined) return null;
  const spans = valueAt(diagnostic, "spans");
  if (!Array.isArray(spans)) return null;
  const primary = spans
    .map(asRecordOrNull)
    .find((span) => span !== null && valueAt(span, "is_primary") === true);
  if (primary === undefined || primary === null) return null;
  const fileName = valueAt(primary, "file_name");
  if (valueAt(primary, "expansion") !== null && valueAt(primary, "expansion") !== undefined) {
    return null;
  }
  const byteStart = valueAt(primary, "byte_start");
  const byteEnd = valueAt(primary, "byte_end");
  const lineStart = valueAt(primary, "line_start");
  const lineEnd = valueAt(primary, "line_end");
  if (
    typeof fileName !== "string" ||
    typeof byteStart !== "number" ||
    typeof byteEnd !== "number" ||
    typeof lineStart !== "number" ||
    typeof lineEnd !== "number"
  ) {
    return null;
  }
  const absolute = resolveCompilerPath(workspace.workspaceRoot, fileName);
  const file = toWorkspaceRel(workspace.workspaceRoot, absolute);
  if (file === null) return null;
  return {
    name: match[1],
    file,
    site: {
      file,
      span: {
        start: byteStart,
        end: byteEnd,
        startLine: lineStart,
        endLine: lineEnd,
      },
    },
  };
}

function resolveCompilerPath(root: string, file: string): string {
  return resolve(isAbsolute(file) ? file : resolve(root, file));
}

function toWorkspaceRel(root: string, file: string): string | null {
  const value = relative(root, file);
  if (value === "" || value === ".." || value.startsWith(`..${sep}`) || isAbsolute(value)) {
    return null;
  }
  return value.split(sep).join("/");
}

function factKey(fact: CompilerDeadFunction): string {
  return `${fact.file}\0${fact.site.span.start}\0${fact.site.span.end}\0${fact.name}`;
}

function dedupe(facts: readonly CompilerDeadFunction[]): CompilerDeadFunction[] {
  return [...new Map(facts.map((fact) => [factKey(fact), fact])).values()];
}

function bySite(a: CompilerDeadFunction, b: CompilerDeadFunction): number {
  return a.file === b.file ? a.site.span.start - b.site.span.start : a.file < b.file ? -1 : 1;
}

function asRecord(value: unknown): Record<string, unknown> {
  const record = asRecordOrNull(value);
  if (record === null) throw new CargoCompileError("Cargo JSON message must be an object");
  return record;
}

function asRecordOrNull(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function valueAt(record: Record<string, unknown>, name: string): unknown {
  return record[name];
}
