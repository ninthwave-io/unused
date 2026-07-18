/**
 * Module-boundary rules for `unused` (architecture.md §1, ADR 0007).
 *
 * Run against `packages/unused/src`; paths below are matched relative to
 * the repo root (dependency-cruiser normalises "from"/"to" paths against
 * the invoking cwd, which is the workspace root in `pnpm run boundaries`).
 *
 * Boundaries:
 *  - core must never import frontends, cli, reporters, or mcp.
 *  - reporters must never import frontends, and may only reach into core
 *    via `core/claims` (the claim schema) — not core's analysis internals.
 *  - frontends must never import cli, reporters, or mcp.
 */
"use strict";

const path = require("node:path");

module.exports = {
  forbidden: [
    {
      name: "core-no-outward-imports",
      comment:
        "core is language-agnostic and must not depend on frontends, cli, reporters, or mcp (ADR 0003).",
      severity: "error",
      from: { path: "^packages/unused/src/core(/|$)" },
      to: { path: "^packages/unused/src/(frontends|cli|reporters|mcp)(/|$)" },
    },
    {
      name: "reporters-boundary",
      comment:
        "reporters render only from the claim schema: no frontends, and no core internals besides core/claims.",
      severity: "error",
      from: { path: "^packages/unused/src/reporters(/|$)" },
      to: {
        path: "^packages/unused/src/(frontends|core)(/|$)",
        pathNot: "^packages/unused/src/core/claims(/|$)",
      },
    },
    {
      name: "frontends-no-outward-imports",
      comment: "frontends emit IR only; they must not depend on cli, reporters, or mcp.",
      severity: "error",
      from: { path: "^packages/unused/src/frontends(/|$)" },
      to: { path: "^packages/unused/src/(cli|reporters|mcp)(/|$)" },
    },
  ],
  options: {
    // The boundary check depends on typescript <7: under TS7 (tsgo) dependency-cruiser
    // silently cruises 0 modules and this file's rules pass vacuously. Do not bump the
    // typescript devDependency past 6.x without verifying the cruised module count is >0.
    tsPreCompilationDeps: true,
    tsConfig: {
      // Must be absolute: TypeScript's parseJsonConfigFileContent mis-resolves
      // a relative "extends" target when configFileName itself is relative.
      fileName: path.resolve(__dirname, "packages/unused/tsconfig.json"),
    },
    enhancedResolveOptions: {
      exportsFields: ["exports"],
      conditionNames: ["import", "require", "node", "default"],
      extensions: [".ts", ".tsx", ".js", ".mjs", ".cjs"],
    },
    reporterOptions: {
      text: {
        highlightFocused: true,
      },
    },
  },
};
