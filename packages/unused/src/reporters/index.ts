/**
 * `reporters` — TTY, JSON, SARIF; all render from the claim schema, no
 * analysis access (architecture.md §1).
 *
 * Boundary (enforced by dependency-cruiser): reporters must never import
 * frontends, and may only depend on core via `core/claims` — not core's
 * analysis internals.
 */
export const REPORTERS_MODULE = "reporters" as const;
