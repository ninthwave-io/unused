/**
 * `frontends/ts` — TS/JS frontend: discovery, parse (oxc-parser), module
 * resolution (oxc-resolver + get-tsconfig), reference/symbol extraction,
 * entrypoint detection, framework presets (architecture.md §1, ADR 0005).
 *
 * Emits IR only; must never import cli, reporters, or mcp.
 */
export const TS_FRONTEND_MODULE = "frontends/ts" as const;
