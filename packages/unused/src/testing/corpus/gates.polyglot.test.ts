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
  isPolyglotToolchainAvailable,
  loadPolyglotCases,
  polyglotAnalyzer,
  polyglotScoreboardPath,
} from "./polyglot-corpus.js";

async function scorePolyglotCorpus() {
  const cases = await loadPolyglotCases();
  const inputs: CaseInput[] = [];
  for (const labelCase of cases) {
    inputs.push({
      case: labelCase.case,
      labels: labelCase.subjects,
      claims: await polyglotAnalyzer.analyze(labelCase.dir),
    });
  }
  return scoreCorpus(inputs);
}

describe.skipIf(!isPolyglotToolchainAvailable())("polyglot bridge corpus gates", () => {
  it("has non-vacuous perfect high-confidence precision and recall", {
    timeout: 120_000,
  }, async () => {
    const metrics = await scorePolyglotCorpus();
    expect(gateNoHighConfidenceFalsePositives(metrics).pass).toBe(true);
    expect(metrics.truePositives).toBeGreaterThan(0);
    expect(metrics.falsePositives).toEqual([]);
    expect(metrics.precision).toBe(1);
    expect(metrics.recall).toBe(1);
  });

  it("has no confidence or unlabelled high-confidence violations", {
    timeout: 120_000,
  }, async () => {
    const metrics = await scorePolyglotCorpus();
    expect(gateNoConfidenceViolations(metrics).pass).toBe(true);
    expect(gateNoUnlabelledHighConfidence(metrics).pass).toBe(true);
  });

  it("does not regress against the committed polyglot scoreboard", {
    timeout: 120_000,
  }, async () => {
    if (!existsSync(polyglotScoreboardPath())) return;
    const baseline = JSON.parse(readFileSync(polyglotScoreboardPath(), "utf8")) as {
      precision: number;
    };
    const metrics = await scorePolyglotCorpus();
    expect(gatePrecisionNonDecreasing(metrics, baseline.precision).pass).toBe(true);
  });
});
