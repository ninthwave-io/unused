/**
 * The `Analyzer` contract the fixture harness scores (docs/phasing.md T1.3).
 *
 * No real analyzer exists yet in M1 (T2.x/T3.x land the graph pipeline). This
 * module exists so the harness — loader, joiner, scoreboard, and CI gates —
 * can be built and proven against a stub today, then pointed at the real
 * analyzer with no interface change once it exists.
 */
import type { Claim } from "../../core/claims/types.js";

export interface Analyzer {
  /** Short, stable identifier recorded in the scoreboard (e.g. "all-alive-stub"). */
  name: string;
  /**
   * Analyses a single fixture case directory (e.g. `fixtures/ts/basic-dead-export`)
   * and returns every claim the analyzer emits for it.
   */
  analyze(fixtureDir: string): Promise<Claim[]>;
}

/**
 * The M1 stub analyzer: claims nothing, ever. Every fixture subject is
 * implicitly "alive" by omission.
 *
 * This is deliberately the most conservative possible analyzer — it can
 * never produce a false positive or a confidence-ceiling violation, so
 * Gates A and B (docs/adr/0009-test-strategy.md) pass vacuously against it.
 * It is also maximally wrong on recall (every dead-labelled subject is a
 * miss), which is expected and, per ADR 0009, not gated.
 *
 * Stands in until M2/M3 wire up the real reference-graph analyzer.
 */
export const allAliveAnalyzer: Analyzer = {
  name: "all-alive-stub",
  async analyze(_fixtureDir: string): Promise<Claim[]> {
    return [];
  },
};
