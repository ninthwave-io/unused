/**
 * `reporters` — TTY, `--json`, SARIF; all render from the claim schema, no
 * analysis access (architecture.md §1).
 *
 * Boundary (enforced by dependency-cruiser): reporters must never import
 * frontends, and may only depend on core via `core/claims` — not core's
 * analysis internals.
 */
export const REPORTERS_MODULE = "reporters" as const;

export {
  applyClaimFilters,
  type ClaimFilterOptions,
  filterClaims,
  hasActiveFilters,
} from "./filter.js";
export { renderHelp } from "./help.js";
export {
  buildSarifLog,
  renderSarif,
  type SarifLog,
  type SarifResult,
  type SarifRule,
  type SarifRun,
} from "./sarif.js";
export {
  renderTtyReport,
  type TtyLayout,
  type TtyRenderOptions,
  type TtyReportContext,
} from "./tty.js";
