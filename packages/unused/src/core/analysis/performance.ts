/** Lightweight, opt-in phase timings and work counters for scalability audits. */

import { performance } from "node:perf_hooks";

export const PERFORMANCE_PHASES = [
  "discovery-gitignore",
  "workspace-config-detection",
  "parsing",
  "module-resolution",
  "convention-config-roots",
  "graph-construction",
  "reachability-partitioning",
  "hazard-activation",
  "claim-generation",
  "shortest-path-evidence",
  "deletion-planning",
  "report-json-assembly",
] as const;

export type PerformancePhase = (typeof PERFORMANCE_PHASES)[number];

export interface PerformanceCounters {
  files: number;
  symbols: number;
  edges: number;
  claims: number;
  workspaces: number;
  resolutionAttempts: number;
  graphWalks: number;
  fixedPointIterations: number;
  deletionPlanSimulations: number;
}

export interface PerformanceSnapshot {
  readonly phasesMs: Readonly<Record<PerformancePhase, number>>;
  readonly counters: Readonly<PerformanceCounters>;
}

export interface PerformancePhaseEvent {
  readonly event: "phase";
  readonly phase: PerformancePhase;
  readonly durationMs: number;
  readonly counters: Readonly<PerformanceCounters>;
}

type CounterName = keyof PerformanceCounters;

const emptyCounters = (): PerformanceCounters => ({
  files: 0,
  symbols: 0,
  edges: 0,
  claims: 0,
  workspaces: 0,
  resolutionAttempts: 0,
  graphWalks: 0,
  fixedPointIterations: 0,
  deletionPlanSimulations: 0,
});

const emptyPhases = (): Record<PerformancePhase, number> =>
  Object.fromEntries(PERFORMANCE_PHASES.map((phase) => [phase, 0])) as Record<
    PerformancePhase,
    number
  >;

/**
 * Mutable run-local collector. It is intentionally absent unless requested,
 * keeping the normal analysis path free of timing calls and diagnostics.
 */
export class PerformanceTracker {
  private readonly phases = emptyPhases();
  private readonly counts = emptyCounters();

  constructor(private readonly onPhase?: (event: PerformancePhaseEvent) => void) {}

  now(): number {
    return performance.now();
  }

  elapsedSince(start: number): number {
    return performance.now() - start;
  }

  addDuration(phase: PerformancePhase, durationMs: number, emit = false): void {
    this.phases[phase] += durationMs;
    if (emit) {
      this.onPhase?.({
        event: "phase",
        phase,
        durationMs,
        counters: { ...this.counts },
      });
    }
  }

  finish(phase: PerformancePhase, start: number): number {
    const durationMs = this.elapsedSince(start);
    this.addDuration(phase, durationMs, true);
    return durationMs;
  }

  emitAccumulated(phase: PerformancePhase, durationMs: number): void {
    this.onPhase?.({
      event: "phase",
      phase,
      durationMs,
      counters: { ...this.counts },
    });
  }

  increment(counter: CounterName, amount = 1): void {
    this.counts[counter] += amount;
  }

  set(counter: CounterName, value: number): void {
    this.counts[counter] = value;
  }

  phaseTotal(phase: PerformancePhase): number {
    return this.phases[phase];
  }

  snapshot(): PerformanceSnapshot {
    return { phasesMs: { ...this.phases }, counters: { ...this.counts } };
  }
}
