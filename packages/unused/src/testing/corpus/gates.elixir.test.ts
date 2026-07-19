/**
 * CI gates for the Elixir fixture corpus (ADR 0011), the false-positive spine
 * for the experimental Elixir frontend — the same Gate A/B/D predicates as the
 * TS corpus (`gates.test.ts`), plus a precision-non-decrease check against the
 * committed `fixtures/scoreboard.elixir.json`.
 *
 * **Gated on a local Elixir toolchain.** The Elixir frontend compiles each
 * fixture with `mix`, which the TS-only CI job does not have, so this whole
 * suite is skipped when `mix` is absent (`describe.skipIf`). Individual fixtures
 * whose hex dependencies are not fetched (the Phoenix HEEx case) are skipped too
 * — the gate never performs a network `mix deps.get`. Run locally with Elixir
 * installed to exercise it.
 */

import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  elixirAnalyzer,
  elixirScoreboardPath,
  isMixAvailable,
  loadElixirCases,
} from "./elixir-corpus.js";
import type { CaseInput } from "./metrics.js";
import {
  gateNoConfidenceViolations,
  gateNoHighConfidenceFalsePositives,
  gateNoUnlabelledHighConfidence,
  gatePrecisionNonDecreasing,
  scoreCorpus,
} from "./metrics.js";

const MIX_AVAILABLE = isMixAvailable();

/** Analyze every runnable Elixir fixture once, shared across the gate assertions. */
async function scoreElixirCorpus(): Promise<ReturnType<typeof scoreCorpus>> {
  const cases = await loadElixirCases();
  const caseInputs: CaseInput[] = [];
  for (const { labelCase, runnable } of cases) {
    if (!runnable) continue;
    const claims = await elixirAnalyzer.analyze(labelCase.dir);
    caseInputs.push({ case: labelCase.case, labels: labelCase.subjects, claims });
  }
  return scoreCorpus(caseInputs);
}

// Compiling every fixture (and the Phoenix one) can take a while — give the
// whole suite a generous ceiling.
describe.skipIf(!MIX_AVAILABLE)("Elixir corpus gates (ADR 0011, experimental)", () => {
  it("Gate A — zero false positives at high confidence, and non-vacuous", {
    timeout: 300_000,
  }, async () => {
    const metrics = await scoreElixirCorpus();
    const gate = gateNoHighConfidenceFalsePositives(metrics);
    expect(gate.pass, gate.reason).toBe(true);
    // Non-vacuous: the Elixir analyzer actually flags dead subjects correctly
    // (the basic-dead-function / test-only-zombie cases).
    expect(metrics.truePositives).toBeGreaterThan(0);
    expect(metrics.falsePositives.length).toBe(0);
  });

  it("Gate B — zero confidence-ceiling violations", { timeout: 300_000 }, async () => {
    const metrics = await scoreElixirCorpus();
    const gate = gateNoConfidenceViolations(metrics);
    expect(gate.pass, gate.reason).toBe(true);
    expect(metrics.confidenceViolations.length).toBe(0);
  });

  it("Gate D — no unlabelled high-confidence claims", { timeout: 300_000 }, async () => {
    const metrics = await scoreElixirCorpus();
    const gate = gateNoUnlabelledHighConfidence(metrics);
    expect(gate.pass, gate.reason).toBe(true);
  });

  it("Gate C — precision does not decrease vs the committed Elixir scoreboard", {
    timeout: 300_000,
  }, async () => {
    const scoreboardPath = elixirScoreboardPath();
    // Absent scoreboard (not yet generated) ⇒ nothing to compare against; the
    // FP gates above still hold. Never a hard failure on a missing baseline.
    if (!existsSync(scoreboardPath)) return;
    const committed = JSON.parse(readFileSync(scoreboardPath, "utf8")) as { precision: number };
    const metrics = await scoreElixirCorpus();
    const gate = gatePrecisionNonDecreasing(metrics, committed.precision);
    expect(gate.pass, gate.reason).toBe(true);
  });
});
