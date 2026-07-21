/**
 * CI gates (docs/adr/0009-test-strategy.md) against the real fixture corpus,
 * run with the M1 stub analyzer — plus the permanent planted-defect proof
 * that the gate predicates actually reject a false positive / confidence
 * violation when one exists, not just that they pass vacuously today.
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { computeClaimId } from "../../core/claims/id.js";
import type { Claim, Confidence, Subject } from "../../core/claims/types.js";
import { type Analyzer, allAliveAnalyzer, realAnalyzer } from "./analyzer.js";
import type { Label } from "./labels.js";
import { loadLabelCase } from "./labels.js";
import {
  gateNoConfidenceViolations,
  gateNoHighConfidenceFalsePositives,
  gateNoUnlabelledHighConfidence,
  gatePrecisionNonDecreasing,
  scoreCorpus,
} from "./metrics.js";
import { BASELINE_SCOREBOARD_ENV_VAR, baselineScoreboardPath, runCorpus } from "./scoreboard.js";

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
    language: "ts",
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

/**
 * A test double that claims a subject **no fixture labels** dead at `high` — a
 * permanent proof Gate D catches an unlabelled high-confidence claim (a silent
 * escape past Gate A, which only fires on claims joining an `alive` label).
 */
const evilUnlabelledHighAnalyzer: Analyzer = {
  name: "evil-unlabelled-high",
  async analyze() {
    const subject = {
      kind: "export",
      name: "__ghost_unlabelled_subject__",
      loc: { file: "src/__ghost__.ts", span: [1, 1] },
    } as Subject;
    return [
      {
        id: computeClaimId(subject),
        language: "ts",
        subject,
        verdict: "unused",
        confidence: "high",
        evidence: [
          {
            type: "static-reachability",
            detail: "planted unlabelled high-confidence claim",
            source: "gates.test.ts",
          },
        ],
        provenance: { analyzer: "evil", version: "0.0.0", generatedAt: "2026-01-01T00:00:00.000Z" },
      } as Claim,
    ];
  },
};

describe("Gate A — zero false positives at high confidence", () => {
  it("passes against the stub analyzer (vacuous: it emits no claims)", async () => {
    const { caseInputs } = await runCorpus(allAliveAnalyzer);
    const metrics = scoreCorpus(caseInputs);
    const gate = gateNoHighConfidenceFalsePositives(metrics);
    expect(gate.pass).toBe(true);
  });

  it("passes against the real analyzer (non-vacuous: it emits high-confidence claims)", async () => {
    const { caseInputs } = await runCorpus(realAnalyzer);
    const metrics = scoreCorpus(caseInputs);
    const gate = gateNoHighConfidenceFalsePositives(metrics);
    expect(gate.pass, gate.reason).toBe(true);
    // Not vacuous: the real analyzer actually flags dead subjects correctly.
    expect(metrics.truePositives).toBeGreaterThan(0);
    expect(metrics.falsePositives.length).toBe(0);
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

  it("passes against the real analyzer (hazard subjects yield no over-confident claim)", async () => {
    const { caseInputs } = await runCorpus(realAnalyzer);
    const metrics = scoreCorpus(caseInputs);
    const gate = gateNoConfidenceViolations(metrics);
    expect(gate.pass, gate.reason).toBe(true);
    expect(metrics.confidenceViolations.length).toBe(0);
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
    const committedRaw = await readFile(baselineScoreboardPath(), "utf8");
    const committed = JSON.parse(committedRaw) as { precision: number };

    const { caseInputs } = await runCorpus(allAliveAnalyzer);
    const metrics = scoreCorpus(caseInputs);

    const gate = gatePrecisionNonDecreasing(metrics, committed.precision);
    expect(gate.pass).toBe(true);
  });

  it("passes: the real analyzer's precision is >= the committed baseline", async () => {
    const committedRaw = await readFile(baselineScoreboardPath(), "utf8");
    const committed = JSON.parse(committedRaw) as { precision: number };

    const { caseInputs } = await runCorpus(realAnalyzer);
    const metrics = scoreCorpus(caseInputs);

    const gate = gatePrecisionNonDecreasing(metrics, committed.precision);
    expect(gate.pass, gate.reason).toBe(true);
  });

  // A precision value the real, committed fixtures/scoreboard.json could
  // never legitimately hold today (the M1 stub analyzer's vacuous precision
  // is exactly 1). Deliberately NOT 1: the committed scoreboard currently
  // also happens to read 1, so asserting equality to 1 here would pass even
  // if `baselineScoreboardPath()` silently ignored the env var and fell back
  // to the in-tree file — this sentinel is what makes the assertion below
  // actually prove the env var was read, not just that the gate math works.
  const DOCTORED_BASELINE_PRECISION = 0.987654321;

  /**
   * Permanent proof of the M2 T2.7 CI hardening (KNOWN GAP note,
   * scoreboard.ts): Gate C must read its baseline through
   * `baselineScoreboardPath()`, which CI redirects — via
   * `UNUSED_BASELINE_SCOREBOARD` — at a scoreboard extracted from
   * `origin/main`, not the (possibly same-commit-regenerated) in-tree file.
   *
   * This simulates exactly the attack the hardening closes: a doctored
   * baseline claiming a precision higher than the current run can produce
   * (standing in for "the PR rewrote fixtures/scoreboard.json in this same
   * commit"), diffed against a run whose real precision is lower (the
   * existing evil-analyzer test double). Two distinct failure modes are
   * covered: (1) the `committed.precision` assertion fails loudly if the env
   * var is ignored and the in-tree file is read instead; (2) `gate.pass`
   * would be `true` if the gate predicate itself regressed.
   */
  it("rejects when UNUSED_BASELINE_SCOREBOARD points at a baseline with higher precision than the current run", async () => {
    const tmpDir = await mkdtemp(path.join(tmpdir(), "unused-gate-c-baseline-"));
    const doctoredBaselinePath = path.join(tmpDir, "scoreboard.json");
    // Stands in for a PR that lowered real precision but overwrote
    // fixtures/scoreboard.json with a rosier number in the same commit —
    // exactly what the KNOWN GAP used to let through.
    await writeFile(
      doctoredBaselinePath,
      JSON.stringify({ precision: DOCTORED_BASELINE_PRECISION }),
      "utf8",
    );

    const previousEnv = process.env[BASELINE_SCOREBOARD_ENV_VAR];
    process.env[BASELINE_SCOREBOARD_ENV_VAR] = doctoredBaselinePath;
    try {
      const committedRaw = await readFile(baselineScoreboardPath(), "utf8");
      const committed = JSON.parse(committedRaw) as { precision: number };
      // Fails here (not in the gate below) if baselineScoreboardPath() ever
      // stops honouring the env var — the real regression this test guards.
      expect(committed.precision).toBe(DOCTORED_BASELINE_PRECISION);

      // evilFalsePositiveAnalyzer never claims a dead-labelled subject
      // correctly, so its corpus-wide precision is 0 — well below the
      // doctored baseline, whatever value that baseline holds.
      const { caseInputs } = await runCorpus(evilFalsePositiveAnalyzer);
      const metrics = scoreCorpus(caseInputs);
      expect(metrics.precision).toBeLessThan(DOCTORED_BASELINE_PRECISION);

      const gate = gatePrecisionNonDecreasing(metrics, committed.precision);
      expect(gate.pass).toBe(false);
      expect(gate.reason).toMatch(/precision regressed/);
    } finally {
      if (previousEnv === undefined) {
        delete process.env[BASELINE_SCOREBOARD_ENV_VAR];
      } else {
        process.env[BASELINE_SCOREBOARD_ENV_VAR] = previousEnv;
      }
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("Gate D — no unlabelled high-confidence claims (M3 reviewer-inherited)", () => {
  it("passes against the stub analyzer (vacuous: it emits no claims)", async () => {
    const { caseInputs } = await runCorpus(allAliveAnalyzer);
    const metrics = scoreCorpus(caseInputs);
    expect(gateNoUnlabelledHighConfidence(metrics).pass).toBe(true);
  });

  it("passes against the real analyzer (every high-confidence claim joins a label)", async () => {
    const { caseInputs } = await runCorpus(realAnalyzer);
    const metrics = scoreCorpus(caseInputs);
    const gate = gateNoUnlabelledHighConfidence(metrics);
    // If this fails, the reason lists every unlabelled high claim — either the
    // subject needs a label or the analyzer over-claimed.
    expect(gate.pass, gate.reason).toBe(true);
  });

  it("rejects a planted unlabelled high-confidence claim (permanent proof, not a manual demo)", async () => {
    const { caseInputs } = await runCorpus(evilUnlabelledHighAnalyzer);
    const metrics = scoreCorpus(caseInputs);

    expect(metrics.unlabelledClaims.some((c) => c.confidence === "high")).toBe(true);

    const gate = gateNoUnlabelledHighConfidence(metrics);
    expect(gate.pass).toBe(false);
    expect(gate.reason).toMatch(/unlabelled high-confidence claim/);
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

  it("reports the real analyzer's recall (M2: partial by design; hazard/keep-alive cases are misses)", async () => {
    const { caseInputs } = await runCorpus(realAnalyzer);
    const metrics = scoreCorpus(caseInputs);
    expect(metrics.truePositives).toBeGreaterThan(0);
    console.log(
      `[gates.test.ts] real analyzer recall: ${metrics.recall} (tp=${metrics.truePositives}, misses=${metrics.misses.length})`,
    );
  });
});
