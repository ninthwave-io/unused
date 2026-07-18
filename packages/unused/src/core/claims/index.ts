/**
 * `core/claims` — the claim schema (subject + verdict + confidence +
 * evidence + provenance + time window; architecture.md §1, PRD §4).
 *
 * This is the one core submodule reporters are allowed to depend on
 * (dependency-cruiser exception: `^src/core/claims`), since reporters
 * render exclusively from the claim schema and must not reach into
 * core's analysis internals.
 */
export const CLAIMS_MODULE = "core/claims" as const;

export * from "./id.js";
export * from "./summary.js";
export * from "./types.js";
