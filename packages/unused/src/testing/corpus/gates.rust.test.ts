import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { CaseInput } from "./metrics.js";
import {
  gateNoConfidenceViolations,
  gateNoHighConfidenceFalsePositives,
  gateNoUnlabelledHighConfidence,
  gatePrecisionNonDecreasing,
  scoreCorpus,
} from "./metrics.js";
import {
  isCargoAvailable,
  loadRustCases,
  rustAnalyzer,
  rustScoreboardPath,
} from "./rust-corpus.js";

async function scoreRustCorpus() {
  const cases = await loadRustCases();
  const inputs: CaseInput[] = [];
  for (const labelCase of cases) {
    inputs.push({
      case: labelCase.case,
      labels: labelCase.subjects,
      claims: await rustAnalyzer.analyze(labelCase.dir),
    });
  }
  return scoreCorpus(inputs);
}

describe.skipIf(!isCargoAvailable())("Rust corpus gates", () => {
  it("has non-vacuous perfect high-confidence precision", { timeout: 120_000 }, async () => {
    const metrics = await scoreRustCorpus();
    expect(gateNoHighConfidenceFalsePositives(metrics).pass).toBe(true);
    expect(metrics.truePositives).toBeGreaterThan(0);
    expect(metrics.falsePositives).toEqual([]);
  });

  it("has no confidence or unlabelled high-confidence violations", {
    timeout: 120_000,
  }, async () => {
    const metrics = await scoreRustCorpus();
    expect(gateNoConfidenceViolations(metrics).pass).toBe(true);
    expect(gateNoUnlabelledHighConfidence(metrics).pass).toBe(true);
  });

  it("does not regress against the committed Rust scoreboard", { timeout: 120_000 }, async () => {
    if (!existsSync(rustScoreboardPath())) return;
    const baseline = JSON.parse(readFileSync(rustScoreboardPath(), "utf8")) as {
      precision: number;
    };
    const metrics = await scoreRustCorpus();
    expect(gatePrecisionNonDecreasing(metrics, baseline.precision).pass).toBe(true);
  });
});
