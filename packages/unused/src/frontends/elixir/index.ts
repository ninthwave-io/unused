/**
 * The Elixir frontend's public surface (ADR 0011, experimental in v0.1.0).
 *
 * Emits the same IR / claim schema as the TS frontend; core computes
 * reachability and claims with zero language knowledge (ADR 0003). See
 * `analyze.ts` for the composition entry and `runner.ts` for the refusal
 * contract.
 */

export { analyzeElixirProject, analyzeElixirProjectWithGraph } from "./analyze.js";
export type {
  ElixirAtomArgumentRole,
  ElixirAtomRoleSummary,
  ElixirAtomRoleSummaryProvider,
} from "./atom-role-summaries.js";
export {
  createElixirAtomRoleSummaryLookup,
  defineElixirAtomRoleSummary,
  ELIXIR_ATOM_ROLE_SUMMARIES,
  lookupElixirAtomRoleSummary,
  validateElixirAtomRoleSummaries,
} from "./atom-role-summaries.js";
export { detectElixirProject, isElixirProject } from "./detect.js";
export {
  ElixirCompileError,
  ElixirFrontendError,
  ElixirToolchainError,
} from "./runner.js";
