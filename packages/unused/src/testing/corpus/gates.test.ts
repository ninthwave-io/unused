/**
 * CI gates (docs/adr/0009-test-strategy.md) against the real fixture corpus,
 * run with the M1 stub analyzer — plus the permanent planted-defect proof
 * that the gate predicates actually reject a false positive / confidence
 * violation when one exists, not just that they pass vacuously today.
 */
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { computeClaimId } from "../../core/claims/id.js";
import type { Claim, Confidence, Subject } from "../../core/claims/types.js";
import { type Analyzer, allAliveAnalyzer } from "./analyzer.js";
import type { Label } from "./labels.js";
import { loadLabelCase } from "./labels.js";
import {
  gateNoConfidenceViolations,
  gateNoHighConfidenceFalsePositives,
  gatePrecisionNonDecreasing,
  scoreCorpus,
} from "./metrics.js";
import { defaultScoreboardPath, runCorpus } from "./scoreboard.js";

/** Builds a claim for exactly the subject a label describes, at a chosen confidence. */
function claimForLabel(label: Label, confidence: Confidence): Claim {
  // The label's `kind` is one of export|file|dependency, all of which take
  // the "unused" verdict (core/claims/types.ts `KIND_VERDICTS`); the cast is
  // needed because TS can't narrow `Subject`'s discriminant from a runtime
  // `LabelKind` value.
  const subject = {
    kind: label.kind,
    name: label.name,
    loc: { file: label.file, span: [1, 1] },
  } as Subject;
  return {
    id: computeClaimId(subject),
    subject,
    verdict: "unused",
    confidence,
    evidence: [
      {
        type: "static-reachability",
        detail: "planted by a gates.test.ts evil analyzer",
        source: "gates.test.ts",
      },
    ],
    provenance: { analyzer: "evil", version: "0.0.0", generatedAt: "2026-01-01T00:00:00.000Z" },
  } as Claim;
}

/**
 * A test double that reads a fixture case's own ground truth and claims its
 * first `alive`-labelled subject dead at `high` confidence — a deliberate,
 * permanent proof that the harness catches a false positive rather than a
 * one-off manual demo (docs/phasing.md T1.3 acceptance: "gates demonstrably
 * fail on a planted FP").
 */
const evilFalsePositiveAnalyzer: Analyzer = {
  name: "evil-fp-planter",
  async analyze(fixtureDir) {
    const labelCase = await loadLabelCase(fixtureDir);
    const aliveSubject = labelCase.subjects.find((s) => s.expected === "alive");
    if (!aliveSubject) return [];
    return [claimForLabel(aliveSubject, "high")];
  },
};

/**
 * A test double that reads a fixture case's ground truth and, for any
 * hazard subject whose `minConfidence` ceiling is below `high`, claims it
 * dead at `high` anyway — a permanent proof the harness catches a
 * confidence-ceiling overclaim (a "false-positive-adjacent" defect per
 * fixtures/README.md), independent of the false-positive path above.
 */
const evilConfidenceViolatorAnalyzer: Analyzer = {
  name: "evil-ceiling-violator",
  async analyze(fixtureDir) {
    const labelCase = await loadLabelCase(fixtureDir);
    const hazardSubject = labelCase.subjects.find(
      (s) => s.expected === "dead" && s.minConfidence !== undefined && s.minConfidence !== "high",
    );
    if (!hazardSubject) return [];
    return [claimForLabel(hazardSubject, "high")];
  },
};

describe("Gate A — zero false positives at high confidence", () => {
  it("passes against the stub analyzer (vacuous: it emits no claims)", async () => {
    const { caseInputs } = await runCorpus(allAliveAnalyzer);
    const metrics = scoreCorpus(caseInputs);
    const gate = gateNoHighConfidenceFalsePositives(metrics);
    expect(gate.pass).toBe(true);
  });

  it("rejects a planted high-confidence false positive (permanent proof, not a manual demo)", async () => {
    const { caseInputs } = await runCorpus(evilFalsePositiveAnalyzer);
    const metrics = scoreCorpus(caseInputs);

    expect(metrics.falsePositives.length).toBeGreaterThan(0);
    expect(metrics.falsePositives.some((fp) => fp.claim.confidence === "high")).toBe(true);

    const gate = gateNoHighConfidenceFalsePositives(metrics);
    expect(gate.pass).toBe(false);
    expect(gate.reason).toMatch(/high-confidence false positive/);
  });
});

describe("Gate B — zero confidence-ceiling violations", () => {
  it("passes against the stub analyzer (vacuous: it emits no claims)", async () => {
    const { caseInputs } = await runCorpus(allAliveAnalyzer);
    const metrics = scoreCorpus(caseInputs);
    const gate = gateNoConfidenceViolations(metrics);
    expect(gate.pass).toBe(true);
  });

  it("rejects a planted confidence-ceiling violation (permanent proof, not a manual demo)", async () => {
    const { caseInputs } = await runCorpus(evilConfidenceViolatorAnalyzer);
    const metrics = scoreCorpus(caseInputs);

    // The corpus has hazard subjects with a medium ceiling (e.g.
    // string-computed-import, require-expression, config-referenced-file) —
    // this must find at least one and plant a violation against it.
    expect(metrics.confidenceViolations.length).toBeGreaterThan(0);

    const gate = gateNoConfidenceViolations(metrics);
    expect(gate.pass).toBe(false);
    expect(gate.reason).toMatch(/confidence violation/);
  });
});

describe("Gate C — corpus-wide precision never decreases vs the committed scoreboard", () => {
  it("passes: the stub analyzer's precision matches (or exceeds) the committed baseline", async () => {
    const committedRaw = await readFile(defaultScoreboardPath(), "utf8");
    const committed = JSON.parse(committedRaw) as { precision: number };

    const { caseInputs } = await runCorpus(allAliveAnalyzer);
    const metrics = scoreCorpus(caseInputs);

    const gate = gatePrecisionNonDecreasing(metrics, committed.precision);
    expect(gate.pass).toBe(true);
  });
});

describe("recall — reported, not gated (ADR 0009 / PRD §8 asymmetry)", () => {
  it("is computed as a number for the stub analyzer, with no pass/fail assertion on its value", async () => {
    const { caseInputs } = await runCorpus(allAliveAnalyzer);
    const metrics = scoreCorpus(caseInputs);
    expect(typeof metrics.recall).toBe("number");
    expect(Number.isNaN(metrics.recall)).toBe(false);
    // Reported for visibility in test output; the stub finds nothing, so
    // recall is expected to be 0 — but that expectation is informational,
    // not a gate.
    console.log(`[gates.test.ts] stub analyzer recall: ${metrics.recall}`);
  });
});
