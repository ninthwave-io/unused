/** Stable Cargo/rustc Rust frontend (ADR 0013, P3). */

import { readFileSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import {
  computePartitionedReachability,
  emitClaims,
  evaluateHazards,
  type HazardEvaluation,
  type PartitionedReachability,
} from "../../core/analysis/index.js";
import {
  type Claim,
  computeSummary,
  type Provenance,
  SCHEMA_VERSION,
} from "../../core/claims/index.js";
import { entrypointId, fileId, IRGraph, symbolId } from "../../core/ir/index.js";
import { createFrontendConfigContribution } from "../config-projection.js";
import {
  applyConfigSymbolEntrypoints,
  graphSymbolLanguages,
} from "../config-symbol-entrypoints.js";
import {
  claimAnnotationKey,
  collectFrontendClaimAnnotations,
} from "../plugins/claim-annotations.js";
import type { FrontendClaimInputs, FrontendLocalGraph } from "../plugins/types.js";
import type { AnalyzeInternalOptions, AnalyzeOptions, AnalyzeResult } from "../ts/analyze.js";
import {
  applyConfigSuppressions,
  assertUnambiguousWorkspaceKeys,
  collectConfigEntrypoints,
  computeConfigHash,
  isClaimable,
  loadConfig,
  warnOnEmptyConfigMatches,
} from "../ts/config.js";
import { discoverProjectInventory } from "../ts/discover.js";
import { collectCompilerDeadFunctions } from "./compiler.js";
import { type CargoPackage, type CargoWorkspace, loadCargoMetadata } from "./metadata.js";
import {
  type CargoExecutionContext,
  createCargoExecutionContext,
  disposeCargoExecutionContext,
} from "./runner.js";

const ANALYZER_NAME = "rust-reference-graph";
const CLAIM_LANGUAGE = "rs";
const DEFAULT_TOOL_VERSION = "0.1.0";

export interface RustAnalyzeInternalOptions extends AnalyzeInternalOptions {
  readonly cargoCommand?: string;
  /** Test-only parent for the analyzer-owned Cargo target directory. */
  readonly cargoTargetParentDir?: string;
  /** Shared gitignore-bounded inventory supplied by repository orchestration. */
  readonly sourceFiles?: readonly string[];
}

export interface AnalyzeRustWithGraph {
  readonly result: AnalyzeResult;
  readonly graph: IRGraph;
  readonly reachability: PartitionedReachability;
  readonly claimInputs: FrontendClaimInputs;
  readonly provenance: Provenance;
  readonly hazardEvaluation: HazardEvaluation;
}

export async function analyzeRustProject(
  rootDir: string,
  options: AnalyzeOptions = {},
): Promise<AnalyzeResult> {
  return (await analyzeRustProjectWithGraph(rootDir, options)).result;
}

export async function analyzeRustProjectWithGraph(
  rootDir: string,
  options: AnalyzeOptions = {},
  internal: RustAnalyzeInternalOptions = {},
): Promise<AnalyzeRustWithGraph> {
  return (await analyzeRustProjectMode(rootDir, options, internal, false)) as AnalyzeRustWithGraph;
}

/** Graph-only frontend path used before repository-wide reachability and claims. */
export async function analyzeRustProjectFragment(
  rootDir: string,
  options: AnalyzeOptions = {},
  internal: RustAnalyzeInternalOptions = {},
): Promise<FrontendLocalGraph> {
  return (await analyzeRustProjectMode(rootDir, options, internal, true)) as FrontendLocalGraph;
}

async function analyzeRustProjectMode(
  rootDir: string,
  options: AnalyzeOptions,
  internal: RustAnalyzeInternalOptions,
  fragmentOnly: boolean,
): Promise<AnalyzeRustWithGraph | FrontendLocalGraph> {
  const root = realpathSync(resolve(rootDir));
  const cargo = createCargoExecutionContext(root, internal.cargoTargetParentDir);
  let primaryFailure: unknown;
  try {
    return await analyzeRustProjectWithIsolatedCargo(root, options, internal, cargo, fragmentOnly);
  } catch (error) {
    primaryFailure = error;
    throw error;
  } finally {
    disposeCargoExecutionContext(cargo, primaryFailure);
  }
}

async function analyzeRustProjectWithIsolatedCargo(
  root: string,
  options: AnalyzeOptions,
  internal: RustAnalyzeInternalOptions,
  cargo: CargoExecutionContext,
  fragmentOnly: boolean,
): Promise<AnalyzeRustWithGraph | FrontendLocalGraph> {
  const started = Date.now();
  const now = options.now ?? new Date();
  const version = options.toolVersion ?? DEFAULT_TOOL_VERSION;
  const performance = options.performance;
  const workspaceStarted = performance?.now();
  const metadata = loadCargoMetadata(root, {
    ...(internal.cargoCommand === undefined ? {} : { cargoCommand: internal.cargoCommand }),
    execution: cargo,
  });
  const config = internal.resolvedConfig ?? (await loadConfig(root, options.configPath));
  const units = cargoUnits(root, metadata);
  const configUnits = units.map((unit) => ({ rootRelDir: unit.rootRelDir, name: unit.name }));
  assertUnambiguousWorkspaceKeys(config, configUnits);
  if (fragmentOnly) performance?.increment("workspaces", units.length);
  else performance?.set("workspaces", units.length);
  if (workspaceStarted !== undefined) {
    performance?.finish("workspace-config-detection", workspaceStarted);
  }
  const discoveryStarted = performance?.now();
  const sourceFiles = await rustSources(root, options, internal.sourceFiles);
  const files = sourceFiles.map((file) => toPosixRel(root, file)).sort();
  if (fragmentOnly) performance?.increment("files", files.length);
  else performance?.set("files", files.length);
  if (discoveryStarted !== undefined) {
    performance?.finish("discovery-gitignore", discoveryStarted);
  }
  const fileSet = new Set(files);
  const graph = new IRGraph();
  const fileLineCounts = new Map<string, number>();
  const sources = new Map<string, string>();
  const parsingStarted = performance?.now();
  for (const file of files) {
    const source = readFileSync(resolve(root, file), "utf8");
    sources.set(file, source);
    fileLineCounts.set(fileId(file), countLines(source));
    graph.addNode({ kind: "file", id: fileId(file), path: file });
  }
  if (parsingStarted !== undefined) performance?.finish("parsing", parsingStarted);

  const graphStarted = performance?.now();
  const targetFiles = new Map<string, "production" | "test" | "config">();
  for (const pkg of workspacePackages(metadata)) {
    for (const target of pkg.targets) {
      const file = toPosixRel(root, target.srcPath);
      if (!fileSet.has(file)) continue;
      const entryKind = targetEntryKind(target.kinds);
      targetFiles.set(file, entryKind);
      addEntrypoint(graph, file, entryKind, `cargo-target:${target.kinds.join("+")}`);
    }
  }
  // Stable Cargo metadata identifies target roots, but not the complete module
  // tree. Root every remaining source conservatively so whole files and public
  // items stay alive; compiler-confirmed private contains-only items can still
  // be claimed without a guessed Rust name-resolution graph.
  for (const file of files) {
    if (targetFiles.has(file)) continue;
    addEntrypoint(
      graph,
      file,
      isRustTestFile(file) ? "test" : "production",
      "rust-source-conservative",
    );
  }
  if (graphStarted !== undefined) performance?.finish("graph-construction", graphStarted);
  const conventionStarted = performance?.now();
  for (const hit of collectConfigEntrypoints(files, config, configUnits)) {
    addEntrypoint(graph, hit.file, "production", hit.reason);
  }
  if (conventionStarted !== undefined) {
    performance?.finish("convention-config-roots", conventionStarted);
  }

  const publicGraphStarted = performance?.now();
  for (const [file, source] of sources) addPublicItems(graph, file, source);
  if (publicGraphStarted !== undefined) {
    performance?.finish("graph-construction", publicGraphStarted);
  }
  const compilerStarted = performance?.now();
  const compilerFacts = collectCompilerDeadFunctions(metadata, {
    ...(internal.cargoCommand === undefined ? {} : { cargoCommand: internal.cargoCommand }),
    execution: cargo,
  }).filter(
    (fact) =>
      fileSet.has(fact.file) &&
      isClaimSafeFunction(fact.name, fact.site.span.startLine, sources.get(fact.file)),
  );
  if (compilerStarted !== undefined) performance?.finish("parsing", compilerStarted);
  const uniqueFacts = uniqueFunctionFacts(compilerFacts);
  const compilerGraphStarted = performance?.now();
  for (const fact of uniqueFacts) {
    const id = symbolId(fact.file, fact.name);
    if (graph.hasNode(id)) continue;
    graph.addNode({
      kind: "symbol",
      id,
      file: fact.file,
      exportedName: fact.name,
      isDefault: false,
      typeOnly: false,
      local: true,
      span: fact.site.span,
    });
    graph.addEdge({
      kind: "contains",
      from: fileId(fact.file),
      to: id,
      site: fact.site,
      name: fact.name,
    });
  }
  const symbolCount = graph.nodes().filter((node) => node.kind === "symbol").length;
  const edgeCount = graph.edges().length;
  if (fragmentOnly) {
    performance?.increment("symbols", symbolCount);
    performance?.increment("edges", edgeCount);
  } else {
    performance?.set("symbols", symbolCount);
    performance?.set("edges", edgeCount);
  }
  if (compilerGraphStarted !== undefined) {
    performance?.finish("graph-construction", compilerGraphStarted);
  }
  if (internal.deferConfigSymbolEntrypoints !== true) {
    applyConfigSymbolEntrypoints({
      graph,
      config,
      units: configUnits,
      symbolLanguages: graphSymbolLanguages(graph, "rs"),
      ...(performance === undefined ? {} : { performance }),
    });
  }
  const provenance: Provenance = {
    analyzer: ANALYZER_NAME,
    version,
    generatedAt: now.toISOString(),
  };
  const claimableFiles = new Set(files.filter((file) => isClaimable(file, config, configUnits)));
  const claimInputs: FrontendClaimInputs = {
    fileLineCounts,
    units: configUnits,
    analysisFiles: fileSet,
    claimableFiles,
  };
  if (fragmentOnly) {
    const evidence = new Map(
      uniqueFacts.map((fact) => [
        claimAnnotationKey("export", fact.file, fact.name),
        rustcEvidence(fact.name, fact.file, fact.site.span.startLine),
      ]),
    );
    return {
      graph,
      provenance,
      claimInputs,
      claimAnnotations: collectFrontendClaimAnnotations({
        graph,
        config,
        units: configUnits,
        claimInputs,
        evidence,
      }),
      configuration: createFrontendConfigContribution(config, configUnits, "rs", files, {
        presetsShadowed: internal.boundaryPresetsShadowed === true,
      }),
      metadata: {
        projectName: repositoryName(root, metadata),
        fileCount: files.length,
        workspaceCount: units.length,
        configHash: computeConfigHash(config),
        gateThreshold: config.gate?.threshold ?? "high",
        completeness: { production: "complete", config: "complete", test: "complete" },
      },
      diagnostics: [],
    };
  }

  const reachability = computePartitionedReachability(graph, performance);
  const rustcFacts = new Set(uniqueFacts.map((fact) => `${fact.file}\0${fact.name}`));
  const hazardEvaluation = evaluateHazards({
    graph,
    reachability,
    units: configUnits,
    analysisFiles: fileSet,
    dependencies: [],
    ...(performance === undefined ? {} : { performance }),
  });
  const emitted = emitClaims({
    graph,
    reachability,
    provenance,
    language: CLAIM_LANGUAGE,
    ...claimInputs,
    hazardEvaluation,
    ...(performance === undefined ? {} : { performance }),
  })
    .filter((claim) => rustcFacts.has(`${claim.subject.loc.file}\0${claim.subject.name}`))
    .map(withRustcEvidence);
  if (internal.emitConfigMatchWarnings !== false) {
    warnOnEmptyConfigMatches(config, files, files, configUnits);
  }
  let claims = applyConfigSuppressions(emitted, config, configUnits, files, {
    emitWarnings: internal.emitConfigMatchWarnings !== false,
  });
  if (units.length > 1) claims = annotateRustPackages(claims, units);
  performance?.set("claims", claims.length);
  const result: AnalyzeResult = {
    schemaVersion: SCHEMA_VERSION,
    tool: { name: "unused", version },
    run: {
      root,
      configHash: computeConfigHash(config),
      startedAt: now.toISOString(),
      durationMs: Date.now() - started,
      boundaries: [
        {
          status: "complete",
          pluginId: "language:rust",
          boundaryId: "rs:.",
          language: "rs",
          fileCount: files.length,
          workspaceCount: units.length,
          partitions: { production: "complete", config: "complete", test: "complete" },
        },
      ],
    },
    claims,
    summary: computeSummary(claims, { ciSecondsPerTestFile: config.ciSecondsPerTestFile }),
    productionEntrypointCount: reachability.production.productionEntrypointFiles.size,
    fileCount: files.length,
    workspaceCount: units.length,
    repoName: repositoryName(root, metadata),
    units: configUnits,
    gateThreshold: config.gate?.threshold ?? "high",
  };
  return { result, graph, reachability, claimInputs, provenance, hazardEvaluation };
}

function annotateRustPackages(
  claims: readonly Claim[],
  units: readonly { readonly rootRelDir: string; readonly name: string | null }[],
): Claim[] {
  const byDepth = [...units].sort((a, b) => b.rootRelDir.length - a.rootRelDir.length);
  return claims.map((claim) => {
    const file = claim.subject.loc.file;
    const owner = byDepth.find(
      (unit) =>
        unit.rootRelDir === "" ||
        file === unit.rootRelDir ||
        file.startsWith(`${unit.rootRelDir}/`),
    );
    if (owner?.name === null || owner?.name === undefined) return claim;
    return {
      ...claim,
      subject: {
        ...claim.subject,
        loc: { ...claim.subject.loc, package: owner.name },
      },
    } as Claim;
  });
}

function withRustcEvidence(claim: Claim): Claim {
  return {
    ...claim,
    evidence: rustcEvidence(claim.subject.name, claim.subject.loc.file, claim.subject.loc.span[0]),
  };
}

function rustcEvidence(name: string, file: string, line: number): Claim["evidence"] {
  return [
    {
      type: "static-reachability",
      detail:
        `rustc emitted dead_code for private function \`${name}\` at ` +
        `${file}:${line} in both default and all-features all-target compilations.`,
      source: "rustc-dead-code",
    },
  ];
}

function addEntrypoint(
  graph: IRGraph,
  file: string,
  entryKind: "production" | "test" | "config",
  reason: string,
): void {
  graph.addNode({
    kind: "entrypoint",
    id: entrypointId(entryKind, file),
    entryKind,
    file,
    reason,
  });
}

function targetEntryKind(kinds: readonly string[]): "production" | "test" | "config" {
  if (kinds.includes("custom-build")) return "config";
  if (kinds.includes("test") || kinds.includes("bench")) return "test";
  return "production";
}

function addPublicItems(graph: IRGraph, file: string, source: string): void {
  const publicItem =
    /^\s*pub(?:\([^)]*\))?\s+(?:(?:async|const|unsafe)\s+)*(?:extern\s+"[^"]+"\s+)?(fn|struct|enum|trait|type|const|static)\s+([A-Za-z_][A-Za-z0-9_]*)/gmu;
  for (const match of source.matchAll(publicItem)) {
    const name = match[2];
    if (name === undefined || match.index === undefined) continue;
    const id = symbolId(file, name);
    if (graph.hasNode(id)) continue;
    const startLine = lineAt(source, match.index);
    const span = {
      start: match.index,
      end: match.index + match[0].length,
      startLine,
      endLine: startLine,
    };
    graph.addNode({
      kind: "symbol",
      id,
      file,
      exportedName: name,
      isDefault: false,
      typeOnly: match[1] === "type",
      local: true,
      span,
    });
    graph.addEdge({ kind: "exports", from: fileId(file), to: id, site: { file, span }, name });
    graph.addEdge({ kind: "contains", from: fileId(file), to: id, site: { file, span }, name });
  }
}

function uniqueFunctionFacts<T extends { readonly file: string; readonly name: string }>(
  facts: readonly T[],
): T[] {
  const counts = new Map<string, number>();
  for (const fact of facts) {
    const key = `${fact.file}\0${fact.name}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return facts.filter((fact) => counts.get(`${fact.file}\0${fact.name}`) === 1);
}

/**
 * Compiler truth supplies liveness; this source check supplies the exclusion
 * boundary for runtime/linkage attributes that can make a symbol externally
 * reachable outside ordinary Rust calls.
 */
function isClaimSafeFunction(name: string, startLine: number, source: string | undefined): boolean {
  if (source === undefined) return false;
  const lines = source.split(/\r?\n/u);
  const declaration = lines[startLine - 1];
  if (declaration === undefined) return false;
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  if (
    !new RegExp(`^\\s*(?:(?:async|const|unsafe)\\s+)*fn\\s+${escapedName}\\b`, "u").test(
      declaration,
    )
  ) {
    return false;
  }
  for (let index = startLine - 2; index >= 0; index -= 1) {
    const line = lines[index]?.trim() ?? "";
    if (line === "") continue;
    if (line.startsWith("///") || line.startsWith("//")) continue;
    if (line.startsWith("#[")) return false;
    break;
  }
  return !/\bextern\b|no_mangle|export_name|link_section|#\[used\]|proc_macro|rustler::nif/u.test(
    declaration,
  );
}

export function cargoUnits(
  root: string,
  workspace: CargoWorkspace,
): Array<{
  readonly rootRelDir: string;
  readonly name: string | null;
}> {
  return workspacePackages(workspace)
    .map((pkg) => ({ rootRelDir: toPosixRel(root, dirname(pkg.manifestPath)), name: pkg.name }))
    .sort((a, b) => compareCodeUnits(a.rootRelDir, b.rootRelDir));
}

function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function workspacePackages(workspace: CargoWorkspace): CargoPackage[] {
  return workspace.packages.filter((pkg) => workspace.workspaceMemberIds.has(pkg.id));
}

async function rustSources(
  root: string,
  options: AnalyzeOptions,
  supplied: readonly string[] | undefined,
): Promise<string[]> {
  const candidates =
    supplied ??
    (
      await discoverProjectInventory(root, {
        ...(options.gitignore === undefined ? {} : { gitignore: options.gitignore }),
      })
    ).rustSourceFiles;
  return candidates
    .map((file) => realpathSync(file))
    .filter((file) => toPosixRelOrNull(root, file) !== null)
    .sort();
}

function repositoryName(root: string, workspace: CargoWorkspace): string {
  const packages = workspacePackages(workspace);
  return packages.length === 1 && packages[0] !== undefined ? packages[0].name : basename(root);
}

function isRustTestFile(file: string): boolean {
  return file.startsWith("tests/") || file.includes("/tests/") || file.endsWith("_test.rs");
}

function lineAt(source: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset; index += 1) if (source.charCodeAt(index) === 10) line += 1;
  return line;
}

function countLines(source: string): number {
  if (source === "") return 1;
  let lines = 1;
  for (let index = 0; index < source.length; index += 1) {
    if (source.charCodeAt(index) === 10) lines += 1;
  }
  return lines;
}

function toPosixRel(root: string, file: string): string {
  const value = toPosixRelOrNull(root, file);
  if (value === null) throw new Error(`Rust source escapes project root: ${file}`);
  return value;
}

function toPosixRelOrNull(root: string, file: string): string | null {
  const value = relative(root, file);
  if (value === ".." || value.startsWith(`..${sep}`) || isAbsolute(value)) {
    return null;
  }
  return value.split(sep).join("/");
}
