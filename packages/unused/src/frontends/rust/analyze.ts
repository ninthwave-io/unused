/** Stable Cargo/rustc Rust frontend (ADR 0013, P3). */

import { readFileSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import {
  computePartitionedReachability,
  emitClaims,
  type PartitionedReachability,
} from "../../core/analysis/index.js";
import {
  type Claim,
  computeSummary,
  type Provenance,
  SCHEMA_VERSION,
} from "../../core/claims/index.js";
import { entrypointId, fileId, IRGraph, symbolId } from "../../core/ir/index.js";
import type { FrontendClaimInputs } from "../plugins/types.js";
import type { AnalyzeInternalOptions, AnalyzeOptions, AnalyzeResult } from "../ts/analyze.js";
import {
  applyConfigSuppressions,
  collectConfigEntrypoints,
  computeConfigHash,
  isClaimable,
  loadConfig,
  warnOnEmptyConfigMatches,
} from "../ts/config.js";
import { discoverProjectInventory } from "../ts/discover.js";
import { collectCompilerDeadFunctions } from "./compiler.js";
import { type CargoPackage, type CargoWorkspace, loadCargoMetadata } from "./metadata.js";

const ANALYZER_NAME = "rust-reference-graph";
const CLAIM_LANGUAGE = "rs";
const DEFAULT_TOOL_VERSION = "0.1.0";

export interface RustAnalyzeInternalOptions extends AnalyzeInternalOptions {
  readonly cargoCommand?: string;
  /** Shared gitignore-bounded inventory supplied by repository orchestration. */
  readonly sourceFiles?: readonly string[];
}

export interface AnalyzeRustWithGraph {
  readonly result: AnalyzeResult;
  readonly graph: IRGraph;
  readonly reachability: PartitionedReachability;
  readonly claimInputs: FrontendClaimInputs;
  readonly provenance: Provenance;
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
  const started = Date.now();
  const root = realpathSync(resolve(rootDir));
  const now = options.now ?? new Date();
  const version = options.toolVersion ?? DEFAULT_TOOL_VERSION;
  const metadata = loadCargoMetadata(root, {
    ...(internal.cargoCommand === undefined ? {} : { cargoCommand: internal.cargoCommand }),
  });
  const config = await loadConfig(root, options.configPath);
  const sourceFiles = await rustSources(root, options, internal.sourceFiles);
  const files = sourceFiles.map((file) => toPosixRel(root, realpathSync(file))).sort();
  const fileSet = new Set(files);
  const units = cargoUnits(root, metadata);
  const configUnits = units.map((unit) => ({ rootRelDir: unit.rootRelDir, name: unit.name }));
  const graph = new IRGraph();
  const fileLineCounts = new Map<string, number>();
  const sources = new Map<string, string>();
  for (const file of files) {
    const source = readFileSync(resolve(root, file), "utf8");
    sources.set(file, source);
    fileLineCounts.set(fileId(file), countLines(source));
    graph.addNode({ kind: "file", id: fileId(file), path: file });
  }

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
  for (const hit of collectConfigEntrypoints(files, config, configUnits)) {
    addEntrypoint(graph, hit.file, "production", hit.reason);
  }

  for (const [file, source] of sources) addPublicItems(graph, file, source);
  const compilerFacts = collectCompilerDeadFunctions(metadata, {
    ...(internal.cargoCommand === undefined ? {} : { cargoCommand: internal.cargoCommand }),
  }).filter((fact) => fileSet.has(fact.file));
  const uniqueFacts = uniqueFunctionFacts(compilerFacts);
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

  const reachability = computePartitionedReachability(graph, options.performance);
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
  const rustcFacts = new Set(uniqueFacts.map((fact) => `${fact.file}\0${fact.name}`));
  const emitted = emitClaims({
    graph,
    reachability,
    provenance,
    language: CLAIM_LANGUAGE,
    ...claimInputs,
    ...(options.performance === undefined ? {} : { performance: options.performance }),
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
  const result: AnalyzeResult = {
    schemaVersion: SCHEMA_VERSION,
    tool: { name: "unused", version },
    run: {
      root,
      configHash: computeConfigHash(config),
      startedAt: now.toISOString(),
      durationMs: Date.now() - started,
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
  return { result, graph, reachability, claimInputs, provenance };
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
    evidence: [
      {
        type: "static-reachability",
        detail:
          `rustc emitted dead_code for private function \`${claim.subject.name}\` at ` +
          `${claim.subject.loc.file}:${claim.subject.loc.span[0]} in both default and all-features all-target compilations.`,
        source: "rustc-dead-code",
      },
    ],
  };
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

function cargoUnits(
  root: string,
  workspace: CargoWorkspace,
): Array<{
  readonly rootRelDir: string;
  readonly name: string | null;
}> {
  return workspacePackages(workspace)
    .map((pkg) => ({ rootRelDir: toPosixRel(root, dirname(pkg.manifestPath)), name: pkg.name }))
    .sort((a, b) =>
      a.rootRelDir === "" ? -1 : b.rootRelDir === "" ? 1 : a.rootRelDir.localeCompare(b.rootRelDir),
    );
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
