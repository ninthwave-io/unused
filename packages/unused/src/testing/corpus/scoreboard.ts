/**
 * Builds and writes `fixtures/scoreboard.json`, the committed CI artifact
 * Gate C (docs/adr/0009-test-strategy.md) diffs the current run's
 * corpus-wide precision against.
 *
 * The file is deterministic by design: stable key order, no timestamps, no
 * raw claim/provenance objects (those carry an ISO `generatedAt` that would
 * make every run produce a spurious diff). Only counts and rates.
 *
 * Regenerate with `pnpm run scoreboard` from the repo root. This is a
 * script, not a test: it writes to disk and is meant to be run, reviewed,
 * and committed by a human/orchestrator when the analyzer's precision
 * legitimately improves — never auto-committed by CI.
 *
 * KNOWN GAP (reviewer, M1 — fix scheduled for M2): Gate C compares against
 * the IN-TREE scoreboard, so a PR that lowers precision AND regenerates
 * this file in the same commit passes trivially. Until CI compares against
 * origin/main's scoreboard (phasing M2, gate-hardening task), any diff to
 * fixtures/scoreboard.json in a PR must be treated as a red flag in review:
 * the orchestrator verifies the regeneration is justified by a genuine
 * corpus or analyzer improvement, never accepted alongside a precision drop.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { Analyzer } from "./analyzer.js";
import { allAliveAnalyzer } from "./analyzer.js";
import type { LabelCase } from "./labels.js";
import { defaultFixturesRoot, loadLabelCases } from "./labels.js";
import type { ByConfidenceTier, CaseInput, CorpusMetrics } from "./metrics.js";
import { scoreCorpus } from "./metrics.js";

/** Absolute path to `fixtures/scoreboard.json`, one level above the `fixtures/ts` corpus root. */
export function defaultScoreboardPath(): string {
  return path.join(defaultFixturesRoot(), "..", "scoreboard.json");
}

export interface ScoreboardCase {
  case: string;
  subjects: number;
  deadLabels: number;
  precision: number;
  recall: number;
  falsePositives: number;
  confidenceViolations: number;
  misses: number;
  unlabelledClaims: number;
}

export interface Scoreboard {
  analyzer: string;
  corpus: {
    cases: number;
    subjects: number;
  };
  precision: number;
  recall: number;
  falsePositives: number;
  confidenceViolations: number;
  misses: number;
  unlabelledClaims: number;
  byConfidenceTier: ByConfidenceTier;
  cases: ScoreboardCase[];
}

/**
 * Runs `analyzer` over every corpus case and returns the raw per-case
 * claims/labels join input, ready to score with `metrics.ts`. Shared by
 * `generateScoreboard` and the gate tests so both exercise the exact same
 * load -> analyze -> join path.
 */
export async function runCorpus(
  analyzer: Analyzer,
  fixturesRoot: string = defaultFixturesRoot(),
): Promise<{ labelCases: LabelCase[]; caseInputs: CaseInput[] }> {
  const labelCases = await loadLabelCases(fixturesRoot);
  const caseInputs: CaseInput[] = [];
  for (const labelCase of labelCases) {
    const claims = await analyzer.analyze(labelCase.dir);
    caseInputs.push({ case: labelCase.case, labels: labelCase.subjects, claims });
  }
  return { labelCases, caseInputs };
}

function buildScoreboard(
  analyzerName: string,
  labelCases: LabelCase[],
  corpusMetrics: CorpusMetrics,
): Scoreboard {
  const subjectCountByCase = new Map(labelCases.map((lc) => [lc.case, lc.subjects.length]));
  const totalSubjects = labelCases.reduce((sum, lc) => sum + lc.subjects.length, 0);

  const cases: ScoreboardCase[] = corpusMetrics.cases
    .map(
      (caseMetrics): ScoreboardCase => ({
        case: caseMetrics.case,
        subjects: subjectCountByCase.get(caseMetrics.case) ?? 0,
        deadLabels: caseMetrics.deadLabelCount,
        precision: caseMetrics.precision,
        recall: caseMetrics.recall,
        falsePositives: caseMetrics.falsePositives.length,
        confidenceViolations: caseMetrics.confidenceViolations.length,
        misses: caseMetrics.misses.length,
        unlabelledClaims: caseMetrics.unlabelledClaims.length,
      }),
    )
    // Stable order regardless of analyzer/loader iteration order.
    .sort((a, b) => (a.case < b.case ? -1 : a.case > b.case ? 1 : 0));

  return {
    analyzer: analyzerName,
    corpus: {
      cases: labelCases.length,
      subjects: totalSubjects,
    },
    precision: corpusMetrics.precision,
    recall: corpusMetrics.recall,
    falsePositives: corpusMetrics.falsePositives.length,
    confidenceViolations: corpusMetrics.confidenceViolations.length,
    misses: corpusMetrics.misses.length,
    unlabelledClaims: corpusMetrics.unlabelledClaims.length,
    byConfidenceTier: corpusMetrics.byConfidenceTier,
    cases,
  };
}

/** Runs `analyzer` over the whole corpus and returns the scoreboard object (no file I/O). */
export async function generateScoreboard(
  analyzer: Analyzer,
  fixturesRoot: string = defaultFixturesRoot(),
): Promise<Scoreboard> {
  const { labelCases, caseInputs } = await runCorpus(analyzer, fixturesRoot);
  const corpusMetrics = scoreCorpus(caseInputs);
  return buildScoreboard(analyzer.name, labelCases, corpusMetrics);
}

/** Serialises with a stable key order (as constructed above) and a trailing newline. */
export function serializeScoreboard(scoreboard: Scoreboard): string {
  return `${JSON.stringify(scoreboard, null, 2)}\n`;
}

export async function writeScoreboard(
  scoreboard: Scoreboard,
  outPath: string = defaultScoreboardPath(),
): Promise<void> {
  await mkdir(path.dirname(outPath), { recursive: true });
  await writeFile(outPath, serializeScoreboard(scoreboard), "utf8");
}

async function main(): Promise<void> {
  const scoreboard = await generateScoreboard(allAliveAnalyzer);
  const outPath = defaultScoreboardPath();
  await writeScoreboard(scoreboard, outPath);
  console.log(
    `wrote ${outPath} (analyzer=${scoreboard.analyzer}, cases=${scoreboard.corpus.cases}, subjects=${scoreboard.corpus.subjects}, precision=${scoreboard.precision}, recall=${scoreboard.recall})`,
  );
}

// Runs only when this module is the process entrypoint (`pnpm run scoreboard`),
// never on import — importing this module for its exports (e.g. from
// `gates.test.ts`) must not have file-writing side effects.
const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
