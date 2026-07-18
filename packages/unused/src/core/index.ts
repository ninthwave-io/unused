/**
 * `core` — language-agnostic reference-graph IR, reachability + entrypoint
 * partitioning, claim engine, hazard registry, cache (architecture.md §1).
 *
 * Boundary (ADR 0003, enforced by dependency-cruiser): core must never
 * import from frontends, cli, reporters, or mcp.
 */
export const CORE_MODULE = "core" as const;
