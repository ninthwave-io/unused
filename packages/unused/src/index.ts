/**
 * `@ninthwave-io/unused` programmatic entry point (T9.1, docs/phasing.md M9;
 * ADR 0008).
 *
 * **Unstable pre-1.0.** This module is published via the package `exports`
 * map (`"."`) so `analyzeProject` can be called from Node without shelling
 * out to the `unused` bin, but it is NOT yet the kind of stability contract
 * the CLI's `--json`/SARIF/exit-code surfaces are (docs/design/cli-ux.md §1:
 * "Machine surfaces are contracts"; PRD §4 fixes the wire *schema*, not this
 * function signature). Expect breaking changes on any 0.x release before
 * v1.0 stabilises this surface too — pin an exact version if you depend on
 * it before then.
 *
 * `Claim`/`ClaimRun`/etc. re-exported here are the same stable wire schema
 * `--json`/SARIF/MCP already use (PRD §4) — only the *function* surface
 * above is unstable, not the data shape it returns.
 */

export type {
  AnalysisBoundary,
  AnalysisPartitionCompletion,
  Claim,
  ClaimRun,
  ClaimSummary,
  CompletedAnalysisBoundary,
  Confidence,
  DeletionPlan,
  DeletionPlanConsequenceSubject,
  DeletionPlanSite,
  DeletionPlanStage,
  DeletionPlanSubject,
  Evidence,
  EvidenceType,
  ReExportEdit,
  Subject,
  SubjectKind,
  Verdict,
} from "./core/claims/index.js";
export {
  type AnalyzeOptions,
  type AnalyzeResult,
  type AnalyzeWithGraph,
  analyzeProject,
  analyzeProjectWithGraph,
} from "./frontends/ts/analyze.js";
