/**
 * The `Analyzer` contract the fixture harness scores (docs/phasing.md T1.3).
 *
 * The M1 stub ({@link allAliveAnalyzer}) stays as a vacuous control; the real
 * reference-graph analyzer ({@link realAnalyzer}, T2.4) runs the same harness
 * over `analyzeProject`. Both are scored by the same loader/joiner/gates — the
 * interface never changed when the real analyzer landed.
 */
import type { Claim } from "../../core/claims/types.js";
import { analyzeProject } from "../../frontends/ts/analyze.js";

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

const REAL_ANALYZER_NAME = "ts-reference-graph";
const FIXED_CLOCK = new Date(0);

/**
 * The real TS/JS reference-graph analyzer (T2.4): discover → parse → resolve →
 * emit IR → reachability → claims, over one fixture mini-repo.
 *
 * A fixed epoch clock keeps the emitted provenance stable run-to-run (the
 * scoreboard and gates score only `claim.subject`, never provenance, so the
 * timestamp is irrelevant to scoring — but a stable one makes the run itself
 * fully deterministic).
 */
export const realAnalyzer: Analyzer = {
  name: REAL_ANALYZER_NAME,
  async analyze(fixtureDir: string): Promise<Claim[]> {
    const run = await analyzeProject(fixtureDir, { now: FIXED_CLOCK });
    return [...run.claims];
  },
};
