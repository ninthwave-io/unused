/**
 * Module-resolution tests (T2.2 acceptance). Two fixture sources:
 *  - the **read-only corpus** at `fixtures/ts/**` (never modified here) — proves
 *    resolution on the real cases: exports-map conditions, re-export sources,
 *    and the computed-import skip;
 *  - **test-only trees** under `./__testfixtures__/**` — targeted probes for
 *    tsconfig `paths` (with `extends`), `.js`→`.ts` remap, directory/index,
 *    self-reference, `#imports`, unresolvable ⇒ hazard, and the
 *    discovered-set / outside-project interaction (see `resolve.ts` header).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Span } from "./module-record.js";
import { parseSource } from "./parse.js";
import {
  packageNameOf,
  Resolver,
  type ResolverOptions,
  resolveModuleRecord,
  unresolvableToHazard,
} from "./resolve.js";

const repoRoot = fileURLToPath(new URL("../../../../../", import.meta.url));
const corpus = (c: string) => join(repoRoot, "fixtures/ts", c);
const testfx = (c: string) => fileURLToPath(new URL(`./__testfixtures__/${c}`, import.meta.url));

const SPAN: Span = { start: 0, end: 0, startLine: 1, endLine: 1 };

function makeResolver(root: string, extra?: Partial<ResolverOptions>): Resolver {
  return new Resolver({ projectRoot: root, ...extra });
}

// ---------------------------------------------------------------------------
// .js → .ts remap + directory/index (NodeNext ESM habit)
// ---------------------------------------------------------------------------

describe(".js → .ts extension remap and directory/index", () => {
  const root = testfx("directory-index");
  const r = makeResolver(root);
  const from = join(root, "src/index.ts");

  it("`./sub/index.js` resolves to the `.ts` source", () => {
    const out = r.resolve("./sub/index.js", from, SPAN, "import").outcome;
    expect(out).toEqual({ kind: "internal", path: join(root, "src/sub/index.ts") });
  });

  it("`./sub` (extensionless directory) resolves to `sub/index.ts`", () => {
    const out = r.resolve("./sub", from, SPAN, "import").outcome;
    expect(out).toEqual({ kind: "internal", path: join(root, "src/sub/index.ts") });
  });

  it("corpus: `./shared.js` → `shared.ts` (real fixture, our own code style)", () => {
    const eRoot = corpus("entrypoint-exports-map");
    const er = makeResolver(eRoot);
    const out = er.resolve("./shared.js", join(eRoot, "src/index.ts"), SPAN, "import").outcome;
    expect(out).toEqual({ kind: "internal", path: join(eRoot, "src/shared.ts") });
  });
});

// ---------------------------------------------------------------------------
// tsconfig paths alias, with extends
// ---------------------------------------------------------------------------

describe("tsconfig paths alias (with extends chain)", () => {
  const root = testfx("paths-alias");
  const r = makeResolver(root);
  const from = join(root, "src/index.ts");

  it("discovers the tsconfig bounded to the project root", () => {
    expect(r.tsconfigPath).toBe(join(root, "tsconfig.json"));
  });

  it("wildcard alias `@app/*` (from the extended base) + `.js`→`.ts` resolves internally", () => {
    const out = r.resolve("@app/thing.js", from, SPAN, "import").outcome;
    expect(out).toEqual({ kind: "internal", path: join(root, "src/thing.ts") });
  });

  it("exact alias `@root` resolves internally", () => {
    const out = r.resolve("@root", from, SPAN, "import").outcome;
    expect(out).toEqual({ kind: "internal", path: join(root, "src/root.ts") });
  });
});

// ---------------------------------------------------------------------------
// workspace-member tsconfig `paths` per member (T4.6, M4 smoke "worst finding")
// ---------------------------------------------------------------------------

describe("workspace-member tsconfig `paths` honoured per member (T4.6)", () => {
  const root = testfx("workspace-member-paths");
  const appDir = join(root, "packages/app");
  const workspacePackages = new Map<string, string>([["@fix/app", appDir]]);
  const rootR = makeResolver(root, { workspacePackages });
  const memberR = makeResolver(root, { tsconfigDir: appDir, workspacePackages });

  it("the member resolver discovers the member's OWN tsconfig (not the root's)", () => {
    expect(memberR.tsconfigPath).toBe(join(appDir, "tsconfig.json"));
  });

  it("the member's own `@/*` alias resolves internally (the fix for the smoke finding)", () => {
    const out = memberR.resolve(
      "@/components/widget",
      join(appDir, "index.ts"),
      SPAN,
      "import",
    ).outcome;
    expect(out).toEqual({ kind: "internal", path: join(appDir, "components/widget.ts") });
  });

  it("root files still use the ROOT tsconfig: its `@root/*` alias resolves, the member's `@/*` does not", () => {
    const rootFrom = join(root, "app.ts");
    expect(rootR.tsconfigPath).toBe(join(root, "tsconfig.json"));
    expect(rootR.resolve("@root/root-widget", rootFrom, SPAN, "import").outcome).toEqual({
      kind: "internal",
      path: join(root, "shared/root-widget.ts"),
    });
    // The member's own alias is invisible to the root resolver — root files are
    // never resolved through a member's tsconfig.
    expect(rootR.resolve("@/components/widget", rootFrom, SPAN, "import").outcome.kind).toBe(
      "unresolvable",
    );
  });
});

// ---------------------------------------------------------------------------
// exports-map conditions (self-reference through package.json "exports")
// ---------------------------------------------------------------------------

describe("package.json exports map + conditions", () => {
  it("corpus entrypoint-exports-map: self-ref `.` and `./worker` resolve via the `import` condition", () => {
    const root = corpus("entrypoint-exports-map");
    const r = makeResolver(root);
    const from = join(root, "src/index.ts");
    expect(r.resolve("fixture-entrypoint-exports-map", from, SPAN, "import").outcome).toEqual({
      kind: "internal",
      path: join(root, "src/index.ts"),
    });
    expect(
      r.resolve("fixture-entrypoint-exports-map/worker", from, SPAN, "import").outcome,
    ).toEqual({ kind: "internal", path: join(root, "src/worker.ts") });
  });

  it("scoped self-reference with subpath resolves through the exports map", () => {
    const root = testfx("self-reference");
    const r = makeResolver(root);
    const from = join(root, "src/index.ts");
    expect(r.resolve("@acme/self-pkg", from, SPAN, "import").outcome).toEqual({
      kind: "internal",
      path: join(root, "src/api.ts"),
    });
    expect(r.resolve("@acme/self-pkg/sub", from, SPAN, "import").outcome).toEqual({
      kind: "internal",
      path: join(root, "src/sub.ts"),
    });
  });
});

// ---------------------------------------------------------------------------
// package.json imports field (#imports)
// ---------------------------------------------------------------------------

describe("package.json imports field (#…)", () => {
  const root = testfx("imports-field");
  const r = makeResolver(root);
  const from = join(root, "src/index.ts");

  it("`#util` resolves to its mapped internal file", () => {
    expect(r.resolve("#util", from, SPAN, "import").outcome).toEqual({
      kind: "internal",
      path: join(root, "src/util.ts"),
    });
  });

  it("`#missing` (mapped to a non-existent file) is unresolvable, not external", () => {
    expect(r.resolve("#missing", from, SPAN, "import").outcome.kind).toBe("unresolvable");
  });
});

// ---------------------------------------------------------------------------
// external packages (scoped + subpath), builtins
// ---------------------------------------------------------------------------

describe("external packages and builtins", () => {
  const root = corpus("entrypoint-exports-map");
  const r = makeResolver(root);
  const from = join(root, "src/index.ts");

  it("scoped subpath `@scope/pkg/sub` → package `@scope/pkg`, subpath `sub`", () => {
    expect(r.resolve("@scope/pkg/sub", from, SPAN, "import").outcome).toEqual({
      kind: "external",
      packageName: "@scope/pkg",
      subpath: "sub",
      path: null,
    });
  });

  it("unscoped subpath `lodash/fp` → package `lodash`, subpath `fp`", () => {
    expect(r.resolve("lodash/fp", from, SPAN, "import").outcome).toEqual({
      kind: "external",
      packageName: "lodash",
      subpath: "fp",
      path: null,
    });
  });

  it("bare `react` → external, no subpath", () => {
    expect(r.resolve("react", from, SPAN, "import").outcome).toEqual({
      kind: "external",
      packageName: "react",
      subpath: null,
      path: null,
    });
  });

  it("`node:path` and bare `fs` and `fs/promises` are builtins (name has no `node:` prefix)", () => {
    expect(r.resolve("node:path", from, SPAN, "import").outcome).toEqual({
      kind: "builtin",
      name: "path",
    });
    expect(r.resolve("fs", from, SPAN, "import").outcome).toEqual({ kind: "builtin", name: "fs" });
    expect(r.resolve("fs/promises", from, SPAN, "import").outcome).toEqual({
      kind: "builtin",
      name: "fs/promises",
    });
  });

  it("bare `test` is NOT a builtin (only `node:test` is)", () => {
    expect(r.resolve("test", from, SPAN, "import").outcome).toEqual({
      kind: "external",
      packageName: "test",
      subpath: null,
      path: null,
    });
  });

  it("packageNameOf covers scoped/subpath/relative/internal forms", () => {
    expect(packageNameOf("@scope/pkg/sub/deep")).toBe("@scope/pkg");
    expect(packageNameOf("lodash")).toBe("lodash");
    expect(packageNameOf("./rel")).toBeNull();
    expect(packageNameOf("#internal")).toBeNull();
    expect(packageNameOf("@scope")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// unresolvable ⇒ hazard-ready (never a throw)
// ---------------------------------------------------------------------------

describe("unresolvable ⇒ hazard", () => {
  const root = testfx("unresolvable");
  const r = makeResolver(root);
  const from = join(root, "src/index.ts");

  it("a missing relative import is unresolvable and converts to a spanned hazard", () => {
    const resolved = r.resolve("./ghost.js", from, SPAN, "import");
    expect(resolved.outcome.kind).toBe("unresolvable");
    const hazard = unresolvableToHazard(resolved);
    expect(hazard.kind).toBe("unresolvable-import");
    expect(hazard.span).toEqual(SPAN);
    expect(hazard.detail).toContain("./ghost.js");
  });

  it("a broken tsconfig paths alias (`@app/missing`) is unresolvable, NOT a phantom external", () => {
    const out = r.resolve("@app/missing", from, SPAN, "import").outcome;
    expect(out.kind).toBe("unresolvable");
  });

  it("unresolvableToHazard throws on misuse (a resolved outcome)", () => {
    const resolved = r.resolve("fs", from, SPAN, "import");
    expect(() => unresolvableToHazard(resolved)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// URL / scheme specifiers ⇒ unresolvable (never a phantom external)
// ---------------------------------------------------------------------------

describe("URL / scheme specifiers are unresolvable, never phantom externals", () => {
  const root = testfx("unresolvable");
  const r = makeResolver(root);
  const from = join(root, "src/index.ts");

  it.each([
    ["https://esm.sh/lodash", "https"],
    ["data:text/javascript,export const x = 1", "data"],
    ["file:///abs/path.js", "file"],
    ["C:\\Users\\me\\pkg.ts", "C (windows drive)"],
  ])("`%s` (%s) → unresolvable, and packageNameOf is null", (specifier) => {
    expect(r.resolve(specifier, from, SPAN, "import").outcome.kind).toBe("unresolvable");
    expect(packageNameOf(specifier)).toBeNull();
  });

  it("a colon after the first slash is a path segment, not a scheme", () => {
    // `foo/bar:baz` has no scheme — it is a normal (external) bare specifier.
    expect(packageNameOf("foo/bar:baz")).toBe("foo");
  });
});

// ---------------------------------------------------------------------------
// .d.ts re-resolution (types-first must not strand the real source)
// ---------------------------------------------------------------------------

describe(".d.ts re-resolution (source-first fallback)", () => {
  const root = testfx("dts-exports");
  const r = makeResolver(root);
  const from = join(root, "src/index.ts");

  it("types→.d.ts + import→.ts: resolves to the .ts source, .d.ts kept as companion", () => {
    // `types` wins first (→ comp.d.ts); we re-resolve source-first to comp.ts so
    // the real implementation keeps its incoming edge (no false 'unused').
    expect(r.resolve("@acme/dts-pkg/comp", from, SPAN, "import").outcome).toEqual({
      kind: "internal",
      path: join(root, "src/comp.ts"),
      declaration: join(root, "src/comp.d.ts"),
    });
  });

  it("declaration-only export → internal-declaration (keep-alive, never a dead-end)", () => {
    expect(r.resolve("@acme/dts-pkg/only-dts", from, SPAN, "import").outcome).toEqual({
      kind: "internal-declaration",
      path: join(root, "src/only.d.ts"),
    });
  });

  it("declaration-only, absent from the discovered set → outside-project (still no dead-end)", () => {
    const rd = makeResolver(root, { discoveredFiles: new Set<string>() });
    expect(rd.resolve("@acme/dts-pkg/only-dts", from, SPAN, "import").outcome).toEqual({
      kind: "outside-project",
      path: join(root, "src/only.d.ts"),
    });
  });
});

// ---------------------------------------------------------------------------
// symlink / discovered-set interaction (outside-project, never a dead-end)
// ---------------------------------------------------------------------------

describe("discovered-set authority (outside-project)", () => {
  const root = testfx("directory-index");
  const target = join(root, "src/sub/index.ts");
  const from = join(root, "src/index.ts");

  it("an internal path absent from the discovered set is downgraded to outside-project", () => {
    const r = makeResolver(root, { discoveredFiles: new Set<string>() });
    expect(r.resolve("./sub/index.js", from, SPAN, "import").outcome).toEqual({
      kind: "outside-project",
      path: target,
    });
  });

  it("the same path present in the discovered set stays internal", () => {
    const r = makeResolver(root, { discoveredFiles: new Set([target, from]) });
    expect(r.resolve("./sub/index.js", from, SPAN, "import").outcome).toEqual({
      kind: "internal",
      path: target,
    });
  });
});

// ---------------------------------------------------------------------------
// resolveModuleRecord — every specifier kind through one API, on real fixtures
// ---------------------------------------------------------------------------

describe("resolveModuleRecord over corpus records", () => {
  function resolveFile(caseDir: string, rel: string) {
    const root = corpus(caseDir);
    const abs = join(root, rel);
    const record = parseSource(abs, readFileSync(abs, "utf8"));
    const resolver = makeResolver(root);
    return { root, resolved: resolveModuleRecord(record, resolver) };
  }

  it("re-export-chain/barrel.ts: both named re-export sources resolve internally", () => {
    const { root, resolved } = resolveFile("re-export-chain", "src/barrel.ts");
    expect(resolved.map((x) => ({ origin: x.origin, outcome: x.outcome }))).toEqual([
      {
        origin: "re-export",
        outcome: { kind: "internal", path: join(root, "src/lib/usedThing.ts") },
      },
      {
        origin: "re-export",
        outcome: { kind: "internal", path: join(root, "src/lib/unusedThing.ts") },
      },
    ]);
  });

  it("export-star-chain/api.ts: the star re-export source resolves internally", () => {
    const { root, resolved } = resolveFile("export-star-chain", "src/api.ts");
    expect(resolved).toHaveLength(1);
    expect(resolved[0]?.origin).toBe("re-export");
    expect(resolved[0]?.outcome).toEqual({ kind: "internal", path: join(root, "src/mid.ts") });
  });

  it("string-computed-import/index.ts: the computed dynamic import is skipped (already a hazard)", () => {
    const { resolved } = resolveFile("string-computed-import", "src/index.ts");
    // The only specifier is the computed `import(`./mods/${name}.js`)` — source
    // is null at parse time, so resolveModuleRecord contributes no edge here.
    expect(resolved).toEqual([]);
  });

  it("import-type-reexport/types.ts: static import, type-import edge, and re-export all resolve", () => {
    const { root, resolved } = resolveFile("import-type-reexport", "src/types.ts");
    // A type-only import + a type-only re-export, both to ./model.js → model.ts.
    for (const r of resolved) {
      expect(r.outcome).toEqual({ kind: "internal", path: join(root, "src/model.ts") });
    }
    expect(resolved.map((x) => x.origin).sort()).toEqual(["import", "re-export"]);
  });
});

// ---------------------------------------------------------------------------
// determinism
// ---------------------------------------------------------------------------

describe("determinism", () => {
  it("same record + fresh resolvers → identical results", () => {
    const root = corpus("re-export-chain");
    const abs = join(root, "src/barrel.ts");
    const record = parseSource(abs, readFileSync(abs, "utf8"));
    const a = resolveModuleRecord(record, makeResolver(root));
    const b = resolveModuleRecord(record, makeResolver(root));
    expect(a).toEqual(b);
  });
});
