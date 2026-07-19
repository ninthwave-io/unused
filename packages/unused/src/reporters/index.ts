/**
 * `reporters` — TTY, `--json`, SARIF; all render from the claim schema, no
 * analysis access (architecture.md §1).
 *
 * Boundary (enforced by dependency-cruiser): reporters must never import
 * frontends, and may only depend on core via `core/claims` — not core's
 * analysis internals.
 */
export const REPORTERS_MODULE = "reporters" as const;

export { type BadgeJson, computeBadge, renderBadgeConfirmation, renderBadgeJson } from "./badge.js";
export { type BaselineUnitSummary, renderBlessSummary } from "./baseline.js";
export {
  type CheckBaselineMeta,
  type CheckVersionMismatch,
  type MismatchField,
  type RenderCheckOptions,
  renderCheckReport,
} from "./check.js";
export {
  type DeletionPlanConsequenceSubjectView,
  type DeletionPlanStageView,
  type DeletionPlanSubjectView,
  type DeletionPlanView,
  deletionSubjectLabel,
  type ReExportEditView,
  renderDeletionPlan,
} from "./deletion-plan.js";
export {
  applyClaimFilters,
  type ClaimFilterOptions,
  filterClaims,
  hasActiveFilters,
} from "./filter.js";
export { renderHelp } from "./help.js";
export {
  type ReportContext,
  type ReportFormat,
  renderReportConfirmation,
  renderReportHtml,
  renderReportMarkdown,
} from "./report.js";
export {
  buildSarifLog,
  renderSarif,
  type SarifLog,
  type SarifResult,
  type SarifRule,
  type SarifRun,
} from "./sarif.js";
export {
  formatCount,
  locLabel,
  renderTtyReport,
  spanLines,
  type TtyLayout,
  type TtyRenderOptions,
  type TtyReportContext,
  whyText,
} from "./tty.js";
export {
  renderHop,
  renderWhy,
  renderWhyPath,
  subjectLabel,
  type WhyCandidateView,
  type WhyEntrypointKind,
  type WhyHazardView,
  type WhyHopView,
  type WhyPathView,
  type WhyReportInput,
  type WhySubjectView,
} from "./why.js";
