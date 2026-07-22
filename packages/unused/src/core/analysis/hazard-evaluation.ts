/** Central, reusable hazard activation and subject-effect evaluation. */

import { fileId, type HazardAnnotation, type IRGraph } from "../ir/index.js";
import {
  type ConfidenceCap,
  capIsStrongerOrEqual,
  type HazardClassEntry,
  lookupHazard,
} from "./hazard-registry.js";
import type { PerformanceTracker } from "./performance.js";
import type { PartitionedReachability } from "./reachability.js";

export interface AppliedHazardCap {
  readonly cap: ConfidenceCap;
  readonly detail: string;
  readonly siteFile: string;
  readonly siteLine: number;
  readonly hazardClass: HazardAnnotation["hazardClass"];
}

export interface HazardEvaluationInput {
  readonly graph: IRGraph;
  readonly reachability: PartitionedReachability;
  /** Optional graph-wide indexes shared by fragment evaluations. */
  readonly context?: HazardEvaluationContext;
  readonly units?: readonly { readonly rootRelDir: string }[];
  readonly analysisFiles?: ReadonlySet<string>;
  /** Dependency subjects owned by this frontend fragment. Absent keeps compatibility. */
  readonly dependencies?: readonly {
    readonly packageName: string;
    readonly loc: { readonly file: string };
  }[];
  readonly performance?: PerformanceTracker;
}

export type HazardSubject =
  | { readonly kind: "file"; readonly file: string }
  | { readonly kind: "export"; readonly file: string; readonly name: string }
  | { readonly kind: "dependency"; readonly file: string; readonly name: string };

export interface HazardEvaluation {
  readonly graph: IRGraph;
  readonly projectNoClaim: boolean;
  readonly activeHazards: ReadonlySet<HazardAnnotation>;
  readonly fileCap: ReadonlyMap<string, AppliedHazardCap>;
  readonly fileOnlyCap: ReadonlyMap<string, AppliedHazardCap>;
  readonly exportCap: ReadonlyMap<string, AppliedHazardCap>;
  readonly symbolCap: ReadonlyMap<string, AppliedHazardCap>;
  readonly unitCap: ReadonlyMap<string, AppliedHazardCap>;
  readonly ownerRootRelDir: (path: string) => string;
  effectsForSubject(subject: HazardSubject): readonly AppliedHazardCap[];
}

export interface HazardEvaluationContext {
  readonly graph: IRGraph;
  readonly fileNodes: readonly FileNode[];
  readonly fileNodeByPath: ReadonlyMap<string, FileNode>;
  readonly hazards: readonly HazardAnnotation[];
  readonly hazardsByCarrierPath: ReadonlyMap<string, readonly HazardAnnotation[]>;
  readonly executableSymbolEdges: ReadonlyMap<string, readonly string[]>;
}

const DEFAULT_UNITS: readonly { readonly rootRelDir: string }[] = [{ rootRelDir: "" }];

interface RegisteredHazard {
  readonly hazard: HazardAnnotation;
  readonly entry: HazardClassEntry;
  readonly carrierNode: string;
}

interface FileNode {
  readonly id: string;
  readonly path: string;
}

interface RangeCap {
  readonly start: number;
  readonly end: number;
  readonly applied: AppliedHazardCap;
}

/** Build graph-wide indexes once when several frontend fragments share a graph. */
export function createHazardEvaluationContext(graph: IRGraph): HazardEvaluationContext {
  const fileNodes = graph
    .nodes()
    .filter(
      (node): node is Extract<ReturnType<IRGraph["nodes"]>[number], { kind: "file" }> =>
        node.kind === "file",
    )
    .map((node) => ({ id: node.id, path: node.path }))
    .sort((a, b) => compareText(a.path, b.path));
  const filePathById = new Map(fileNodes.map((file) => [file.id, file.path]));
  const hazards = graph.hazards();
  const hazardsByCarrierPath = new Map<string, HazardAnnotation[]>();
  for (const hazard of hazards) {
    addToList(hazardsByCarrierPath, filePathById.get(hazard.file) ?? hazard.site.file, hazard);
  }
  return {
    graph,
    fileNodes,
    fileNodeByPath: new Map(fileNodes.map((file) => [file.path, file])),
    hazards,
    hazardsByCarrierPath,
    executableSymbolEdges: buildExecutableSymbolEdges(graph),
  };
}

/**
 * Evaluate every hazard once for a captured graph/partition set. Callers should
 * retain and share the result across claims, why, and deletion planning.
 */
export function evaluateHazards(input: HazardEvaluationInput): HazardEvaluation {
  const { graph, reachability, analysisFiles, performance } = input;
  const context =
    input.context?.graph === graph ? input.context : createHazardEvaluationContext(graph);
  const started = performance?.now();
  const fileCap = new Map<string, AppliedHazardCap>();
  const fileOnlyCap = new Map<string, AppliedHazardCap>();
  const exportCap = new Map<string, AppliedHazardCap>();
  const symbolCap = new Map<string, AppliedHazardCap>();
  const fileEffects = new Map<string, AppliedHazardCap[]>();
  const exportEffects = new Map<string, AppliedHazardCap[]>();
  const symbolEffects = new Map<string, AppliedHazardCap[]>();
  const unitEffects = new Map<string, AppliedHazardCap[]>();
  const projectEffects: AppliedHazardCap[] = [];
  const prefixEffects = new PrefixEffectIndex();
  const rangeCaps: RangeCap[] = [];
  let projectNoClaim = false;
  const warned = new Set<string>();

  const unitsByDepth = [...(input.units ?? DEFAULT_UNITS)].sort(
    (a, b) => b.rootRelDir.length - a.rootRelDir.length,
  );
  const ownerRootRelDir = (path: string): string => {
    for (const unit of unitsByDepth) {
      if (
        unit.rootRelDir === "" ||
        path === unit.rootRelDir ||
        path.startsWith(`${unit.rootRelDir}/`)
      ) {
        return unit.rootRelDir;
      }
    }
    return "";
  };

  const fileNodes: FileNode[] = [];
  const fileById = new Map<string, FileNode>();
  const scopedFileNodes =
    analysisFiles === undefined
      ? context.fileNodes
      : [...analysisFiles]
          .map((path) => context.fileNodeByPath.get(path))
          .filter((file): file is FileNode => file !== undefined)
          .sort((a, b) => compareText(a.path, b.path));
  for (const file of scopedFileNodes) {
    fileNodes.push(file);
    fileById.set(file.id, file);
  }

  const registered: RegisteredHazard[] = [];
  const byCarrier = new Map<string, RegisteredHazard[]>();
  const scopedHazards =
    analysisFiles === undefined
      ? context.hazards
      : [...analysisFiles].flatMap((file) => context.hazardsByCarrierPath.get(file) ?? []);
  for (const hazard of scopedHazards) {
    const carrierFile = fileById.get(hazard.file) ?? graphFile(graph, hazard.file);
    const carrierPath = carrierFile?.path ?? hazard.site.file;
    if (!isInScope(carrierPath, analysisFiles)) continue;
    const entry = lookupHazard(hazard.hazardClass);
    if (entry === undefined) {
      projectNoClaim = true;
      projectEffects.push(appliedCap(hazard, "no-claim"));
      if (!warned.has(hazard.hazardClass)) {
        warned.add(hazard.hazardClass);
        console.warn(
          `[unused] unregistered hazard class "${hazard.hazardClass}" at ` +
            `${hazard.site.file}:${hazard.site.span.startLine} — treating the whole project ` +
            "as no-claim (conservative). Add it to core/analysis/hazard-registry.ts.",
        );
      }
      continue;
    }
    const exactCarrier =
      hazard.carrierSymbol === undefined ? undefined : graph.getNode(hazard.carrierSymbol);
    const carrierNode = exactCarrier?.kind === "symbol" ? exactCarrier.id : hazard.file;
    const item = { hazard, entry, carrierNode };
    registered.push(item);
    if (entry.activation === "carrier-reachable") addToList(byCarrier, carrierNode, item);
  }
  const executableSymbolEdges = context.executableSymbolEdges;

  const activeHazards = new Set<HazardAnnotation>();
  const reachableCarrierNodes = new Set<string>([
    ...reachability.production.reachableFiles,
    ...reachability.production.reachableSymbols,
    ...reachability.config.reachableFiles,
    ...reachability.config.reachableSymbols,
    ...reachability.test.reachableFiles,
    ...reachability.test.reachableSymbols,
  ]);
  const queue = [...reachableCarrierNodes];
  let queueIndex = 0;
  const syntheticSourceBySymbol = new Map<string, HazardAnnotation>();
  const unreachedFiles = new UnreachedFileIndex(fileNodes, ownerRootRelDir, reachableCarrierNodes);

  const activate = (item: RegisteredHazard): void => {
    if (activeHazards.has(item.hazard)) return;
    activeHazards.add(item.hazard);
    if (item.entry.propagation === "affected-symbols") {
      for (const target of item.hazard.affectedSymbols ?? []) {
        markSyntheticSymbol(target, item.hazard);
      }
      return;
    }
    for (const target of propagationTargets(item, unreachedFiles, ownerRootRelDir, graph)) {
      if (reachableCarrierNodes.has(target)) continue;
      reachableCarrierNodes.add(target);
      queue.push(target);
    }
  };

  const markSyntheticSymbol = (target: string, source: HazardAnnotation): void => {
    if (graph.getNode(target)?.kind !== "symbol") return;
    if (syntheticSourceBySymbol.has(target)) return;
    syntheticSourceBySymbol.set(target, source);
    reachableCarrierNodes.add(target);
    // Queue even when ordinary production/config/test reachability already
    // contains the symbol: synthetic uncertainty has its own effect closure,
    // and a test-only target still needs the production-active hazard cap.
    queue.push(target);
  };

  for (const item of registered) {
    if (item.entry.activation === "always") activate(item);
  }
  if (registered.some((item) => item.entry.activation === "carrier-reachable")) {
    performance?.increment("fixedPointIterations");
  }
  while (queueIndex < queue.length) {
    const carrier = queue[queueIndex];
    queueIndex += 1;
    if (carrier === undefined) continue;
    for (const item of byCarrier.get(carrier) ?? []) activate(item);
    const syntheticSource = syntheticSourceBySymbol.get(carrier);
    if (syntheticSource !== undefined) {
      for (const target of executableSymbolEdges.get(carrier) ?? []) {
        markSyntheticSymbol(target, syntheticSource);
      }
    }
  }

  const unitCap = new Map<string, AppliedHazardCap>();
  const raiseUnitCap = (unit: string, applied: AppliedHazardCap): void => {
    mergeCap(unitCap, unit, applied);
    addEffect(unitEffects, unit, applied);
  };

  for (const item of registered) {
    const { hazard, entry } = item;
    if (!activeHazards.has(hazard)) continue;
    const applied = appliedCap(hazard, entry.cap);
    if (hazard.affectedSymbols !== undefined) {
      if (entry.propagation === "affected-symbols") continue;
      for (const id of hazard.affectedSymbols) {
        const symbol = graph.getNode(id);
        if (symbol?.kind !== "symbol" || !isInScope(symbol.file, analysisFiles)) continue;
        mergeCap(symbolCap, symbol.id, applied);
        addEffect(symbolEffects, symbol.id, applied);
        if (entry.scope !== "symbol-set") {
          const containingFile = fileId(symbol.file);
          mergeCap(fileOnlyCap, containingFile, applied);
          addEffect(fileEffects, containingFile, applied);
        }
      }
      continue;
    }

    switch (entry.scope) {
      case "none":
        break;
      case "project":
        if (entry.cap === "no-claim") {
          projectNoClaim = true;
          projectEffects.push(applied);
        } else raiseUnitCap(ownerRootRelDir(carrierPath(hazard, graph)), applied);
        break;
      case "file":
        mergeCap(fileCap, hazard.file, applied);
        addEffect(fileEffects, hazard.file, applied);
        addEffect(exportEffects, hazard.file, applied);
        break;
      case "symbol-set":
        mergeCap(exportCap, hazard.file, applied);
        addEffect(exportEffects, hazard.file, applied);
        break;
      case "directory-subtree": {
        const prefix = hazard.subtreePrefix ?? "";
        if (prefix === "") {
          raiseUnitCap(ownerRootRelDir(carrierPath(hazard, graph)), applied);
        } else {
          const [start, end] = prefixRange(fileNodes, prefix);
          if (start < end) rangeCaps.push({ start, end, applied });
          prefixEffects.add(prefix, applied);
        }
        break;
      }
    }
  }

  for (const [id, source] of syntheticSourceBySymbol) {
    const symbol = graph.getNode(id);
    if (symbol?.kind !== "symbol" || !isInScope(symbol.file, analysisFiles)) continue;
    const entry = lookupHazard(source.hazardClass);
    if (entry === undefined) continue;
    const applied = appliedCap(source, entry.cap);
    mergeCap(symbolCap, symbol.id, applied);
    addEffect(symbolEffects, symbol.id, applied);
    const containingFile = fileId(symbol.file);
    mergeCap(fileOnlyCap, containingFile, applied);
    addEffect(fileEffects, containingFile, applied);
  }

  applyRangeCaps(fileNodes, rangeCaps, fileCap);

  if (unitCap.size > 0) {
    for (const file of fileNodes) {
      const unit = ownerRootRelDir(file.path);
      const cap = unitCap.get(unit);
      if (cap !== undefined) mergeCap(fileCap, file.id, cap);
    }
  }

  const dependencySubjects =
    input.dependencies === undefined
      ? undefined
      : new Set(
          input.dependencies.map((dependency) =>
            dependencySubjectKey(dependency.loc.file, dependency.packageName),
          ),
        );

  const effectsForSubject = (subject: HazardSubject): readonly AppliedHazardCap[] => {
    if (subject.kind === "dependency") {
      if (
        dependencySubjects !== undefined &&
        !dependencySubjects.has(dependencySubjectKey(subject.file, subject.name))
      ) {
        return [];
      }
      return stableEffects([
        ...projectEffects,
        ...(unitEffects.get(ownerRootRelDir(subject.file)) ?? []),
      ]);
    }
    if (!isInScope(subject.file, analysisFiles)) return [];
    const id = fileId(subject.file);
    const scopedEffects = [
      ...projectEffects,
      ...(unitEffects.get(ownerRootRelDir(subject.file)) ?? []),
      ...prefixEffects.forPath(subject.file),
    ];
    if (subject.kind === "file")
      return stableEffects([...scopedEffects, ...(fileEffects.get(id) ?? [])]);
    return stableEffects([
      ...scopedEffects,
      ...(exportEffects.get(id) ?? []),
      ...(symbolEffects.get(`symbol:${subject.file}#${subject.name}`) ?? []),
    ]);
  };

  const result: HazardEvaluation = {
    graph,
    projectNoClaim,
    activeHazards,
    fileCap,
    fileOnlyCap,
    exportCap,
    symbolCap,
    unitCap,
    ownerRootRelDir,
    effectsForSubject,
  };
  if (started !== undefined) performance?.finish("hazard-activation", started);
  return result;
}

export function effectsForSubject(
  evaluations: readonly HazardEvaluation[],
  subject: HazardSubject,
): readonly AppliedHazardCap[] {
  return stableEffects(
    evaluations.flatMap((evaluation) => [...evaluation.effectsForSubject(subject)]),
  );
}

function propagationTargets(
  item: RegisteredHazard,
  unreachedFiles: UnreachedFileIndex,
  ownerRootRelDir: (path: string) => string,
  graph: IRGraph,
): readonly string[] {
  switch (item.entry.propagation ?? "none") {
    case "none":
    case "affected-symbols":
      return [];
    case "scope-files":
      return unreachedFiles.takeScope(item.hazard, item.entry.scope, ownerRootRelDir, graph);
  }
}

function carrierPath(hazard: HazardAnnotation, graph: IRGraph): string {
  return graphFile(graph, hazard.file)?.path ?? hazard.site.file;
}

function graphFile(
  graph: IRGraph,
  id: string,
): { readonly id: string; readonly path: string } | undefined {
  const node = graph.getNode(id);
  return node?.kind === "file" ? node : undefined;
}

/** Exact executable symbol adjacency used by bounded dynamic-target closure. */
function buildExecutableSymbolEdges(graph: IRGraph): ReadonlyMap<string, readonly string[]> {
  const adjacency = new Map<string, string[]>();
  for (const edge of graph.edges()) {
    if (edge.kind !== "references") continue;
    if (
      edge.referenceKind !== "static" &&
      edge.referenceKind !== "runtime-resolved" &&
      edge.referenceKind !== "safety-root"
    ) {
      continue;
    }
    if (graph.getNode(edge.from)?.kind !== "symbol" || graph.getNode(edge.to)?.kind !== "symbol")
      continue;
    addToList(adjacency, edge.from, edge.to);
  }
  return adjacency;
}

/**
 * Tracks file nodes that have not yet been made possible by scope propagation.
 * Prefix ranges use a successor structure, so every file index is returned and
 * removed at most once even when many active scopes overlap.
 */
class UnreachedFileIndex {
  private readonly next: number[];
  private readonly indexById = new Map<string, number>();
  private readonly remainingByUnit = new Map<string, Set<number>>();

  constructor(
    private readonly files: readonly FileNode[],
    ownerRootRelDir: (path: string) => string,
    initiallyReached: ReadonlySet<string>,
  ) {
    this.next = Array.from({ length: files.length + 1 }, (_, index) => index);
    for (let index = 0; index < files.length; index += 1) {
      const file = files[index];
      if (file === undefined) continue;
      this.indexById.set(file.id, index);
      const unit = ownerRootRelDir(file.path);
      let remaining = this.remainingByUnit.get(unit);
      if (remaining === undefined) {
        remaining = new Set<number>();
        this.remainingByUnit.set(unit, remaining);
      }
      remaining.add(index);
    }
    for (const id of initiallyReached) {
      const index = this.indexById.get(id);
      if (index !== undefined) this.remove(index, ownerRootRelDir);
    }
  }

  takeScope(
    hazard: HazardAnnotation,
    scope: HazardClassEntry["scope"],
    ownerRootRelDir: (path: string) => string,
    graph: IRGraph,
  ): readonly string[] {
    switch (scope) {
      case "none":
        return [];
      case "file":
      case "symbol-set": {
        const index = this.indexById.get(hazard.file);
        return index === undefined ? [] : this.takeIndexes([index], ownerRootRelDir);
      }
      case "project":
        return this.takeUnit(ownerRootRelDir(carrierPath(hazard, graph)), ownerRootRelDir);
      case "directory-subtree": {
        const prefix = hazard.subtreePrefix ?? "";
        if (prefix === "") {
          return this.takeUnit(ownerRootRelDir(carrierPath(hazard, graph)), ownerRootRelDir);
        }
        return this.takePrefix(prefix, ownerRootRelDir);
      }
    }
  }

  private takePrefix(prefix: string, ownerRootRelDir: (path: string) => string): readonly string[] {
    const [start, end] = prefixRange(this.files, prefix);
    const result: string[] = [];
    let index = this.find(start);
    while (index < end) {
      const file = this.files[index];
      if (file !== undefined) result.push(file.id);
      this.remove(index, ownerRootRelDir);
      index = this.find(index);
    }
    return result;
  }

  private takeUnit(unit: string, ownerRootRelDir: (path: string) => string): readonly string[] {
    return this.takeIndexes(this.remainingByUnit.get(unit) ?? [], ownerRootRelDir);
  }

  private takeIndexes(
    indexes: Iterable<number>,
    ownerRootRelDir: (path: string) => string,
  ): readonly string[] {
    const result: string[] = [];
    for (const index of [...indexes]) {
      if (this.find(index) !== index) continue;
      const file = this.files[index];
      if (file !== undefined) result.push(file.id);
      this.remove(index, ownerRootRelDir);
    }
    return result;
  }

  private find(index: number): number {
    let root = index;
    while (this.next[root] !== undefined && this.next[root] !== root) {
      root = this.next[root] as number;
    }
    let cursor = index;
    while (this.next[cursor] !== undefined && this.next[cursor] !== cursor) {
      const parent = this.next[cursor] as number;
      this.next[cursor] = root;
      cursor = parent;
    }
    return root;
  }

  private remove(index: number, ownerRootRelDir: (path: string) => string): void {
    if (this.find(index) !== index) return;
    const file = this.files[index];
    if (file !== undefined) {
      this.remainingByUnit.get(ownerRootRelDir(file.path))?.delete(index);
    }
    this.next[index] = this.find(index + 1);
  }
}

class PrefixEffectIndex {
  private readonly root: PrefixEffectNode = { effects: [], children: new Map() };

  add(prefix: string, effect: AppliedHazardCap): void {
    let node = this.root;
    for (const character of prefix) {
      let child = node.children.get(character);
      if (child === undefined) {
        child = { effects: [], children: new Map() };
        node.children.set(character, child);
      }
      node = child;
    }
    node.effects.push(effect);
  }

  forPath(path: string): readonly AppliedHazardCap[] {
    const result: AppliedHazardCap[] = [...this.root.effects];
    let node = this.root;
    for (const character of path) {
      const child = node.children.get(character);
      if (child === undefined) break;
      result.push(...child.effects);
      node = child;
    }
    return result;
  }
}

interface PrefixEffectNode {
  readonly effects: AppliedHazardCap[];
  readonly children: Map<string, PrefixEffectNode>;
}

function prefixRange(files: readonly FileNode[], prefix: string): readonly [number, number] {
  const start = lowerBound(files, prefix);
  const upper = nextTextPrefix(prefix);
  const end = upper === undefined ? files.length : lowerBound(files, upper);
  return [start, end];
}

function nextTextPrefix(prefix: string): string | undefined {
  for (let index = prefix.length - 1; index >= 0; index -= 1) {
    const code = prefix.charCodeAt(index);
    if (code < 0xffff) return `${prefix.slice(0, index)}${String.fromCharCode(code + 1)}`;
  }
  return undefined;
}

function lowerBound(files: readonly FileNode[], value: string): number {
  let low = 0;
  let high = files.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    const path = files[middle]?.path ?? "";
    if (compareText(path, value) < 0) low = middle + 1;
    else high = middle;
  }
  return low;
}

function applyRangeCaps(
  files: readonly FileNode[],
  ranges: readonly RangeCap[],
  fileCap: Map<string, AppliedHazardCap>,
): void {
  if (ranges.length === 0) return;
  const ordered = [...ranges].sort((a, b) => a.start - b.start || preferredRange(a, b));
  const active = new RangeCapHeap();
  let rangeIndex = 0;
  for (let fileIndex = 0; fileIndex < files.length; fileIndex += 1) {
    while (ordered[rangeIndex]?.start === fileIndex) {
      const range = ordered[rangeIndex];
      rangeIndex += 1;
      if (range !== undefined) active.push(range);
    }
    while (active.peek()?.end !== undefined && (active.peek()?.end ?? 0) <= fileIndex) active.pop();
    const file = files[fileIndex];
    const cap = active.peek()?.applied;
    if (file !== undefined && cap !== undefined) mergeCap(fileCap, file.id, cap);
  }
}

class RangeCapHeap {
  private readonly values: RangeCap[] = [];

  peek(): RangeCap | undefined {
    return this.values[0];
  }

  push(value: RangeCap): void {
    this.values.push(value);
    let index = this.values.length - 1;
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      const parentValue = this.values[parent];
      if (parentValue === undefined || !isPreferredRange(value, parentValue)) break;
      this.values[index] = parentValue;
      this.values[parent] = value;
      index = parent;
    }
  }

  pop(): void {
    const last = this.values.pop();
    if (last === undefined || this.values.length === 0) return;
    this.values[0] = last;
    let index = 0;
    while (true) {
      const left = index * 2 + 1;
      const right = left + 1;
      let preferred = index;
      if (
        this.values[left] !== undefined &&
        this.values[preferred] !== undefined &&
        isPreferredRange(this.values[left] as RangeCap, this.values[preferred] as RangeCap)
      ) {
        preferred = left;
      }
      if (
        this.values[right] !== undefined &&
        this.values[preferred] !== undefined &&
        isPreferredRange(this.values[right] as RangeCap, this.values[preferred] as RangeCap)
      ) {
        preferred = right;
      }
      if (preferred === index) return;
      const current = this.values[index] as RangeCap;
      this.values[index] = this.values[preferred] as RangeCap;
      this.values[preferred] = current;
      index = preferred;
    }
  }
}

function preferredRange(a: RangeCap, b: RangeCap): number {
  if (isPreferredRange(a, b)) return -1;
  if (isPreferredRange(b, a)) return 1;
  return 0;
}

function isPreferredRange(a: RangeCap, b: RangeCap): boolean {
  if (a.applied.cap !== b.applied.cap) {
    return capIsStrongerOrEqual(a.applied.cap, b.applied.cap);
  }
  return effectKey(a.applied).localeCompare(effectKey(b.applied)) < 0;
}

function dependencySubjectKey(file: string, name: string): string {
  return `${file}\0${name}`;
}

function effectKey(effect: AppliedHazardCap): string {
  return `${effect.siteFile}\0${effect.siteLine}\0${effect.hazardClass}\0${effect.detail}\0${effect.cap}`;
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function appliedCap(hazard: HazardAnnotation, cap: ConfidenceCap): AppliedHazardCap {
  return {
    cap,
    detail: hazard.detail,
    siteFile: hazard.site.file,
    siteLine: hazard.site.span.startLine,
    hazardClass: hazard.hazardClass,
  };
}

function mergeCap(
  map: Map<string, AppliedHazardCap>,
  key: string,
  applied: AppliedHazardCap,
): void {
  const current = map.get(key);
  if (current === undefined || capIsStrongerOrEqual(applied.cap, current.cap))
    map.set(key, applied);
}

function addEffect(
  map: Map<string, AppliedHazardCap[]>,
  key: string,
  effect: AppliedHazardCap,
): void {
  addToList(map, key, effect);
}

function addToList<T>(map: Map<string, T[]>, key: string, value: T): void {
  const values = map.get(key);
  if (values === undefined) map.set(key, [value]);
  else values.push(value);
}

function stableEffects(effects: readonly AppliedHazardCap[]): AppliedHazardCap[] {
  const byKey = new Map<string, AppliedHazardCap>();
  for (const effect of effects) {
    const key = `${effect.hazardClass}\0${effect.siteFile}\0${effect.siteLine}\0${effect.detail}\0${effect.cap}`;
    if (!byKey.has(key)) byKey.set(key, effect);
  }
  return [...byKey.values()].sort(
    (a, b) =>
      a.siteFile.localeCompare(b.siteFile) ||
      a.siteLine - b.siteLine ||
      a.hazardClass.localeCompare(b.hazardClass) ||
      a.detail.localeCompare(b.detail),
  );
}

function isInScope(file: string, scope: ReadonlySet<string> | undefined): boolean {
  return scope === undefined || scope.has(file);
}
