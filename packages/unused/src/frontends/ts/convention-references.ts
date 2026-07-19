/**
 * References carried by external tool/runtime conventions rather than normal
 * JavaScript imports. These recognisers only add liveness: a resolved source
 * file becomes either the target of an edge from the source that names it, or
 * a config root when the carrier is outside the JS graph (a manifest/workflow).
 */
import { type Dirent, lstatSync } from "node:fs";
import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  posix,
  relative,
  resolve as resolvePath,
  sep,
} from "node:path";
import ignore, { type Ignore } from "ignore";
import { parseSync } from "oxc-parser";
import { parse as parseYaml } from "yaml";
import type { Site } from "../../core/ir/index.js";
import { isNode, keys, nodeArray, prop, type RawNode, str } from "./ast.js";
import { ancestorGitignoreFiles } from "./discover.js";
import type { PackageJsonLike } from "./emit.js";
import { LineIndex } from "./line-index.js";

const SOURCE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"] as const;
const SOURCE_PATH_RE = /\.(?:[cm]?[tj]sx?)$/i;

export interface ConventionSource {
  /** Root-relative POSIX file path. */
  readonly file: string;
  readonly source: string;
}

export interface ConventionUnit {
  readonly dir: string;
  /** Root-relative POSIX package directory; empty for the repository root. */
  readonly rootRelDir: string;
  readonly packageJson: PackageJsonLike | null;
}

export interface ConventionReference {
  readonly fromFile: string;
  readonly targetFile: string;
  readonly site: Site;
}

export interface ConventionRoot {
  readonly file: string;
  readonly reason: string;
}

/**
 * A CDK `NodejsFunction` bundle target is executable code even though the
 * construct names it through an `entry` option rather than importing it. The
 * edge is attached to the construct source, so a dead construct does not keep
 * an otherwise-dead target alive.
 */
export function cdkNodejsFunctionReferences(
  projectRoot: string,
  _unit: ConventionUnit,
  unitSources: readonly ConventionSource[],
  analyzedFiles: ReadonlySet<string>,
): ConventionReference[] {
  const out: ConventionReference[] = [];
  const seen = new Set<string>();
  for (const input of unitSources) {
    // Scope this heuristic tightly to CDK construct code. It is a keep-alive
    // recogniser, but an unrelated object property named `entry` should not
    // quietly erase useful recall across an entire CDK package.
    if (!/\bNodejsFunction\b/.test(input.source)) continue;
    const lineIndex = new LineIndex(input.source);

    const sourceDir = dirname(resolvePath(projectRoot, input.file));
    for (const match of cdkEntryExpressions(input.file, input.source, sourceDir)) {
      if (!SOURCE_PATH_RE.test(stripQuery(match.value))) continue;
      const target = resolveEvaluatedSourcePath(match.value, projectRoot, sourceDir, analyzedFiles);
      if (target === null) continue;
      const key = `${input.file}\0${target}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        fromFile: input.file,
        targetFile: target,
        site: { file: input.file, span: lineIndex.span(match.start, match.end) },
      });
    }
  }
  return out;
}

/**
 * `AudioWorklet.addModule("/worker.js")` resolves a root-relative URL from the
 * package's conventional `public/` directory. Model it as a source edge so the
 * asset is alive only when the calling module is alive.
 */
export function audioWorkletReferences(
  unit: ConventionUnit,
  unitSources: readonly ConventionSource[],
  analyzedFiles: ReadonlySet<string>,
): ConventionReference[] {
  const out: ConventionReference[] = [];
  const seen = new Set<string>();
  const re = /\baudioWorklet\s*\.\s*addModule\s*\(\s*(["'`])([^"'`\r\n]+)\1/gi;
  for (const input of unitSources) {
    const lineIndex = new LineIndex(input.source);
    re.lastIndex = 0;
    let match: RegExpExecArray | null = re.exec(input.source);
    while (match !== null) {
      const target = publicUrlTarget(unit, match[2] ?? "", analyzedFiles);
      if (target !== null) {
        const key = `${input.file}\0${target}`;
        if (!seen.has(key)) {
          seen.add(key);
          out.push({
            fromFile: input.file,
            targetFile: target,
            site: {
              file: input.file,
              span: lineIndex.span(match.index, match.index + match[0].length),
            },
          });
        }
      }
      match = re.exec(input.source);
    }
  }
  return out;
}

/** The MSW package-manifest convention installs this fixed public worker file. */
export function mswWorkerRoots(
  unit: ConventionUnit,
  analyzedFiles: ReadonlySet<string>,
): ConventionRoot[] {
  const msw = (unit.packageJson as { msw?: unknown } | null)?.msw;
  if (msw === null || typeof msw !== "object" || Array.isArray(msw)) return [];
  const configured = (msw as { workerDirectory?: unknown }).workerDirectory;
  const directories =
    typeof configured === "string"
      ? [configured]
      : Array.isArray(configured)
        ? configured.filter((value): value is string => typeof value === "string")
        : [];
  const out: ConventionRoot[] = [];
  const seen = new Set<string>();
  for (const directory of directories) {
    const clean = directory.trim().replace(/^\.\//, "").replace(/\/+$/, "");
    if (clean === "" || clean === ".." || clean.startsWith("../") || clean.startsWith("/")) {
      continue;
    }
    const packageRelative = posix.join(clean, "mockServiceWorker.js");
    const file =
      unit.rootRelDir === "" ? packageRelative : posix.join(unit.rootRelDir, packageRelative);
    if (!analyzedFiles.has(file) || seen.has(file)) continue;
    seen.add(file);
    out.push({ file, reason: "config:package.json:msw.workerDirectory" });
  }
  return out;
}

/**
 * Source files explicitly executed by GitHub Actions `run` steps. Workflows
 * run at the repository root unless a workflow/job/step working directory
 * overrides it; all three scopes are honoured here.
 */
export async function githubActionsRunRoots(
  projectRoot: string,
  analyzedFiles: ReadonlySet<string>,
  useGitignore = true,
): Promise<ConventionRoot[]> {
  const workflowsDir = join(projectRoot, ".github", "workflows");
  let names: string[];
  try {
    names = await readdir(workflowsDir);
  } catch {
    return [];
  }

  const ignoreContexts = useGitignore ? await ignoreContextsThrough(projectRoot, workflowsDir) : [];
  if (useGitignore && isCarrierIgnored(workflowsDir, true, ignoreContexts)) return [];
  const out: ConventionRoot[] = [];
  const seen = new Set<string>();
  for (const name of names.sort()) {
    if (!/\.ya?ml$/i.test(name)) continue;
    if (useGitignore && isCarrierIgnored(join(workflowsDir, name), false, ignoreContexts)) continue;
    let parsed: unknown;
    try {
      parsed = parseYaml(await readFile(join(workflowsDir, name), "utf8"));
    } catch {
      continue;
    }
    for (const step of workflowRunSteps(parsed)) {
      const workingDir = safeWorkingDirectory(projectRoot, step.workingDirectory);
      if (workingDir === null) continue;
      for (const sourcePath of shellSourcePaths(step.run)) {
        const commandWorkingDir =
          sourcePath.directory === null
            ? workingDir
            : boundedWorkingDirectory(projectRoot, workingDir, sourcePath.directory);
        if (commandWorkingDir === null) continue;
        const target = resolveCommandSourcePath(
          sourcePath.path,
          projectRoot,
          commandWorkingDir,
          analyzedFiles,
        );
        if (
          target === null ||
          (sourcePath.direct && !isExecutableSourceFile(projectRoot, target)) ||
          seen.has(target)
        ) {
          continue;
        }
        seen.add(target);
        out.push({ file: target, reason: "config:github-actions:run" });
      }
    }
  }
  return out;
}

/** Repository scripts invoked by Task task command lists. */
export async function taskfileCommandRoots(
  projectRoot: string,
  analyzedFiles: ReadonlySet<string>,
  useGitignore = true,
): Promise<ConventionRoot[]> {
  const discoveredTaskfiles = await findCarrierFiles(
    projectRoot,
    (name) => TASKFILE_DIRECTORY_NAMES.includes(name as TaskfileDirectoryName),
    useGitignore,
  );
  const taskfiles = preferredRootTaskfiles(discoveredTaskfiles);
  const out: ConventionRoot[] = [];
  const seen = new Set<string>();
  for (const taskfile of taskfiles) {
    await collectTaskfileCommandRoots({
      projectRoot,
      taskfile,
      defaultWorkingDirectory: dirname(taskfile),
      analyzedFiles,
      useGitignore,
      depth: 0,
      stack: new Set(),
      out,
      seen,
    });
  }
  return out;
}

const TASKFILE_INCLUDE_MAX_DEPTH = 16;
const TASKFILE_DIRECTORY_NAMES = [
  "Taskfile.yml",
  "taskfile.yml",
  "Taskfile.yaml",
  "taskfile.yaml",
  "Taskfile.dist.yml",
  "taskfile.dist.yml",
  "Taskfile.dist.yaml",
  "taskfile.dist.yaml",
] as const;
type TaskfileDirectoryName = (typeof TASKFILE_DIRECTORY_NAMES)[number];

/** Task loads only the first supported basename present in each directory. */
function preferredRootTaskfiles(taskfiles: readonly string[]): string[] {
  const byDirectory = new Map<string, string[]>();
  for (const taskfile of taskfiles) {
    const directory = dirname(taskfile);
    const candidates = byDirectory.get(directory);
    if (candidates === undefined) byDirectory.set(directory, [taskfile]);
    else candidates.push(taskfile);
  }
  return [...byDirectory.values()]
    .map(
      (candidates) =>
        candidates.sort(
          (a, b) =>
            TASKFILE_DIRECTORY_NAMES.indexOf(basename(a) as TaskfileDirectoryName) -
            TASKFILE_DIRECTORY_NAMES.indexOf(basename(b) as TaskfileDirectoryName),
        )[0],
    )
    .filter((taskfile): taskfile is string => taskfile !== undefined)
    .sort();
}

interface TaskfileCollectionContext {
  readonly projectRoot: string;
  readonly taskfile: string;
  readonly defaultWorkingDirectory: string;
  readonly analyzedFiles: ReadonlySet<string>;
  readonly useGitignore: boolean;
  readonly depth: number;
  readonly stack: ReadonlySet<string>;
  readonly out: ConventionRoot[];
  readonly seen: Set<string>;
}

async function collectTaskfileCommandRoots(context: TaskfileCollectionContext): Promise<void> {
  if (
    context.depth > TASKFILE_INCLUDE_MAX_DEPTH ||
    context.stack.has(context.taskfile) ||
    !(await isAllowedCarrierPath(context.projectRoot, context.taskfile, context.useGitignore))
  ) {
    return;
  }
  let parsed: unknown;
  try {
    parsed = parseYaml(await readFile(context.taskfile, "utf8"));
  } catch {
    return;
  }

  for (const command of taskfileCommands(parsed)) {
    const workingDir = boundedWorkingDirectory(
      context.projectRoot,
      context.defaultWorkingDirectory,
      command.directory,
    );
    if (workingDir === null) continue;
    collectCommandRoots(
      command.command,
      context.projectRoot,
      workingDir,
      context.analyzedFiles,
      "config:taskfile:cmd",
      context.out,
      context.seen,
      true,
    );
  }

  const stack = new Set([...context.stack, context.taskfile]);
  for (const include of taskfileIncludes(parsed)) {
    const includedTaskfile = await resolveLocalIncludedTaskfile(
      context.projectRoot,
      context.taskfile,
      include.taskfile,
      context.useGitignore,
    );
    if (includedTaskfile === null) continue;
    if (context.depth + 1 > TASKFILE_INCLUDE_MAX_DEPTH || stack.has(includedTaskfile)) {
      continue;
    }
    const defaultWorkingDirectory =
      include.directory === null
        ? context.defaultWorkingDirectory
        : boundedWorkingDirectory(
            context.projectRoot,
            dirname(context.taskfile),
            include.directory,
          );
    if (defaultWorkingDirectory === null) continue;
    for (const command of include.dynamicCommands) {
      collectCommandRoots(
        command,
        context.projectRoot,
        defaultWorkingDirectory,
        context.analyzedFiles,
        "config:taskfile:dynamic-variable",
        context.out,
        context.seen,
        true,
      );
    }
    await collectTaskfileCommandRoots({
      ...context,
      taskfile: includedTaskfile,
      defaultWorkingDirectory,
      depth: context.depth + 1,
      stack,
    });
  }
}

/** Explicit `k6 run <file>` commands in package scripts. */
export function k6PackageScriptRoots(
  projectRoot: string,
  unit: ConventionUnit,
  analyzedFiles: ReadonlySet<string>,
): ConventionRoot[] {
  const scripts = (unit.packageJson as { scripts?: unknown } | null)?.scripts;
  if (!isRecord(scripts)) return [];
  const out: ConventionRoot[] = [];
  const seen = new Set<string>();
  for (const command of Object.values(scripts)) {
    if (typeof command !== "string" || !/\bk6\s+run(?:\s|$)/.test(command)) continue;
    collectCommandRoots(
      command,
      projectRoot,
      unit.dir,
      analyzedFiles,
      "config:package.json:k6-run",
      out,
      seen,
    );
  }
  return out;
}

/**
 * Vite Rollup inputs and Vitest setup files are path-valued config references.
 * They are edges from the config source (itself a config root), so normal graph
 * reachability supplies liveness and why-path provenance.
 */
export function viteVitestConfigReferences(
  projectRoot: string,
  unit: ConventionUnit,
  unitSources: readonly ConventionSource[],
  analyzedFiles: ReadonlySet<string>,
): ConventionReference[] {
  const out: ConventionReference[] = [];
  const seen = new Set<string>();
  for (const input of unitSources) {
    const base = posix.basename(input.file);
    const vite = /^vite\.config\.[cm]?[tj]s$/i.test(base);
    const vitest = /^vitest\.config\.[cm]?[tj]s$/i.test(base);
    if (!vite && !vitest) continue;
    const lineIndex = new LineIndex(input.source);
    const expressions: PropertyExpression[] = [];
    if (vite) {
      for (const rollup of propertyExpressions(input.source, "rollupOptions")) {
        expressions.push(...propertyExpressions(rollup.text, "input", rollup.valueStart));
      }
    }
    for (const test of propertyExpressions(input.source, "test")) {
      expressions.push(...propertyExpressions(test.text, "setupFiles", test.valueStart));
      expressions.push(...propertyExpressions(test.text, "globalSetup", test.valueStart));
    }
    // A dedicated Vitest config may export the test object directly.
    if (vitest) {
      expressions.push(...propertyExpressions(input.source, "setupFiles"));
      expressions.push(...propertyExpressions(input.source, "globalSetup"));
    }
    for (const expression of expressions) {
      for (const value of quotedValues(expression.text)) {
        if (!SOURCE_PATH_RE.test(stripQuery(value))) continue;
        const target = resolveSourcePath(
          value,
          projectRoot,
          unit.dir,
          dirname(resolvePath(projectRoot, input.file)),
          analyzedFiles,
        );
        if (target === null) continue;
        const key = `${input.file}\0${target}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({
          fromFile: input.file,
          targetFile: target,
          site: {
            file: input.file,
            span: lineIndex.span(expression.start, expression.end),
          },
        });
      }
    }
  }
  return out;
}

/** Browser APIs whose literal root-relative URL loads a public source asset. */
export function browserRuntimeAssetReferences(
  unit: ConventionUnit,
  unitSources: readonly ConventionSource[],
  analyzedFiles: ReadonlySet<string>,
): ConventionReference[] {
  const out = audioWorkletReferences(unit, unitSources, analyzedFiles);
  const seen = new Set(out.map((reference) => `${reference.fromFile}\0${reference.targetFile}`));
  const patterns = [
    /\bserviceWorker\s*\.\s*register\s*\(\s*(["'`])([^"'`\r\n]+)\1/gi,
    /\bnew\s+(?:Shared)?Worker\s*\(\s*(["'`])([^"'`\r\n]+)\1/gi,
  ];
  for (const input of unitSources) {
    const lineIndex = new LineIndex(input.source);
    for (const pattern of patterns) {
      pattern.lastIndex = 0;
      let match: RegExpExecArray | null = pattern.exec(input.source);
      while (match !== null) {
        const target = publicUrlTarget(unit, match[2] ?? "", analyzedFiles);
        const key = target === null ? "" : `${input.file}\0${target}`;
        if (target !== null && !seen.has(key)) {
          seen.add(key);
          out.push({
            fromFile: input.file,
            targetFile: target,
            site: {
              file: input.file,
              span: lineIndex.span(match.index, match.index + match[0].length),
            },
          });
        }
        match = pattern.exec(input.source);
      }
    }
  }
  return out;
}

/** Script/module entrypoints named by HTML and browser-extension manifests. */
export async function browserCarrierRoots(
  projectRoot: string,
  units: readonly ConventionUnit[],
  analyzedFiles: ReadonlySet<string>,
  useGitignore = true,
): Promise<ConventionRoot[]> {
  const carriers = await findCarrierFiles(
    projectRoot,
    (name) => name.toLowerCase().endsWith(".html") || name === "manifest.json",
    useGitignore,
  );
  const out: ConventionRoot[] = [];
  const seen = new Set<string>();
  for (const carrier of carriers) {
    const unit = ownerUnitForAbsolute(units, carrier);
    if (unit === null) continue;
    const name = posix.basename(toPosixRel(projectRoot, carrier));
    if (name.toLowerCase().endsWith(".html")) {
      let source: string;
      try {
        source = await readFile(carrier, "utf8");
      } catch {
        continue;
      }
      const re = /<script\b[^>]*\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)')[^>]*>/gi;
      let match: RegExpExecArray | null = re.exec(source);
      while (match !== null) {
        for (const target of browserPathTargets(
          match[1] ?? match[2] ?? "",
          projectRoot,
          unit,
          dirname(carrier),
          analyzedFiles,
        )) {
          addRoot(target, "browser:html:script", out, seen);
        }
        match = re.exec(source);
      }
      continue;
    }

    let manifest: unknown;
    try {
      manifest = JSON.parse(await readFile(carrier, "utf8"));
    } catch {
      continue;
    }
    if (!isRecord(manifest)) continue;
    const browserManifest = manifest as RawBrowserManifest;
    if (typeof browserManifest.manifest_version !== "number") continue;
    for (const value of browserManifestScriptPaths(browserManifest)) {
      for (const target of browserPathTargets(
        value,
        projectRoot,
        unit,
        dirname(carrier),
        analyzedFiles,
      )) {
        addRoot(target, "browser:manifest:script", out, seen);
      }
    }
  }
  return out;
}

/** Node scripts executed by common iOS/Android native project configuration. */
export async function nativeConfigScriptRoots(
  projectRoot: string,
  analyzedFiles: ReadonlySet<string>,
  useGitignore = true,
): Promise<ConventionRoot[]> {
  const carriers = await findCarrierFiles(
    projectRoot,
    (name) =>
      /^(?:project\.pbxproj|Podfile|build\.gradle(?:\.kts)?|settings\.gradle(?:\.kts)?|[^/]+\.xcconfig)$/i.test(
        name,
      ),
    useGitignore,
  );
  const out: ConventionRoot[] = [];
  const seen = new Set<string>();
  for (const carrier of carriers) {
    let source: string;
    try {
      source = await readFile(carrier, "utf8");
    } catch {
      continue;
    }
    const xcodeProjectDirectory = owningXcodeProjectDirectory(carrier);
    const workingDirectory = xcodeProjectDirectory ?? dirname(carrier);
    for (const command of nativeCarrierCommands(carrier, source)) {
      const expanded = expandNativeProjectVariables(command, xcodeProjectDirectory !== null);
      collectCommandRoots(
        expanded,
        projectRoot,
        workingDirectory,
        analyzedFiles,
        "config:native-build-script",
        out,
        seen,
      );
    }
  }
  return out;
}

function nativeCarrierCommands(carrier: string, source: string): string[] {
  const name = basename(carrier).toLowerCase();
  if (name === "project.pbxproj") {
    const uncommented = stripCarrierComments(source, false);
    return quotedAssignmentValues(uncommented, "shellScript").flatMap((command) =>
      literalNodeShellCommands(stripShellComments(command)),
    );
  }
  if (name === "podfile") {
    // Precision first: Ruby's lexical boundaries are context-sensitive enough
    // that a guessed quote/comment/heredoc boundary can hide a later real call.
    // Inspect every receiver-eligible token instead. Exact literal arguments
    // still gate the keep-alive below, so the deliberate cost is recall only.
    return literalNodeRuntimeCalls(source, "system", true, "bare-or-kernel", "all-tokens");
  }
  if (/^(?:build|settings)\.gradle(?:\.kts)?$/i.test(name)) {
    return literalNodeRuntimeCalls(stripCarrierComments(source, false), "commandLine");
  }
  // `.xcconfig` files configure build settings but do not themselves execute
  // commands. Merely mentioning a source-looking path there is not liveness.
  return [];
}

function literalNodeShellCommands(source: string): string[] {
  return source
    .split(/(?:\r?\n|&&|\|\||;)/)
    .map((command) => command.trim())
    .filter((command) => {
      if (command === "") return false;
      return /^(?:(?:exec\s+)?(?:\/usr\/bin\/env\s+)?)(?:["']?(?:[^\s"']*\/)?node(?:js)?["']?)(?:\s|$)/i.test(
        command,
      );
    });
}

function literalNodeRuntimeCalls(
  source: string,
  callName: string,
  allowCommandLine = false,
  receiverPolicy: "any" | "bare-or-kernel" = "any",
  scanPolicy: "code-only" | "all-tokens" = "code-only",
): string[] {
  const out: string[] = [];
  for (const argumentsText of codeCallArguments(source, callName, receiverPolicy, scanPolicy)) {
    const values = splitTopLevelArguments(argumentsText).map(exactQuotedValue);
    if (values.some((value) => value === null)) continue;
    const literalValues = values.filter((value): value is string => value !== null);
    if (allowCommandLine && literalValues.length === 1) {
      out.push(...literalNodeShellCommands(stripShellComments(literalValues[0] ?? "")));
      continue;
    }
    const executable = literalValues[0]?.replace(/\\/g, "/").split("/").pop()?.toLowerCase();
    if (executable !== "node" && executable !== "nodejs") continue;
    out.push(literalValues.join(" "));
  }
  return out;
}

function splitTopLevelArguments(source: string): string[] {
  const out: string[] = [];
  const stack: string[] = [];
  let quote: string | null = null;
  let escaped = false;
  let start = 0;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index] ?? "";
    if (quote !== null) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === "(" || char === "[" || char === "{") stack.push(char);
    else if (char === ")" || char === "]" || char === "}") stack.pop();
    else if (char === "," && stack.length === 0) {
      out.push(source.slice(start, index).trim());
      start = index + 1;
    }
  }
  out.push(source.slice(start).trim());
  return out.filter((value) => value !== "");
}

function exactQuotedValue(source: string): string | null {
  const parsed = parseQuotedValue(source, 0);
  return parsed !== null && parsed.end === source.length - 1 ? parsed.value : null;
}

/** Extract receiver-eligible calls, optionally ignoring surrounding lexical state. */
function codeCallArguments(
  source: string,
  callName: string,
  receiverPolicy: "any" | "bare-or-kernel" = "any",
  scanPolicy: "code-only" | "all-tokens" = "code-only",
): string[] {
  const out: string[] = [];
  let quote: string | null = null;
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index] ?? "";
    if (scanPolicy === "code-only" && quote !== null) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = null;
      continue;
    }
    if (scanPolicy === "code-only" && (char === '"' || char === "'" || char === "`")) {
      quote = char;
      continue;
    }
    if (
      !source.startsWith(callName, index) ||
      /[A-Za-z0-9_$]/.test(source[index - 1] ?? "") ||
      /[A-Za-z0-9_$]/.test(source[index + callName.length] ?? "") ||
      (receiverPolicy === "bare-or-kernel" && !isBareOrKernelCall(source, index))
    ) {
      continue;
    }
    let start = index + callName.length;
    while (/\s/.test(source[start] ?? "")) start += 1;
    if (source[start] === "(") {
      const end = matchingDelimiterEnd(source, start, "(", ")");
      if (end !== null) out.push(source.slice(start + 1, end));
    } else {
      out.push(commandFormArguments(source, start));
    }
    index = start;
  }
  return out;
}

/**
 * Bound one Ruby command-form call without carrying lexical state from any
 * preceding source. Exact literal validation happens after this local slice.
 */
function commandFormArguments(source: string, start: number): string {
  const stack: string[] = [];
  const parts: string[] = [];
  let segmentStart = start;
  let quote: string | null = null;
  let escaped = false;

  for (let index = start; index < source.length; index += 1) {
    const char = source[index] ?? "";
    if (quote !== null) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === "(" || char === "[" || char === "{") {
      stack.push(char);
      continue;
    }
    if (char === ")" || char === "]" || char === "}") {
      stack.pop();
      continue;
    }
    if (stack.length !== 0) continue;
    if (char === "#") {
      let previous = index - 1;
      while (previous >= start && /[ \t]/u.test(source[previous] ?? "")) previous -= 1;
      if (source[previous] !== ",") return `${parts.join("")}${source.slice(segmentStart, index)}`;
      const newline = source.indexOf("\n", index);
      if (newline < 0) return `${parts.join("")}${source.slice(segmentStart, index)}`;
      parts.push(source.slice(segmentStart, index), "\n");
      segmentStart = newline + 1;
      index = newline;
      continue;
    }
    if (char === ";" || source.startsWith("&&", index) || source.startsWith("||", index)) {
      return `${parts.join("")}${source.slice(segmentStart, index)}`;
    }
    if (/\s/u.test(char)) {
      let wordStart = index + 1;
      while (wordStart < source.length && /\s/u.test(source[wordStart] ?? "")) wordStart += 1;
      if (char === "\n" || char === "\r") {
        let previous = index - 1;
        while (previous >= start && /\s/u.test(source[previous] ?? "")) previous -= 1;
        if (source[previous] !== ",") {
          return `${parts.join("")}${source.slice(segmentStart, index)}`;
        }
      }
      const suffix = /^(?:if|unless|while|until|rescue|and|or)\b/u.exec(source.slice(wordStart));
      if (suffix !== null) return `${parts.join("")}${source.slice(segmentStart, index)}`;
    }
  }
  return `${parts.join("")}${source.slice(segmentStart)}`;
}

/** Ruby's shell-executing `system` is bare or explicitly owned by `Kernel`. */
function isBareOrKernelCall(source: string, callStart: number): boolean {
  const inlineWhitespace = (char: string): boolean => char === " " || char === "\t";
  let cursor = callStart - 1;
  while (/\s/.test(source[cursor] ?? "")) cursor -= 1;
  if (source[cursor] === ".") cursor -= 1;
  else if (source[cursor] === ":" && source[cursor - 1] === ":") cursor -= 2;
  else if (source[cursor] === ":") return false;
  else return true;

  while (/\s/.test(source[cursor] ?? "")) cursor -= 1;
  const receiverEnd = cursor + 1;
  while (/[A-Za-z0-9_$]/.test(source[cursor] ?? "")) cursor -= 1;
  if (source.slice(cursor + 1, receiverEnd) !== "Kernel") return false;

  while (inlineWhitespace(source[cursor] ?? "")) cursor -= 1;
  if (source[cursor] === ":" && source[cursor - 1] === ":") {
    cursor -= 2;
    while (inlineWhitespace(source[cursor] ?? "")) cursor -= 1;
  }
  return !/[A-Za-z0-9_$:.]/.test(source[cursor] ?? "");
}

function quotedAssignmentValues(source: string, key: string): string[] {
  const out: string[] = [];
  let quote: string | null = null;
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index] ?? "";
    if (quote !== null) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (
      !source.startsWith(key, index) ||
      /[A-Za-z0-9_$]/.test(source[index - 1] ?? "") ||
      /[A-Za-z0-9_$]/.test(source[index + key.length] ?? "")
    ) {
      continue;
    }
    let cursor = index + key.length;
    while (/\s/.test(source[cursor] ?? "")) cursor += 1;
    if (source[cursor] !== "=") continue;
    cursor += 1;
    while (/\s/.test(source[cursor] ?? "")) cursor += 1;
    if (source[cursor] !== '"') continue;
    const parsed = parseQuotedValue(source, cursor);
    if (parsed !== null) {
      out.push(parsed.value);
      index = parsed.end;
    }
  }
  return out;
}

function parseQuotedValue(
  source: string,
  start: number,
): { readonly value: string; readonly end: number } | null {
  const quote = source[start];
  if (quote !== '"' && quote !== "'") return null;
  let value = "";
  let escaped = false;
  for (let index = start + 1; index < source.length; index += 1) {
    const char = source[index] ?? "";
    if (escaped) {
      value += char === "n" ? "\n" : char === "r" ? "\r" : char === "t" ? "\t" : char;
      escaped = false;
    } else if (char === "\\") {
      escaped = true;
    } else if (char === quote) {
      return { value, end: index };
    } else {
      value += char;
    }
  }
  return null;
}

function matchingDelimiterEnd(
  source: string,
  start: number,
  open: string,
  close: string,
): number | null {
  let depth = 0;
  let quote: string | null = null;
  let escaped = false;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index] ?? "";
    if (quote !== null) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      quote = char;
      continue;
    }
    if (char === open) depth += 1;
    else if (char === close && --depth === 0) return index;
  }
  return null;
}

function stripCarrierComments(source: string, hashComments: boolean): string {
  let out = "";
  let quote: string | null = null;
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index] ?? "";
    const next = source[index + 1] ?? "";
    if (quote !== null) {
      out += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      quote = char;
      out += char;
      continue;
    }
    if ((hashComments && char === "#") || (char === "/" && next === "/")) {
      while (index < source.length && source[index] !== "\n") index += 1;
      out += "\n";
      continue;
    }
    if (char === "/" && next === "*") {
      index += 2;
      while (index < source.length && !(source[index] === "*" && source[index + 1] === "/")) {
        if (source[index] === "\n") out += "\n";
        index += 1;
      }
      index += 1;
      continue;
    }
    out += char;
  }
  return out;
}

function stripShellComments(source: string): string {
  let out = "";
  let quote: string | null = null;
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index] ?? "";
    if (quote !== null) {
      out += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      quote = char;
      out += char;
      continue;
    }
    if (char === "#" && (index === 0 || /\s/.test(source[index - 1] ?? ""))) {
      while (index < source.length && source[index] !== "\n") index += 1;
      if (source[index] === "\n") out += "\n";
      continue;
    }
    out += char;
  }
  return out;
}

interface TaskCommand {
  readonly command: string;
  readonly directory: string | null;
}

interface RawTaskfile {
  readonly tasks?: unknown;
  readonly includes?: unknown;
  readonly vars?: unknown;
  readonly env?: unknown;
}

interface RawTask {
  readonly cmd?: unknown;
  readonly cmds?: unknown;
  readonly dir?: unknown;
  readonly if?: unknown;
  readonly status?: unknown;
  readonly preconditions?: unknown;
  readonly vars?: unknown;
  readonly env?: unknown;
}

interface RawTaskCommand {
  readonly cmd?: unknown;
  readonly defer?: unknown;
  readonly if?: unknown;
}

interface RawTaskPrecondition {
  readonly sh?: unknown;
}

interface RawTaskInclude {
  readonly taskfile?: unknown;
  readonly dir?: unknown;
  readonly vars?: unknown;
}

interface RawDynamicVariable {
  readonly sh?: unknown;
}

interface TaskfileInclude {
  readonly taskfile: string;
  readonly directory: string | null;
  readonly dynamicCommands: readonly string[];
}

function taskfileCommands(parsed: unknown): TaskCommand[] {
  if (!isRecord(parsed)) return [];
  const taskfile = parsed as RawTaskfile;
  const out: TaskCommand[] = [];
  appendDynamicVariableCommands(taskfile.vars, null, out);
  appendDynamicVariableCommands(taskfile.env, null, out);
  if (!isRecord(taskfile.tasks)) return out;
  for (const candidateTask of Object.values(taskfile.tasks)) {
    if (typeof candidateTask === "string") {
      out.push({ command: candidateTask, directory: null });
      continue;
    }
    if (Array.isArray(candidateTask)) {
      for (const candidateCommand of candidateTask) {
        appendTaskCommand(candidateCommand, null, out);
      }
      continue;
    }
    if (!isRecord(candidateTask)) continue;
    const task = candidateTask as RawTask;
    const taskDirectory = typeof task.dir === "string" ? task.dir : null;
    appendDynamicVariableCommands(task.vars, taskDirectory, out);
    appendDynamicVariableCommands(task.env, taskDirectory, out);
    appendExecutableString(task.if, taskDirectory, out);
    if (typeof task.cmd === "string") {
      out.push({ command: task.cmd, directory: taskDirectory });
    }
    if (Array.isArray(task.cmds)) {
      for (const candidateCommand of task.cmds) {
        appendTaskCommand(candidateCommand, taskDirectory, out);
      }
    }
    if (Array.isArray(task.status)) {
      for (const status of task.status) appendExecutableString(status, taskDirectory, out);
    }
    if (Array.isArray(task.preconditions)) {
      for (const precondition of task.preconditions) {
        if (typeof precondition === "string") {
          out.push({ command: precondition, directory: taskDirectory });
        } else if (isRecord(precondition)) {
          appendExecutableString((precondition as RawTaskPrecondition).sh, taskDirectory, out);
        }
      }
    }
  }
  return out;
}

function appendTaskCommand(candidate: unknown, directory: string | null, out: TaskCommand[]): void {
  if (typeof candidate === "string") {
    out.push({ command: candidate, directory });
    return;
  }
  if (!isRecord(candidate)) return;
  const command = candidate as RawTaskCommand;
  appendExecutableString(command.if, directory, out);
  appendExecutableString(command.cmd, directory, out);
  appendExecutableString(command.defer, directory, out);
}

function appendExecutableString(
  candidate: unknown,
  directory: string | null,
  out: TaskCommand[],
): void {
  if (typeof candidate === "string") out.push({ command: candidate, directory });
}

/** Accept only YAML string-valued `sh` commands; dynamic/template objects stay unresolved. */
function appendDynamicVariableCommands(
  variables: unknown,
  directory: string | null,
  out: TaskCommand[],
): void {
  if (!isRecord(variables)) return;
  for (const candidate of Object.values(variables)) {
    if (!isRecord(candidate)) continue;
    appendExecutableString((candidate as RawDynamicVariable).sh, directory, out);
  }
}

function dynamicVariableCommands(variables: unknown): string[] {
  const commands: TaskCommand[] = [];
  appendDynamicVariableCommands(variables, null, commands);
  return commands.map((command) => command.command);
}

function taskfileIncludes(parsed: unknown): TaskfileInclude[] {
  if (!isRecord(parsed)) return [];
  const includes = (parsed as RawTaskfile).includes;
  if (!isRecord(includes)) return [];
  const out: TaskfileInclude[] = [];
  for (const candidate of Object.values(includes)) {
    if (typeof candidate === "string") {
      out.push({ taskfile: candidate, directory: null, dynamicCommands: [] });
      continue;
    }
    if (!isRecord(candidate)) continue;
    const include = candidate as RawTaskInclude;
    if (typeof include.taskfile !== "string") continue;
    out.push({
      taskfile: include.taskfile,
      directory: typeof include.dir === "string" ? include.dir : null,
      dynamicCommands: dynamicVariableCommands(include.vars),
    });
  }
  return out;
}

function owningXcodeProjectDirectory(carrier: string): string | null {
  const directory = dirname(carrier);
  return basename(directory).toLowerCase().endsWith(".xcodeproj") ? dirname(directory) : null;
}

/** Expand only the two Xcode project-root variables whose value is certain. */
function expandNativeProjectVariables(
  command: string,
  hasKnownXcodeProjectDirectory: boolean,
): string {
  const knownVariable =
    /\$(?:\((?:PROJECT_DIR|SRCROOT)\)|\{(?:PROJECT_DIR|SRCROOT)\}|(?:PROJECT_DIR|SRCROOT)\b)/;
  if (knownVariable.test(command) && !hasKnownXcodeProjectDirectory) return command;
  return command.replace(
    /\$(?:\((PROJECT_DIR|SRCROOT)\)|\{(PROJECT_DIR|SRCROOT)\}|(PROJECT_DIR|SRCROOT)\b)/g,
    ".",
  );
}

function collectCommandRoots(
  command: string,
  projectRoot: string,
  workingDir: string,
  analyzedFiles: ReadonlySet<string>,
  reason: string,
  out: ConventionRoot[],
  seen: Set<string>,
  allowTaskRuntimeTemplates = false,
): void {
  for (const sourcePath of shellSourcePaths(command, allowTaskRuntimeTemplates)) {
    const commandWorkingDir =
      sourcePath.directory === null
        ? workingDir
        : boundedWorkingDirectory(projectRoot, workingDir, sourcePath.directory);
    if (commandWorkingDir === null) continue;
    const templateTargets = allowTaskRuntimeTemplates
      ? resolveTaskRuntimeTemplatePaths(
          sourcePath.path,
          projectRoot,
          commandWorkingDir,
          analyzedFiles,
        )
      : null;
    if (templateTargets !== null) {
      for (const target of templateTargets) {
        if (!sourcePath.direct || isExecutableSourceFile(projectRoot, target)) {
          addRoot(target, reason, out, seen);
        }
      }
      continue;
    }
    const target = resolveCommandSourcePath(
      sourcePath.path,
      projectRoot,
      commandWorkingDir,
      analyzedFiles,
    );
    if (target !== null && (!sourcePath.direct || isExecutableSourceFile(projectRoot, target))) {
      addRoot(target, reason, out, seen);
    }
  }
}

function addRoot(file: string, reason: string, out: ConventionRoot[], seen: Set<string>): void {
  if (seen.has(file)) return;
  seen.add(file);
  out.push({ file, reason });
}

function isExecutableSourceFile(projectRoot: string, file: string): boolean {
  const root = resolvePath(projectRoot);
  const absolute = resolvePath(root, file);
  if (absolute !== root && !absolute.startsWith(`${root}${sep}`)) return false;
  try {
    const info = lstatSync(absolute);
    return info.isFile() && !info.isSymbolicLink() && (info.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

interface PropertyExpression {
  readonly text: string;
  readonly start: number;
  readonly end: number;
  readonly valueStart: number;
}

/** Best-effort extraction of one object property's complete literal/call value. */
function propertyExpressions(source: string, key: string, baseOffset = 0): PropertyExpression[] {
  const out: PropertyExpression[] = [];
  const re = new RegExp(`\\b${key}\\s*:`, "g");
  let match: RegExpExecArray | null = re.exec(source);
  while (match !== null) {
    let start = match.index + match[0].length;
    while (/\s/.test(source[start] ?? "")) start += 1;
    const end = expressionEnd(source, start);
    if (end > start) {
      out.push({
        text: source.slice(start, end),
        start: baseOffset + match.index,
        end: baseOffset + end,
        valueStart: baseOffset + start,
      });
    }
    re.lastIndex = Math.max(re.lastIndex, end);
    match = re.exec(source);
  }
  return out;
}

function expressionEnd(source: string, start: number): number {
  const stack: string[] = [];
  let quote: string | null = null;
  let escaped = false;
  for (let i = start; i < source.length; i += 1) {
    const char = source[i] ?? "";
    if (quote !== null) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      quote = char;
      continue;
    }
    if (char === "(" || char === "[" || char === "{") {
      stack.push(char);
      continue;
    }
    if (char === ")" || char === "]" || char === "}") {
      if (stack.length === 0) return i;
      stack.pop();
      continue;
    }
    if (stack.length === 0 && (char === "," || char === "\n" || char === "\r")) return i;
  }
  return source.length;
}

function quotedValues(source: string): string[] {
  const out: string[] = [];
  const re = /(["'`])([^"'`\r\n]+)\1/g;
  let match: RegExpExecArray | null = re.exec(source);
  while (match !== null) {
    if (match[2] !== undefined) out.push(match[2]);
    match = re.exec(source);
  }
  return out;
}

function publicUrlTarget(
  unit: ConventionUnit,
  value: string,
  analyzedFiles: ReadonlySet<string>,
): string | null {
  const url = value.trim();
  if (!url.startsWith("/") || url.startsWith("//")) return null;
  const clean = stripQuery(url).replace(/^\/+/, "");
  if (clean === "") return null;
  const publicRoot = unit.rootRelDir === "" ? "public" : posix.join(unit.rootRelDir, "public");
  const packageRelative = posix.join(publicRoot, clean);
  if (packageRelative !== publicRoot && !packageRelative.startsWith(`${publicRoot}/`)) return null;
  const target = packageRelative;
  return analyzedFiles.has(target) ? target : null;
}

function browserPathTargets(
  value: string,
  projectRoot: string,
  unit: ConventionUnit,
  carrierDir: string,
  analyzedFiles: ReadonlySet<string>,
): string[] {
  const clean = stripQuery(value).trim();
  if (clean === "" || /^(?:[a-z][a-z0-9+.-]*:)?\/\//i.test(clean)) return [];
  const absolutes = (
    clean.startsWith("/")
      ? ["", "public"].map((prefix) => resolvePath(unit.dir, prefix, clean.replace(/^\/+/, "")))
      : [resolvePath(carrierDir, clean), resolvePath(unit.dir, clean)]
  ).filter((absolute) => isWithin(unit.dir, absolute));
  for (const absolute of absolutes) {
    const candidates = [
      absolute,
      ...SOURCE_EXTENSIONS.map((extension) => stripSourceExtension(absolute) + extension),
    ];
    for (const candidate of candidates) {
      const rel = toPosixRel(projectRoot, candidate);
      if (analyzedFiles.has(rel)) return [rel];
    }
  }
  return [];
}

function isWithin(root: string, target: string): boolean {
  const resolvedRoot = resolvePath(root);
  const resolvedTarget = resolvePath(target);
  return resolvedTarget === resolvedRoot || resolvedTarget.startsWith(`${resolvedRoot}${sep}`);
}

interface RawBrowserManifest {
  readonly manifest_version?: unknown;
  readonly background?: unknown;
  readonly content_scripts?: unknown;
}

interface RawBrowserBackground {
  readonly service_worker?: unknown;
  readonly scripts?: unknown;
}

interface RawBrowserContentScript {
  readonly js?: unknown;
}

function browserManifestScriptPaths(manifest: RawBrowserManifest): string[] {
  const out: string[] = [];
  const background = manifest.background;
  if (isRecord(background)) {
    const rawBackground = background as RawBrowserBackground;
    if (typeof rawBackground.service_worker === "string") out.push(rawBackground.service_worker);
    if (Array.isArray(rawBackground.scripts)) {
      out.push(
        ...rawBackground.scripts.filter((value): value is string => typeof value === "string"),
      );
    }
  }
  const contentScripts = manifest.content_scripts;
  if (Array.isArray(contentScripts)) {
    for (const entry of contentScripts) {
      if (!isRecord(entry)) continue;
      const contentScript = entry as RawBrowserContentScript;
      if (!Array.isArray(contentScript.js)) continue;
      out.push(...contentScript.js.filter((value): value is string => typeof value === "string"));
    }
  }
  return out;
}

function ownerUnitForAbsolute(
  units: readonly ConventionUnit[],
  absolute: string,
): ConventionUnit | null {
  const target = resolvePath(absolute);
  let owner: ConventionUnit | null = null;
  for (const unit of units) {
    const dir = resolvePath(unit.dir);
    if (target !== dir && !target.startsWith(`${dir}${sep}`)) continue;
    if (owner === null || dir.length > owner.dir.length) owner = unit;
  }
  return owner;
}

const CARRIER_EXCLUDED_DIRS = new Set(["node_modules", "dist", "cdk.out", ".git"]);

interface CarrierIgnoreContext {
  readonly dir: string;
  readonly matcher: Ignore;
}

async function findCarrierFiles(
  root: string,
  matches: (name: string) => boolean,
  useGitignore = true,
): Promise<string[]> {
  const out: string[] = [];
  const initial = useGitignore ? await initialIgnoreContexts(root) : [];
  const walk = async (dir: string, inherited: readonly CarrierIgnoreContext[]): Promise<void> => {
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    const contexts = useGitignore ? await appendIgnoreContext(inherited, dir) : inherited;
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (CARRIER_EXCLUDED_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
        if (useGitignore && isCarrierIgnored(full, true, contexts)) continue;
        await walk(full, contexts);
      } else if (entry.isFile() && matches(entry.name)) {
        if (useGitignore && isCarrierIgnored(full, false, contexts)) continue;
        out.push(full);
      }
    }
  };
  await walk(root, initial);
  return out.sort();
}

async function initialIgnoreContexts(root: string): Promise<CarrierIgnoreContext[]> {
  const paths = await ancestorGitignoreFiles(root);
  const rootIgnore = join(resolvePath(root), ".gitignore");
  if (!paths.includes(rootIgnore)) paths.push(rootIgnore);
  const contexts: CarrierIgnoreContext[] = [];
  for (const path of paths) {
    const context = await readIgnoreContext(path);
    if (context !== null) contexts.push(context);
  }
  return contexts;
}

async function ignoreContextsThrough(
  root: string,
  targetDir: string,
): Promise<CarrierIgnoreContext[]> {
  let contexts = await initialIgnoreContexts(root);
  const rel = relative(resolvePath(root), resolvePath(targetDir));
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return contexts;
  let current = resolvePath(root);
  for (const segment of rel.split(sep)) {
    current = join(current, segment);
    contexts = await appendIgnoreContext(contexts, current);
  }
  return contexts;
}

async function appendIgnoreContext(
  contexts: readonly CarrierIgnoreContext[],
  dir: string,
): Promise<CarrierIgnoreContext[]> {
  const resolvedDir = resolvePath(dir);
  if (contexts.some((context) => context.dir === resolvedDir)) return [...contexts];
  const context = await readIgnoreContext(join(resolvedDir, ".gitignore"));
  return context === null ? [...contexts] : [...contexts, context];
}

async function readIgnoreContext(path: string): Promise<CarrierIgnoreContext | null> {
  try {
    return {
      dir: dirname(path),
      matcher: ignore().add(await readFile(path, "utf8")),
    };
  } catch {
    return null;
  }
}

function isCarrierIgnored(
  absolutePath: string,
  directory: boolean,
  contexts: readonly CarrierIgnoreContext[],
): boolean {
  let ignored = false;
  for (const context of contexts) {
    const local = relative(context.dir, absolutePath).split(sep).join("/");
    if (local === "" || local.startsWith("../")) continue;
    const result = context.matcher.test(directory ? `${local}/` : local);
    if (result.ignored) ignored = true;
    else if (result.unignored) ignored = false;
  }
  return ignored;
}

interface EntryExpression {
  readonly start: number;
  readonly end: number;
  readonly value: string;
}

interface OxcProgramResult {
  readonly program: RawNode;
  readonly errors: readonly unknown[];
}

/**
 * Evaluate only path expressions whose value is statically certain. The
 * supported subset deliberately stops at literals, dirname primitives,
 * unique `const` bindings, and `path.join`/`path.resolve` calls. Any dynamic,
 * shadow-ambiguous, or unsupported value yields no edge.
 */
function cdkEntryExpressions(file: string, source: string, sourceDir: string): EntryExpression[] {
  let result: OxcProgramResult;
  try {
    const lang = /\.tsx$/i.test(file) ? "tsx" : /\.[cm]?ts$/i.test(file) ? "ts" : "js";
    result = parseSync(file, source, { lang }) as unknown as OxcProgramResult;
  } catch {
    return [];
  }
  if (result.errors.length > 0) return [];

  const out: EntryExpression[] = [];
  walkAst(result.program, (node, ancestors) => {
    if (node.type !== "NewExpression" || memberName(prop(node, "callee")) !== "NodejsFunction") {
      return;
    }
    const options = nodeArray(prop(node, "arguments"))[2];
    if (options?.type !== "ObjectExpression") return;
    for (const property of nodeArray(prop(options, "properties"))) {
      if (property.type !== "Property" || propertyName(prop(property, "key")) !== "entry") continue;
      const expression = prop(property, "value");
      if (!isNode(expression)) continue;
      const value = evaluatePathExpression(expression, {
        bindings: visibleConstBindings(ancestors, node.start),
        pathCalls: visiblePathCallBindings(ancestors),
        dirnameShadowed: isBindingShadowed(ancestors, "__dirname"),
        sourceDir,
        resolving: new Set(),
        depth: 0,
      });
      if (value !== null) out.push({ start: property.start, end: property.end, value });
    }
  });
  return out;
}

interface PathEvaluationContext {
  readonly bindings: ReadonlyMap<string, RawNode>;
  readonly pathCalls: PathCallBindings;
  readonly dirnameShadowed: boolean;
  readonly sourceDir: string;
  readonly resolving: ReadonlySet<string>;
  readonly depth: number;
}

function evaluatePathExpression(node: RawNode, context: PathEvaluationContext): string | null {
  if (context.depth > 16) return null;
  if (node.type === "Literal") {
    const value = prop(node, "value");
    return typeof value === "string" ? value : null;
  }
  if (node.type === "Identifier") {
    const name = str(node, "name");
    if (name === "__dirname") return context.dirnameShadowed ? null : context.sourceDir;
    if (name === undefined || context.resolving.has(name)) return null;
    const binding = context.bindings.get(name);
    if (binding === undefined) return null;
    return evaluatePathExpression(binding, {
      ...context,
      resolving: new Set([...context.resolving, name]),
      depth: context.depth + 1,
    });
  }
  if (isImportMetaDirname(node)) return context.sourceDir;
  if (
    node.type === "ParenthesizedExpression" ||
    node.type === "TSAsExpression" ||
    node.type === "TSSatisfiesExpression" ||
    node.type === "TSNonNullExpression"
  ) {
    const expression = prop(node, "expression");
    return isNode(expression)
      ? evaluatePathExpression(expression, { ...context, depth: context.depth + 1 })
      : null;
  }
  if (node.type !== "CallExpression") return null;
  const operation = pathOperation(prop(node, "callee"), context.pathCalls);
  if (operation === null) return null;
  const parts: string[] = [];
  for (const argument of nodeArray(prop(node, "arguments"))) {
    const part = evaluatePathExpression(argument, { ...context, depth: context.depth + 1 });
    if (part === null) return null;
    parts.push(part);
  }
  if (parts.length === 0) return null;
  if (operation === "join") return join(...parts);
  return parts.some((part) => isAbsolute(part)) ? resolvePath(...parts) : null;
}

function visibleConstBindings(
  ancestors: readonly RawNode[],
  targetStart: number,
): Map<string, RawNode> {
  const visible = new Map<string, RawNode>();
  for (const scope of ancestors) {
    for (const name of ancestorBindingNames(scope)) visible.delete(name);
    if (
      scope.type !== "Program" &&
      scope.type !== "BlockStatement" &&
      scope.type !== "TSModuleBlock"
    ) {
      continue;
    }
    const local = new Map<string, RawNode | null>();
    for (const statement of nodeArray(prop(scope, "body"))) {
      if (statement.type === "VariableDeclaration") {
        const constant = str(statement, "kind") === "const" && statement.end <= targetStart;
        for (const declaration of nodeArray(prop(statement, "declarations"))) {
          const id = prop(declaration, "id");
          const init = prop(declaration, "init");
          for (const name of bindingNames(id)) {
            const safeInitializer =
              constant && isNode(id) && id.type === "Identifier" && isNode(init) ? init : null;
            local.set(name, local.has(name) ? null : safeInitializer);
          }
        }
        continue;
      }
      for (const name of directDeclarationNames(statement)) {
        local.set(name, null);
      }
    }
    for (const [name, initializer] of local) {
      if (initializer === null) visible.delete(name);
      else visible.set(name, initializer);
    }
  }
  return visible;
}

type PathOperation = "join" | "resolve";

interface PathCallBindings {
  readonly namespaces: ReadonlySet<string>;
  readonly operations: ReadonlyMap<string, PathOperation>;
}

/** Node path imports still visible at the construct site, after nearer shadows. */
function visiblePathCallBindings(ancestors: readonly RawNode[]): PathCallBindings {
  const namespaces = new Set<string>();
  const operations = new Map<string, PathOperation>();
  const program = ancestors.find((ancestor) => ancestor.type === "Program");
  if (program !== undefined) {
    for (const statement of nodeArray(prop(program, "body"))) {
      if (statement.type !== "ImportDeclaration") continue;
      const source = prop(statement, "source");
      if (
        !isNode(source) ||
        (prop(source, "value") !== "node:path" && prop(source, "value") !== "path")
      ) {
        continue;
      }
      for (const specifier of nodeArray(prop(statement, "specifiers"))) {
        const local = prop(specifier, "local");
        const localName = isNode(local) ? str(local, "name") : undefined;
        if (localName === undefined) continue;
        if (
          specifier.type === "ImportNamespaceSpecifier" ||
          specifier.type === "ImportDefaultSpecifier"
        ) {
          namespaces.add(localName);
          continue;
        }
        if (specifier.type !== "ImportSpecifier") continue;
        const imported = propertyName(prop(specifier, "imported"));
        if (imported === "join" || imported === "resolve") operations.set(localName, imported);
      }
    }
  }

  // The Program import itself establishes the binding. Every declaration in a
  // nearer lexical/function scope invalidates it; guessing through a shadow is
  // exactly the false keep-alive this bounded evaluator must avoid.
  for (const scope of ancestors) {
    if (scope.type === "Program") continue;
    const shadows = new Set(ancestorBindingNames(scope));
    if (scope.type === "BlockStatement" || scope.type === "TSModuleBlock") {
      for (const statement of nodeArray(prop(scope, "body"))) {
        if (statement.type === "VariableDeclaration") {
          for (const declaration of nodeArray(prop(statement, "declarations"))) {
            for (const name of bindingNames(prop(declaration, "id"))) shadows.add(name);
          }
        } else {
          for (const name of directDeclarationNames(statement)) shadows.add(name);
        }
      }
    }
    for (const name of shadows) {
      namespaces.delete(name);
      operations.delete(name);
    }
  }
  return { namespaces, operations };
}

function pathOperation(value: unknown, bindings: PathCallBindings): PathOperation | null {
  if (!isNode(value)) return null;
  if (value.type === "Identifier") {
    const name = str(value, "name");
    return name === undefined ? null : (bindings.operations.get(name) ?? null);
  }
  if (value.type !== "MemberExpression") return null;
  const operation = propertyName(prop(value, "property"));
  if (operation !== "join" && operation !== "resolve") return null;
  const object = prop(value, "object");
  const objectName =
    isNode(object) && object.type === "Identifier" ? str(object, "name") : undefined;
  return objectName !== undefined && bindings.namespaces.has(objectName) ? operation : null;
}

function ancestorBindingNames(node: RawNode): string[] {
  if (node.type === "Program" || node.type === "TSModuleBlock") {
    return varScopeBindingNames(node);
  }
  if (
    node.type === "FunctionDeclaration" ||
    node.type === "FunctionExpression" ||
    node.type === "ArrowFunctionExpression"
  ) {
    return [
      ...nodeArray(prop(node, "params")).flatMap(bindingNames),
      ...varScopeBindingNames(node),
    ];
  }
  if (node.type === "CatchClause") return bindingNames(prop(node, "param"));
  if (
    node.type === "ForStatement" ||
    node.type === "ForInStatement" ||
    node.type === "ForOfStatement"
  ) {
    const init = prop(node, node.type === "ForStatement" ? "init" : "left");
    if (isNode(init) && init.type === "VariableDeclaration") {
      return nodeArray(prop(init, "declarations")).flatMap((declaration) =>
        bindingNames(prop(declaration, "id")),
      );
    }
  }
  return [];
}

/**
 * `var` is scoped to its containing function or Program even when declared
 * inside a nested block/loop. Walk that var-scope body, but never cross into a
 * nested function, class, or TypeScript namespace whose declarations have a
 * different scope.
 */
function varScopeBindingNames(scope: RawNode): string[] {
  const out = new Set<string>();
  const body =
    scope.type === "Program" || scope.type === "TSModuleBlock" ? scope : prop(scope, "body");
  if (!isNode(body)) return [];

  const visit = (node: RawNode, root: boolean): void => {
    if (
      !root &&
      (node.type === "FunctionDeclaration" ||
        node.type === "FunctionExpression" ||
        node.type === "ArrowFunctionExpression" ||
        node.type === "ClassDeclaration" ||
        node.type === "ClassExpression" ||
        node.type === "StaticBlock" ||
        node.type === "TSModuleDeclaration" ||
        node.type === "TSModuleBlock")
    ) {
      return;
    }
    if (node.type === "VariableDeclaration" && str(node, "kind") === "var") {
      for (const declaration of nodeArray(prop(node, "declarations"))) {
        for (const name of bindingNames(prop(declaration, "id"))) out.add(name);
      }
    }
    for (const key of keys(node)) {
      if (key === "type" || key === "start" || key === "end") continue;
      const child = prop(node, key);
      if (isNode(child)) visit(child, false);
      else for (const item of nodeArray(child)) visit(item, false);
    }
  };
  visit(body, true);
  return [...out];
}

function directDeclarationNames(node: RawNode): string[] {
  if (node.type === "ImportDeclaration") {
    return nodeArray(prop(node, "specifiers")).flatMap((specifier) =>
      bindingNames(prop(specifier, "local")),
    );
  }
  if (node.type === "FunctionDeclaration" || node.type === "ClassDeclaration") {
    return bindingNames(prop(node, "id"));
  }
  if (node.type === "TSModuleDeclaration") return bindingNames(prop(node, "id"));
  return [];
}

function isBindingShadowed(ancestors: readonly RawNode[], target: string): boolean {
  for (const scope of ancestors) {
    if (ancestorBindingNames(scope).includes(target)) return true;
    if (
      scope.type !== "Program" &&
      scope.type !== "BlockStatement" &&
      scope.type !== "TSModuleBlock"
    ) {
      continue;
    }
    for (const statement of nodeArray(prop(scope, "body"))) {
      if (statement.type === "VariableDeclaration") {
        for (const declaration of nodeArray(prop(statement, "declarations"))) {
          if (bindingNames(prop(declaration, "id")).includes(target)) return true;
        }
      } else if (directDeclarationNames(statement).includes(target)) {
        return true;
      }
    }
  }
  return false;
}

function bindingNames(value: unknown): string[] {
  if (!isNode(value)) return [];
  if (value.type === "Identifier") {
    const name = str(value, "name");
    return name === undefined ? [] : [name];
  }
  if (value.type === "RestElement" || value.type === "AssignmentPattern") {
    return bindingNames(prop(value, value.type === "AssignmentPattern" ? "left" : "argument"));
  }
  if (value.type === "TSParameterProperty") {
    return bindingNames(prop(value, "parameter"));
  }
  if (value.type === "ArrayPattern") {
    return nodeArray(prop(value, "elements")).flatMap(bindingNames);
  }
  if (value.type === "ObjectPattern") {
    return nodeArray(prop(value, "properties")).flatMap((property) =>
      property.type === "Property"
        ? bindingNames(prop(property, "value"))
        : bindingNames(prop(property, "argument")),
    );
  }
  return [];
}

function isImportMetaDirname(node: RawNode): boolean {
  if (node.type !== "MemberExpression" || memberName(node) !== "dirname") return false;
  const object = prop(node, "object");
  if (!isNode(object)) return false;
  if (object.type === "MetaProperty") {
    return (
      propertyName(prop(object, "meta")) === "import" &&
      propertyName(prop(object, "property")) === "meta"
    );
  }
  if (object.type !== "MemberExpression" || memberName(object) !== "meta") return false;
  const meta = prop(object, "object");
  return isNode(meta) && meta.type === "MetaProperty";
}

function memberName(value: unknown): string | null {
  if (!isNode(value)) return null;
  if (value.type === "Identifier") return str(value, "name") ?? null;
  if (value.type !== "MemberExpression") return null;
  return propertyName(prop(value, "property"));
}

function propertyName(value: unknown): string | null {
  if (!isNode(value)) return null;
  if (value.type === "Identifier") return str(value, "name") ?? null;
  if (value.type === "Literal") {
    const literal = prop(value, "value");
    return typeof literal === "string" ? literal : null;
  }
  return null;
}

function walkAst(
  node: RawNode,
  visit: (node: RawNode, ancestors: readonly RawNode[]) => void,
  ancestors: readonly RawNode[] = [],
): void {
  visit(node, ancestors);
  const childAncestors = [...ancestors, node];
  for (const key of keys(node)) {
    if (key === "type" || key === "start" || key === "end") continue;
    const child = prop(node, key);
    if (isNode(child)) walkAst(child, visit, childAncestors);
    else for (const item of nodeArray(child)) walkAst(item, visit, childAncestors);
  }
}

function stripQuery(value: string): string {
  return value.split(/[?#]/)[0] ?? "";
}

function resolveEvaluatedSourcePath(
  value: string,
  projectRoot: string,
  sourceDir: string,
  analyzedFiles: ReadonlySet<string>,
): string | null {
  // AWS NodejsFunction evaluates a relative `entry` from the JS/TS source file
  // that instantiates the construct, not from the package or process root.
  const absolute = isAbsolute(value) ? value : resolvePath(sourceDir, value);
  for (const candidate of sourceCandidates(absolute)) {
    const rel = toPosixRel(projectRoot, candidate);
    if (analyzedFiles.has(rel)) return rel;
  }
  return null;
}

/** Try the repository, package, and declaring-file bases, then extension remaps. */
function resolveSourcePath(
  value: string,
  projectRoot: string,
  packageDir: string,
  sourceDir: string,
  analyzedFiles: ReadonlySet<string>,
): string | null {
  const clean = stripQuery(value)
    .trim()
    .replace(/^['"]|['"]$/g, "");
  if (clean === "" || /^(?:[a-z][a-z0-9+.-]*:)?\/\//i.test(clean)) return null;
  const bases = clean.startsWith("/") ? [projectRoot] : [sourceDir, packageDir, projectRoot];
  const relativeTarget = clean.startsWith("/") ? clean.replace(/^\/+/, "") : clean;
  for (const base of bases) {
    const absolute = resolvePath(base, relativeTarget);
    for (const candidate of sourceCandidates(absolute)) {
      const rel = toPosixRel(projectRoot, candidate);
      if (analyzedFiles.has(rel)) return rel;
    }
  }
  return null;
}

function resolveCommandSourcePath(
  value: string,
  projectRoot: string,
  workingDir: string,
  analyzedFiles: ReadonlySet<string>,
): string | null {
  const clean = stripQuery(value)
    .trim()
    .replace(/^['"]|['"]$/g, "");
  if (clean === "" || isAbsolute(clean) || /^(?:[a-z][a-z0-9+.-]*:)?\/\//i.test(clean)) {
    return null;
  }
  for (const candidate of sourceCandidates(resolvePath(workingDir, clean))) {
    const rel = toPosixRel(projectRoot, candidate);
    if (analyzedFiles.has(rel)) return rel;
  }
  return null;
}

/**
 * Expand a bounded Task runtime template against analyzed files only. Each
 * placeholder occupies one path segment fragment (`[^/]+`), and both a literal
 * prefix and suffix are required so a bare variable cannot root a whole tree.
 */
function resolveTaskRuntimeTemplatePaths(
  value: string,
  projectRoot: string,
  workingDir: string,
  analyzedFiles: ReadonlySet<string>,
): string[] | null {
  const pattern = taskRuntimeTemplatePattern(value);
  if (pattern === null) return null;
  const root = resolvePath(projectRoot);
  const out: string[] = [];
  for (const file of [...analyzedFiles].sort()) {
    const absolute = resolvePath(root, file);
    if (absolute !== root && !absolute.startsWith(`${root}${sep}`)) continue;
    const fromWorkingDirectory = relative(workingDir, absolute);
    if (fromWorkingDirectory === "" || isAbsolute(fromWorkingDirectory)) continue;
    if (pattern.test(fromWorkingDirectory.split(sep).join("/"))) out.push(file);
  }
  return out;
}

function taskRuntimeTemplatePattern(value: string): RegExp | null {
  const normalized = value.trim().replace(/\\/gu, "/").replace(/^\.\//u, "");
  if (
    normalized === "" ||
    isAbsolute(normalized) ||
    /^(?:[a-z][a-z0-9+.-]*:)?\/\//iu.test(normalized)
  ) {
    return null;
  }
  const placeholders = [...normalized.matchAll(/\{\{[^{}]+\}\}/gu)];
  if (placeholders.length === 0) return null;
  const first = placeholders[0];
  const last = placeholders.at(-1);
  if (first?.index === undefined || last?.index === undefined) return null;
  const prefix = normalized.slice(0, first.index);
  const suffix = normalized.slice(last.index + last[0].length);
  const meaningfulLiteral = (part: string): boolean => /[A-Za-z0-9]/u.test(part);
  if (!meaningfulLiteral(prefix) || !meaningfulLiteral(suffix)) return null;
  const concreteShape = normalized.replace(/\{\{[^{}]+\}\}/gu, "x");
  if (
    concreteShape.includes("{{") ||
    concreteShape.includes("}}") ||
    !isShellSourcePath(concreteShape)
  ) {
    return null;
  }
  const escaped = normalized
    .split(/\{\{[^{}]+\}\}/gu)
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"));
  const classes = placeholders.map((placeholder) =>
    placeholder[0].includes("__unused_task_quoted__") ? "[^/]+" : "[A-Za-z0-9_@.+-]+",
  );
  let expression = escaped[0] ?? "";
  for (let index = 0; index < classes.length; index += 1) {
    expression += `${classes[index] ?? ""}${escaped[index + 1] ?? ""}`;
  }
  return new RegExp(`^${expression}$`, "u");
}

function sourceCandidates(absolute: string): string[] {
  return [absolute, ...SOURCE_EXTENSIONS.map((ext) => stripSourceExtension(absolute) + ext)];
}

function stripSourceExtension(value: string): string {
  const lower = value.toLowerCase();
  for (const extension of SOURCE_EXTENSIONS) {
    if (lower.endsWith(extension)) return value.slice(0, -extension.length);
  }
  return value;
}

interface WorkflowRunStep {
  readonly run: string;
  readonly workingDirectory: string | null;
}

interface RawWorkflow {
  readonly defaults?: unknown;
  readonly jobs?: unknown;
}

interface RawWorkflowJob {
  readonly defaults?: unknown;
  readonly steps?: unknown;
}

interface RawWorkflowStep {
  readonly run?: unknown;
  readonly "working-directory"?: unknown;
}

interface RawDefaults {
  readonly run?: unknown;
}

interface RawRunDefaults {
  readonly "working-directory"?: unknown;
}

function workflowRunSteps(parsed: unknown): WorkflowRunStep[] {
  if (!isRecord(parsed)) return [];
  const workflow = parsed as RawWorkflow;
  const workflowDirectory = defaultsWorkingDirectory(workflow.defaults);
  if (!isRecord(workflow.jobs)) return [];
  const out: WorkflowRunStep[] = [];
  for (const candidateJob of Object.values(workflow.jobs)) {
    if (!isRecord(candidateJob)) continue;
    const job = candidateJob as RawWorkflowJob;
    if (!Array.isArray(job.steps)) continue;
    const jobDirectory = defaultsWorkingDirectory(job.defaults) ?? workflowDirectory;
    for (const candidateStep of job.steps) {
      if (!isRecord(candidateStep)) continue;
      const step = candidateStep as RawWorkflowStep;
      if (typeof step.run !== "string") continue;
      out.push({
        run: step.run,
        workingDirectory:
          typeof step["working-directory"] === "string" ? step["working-directory"] : jobDirectory,
      });
    }
  }
  return out;
}

function defaultsWorkingDirectory(value: unknown): string | null {
  if (!isRecord(value)) return null;
  const defaults = value as RawDefaults;
  if (!isRecord(defaults.run)) return null;
  const directory = (defaults.run as RawRunDefaults)["working-directory"];
  return typeof directory === "string" ? directory : null;
}

function safeWorkingDirectory(projectRoot: string, configured: string | null): string | null {
  if (configured === null) return projectRoot;
  if (configured.includes("${{")) return null;
  const absolute = resolvePath(projectRoot, configured);
  const root = resolvePath(projectRoot);
  return absolute === root || absolute.startsWith(`${root}${sep}`) ? absolute : null;
}

function boundedWorkingDirectory(
  projectRoot: string,
  baseDirectory: string,
  configured: string | null,
): string | null {
  if (configured === null) return baseDirectory;
  if (configured.includes("{{")) return null;
  const absolute = resolvePath(baseDirectory, configured);
  const root = resolvePath(projectRoot);
  return absolute === root || absolute.startsWith(`${root}${sep}`) ? absolute : null;
}

async function resolveLocalIncludedTaskfile(
  projectRoot: string,
  includingTaskfile: string,
  configured: string,
  useGitignore: boolean,
): Promise<string | null> {
  const clean = configured.trim();
  if (
    clean === "" ||
    clean.includes("{{") ||
    clean.startsWith("~") ||
    /^(?:[a-z][a-z0-9+.-]*:)?\/\//i.test(clean)
  ) {
    return null;
  }
  const target = isAbsolute(clean)
    ? resolvePath(clean)
    : resolvePath(dirname(includingTaskfile), clean);
  if (!isWithin(projectRoot, target)) return null;

  let info: Awaited<ReturnType<typeof lstat>>;
  try {
    info = await lstat(target);
  } catch {
    return null;
  }
  if (info.isSymbolicLink()) return null;
  if (info.isFile()) {
    return (await isAllowedCarrierPath(projectRoot, target, useGitignore)) ? target : null;
  }
  if (!info.isDirectory()) return null;
  for (const name of TASKFILE_DIRECTORY_NAMES) {
    const candidate = join(target, name);
    try {
      const candidateInfo = await lstat(candidate);
      if (
        !candidateInfo.isSymbolicLink() &&
        candidateInfo.isFile() &&
        (await isAllowedCarrierPath(projectRoot, candidate, useGitignore))
      ) {
        return candidate;
      }
    } catch {
      // Try the next official Taskfile basename.
    }
  }
  return null;
}

async function isAllowedCarrierPath(
  projectRoot: string,
  target: string,
  useGitignore: boolean,
): Promise<boolean> {
  const root = resolvePath(projectRoot);
  const absolute = resolvePath(target);
  if (!isWithin(root, absolute)) return false;
  try {
    const [realRoot, realTarget] = await Promise.all([realpath(root), realpath(absolute)]);
    if (!isWithin(realRoot, realTarget)) return false;
  } catch {
    return false;
  }
  if (!useGitignore) return true;

  const rel = relative(root, absolute);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return false;
  let contexts = await initialIgnoreContexts(root);
  let current = root;
  const parts = rel.split(sep);
  for (const part of parts.slice(0, -1)) {
    current = join(current, part);
    if (isCarrierIgnored(current, true, contexts)) return false;
    contexts = await appendIgnoreContext(contexts, current);
  }
  return !isCarrierIgnored(absolute, false, contexts);
}

interface ShellSourcePath {
  readonly path: string;
  readonly directory: string | null;
  readonly direct: boolean;
}

function shellSourcePaths(run: string, allowTaskRuntimeTemplates = false): ShellSourcePath[] {
  const out: ShellSourcePath[] = [];
  const protectedTemplates = allowTaskRuntimeTemplates
    ? protectTaskRuntimeTemplates(run)
    : { source: run, replacements: new Map<string, string>() };
  for (const rawTokens of shellCommandTokens(protectedTemplates.source)) {
    const tokens = rawTokens.map((token) =>
      restoreTaskRuntimeTemplates(token, protectedTemplates.replacements),
    );
    const invocation = shellCommandInvocation(tokens);
    if (invocation === null) continue;
    const { cursor, directory } = invocation;

    const command = shellCommandName(tokens[cursor] ?? "");
    if (command === "node" || command === "nodejs") {
      out.push(
        ...nodeCommandSourcePaths(tokens, cursor + 1, allowTaskRuntimeTemplates).map((path) => ({
          path,
          directory,
          direct: false,
        })),
      );
    } else if (command === "k6" && tokens[cursor + 1] === "run") {
      const entry = k6RunSourcePath(tokens, cursor + 2, allowTaskRuntimeTemplates);
      if (entry !== null) out.push({ path: entry, directory, direct: false });
    } else {
      const direct = tokens[cursor] ?? "";
      if (direct.includes("/") && isExecutableShellSourcePath(direct, allowTaskRuntimeTemplates)) {
        out.push({ path: direct, directory, direct: true });
      }
    }
  }
  return out;
}

interface ProtectedTaskTemplates {
  readonly source: string;
  readonly replacements: ReadonlyMap<string, string>;
}

/** Keep a Go-template directive atomic while the surrounding shell is tokenized. */
function protectTaskRuntimeTemplates(source: string): ProtectedTaskTemplates {
  const replacements = new Map<string, string>();
  let out = "";
  let quote: string | null = null;
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    if (source.startsWith("{{", index)) {
      const end = source.indexOf("}}", index + 2);
      if (end >= 0 && source.slice(index + 2, end).trim() !== "") {
        const marker = `__UNUSED_TASK_TEMPLATE_${replacements.size}__`;
        const directive = source.slice(index + 2, end).trim();
        replacements.set(
          marker,
          directive === ".CLI_ARGS"
            ? "{{__unused_task_cli_args__}}"
            : quote === null
              ? "{{__unused_task_unquoted__}}"
              : "{{__unused_task_quoted__}}",
        );
        out += marker;
        index = end + 1;
        escaped = false;
        continue;
      }
    }
    const char = source[index] ?? "";
    out += char;
    if (escaped) {
      escaped = false;
    } else if (char === "\\" && quote !== "'") {
      escaped = true;
    } else if (quote !== null && char === quote) {
      quote = null;
    } else if (quote === null && (char === '"' || char === "'")) {
      quote = char;
    }
  }
  return { source: out, replacements };
}

function restoreTaskRuntimeTemplates(
  token: string,
  replacements: ReadonlyMap<string, string>,
): string {
  let restored = token;
  for (const [marker, replacement] of replacements)
    restored = restored.replaceAll(marker, replacement);
  return restored;
}

function shellCommandInvocation(
  tokens: readonly string[],
): { readonly cursor: number; readonly directory: string | null } | null {
  let cursor = 0;
  let directory: string | null = null;
  while (/^[A-Za-z_][A-Za-z0-9_]*=/u.test(tokens[cursor] ?? "")) cursor += 1;
  while (tokens[cursor] === "exec" || tokens[cursor] === "command") cursor += 1;
  if (shellCommandName(tokens[cursor] ?? "") !== "env") return { cursor, directory };

  cursor += 1;
  while (cursor < tokens.length) {
    const token = tokens[cursor] ?? "";
    if (/^[A-Za-z_][A-Za-z0-9_]*=/u.test(token)) {
      cursor += 1;
      continue;
    }
    if (token === "--") {
      cursor += 1;
      break;
    }
    if (
      token === "-i" ||
      token === "--ignore-environment" ||
      token === "-0" ||
      token === "--null"
    ) {
      cursor += 1;
      continue;
    }
    if (token === "-u" || token === "--unset") {
      if (tokens[cursor + 1] === undefined) return null;
      cursor += 2;
      continue;
    }
    if ((token.startsWith("-u") && token.length > 2) || token.startsWith("--unset=")) {
      cursor += 1;
      continue;
    }
    if (token === "-C" || token === "--chdir") {
      const value = tokens[cursor + 1];
      if (value === undefined) return null;
      directory = value;
      cursor += 2;
      continue;
    }
    if (token.startsWith("--chdir=")) {
      directory = token.slice("--chdir=".length);
      cursor += 1;
      continue;
    }
    if (token.startsWith("-C") && token.length > 2) {
      directory = token.slice(2);
      cursor += 1;
      continue;
    }
    if (token.startsWith("-")) return null;
    break;
  }
  return { cursor, directory };
}

const NODE_EXECUTED_VALUE_OPTIONS = new Set([
  "-r",
  "--require",
  "--import",
  "--loader",
  "--experimental-loader",
]);
const NODE_NON_EXECUTING_VALUE_OPTIONS = new Set([
  "--conditions",
  "--diagnostic-dir",
  "--icu-data-dir",
  "--max-http-header-size",
  "--redirect-warnings",
  "--report-directory",
  "--report-filename",
  "--title",
]);
const NODE_FLAG_OPTIONS = new Set([
  "--enable-source-maps",
  "--no-warnings",
  "--preserve-symlinks",
  "--preserve-symlinks-main",
  "--trace-warnings",
  "--watch",
]);
const NODE_NO_ENTRY_OPTIONS = new Set(["-c", "--check", "-e", "--eval", "-p", "--print"]);

function nodeCommandSourcePaths(
  tokens: readonly string[],
  start: number,
  allowTaskRuntimeTemplates = false,
): string[] {
  const out: string[] = [];
  for (let cursor = start; cursor < tokens.length; cursor += 1) {
    const token = tokens[cursor] ?? "";
    if (isTaskCliArgs(token)) continue;
    if (token === "--") {
      const entry = tokens[cursor + 1] ?? "";
      if (isExecutableShellSourcePath(entry, allowTaskRuntimeTemplates)) out.push(entry);
      return out;
    }
    if (NODE_NO_ENTRY_OPTIONS.has(token)) return out;
    const noEntryWithValue = [...NODE_NO_ENTRY_OPTIONS].find((option) =>
      token.startsWith(`${option}=`),
    );
    if (noEntryWithValue !== undefined) return out;
    const executedEqualsOption = [...NODE_EXECUTED_VALUE_OPTIONS].find((option) =>
      token.startsWith(`${option}=`),
    );
    if (executedEqualsOption !== undefined) {
      const executed = token.slice(executedEqualsOption.length + 1);
      if (isExecutableShellSourcePath(executed, allowTaskRuntimeTemplates)) out.push(executed);
      continue;
    }
    if (token.startsWith("-r") && token.length > 2) {
      const executed = token.slice(2).replace(/^=/u, "");
      if (isExecutableShellSourcePath(executed, allowTaskRuntimeTemplates)) out.push(executed);
      continue;
    }
    if (NODE_EXECUTED_VALUE_OPTIONS.has(token)) {
      const executed = tokens[cursor + 1] ?? "";
      if (isExecutableShellSourcePath(executed, allowTaskRuntimeTemplates)) out.push(executed);
      cursor += 1;
      continue;
    }
    if (NODE_NON_EXECUTING_VALUE_OPTIONS.has(token)) {
      cursor += 1;
      continue;
    }
    if (NODE_FLAG_OPTIONS.has(token) || token.startsWith("--inspect")) continue;
    // Unknown options are not guessed through: their next token may be an
    // option value rather than the executed entrypoint.
    if (token.startsWith("-")) return out;
    if (isExecutableShellSourcePath(token, allowTaskRuntimeTemplates)) out.push(token);
    return out;
  }
  return out;
}

const K6_VALUE_OPTIONS = new Set([
  "-d",
  "--duration",
  "-e",
  "--env",
  "-i",
  "--iterations",
  "-o",
  "--out",
  "-s",
  "--stage",
  "-u",
  "--vus",
  "--address",
  "--compatibility-mode",
  "--config",
  "--console-output",
  "--execution-segment",
  "--execution-segment-sequence",
  "--http-debug",
  "--log-format",
  "--log-output",
  "--max-redirects",
  "--min-iteration-duration",
  "--rps",
  "--setup-timeout",
  "--summary-export",
  "--summary-mode",
  "--summary-time-unit",
  "--tag",
  "--teardown-timeout",
  "--user-agent",
]);
const K6_FLAG_OPTIONS = new Set([
  "--discard-response-bodies",
  "--linger",
  "--no-color",
  "--no-connection-reuse",
  "--no-thresholds",
  "--no-usage-report",
  "--paused",
  "--quiet",
  "--throw",
]);

function k6RunSourcePath(
  tokens: readonly string[],
  start: number,
  allowTaskRuntimeTemplates = false,
): string | null {
  for (let cursor = start; cursor < tokens.length; cursor += 1) {
    const token = tokens[cursor] ?? "";
    if (isTaskCliArgs(token)) continue;
    if (token === "--") {
      const entry = tokens[cursor + 1] ?? "";
      return isExecutableShellSourcePath(entry, allowTaskRuntimeTemplates) ? entry : null;
    }
    if (K6_FLAG_OPTIONS.has(token)) continue;
    if (K6_VALUE_OPTIONS.has(token)) {
      if (tokens[cursor + 1] === undefined) return null;
      cursor += 1;
      continue;
    }
    if ([...K6_VALUE_OPTIONS].some((option) => token.startsWith(`${option}=`))) continue;
    if (/^-[deiosu].+/u.test(token)) continue;
    if (token.startsWith("-")) return null;
    return isExecutableShellSourcePath(token, allowTaskRuntimeTemplates) ? token : null;
  }
  return null;
}

function shellCommandTokens(source: string): string[][] {
  const commands: string[][] = [];
  let tokens: string[] = [];
  let token = "";
  let quote: string | null = null;

  const flushToken = (): void => {
    if (token !== "") tokens.push(token);
    token = "";
  };
  const flushCommand = (): void => {
    flushToken();
    if (tokens.length > 0) commands.push(tokens);
    tokens = [];
  };

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index] ?? "";
    if (quote !== null) {
      if (char === "\\" && source[index + 1] !== undefined) {
        token += source[index + 1];
        index += 1;
      } else if (quote !== "'" && source.startsWith("$(", index)) {
        const end = shellDollarSubstitutionEnd(source, index + 1);
        if (end === null) token += char;
        else {
          commands.push(...shellCommandTokens(source.slice(index + 2, end)));
          token += "__command_substitution__";
          index = end;
        }
      } else if (quote !== "'" && char === "`") {
        const end = shellBacktickEnd(source, index);
        if (end === null) token += char;
        else {
          commands.push(...shellCommandTokens(source.slice(index + 1, end)));
          token += "__command_substitution__";
          index = end;
        }
      } else if (char === quote) quote = null;
      else token += char;
      continue;
    }
    if (char === "\\" && source[index + 1] !== undefined) {
      if (source[index + 1] === "\r" && source[index + 2] === "\n") index += 2;
      else if (source[index + 1] === "\n" || source[index + 1] === "\r") index += 1;
      else {
        token += source[index + 1];
        index += 1;
      }
      continue;
    }
    if (source.startsWith("$(", index)) {
      const end = shellDollarSubstitutionEnd(source, index + 1);
      if (end === null) token += char;
      else {
        commands.push(...shellCommandTokens(source.slice(index + 2, end)));
        token += "__command_substitution__";
        index = end;
      }
      continue;
    }
    if (char === "`") {
      const end = shellBacktickEnd(source, index);
      if (end === null) token += char;
      else {
        commands.push(...shellCommandTokens(source.slice(index + 1, end)));
        token += "__command_substitution__";
        index = end;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === "#" && token === "") {
      flushCommand();
      const newline = source.indexOf("\n", index);
      index = newline < 0 ? source.length : newline;
      continue;
    }
    if (/\s/u.test(char)) {
      if (char === "\n" || char === "\r") flushCommand();
      else flushToken();
      continue;
    }
    if (char === ";" || char === "&" || char === "|" || char === "(" || char === ")") {
      flushCommand();
      if ((char === "&" || char === "|") && source[index + 1] === char) index += 1;
      continue;
    }
    token += char;
  }
  flushCommand();
  return commands;
}

function shellBacktickEnd(source: string, start: number): number | null {
  for (let index = start + 1; index < source.length; index += 1) {
    if (source[index] === "\\") index += 1;
    else if (source[index] === "`") return index;
  }
  return null;
}

function shellDollarSubstitutionEnd(source: string, openParen: number): number | null {
  let depth = 1;
  let quote: string | null = null;
  for (let index = openParen + 1; index < source.length; index += 1) {
    const char = source[index] ?? "";
    if (char === "\\") {
      index += 1;
      continue;
    }
    if (quote !== null) {
      if (quote !== "'" && char === "`") {
        const end = shellBacktickEnd(source, index);
        if (end !== null) index = end;
      } else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === "`") {
      const end = shellBacktickEnd(source, index);
      if (end !== null) index = end;
      continue;
    }
    if (source.startsWith("$(", index)) {
      depth += 1;
      index += 1;
    } else if (char === "(") depth += 1;
    else if (char === ")" && --depth === 0) return index;
  }
  return null;
}

function shellCommandName(token: string): string {
  return token.replace(/\\/gu, "/").split("/").pop()?.toLowerCase() ?? "";
}

function isShellSourcePath(token: string): boolean {
  return /^(?:\.{0,2}\/)?(?:[A-Za-z0-9_@.-]+\/)*[A-Za-z0-9_@.-]+\.(?:[cm]?[tj]sx?)$/iu.test(token);
}

function isExecutableShellSourcePath(token: string, allowTaskRuntimeTemplates: boolean): boolean {
  return (
    isShellSourcePath(token) ||
    (allowTaskRuntimeTemplates && taskRuntimeTemplatePattern(token) !== null)
  );
}

function isTaskCliArgs(token: string): boolean {
  return token === "{{__unused_task_cli_args__}}";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function toPosixRel(root: string, absolute: string): string {
  return relative(root, absolute).split(sep).join("/");
}
