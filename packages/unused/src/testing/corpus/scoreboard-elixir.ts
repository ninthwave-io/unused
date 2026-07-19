/**
 * Generates `fixtures/scoreboard.elixir.json` — the multi-language counterpart
 * to `fixtures/scoreboard.json` (ADR 0011). The Elixir corpus is scored by the
 * Elixir frontend, which compiles each fixture (`mix compile`), so this script
 * requires a local Elixir toolchain and is run/committed by a human, never by
 * the TS-only CI job. Fixtures whose hex dependencies are not fetched are
 * skipped and listed under `skipped` rather than failing the run.
 *
 * Regenerate with `pnpm run scoreboard:elixir`.
 */

import { pathToFileURL } from "node:url";
import { elixirAnalyzer, elixirScoreboardPath, loadElixirCases } from "./elixir-corpus.js";
import type { CaseInput } from "./metrics.js";
import { scoreCorpus } from "./metrics.js";
import {
  type Scoreboard,
  type ScoreboardCase,
  serializeScoreboard,
  writeScoreboard,
} from "./scoreboard.js";

interface ElixirScoreboard extends Scoreboard {
  /** Fixture case names skipped because their dependencies were not fetched. */
  skipped: string[];
}

async function buildElixirScoreboard(): Promise<ElixirScoreboard> {
  const cases = await loadElixirCases();
  const runnable = cases.filter((c) => c.runnable);
  const skipped = cases.filter((c) => !c.runnable).map((c) => c.labelCase.case);

  const caseInputs: CaseInput[] = [];
  const subjectCountByCase = new Map<string, number>();
  for (const { labelCase } of runnable) {
    const claims = await elixirAnalyzer.analyze(labelCase.dir);
    caseInputs.push({ case: labelCase.case, labels: labelCase.subjects, claims });
    subjectCountByCase.set(labelCase.case, labelCase.subjects.length);
  }

  const metrics = scoreCorpus(caseInputs);
  const scoreboardCases: ScoreboardCase[] = metrics.cases
    .map((cm) => ({
      case: cm.case,
      subjects: subjectCountByCase.get(cm.case) ?? 0,
      deadLabels: cm.deadLabelCount,
      precision: cm.precision,
      recall: cm.recall,
      falsePositives: cm.falsePositives.length,
      confidenceViolations: cm.confidenceViolations.length,
      misses: cm.misses.length,
      unlabelledClaims: cm.unlabelledClaims.length,
    }))
    .sort((a, b) => (a.case < b.case ? -1 : a.case > b.case ? 1 : 0));

  const totalSubjects = runnable.reduce((sum, c) => sum + c.labelCase.subjects.length, 0);
  return {
    analyzer: elixirAnalyzer.name,
    corpus: { cases: runnable.length, subjects: totalSubjects },
    precision: metrics.precision,
    recall: metrics.recall,
    falsePositives: metrics.falsePositives.length,
    confidenceViolations: metrics.confidenceViolations.length,
    misses: metrics.misses.length,
    unlabelledClaims: metrics.unlabelledClaims.length,
    byConfidenceTier: metrics.byConfidenceTier,
    cases: scoreboardCases,
    skipped,
  };
}

async function main(): Promise<void> {
  const scoreboard = await buildElixirScoreboard();
  const outPath = elixirScoreboardPath();
  await writeScoreboard(scoreboard, outPath);
  process.stdout.write(
    `${serializeScoreboard(scoreboard).length} bytes -> ${outPath} ` +
      `(cases=${scoreboard.corpus.cases}, precision=${scoreboard.precision}, ` +
      `recall=${scoreboard.recall}, skipped=[${scoreboard.skipped.join(", ")}])\n`,
  );
}

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
