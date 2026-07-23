import type { PerformanceTracker } from "../core/analysis/index.js";
import { entrypointId, type IRGraph } from "../core/ir/index.js";
import type { ConfiguredSymbolRoot } from "./plugins/types.js";
import {
  ConfigError,
  type ConfigUnit,
  type EntrySymbolLanguage,
  type UnusedConfig,
} from "./ts/config.js";

export interface ApplyConfigSymbolEntrypointsInput {
  readonly graph: IRGraph;
  readonly config: UnusedConfig;
  readonly units: readonly ConfigUnit[];
  /** Symbol id to the language frontend that emitted it. */
  readonly symbolLanguages: ReadonlyMap<string, EntrySymbolLanguage>;
  readonly performance?: PerformanceTracker;
}

export interface ApplyConfiguredSymbolRootsInput {
  readonly graph: IRGraph;
  readonly roots: readonly ConfiguredSymbolRoot[];
  /** Symbol id to the language frontend that emitted it. */
  readonly symbolLanguages: ReadonlyMap<string, EntrySymbolLanguage>;
  /** Symbol id to its exact owning analysis boundary. */
  readonly symbolBoundaries?: ReadonlyMap<string, string>;
  readonly performance?: PerformanceTracker;
}

export function graphSymbolLanguages(
  graph: IRGraph,
  language: EntrySymbolLanguage,
): ReadonlyMap<string, EntrySymbolLanguage> {
  const languages = new Map<string, EntrySymbolLanguage>();
  for (const node of graph.nodes()) {
    if (node.kind === "symbol") languages.set(node.id, language);
  }
  return languages;
}

/**
 * Resolve strict configured symbol roots once, after every language and
 * convention contribution has been composed. The index and rule pass are
 * O(symbols + rules); no reachability or whole-graph walk is repeated per rule.
 */
export function applyConfigSymbolEntrypoints(input: ApplyConfigSymbolEntrypointsInput): void {
  const { graph, config, units, symbolLanguages } = input;
  applyConfiguredSymbolRoots({
    graph,
    roots: collectConfiguredSymbolRoots(config, units),
    symbolLanguages,
    ...(input.performance === undefined ? {} : { performance: input.performance }),
  });
}

/** Expand root/workspace selectors while their owning units are authoritative. */
export function collectConfiguredSymbolRoots(
  config: UnusedConfig,
  units: readonly ConfigUnit[],
  options: { readonly language?: EntrySymbolLanguage } = {},
): ConfiguredSymbolRoot[] {
  if (
    config.entrySymbols.length === 0 &&
    !Object.values(config.workspaces).some((override) => (override.entrySymbols?.length ?? 0) > 0)
  ) {
    return [];
  }

  const unitMatches = indexUnitKeys(units);
  const effective = new Set<string>();
  const roots: ConfiguredSymbolRoot[] = config.entrySymbols.flatMap((rule, index) =>
    options.language !== undefined && rule.language !== options.language
      ? []
      : [
          {
            language: rule.language,
            file: rule.file,
            name: rule.name,
            reason: rule.reason,
            label: `entrySymbols[${index}]`,
          },
        ],
  );

  for (const workspaceKey of Object.keys(config.workspaces).sort()) {
    const override = config.workspaces[workspaceKey];
    if (override === undefined || (override.entrySymbols?.length ?? 0) === 0) continue;
    const selectedRules = (override.entrySymbols ?? []).flatMap((rule, index) =>
      options.language !== undefined && rule.language !== options.language ? [] : [{ rule, index }],
    );
    if (selectedRules.length === 0) continue;
    const matches = unitMatches.get(workspaceKey) ?? [];
    if (matches.length === 0) {
      throw new ConfigError(
        `unused.config: workspace entrySymbols key ${JSON.stringify(workspaceKey)} matched no analysis workspace. ` +
          "Fix: use an exact workspace directory or package name.",
      );
    }
    if (matches.length > 1) {
      throw new ConfigError(
        `unused.config: workspace entrySymbols key ${JSON.stringify(workspaceKey)} is ambiguous across ${matches.length} workspaces. ` +
          "Fix: use the unique root-relative workspace directory.",
      );
    }
    const unit = matches[0] as ConfigUnit;
    selectedRules.forEach(({ rule, index }) => {
      roots.push({
        language: rule.language,
        file: prefixUnitPath(unit.rootRelDir, rule.file),
        name: rule.name,
        reason: rule.reason,
        label: `workspaces.${workspaceKey}.entrySymbols[${index}]`,
      });
    });
  }

  for (const root of roots) {
    const key = selectorKey(root.language, root.file, root.name);
    if (effective.has(key)) {
      throw new ConfigError(
        `unused.config: ${root.label} duplicates another effective entrySymbols selector ` +
          `${root.language}:${root.file}#${root.name}. Fix: keep exactly one root for that symbol.`,
      );
    }
    effective.add(key);
  }
  return roots;
}

/** Canonical selector inventory shared by every frontend reading one physical config. */
export function configuredSymbolSelectorInventory(
  config: UnusedConfig,
): readonly { readonly language: EntrySymbolLanguage; readonly label: string }[] {
  const inventory: Array<{ readonly language: EntrySymbolLanguage; readonly label: string }> =
    config.entrySymbols.map((rule, index) => ({
      language: rule.language,
      label: `entrySymbols[${index}]`,
    }));
  for (const workspaceKey of Object.keys(config.workspaces).sort(compareCodeUnits)) {
    config.workspaces[workspaceKey]?.entrySymbols?.forEach((rule, index) => {
      inventory.push({
        language: rule.language,
        label: `workspaces.${workspaceKey}.entrySymbols[${index}]`,
      });
    });
  }
  return inventory;
}

/** Resolve repository-global and boundary-scoped roots in one O(symbols + rules) pass. */
export function applyConfiguredSymbolRoots(input: ApplyConfiguredSymbolRootsInput): void {
  if (input.roots.length === 0) return;
  const started = input.performance?.now();
  const globalIndex = new Map<string, string[]>();
  const scopedIndex = new Map<string, string[]>();
  for (const node of input.graph.nodes()) {
    if (node.kind !== "symbol") continue;
    const language = input.symbolLanguages.get(node.id);
    if (language === undefined) continue;
    appendSymbol(globalIndex, selectorKey(language, node.file, node.exportedName), node.id);
    const boundaryId = input.symbolBoundaries?.get(node.id);
    if (boundaryId !== undefined) {
      appendSymbol(
        scopedIndex,
        scopedSelectorKey(boundaryId, language, node.file, node.exportedName),
        node.id,
      );
    }
  }

  const selectedTargets = new Map<string, string>();
  for (const root of input.roots) {
    input.performance?.increment("resolutionAttempts");
    const key =
      root.boundaryId === undefined
        ? selectorKey(root.language, root.file, root.name)
        : scopedSelectorKey(root.boundaryId, root.language, root.file, root.name);
    const matches =
      (root.boundaryId === undefined ? globalIndex.get(key) : scopedIndex.get(key)) ?? [];

    if (matches.length === 0) {
      throw new ConfigError(
        `unused.config: ${root.label} matched no exported ${root.language} symbol ` +
          `${root.file}#${root.name}. Fix: use the exact analyzed file and exportedName.`,
      );
    }
    if (matches.length > 1) {
      throw new ConfigError(
        `unused.config: ${root.label} ambiguously matched ${matches.length} exported symbols ` +
          `${root.file}#${root.name}. Fix: make the configured selector unique.`,
      );
    }

    const targetSymbol = matches[0] as string;
    const earlier = selectedTargets.get(targetSymbol);
    if (earlier !== undefined) {
      throw new ConfigError(
        `unused.config: ${root.label} duplicates effective configured symbol root ${earlier}. ` +
          `Fix: keep exactly one root for ${root.language}:${root.file}#${root.name}.`,
      );
    }
    selectedTargets.set(targetSymbol, root.label);
    input.graph.addNode({
      kind: "entrypoint",
      id: entrypointId("production", root.file, targetSymbol),
      entryKind: "production",
      file: root.file,
      targetSymbol,
      reason: root.reason,
    });
  }
  if (started !== undefined) input.performance?.finish("convention-config-roots", started);
}

function appendSymbol(index: Map<string, string[]>, key: string, symbolId: string): void {
  const bucket = index.get(key);
  if (bucket === undefined) index.set(key, [symbolId]);
  else bucket.push(symbolId);
}

function selectorKey(language: string, file: string, name: string): string {
  return `${language}\0${file}\0${name}`;
}

function scopedSelectorKey(
  boundaryId: string,
  language: string,
  file: string,
  name: string,
): string {
  return `${boundaryId}\0${selectorKey(language, file, name)}`;
}

function indexUnitKeys(units: readonly ConfigUnit[]): ReadonlyMap<string, readonly ConfigUnit[]> {
  const index = new Map<string, ConfigUnit[]>();
  for (const unit of units) {
    if (unit.rootRelDir !== "") appendUnit(index, unit.rootRelDir, unit);
    if (unit.name !== null && unit.name !== unit.rootRelDir) appendUnit(index, unit.name, unit);
  }
  return index;
}

function appendUnit(index: Map<string, ConfigUnit[]>, key: string, unit: ConfigUnit): void {
  const bucket = index.get(key);
  if (bucket === undefined) index.set(key, [unit]);
  else bucket.push(unit);
}

function prefixUnitPath(rootRelDir: string, file: string): string {
  return rootRelDir === "" ? file : `${rootRelDir}/${file}`;
}

function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
