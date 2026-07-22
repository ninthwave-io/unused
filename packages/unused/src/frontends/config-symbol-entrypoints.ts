import type { PerformanceTracker } from "../core/analysis/index.js";
import { entrypointId, type IRGraph } from "../core/ir/index.js";
import {
  ConfigError,
  type ConfigUnit,
  type EntrySymbolLanguage,
  type EntrySymbolRule,
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
  if (
    config.entrySymbols.length === 0 &&
    !Object.values(config.workspaces).some((override) => (override.entrySymbols?.length ?? 0) > 0)
  ) {
    return;
  }
  const started = input.performance?.now();

  const symbolIndex = new Map<string, string[]>();
  for (const node of graph.nodes()) {
    if (node.kind !== "symbol") continue;
    const language = symbolLanguages.get(node.id);
    if (language === undefined) continue;
    const key = selectorKey(language, node.file, node.exportedName);
    const bucket = symbolIndex.get(key);
    if (bucket === undefined) symbolIndex.set(key, [node.id]);
    else bucket.push(node.id);
  }

  const unitMatches = indexUnitKeys(units);
  const effective = new Set<string>();
  const rules: Array<{
    readonly rule: EntrySymbolRule;
    readonly file: string;
    readonly label: string;
  }> = config.entrySymbols.map((rule, index) => ({
    rule,
    file: rule.file,
    label: `entrySymbols[${index}]`,
  }));

  for (const workspaceKey of Object.keys(config.workspaces).sort()) {
    const override = config.workspaces[workspaceKey];
    if (override === undefined || (override.entrySymbols?.length ?? 0) === 0) continue;
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
    override.entrySymbols?.forEach((rule, index) => {
      rules.push({
        rule,
        file: prefixUnitPath(unit.rootRelDir, rule.file),
        label: `workspaces.${workspaceKey}.entrySymbols[${index}]`,
      });
    });
  }

  for (const { rule, file, label } of rules) {
    input.performance?.increment("resolutionAttempts");
    const key = selectorKey(rule.language, file, rule.name);
    if (effective.has(key)) {
      throw new ConfigError(
        `unused.config: ${label} duplicates another effective entrySymbols selector ` +
          `${rule.language}:${file}#${rule.name}. Fix: keep exactly one root for that symbol.`,
      );
    }
    effective.add(key);

    const matches = symbolIndex.get(key) ?? [];
    if (matches.length === 0) {
      throw new ConfigError(
        `unused.config: ${label} matched no exported ${rule.language} symbol ` +
          `${file}#${rule.name}. Fix: use the exact analyzed file and exportedName.`,
      );
    }
    if (matches.length > 1) {
      throw new ConfigError(
        `unused.config: ${label} ambiguously matched ${matches.length} exported symbols ` +
          `${file}#${rule.name}. Fix: make the configured selector unique.`,
      );
    }

    const targetSymbol = matches[0] as string;
    graph.addNode({
      kind: "entrypoint",
      id: entrypointId("production", file, targetSymbol),
      entryKind: "production",
      file,
      targetSymbol,
      reason: rule.reason,
    });
  }
  if (started !== undefined) input.performance?.finish("convention-config-roots", started);
}

function selectorKey(language: string, file: string, name: string): string {
  return `${language}\0${file}\0${name}`;
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
  else if (!bucket.includes(unit)) bucket.push(unit);
}

function prefixUnitPath(rootRelDir: string, file: string): string {
  return rootRelDir === "" ? file : `${rootRelDir}/${file}`;
}
