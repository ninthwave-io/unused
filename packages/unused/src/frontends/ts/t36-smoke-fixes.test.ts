/**
 * T3.6 regression tests — the four smoke-triage false-positive fixes
 * (docs/smoke/M3.md), each pinned to a `__testfixtures__` mini-repo shaped like
 * the real-world case that produced the false positive:
 *
 *  1. **Interim test-file recognition** (`test-file-roots`) — a `*.spec.ts` file
 *     and a `tests/` directory keep their reachable code alive; the test files
 *     themselves are never claimed; a genuine orphan still flags high.
 *  2. **Unresolvable declared entrypoints / the hono trap** (`unresolvable-
 *     entrypoint`) — `exports` targets into an unbuilt `dist/` are remapped to
 *     `src/`, a still-unresolved target raises `unresolvable-entrypoint-target`,
 *     and the whole package is capped medium (never high).
 *  3. **`staticSpecifierPrefix` non-relative left literal** (`scheme-concat-
 *     import`) — the axios `import('file://' + …)` shape caps the whole package
 *     medium instead of leaking a high-confidence claim.
 *  4. **Tool-invoked config-root widening** (`tool-config-roots`) — `gulpfile.js`
 *     and `karma.conf.js` are config roots (never claimed, seed keep-alive); a
 *     real orphan still flags high.
 */
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Claim } from "../../core/claims/types.js";
import { analyzeProject } from "./analyze.js";

const testfx = (c: string): string =>
  fileURLToPath(new URL(`./__testfixtures__/${c}`, import.meta.url));
const FIXED_CLOCK = new Date(0);

interface Shape {
  kind: string;
  name: string;
  confidence: string;
}

function shapes(claims: readonly Claim[]): Shape[] {
  return claims
    .map((c) => ({ kind: c.subject.kind, name: c.subject.name, confidence: c.confidence }))
    .sort((a, b) => `${a.kind} ${a.name}`.localeCompare(`${b.kind} ${b.name}`));
}

const names = (claims: readonly Claim[]): string[] =>
  claims.map((c) => `${c.subject.kind}:${c.subject.name}`);

// ---------------------------------------------------------------------------
// Fix 1 — interim test-file recognition
// ---------------------------------------------------------------------------

describe("T3.6 Fix 1 — interim test-file recognition", () => {
  it("test-reachable code stays alive, test files are never claimed, a real orphan flags high", async () => {
    const run = await analyzeProject(testfx("test-file-roots"), { now: FIXED_CLOCK });
    const ns = names(run.claims);

    // Reached only from `only-tested.spec.ts` ⇒ alive (no claim at any confidence).
    expect(ns).not.toContain("file:src/only-tested.ts");
    expect(ns).not.toContain("export:helper");
    // The `*.spec.ts` file and the `tests/` directory file are test roots ⇒ never claimed.
    expect(ns).not.toContain("file:src/only-tested.spec.ts");
    expect(ns).not.toContain("file:tests/setup.ts");

    // Only the genuine orphan is flagged, at high.
    expect(shapes(run.claims)).toEqual([{ kind: "file", name: "src/dead.ts", confidence: "high" }]);
  });
});

// ---------------------------------------------------------------------------
// Fix 2 — unresolvable declared entrypoints (the hono trap)
// ---------------------------------------------------------------------------

describe("T3.6 Fix 2 — unresolvable declared entrypoints (the hono trap)", () => {
  it("remaps dist→src entries, fires the hazard on a still-unresolved target, caps the package medium", async () => {
    const run = await analyzeProject(testfx("unresolvable-entrypoint"), { now: FIXED_CLOCK });
    const ns = names(run.claims);

    // The `./dist/index.js` / `./dist/sub.js` entries are recovered under `src/`,
    // so the real public API (and its transitive deps) is alive, not flagged.
    expect(run.productionEntrypointCount).toBeGreaterThan(0);
    expect(ns).not.toContain("file:src/index.ts");
    expect(ns).not.toContain("file:src/sub.ts");
    expect(ns).not.toContain("file:src/core.ts");

    // The unresolved `require` target (`./dist/cjs/index.cjs`, no src/ counterpart)
    // raises the whole-package cap: the orphan is MEDIUM, and nothing is high.
    expect(shapes(run.claims)).toEqual([
      { kind: "file", name: "src/dead.ts", confidence: "medium" },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Fix 3 — staticSpecifierPrefix non-relative left literal (axios file://)
// ---------------------------------------------------------------------------

describe("T3.6 Fix 3 — staticSpecifierPrefix non-relative left literal", () => {
  it("`import('file://' + …)` caps the whole package medium, not zero files", async () => {
    const run = await analyzeProject(testfx("scheme-concat-import"), { now: FIXED_CLOCK });
    // Without the fix, prefix `"file://"` matches no file, so mod.ts leaks HIGH.
    expect(shapes(run.claims)).toEqual([{ kind: "file", name: "mod.ts", confidence: "medium" }]);
  });
});

// ---------------------------------------------------------------------------
// Fix 4 — tool-invoked config-root widening
// ---------------------------------------------------------------------------

describe("T3.6 Fix 4 — tool-invoked config-root widening", () => {
  it("gulpfile.js / karma.conf.js are config roots (never claimed, seed keep-alive); a real orphan flags high", async () => {
    const run = await analyzeProject(testfx("tool-config-roots"), { now: FIXED_CLOCK });
    const ns = names(run.claims);

    expect(ns).not.toContain("file:gulpfile.js");
    expect(ns).not.toContain("file:karma.conf.js");
    expect(ns).not.toContain("file:src/tasks.ts"); // alive via the gulpfile config seed

    expect(shapes(run.claims)).toEqual([{ kind: "file", name: "src/dead.ts", confidence: "high" }]);
  });
});
