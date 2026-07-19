/**
 * T3.6 regression tests — the four smoke-triage false-positive fixes
 * (docs/smoke/M3.md), each pinned to a `__testfixtures__` mini-repo shaped like
 * the real-world case that produced the false positive:
 *
 *  1. **Test-file recognition** (`test-file-roots`) — a `*.spec.ts` file and a
 *     `tests/` directory are `test` reachability roots. Under M5 (T5.1/T5.2) the
 *     code reached only from them is claimed `test-only` (the M3 interim kept it
 *     silently alive), a test exercising only such code is a zombie `test`, and a
 *     genuine orphan still flags `unused` high.
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

describe("T3.6 Fix 1 — test-file recognition (M5 tier-2 semantics)", () => {
  it("test-reachable-only code is test-only, its lone test is a zombie, a real orphan flags unused high", async () => {
    const run = await analyzeProject(testfx("test-file-roots"), { now: FIXED_CLOCK });
    const ns = names(run.claims);

    // A test file is never a `file` claim (it is a reachability root); `tests/setup.ts`
    // imports nothing, so it is not even a zombie.
    expect(ns).not.toContain("file:src/only-tested.spec.ts");
    expect(ns).not.toContain("file:tests/setup.ts");
    expect(ns).not.toContain("test:tests/setup.ts");
    // Production-alive code stays unflagged.
    expect(ns).not.toContain("file:src/app.ts");
    expect(ns).not.toContain("export:app");

    // Under M5: the genuine orphan is `unused` high; `only-tested.ts` (reached only
    // from the spec) is `test-only` high; the spec, exercising only test-only code,
    // is a zombie `test` at high.
    const shapesWithVerdict = run.claims
      .map((c) => ({
        kind: c.subject.kind,
        name: c.subject.name,
        verdict: c.verdict,
        confidence: c.confidence,
      }))
      .sort((a, b) => `${a.kind} ${a.name}`.localeCompare(`${b.kind} ${b.name}`));
    expect(shapesWithVerdict).toEqual([
      { kind: "file", name: "src/dead.ts", verdict: "unused", confidence: "high" },
      { kind: "file", name: "src/only-tested.ts", verdict: "test-only", confidence: "high" },
      { kind: "test", name: "src/only-tested.spec.ts", verdict: "test-only", confidence: "high" },
    ]);
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
