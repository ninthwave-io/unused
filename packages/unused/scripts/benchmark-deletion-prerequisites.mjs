/** Synthetic scaling probe for the indexed deletion-prerequisite preflight. */

import {
  computeDeletionPlan,
  computePartitionedReachability,
  createDeletionPlanningContext,
} from "../dist/core/analysis/index.js";
import { fileId, IRGraph, symbolId } from "../dist/core/ir/index.js";

const SIZES = [250, 500, 1_000, 2_000, 4_000];
const TARGET_COUNT = 10;
const REPEATS = 30;

function span(line = 1) {
  return { start: line * 10, end: line * 10 + 5, startLine: line, endLine: line };
}

function addSymbol(graph, file, name) {
  graph.addNode({ kind: "file", id: fileId(file), path: file });
  graph.addNode({
    kind: "symbol",
    id: symbolId(file, name),
    file,
    exportedName: name,
    localName: name,
    localNameKind: "Name",
    isDefault: false,
    typeOnly: false,
    local: true,
    span: span(),
  });
  graph.addEdge({
    kind: "exports",
    from: fileId(file),
    to: symbolId(file, name),
    name,
    site: { file, span: span() },
  });
  graph.addEdge({
    kind: "contains",
    from: fileId(file),
    to: symbolId(file, name),
    name,
    site: { file, span: span() },
  });
}

function fixture(callerCount) {
  const graph = new IRGraph();
  for (let index = 0; index < TARGET_COUNT; index += 1) {
    addSymbol(graph, `src/target_${index}.ts`, `target_${index}`);
  }
  for (let index = 0; index < callerCount; index += 1) {
    const file = `src/caller_${index}.ts`;
    const name = `caller_${index}`;
    const target = index % TARGET_COUNT;
    addSymbol(graph, file, name);
    graph.addEdge({
      kind: "references",
      referenceKind: "static",
      from: symbolId(file, name),
      to: symbolId(`src/target_${target}.ts`, `target_${target}`),
      name: `target_${target}`,
      site: { file, span: span(2) },
    });
  }
  return graph;
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

const results = [];
for (const callerCount of SIZES) {
  const graph = fixture(callerCount);
  const reachability = computePartitionedReachability(graph);
  const indexDurations = [];
  const planDurations = [];
  for (let repeat = 0; repeat < REPEATS; repeat += 1) {
    const indexStarted = performance.now();
    const context = createDeletionPlanningContext(graph);
    indexDurations.push(performance.now() - indexStarted);
    const plansStarted = performance.now();
    for (let index = 0; index < TARGET_COUNT; index += 1) {
      const plan = computeDeletionPlan({
        graph,
        reachability,
        context,
        subject: { kind: "file", file: `src/target_${index}.ts` },
      });
      if (plan.supported) throw new Error("expected a direct inbound blocker");
    }
    planDurations.push(performance.now() - plansStarted);
  }
  results.push({
    callers: callerCount,
    files: callerCount + TARGET_COUNT,
    symbols: callerCount + TARGET_COUNT,
    edges: graph.edges().length,
    plans: TARGET_COUNT,
    medianIndexMs: median(indexDurations),
    medianPlansMs: median(planDurations),
  });
}

process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
