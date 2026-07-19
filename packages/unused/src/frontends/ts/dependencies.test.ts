/**
 * Dependency-claim integration tests (T4.1 acceptance, phasing.md M4). Runs the
 * full pipeline over `./__testfixtures__/dep-*` mini-repos and asserts the exact
 * `dependency` claim set per case — the declared-vs-referenced core plus every
 * keep-alive rule:
 *  - `dep-basic`          — an unused declared dep is claimed; an imported one is not.
 *  - `dep-types-pairing`  — `@types/*` kept alive whenever a TS file exists (blunt v1).
 *  - `dep-bin-only`       — a dep whose installed manifest declares `bin` is kept.
 *  - `dep-jsx-runtime`    — `react` kept alive under `jsx: react-jsx` with a `.tsx`
 *                           file, though nothing imports it (the classic FP).
 *  - `dep-jsx-js`         — same, with automatic JSX in a `.js` file (CRA-style).
 *  - `dep-config-named`   — deps named in `scripts`/config (incl. eslint-plugin
 *                           shorthand) are kept alive.
 *  - `dep-reference-types`— a dep referenced only by `/// <reference types=... />`
 *                           is kept alive (comment-borne, no import edge).
 *  - `dep-workspace`      — a used `workspace:` sibling is kept; an unused one is claimed.
 *  - `dep-hoisted-root`   — a root-declared dep imported only by a member is kept
 *                           alive (hoisting); a root dep used by no unit is claimed.
 *  - `dep-dead-code-ref`  — a dep imported only by a dead file is kept alive
 *                           (deleting it is a human cascade decision).
 *
 * `node_modules` is gitignored, so each fixture's committed part is package.json
 * + src; the installed manifests every case's declared deps resolve to (a `bin`
 * for the CLI, no `bin` for the rest) are materialized here. This also satisfies
 * the pre-install conservatism rule: a claimable external dep needs a readable
 * manifest to be proven not-a-CLI (an un-installed dep is kept alive).
 */
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Claim } from "../../core/claims/types.js";
import { analyzeProject } from "./analyze.js";

const testfx = (c: string): string =>
  fileURLToPath(new URL(`./__testfixtures__/${c}`, import.meta.url));
const FIXED_CLOCK = new Date(0);

/**
 * fixture → installed manifests to materialize: `depName → bin` (a `bin` object,
 * or `null` for an installed package with no `bin` — i.e. a claimable, non-CLI dep).
 */
const INSTALLED: Record<string, Record<string, Record<string, string> | null>> = {
  "dep-basic": { "dead-lib": null },
  "dep-types-pairing": { "dead-lib": null },
  "dep-config-named": { "dead-lib": null },
  "dep-jsx-runtime": { "unused-dep": null },
  "dep-jsx-js": { "unused-dep": null },
  "dep-reference-types": { "dead-lib": null },
  "dep-bin-only": { "dead-lib": null, "some-cli": { "some-cli": "./cli.js" } },
  "dep-hoisted-root": { "truly-unused": null },
};

beforeAll(async () => {
  for (const [fixture, manifests] of Object.entries(INSTALLED)) {
    for (const [depName, bin] of Object.entries(manifests)) {
      const dir = join(testfx(fixture), "node_modules", ...depName.split("/"));
      await mkdir(dir, { recursive: true });
      const manifest = { name: depName, version: "1.0.0", ...(bin !== null ? { bin } : {}) };
      await writeFile(join(dir, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    }
  }
});
afterAll(async () => {
  for (const fixture of Object.keys(INSTALLED)) {
    await rm(join(testfx(fixture), "node_modules"), { recursive: true, force: true });
  }
});

interface DepShape {
  name: string;
  file: string;
  span: readonly [number, number];
  confidence: string;
  verdict: string;
  package: string | undefined;
}

function depShape(c: Claim): DepShape {
  return {
    name: c.subject.name,
    file: c.subject.loc.file,
    span: c.subject.loc.span,
    confidence: c.confidence,
    verdict: c.verdict,
    package: c.subject.loc.package,
  };
}

async function analyze(fixture: string): Promise<readonly Claim[]> {
  const run = await analyzeProject(testfx(fixture), { now: FIXED_CLOCK });
  return run.claims;
}

async function dependencyClaims(fixture: string): Promise<DepShape[]> {
  const claims = await analyze(fixture);
  return claims
    .filter((c) => c.subject.kind === "dependency")
    .map(depShape)
    .sort((a, b) => a.name.localeCompare(b.name));
}

describe("dependency claims — declared vs referenced", () => {
  it("dep-basic: the unused declared dep is claimed (high); the imported one is not", async () => {
    expect(await dependencyClaims("dep-basic")).toEqual([
      {
        name: "dead-lib",
        file: "package.json",
        span: [6, 6], // the `"dead-lib"` line inside `dependencies`
        confidence: "high",
        verdict: "unused",
        package: undefined, // single-package run carries no loc.package
      },
    ]);
  });

  it("dep-reference-types: a dep referenced only by /// <reference types=... /> is kept alive", async () => {
    // `some-types` is pulled in solely by a comment directive (no import edge);
    // only the genuinely-unused `dead-lib` is claimed.
    expect(await dependencyClaims("dep-reference-types")).toEqual([
      expect.objectContaining({ name: "dead-lib", verdict: "unused" }),
    ]);
  });

  it("dep-dead-code-ref: a dep imported only by a dead file is kept alive; the file is still claimed", async () => {
    const claims = await analyze("dep-dead-code-ref");
    // No dependency claim — `dead-code-dep` is referenced by src/orphan.ts even
    // though that file is itself dead.
    expect(claims.filter((c) => c.subject.kind === "dependency")).toEqual([]);
    // The dead file is still flagged (the cascade decision is left to the human).
    expect(claims.filter((c) => c.subject.kind === "file").map((c) => c.subject.name)).toEqual([
      "src/orphan.ts",
    ]);
  });
});

describe("dependency claims — keep-alive rules", () => {
  it("dep-types-pairing: @types/* is kept alive when any TS file exists (blunt v1)", async () => {
    expect(await dependencyClaims("dep-types-pairing")).toEqual([
      expect.objectContaining({ name: "dead-lib", verdict: "unused" }),
    ]);
  });

  it("dep-jsx-runtime: react is kept alive under jsx:react-jsx with a .tsx file (the classic FP)", async () => {
    // `react` is never imported in source, yet must not be claimed; only the
    // genuinely-unused `unused-dep` is.
    expect(await dependencyClaims("dep-jsx-runtime")).toEqual([
      expect.objectContaining({ name: "unused-dep", verdict: "unused", confidence: "high" }),
    ]);
  });

  it("dep-jsx-js: react is kept alive under jsx:react-jsx even with a .js source (CRA-style)", async () => {
    expect(await dependencyClaims("dep-jsx-js")).toEqual([
      expect.objectContaining({ name: "unused-dep", verdict: "unused" }),
    ]);
  });

  it("dep-config-named: deps named in scripts/config (incl. eslint-plugin shorthand) are kept alive", async () => {
    // eslint-plugin-react (as "react"), eslint-plugin-import (as "import"),
    // eslint + prettier (in scripts) are all kept; only dead-lib is claimed.
    expect(await dependencyClaims("dep-config-named")).toEqual([
      expect.objectContaining({ name: "dead-lib", verdict: "unused" }),
    ]);
  });
});

describe("dependency claims — bin-only", () => {
  it("keeps a dep whose installed manifest declares bin, claims the one that does not", async () => {
    expect(await dependencyClaims("dep-bin-only")).toEqual([
      expect.objectContaining({ name: "dead-lib", verdict: "unused" }),
    ]);
  });
});

describe("dependency claims — workspaces & hoisting", () => {
  it("dep-workspace: a used workspace: sibling is kept, an unused one is claimed and tagged", async () => {
    expect(await dependencyClaims("dep-workspace")).toEqual([
      {
        name: "@fx/unused-sib",
        file: "packages/app/package.json",
        span: [6, 6], // the `"@fx/unused-sib"` line inside app's dependencies
        confidence: "high",
        verdict: "unused",
        package: "@fx/app", // tagged with the declaring workspace
      },
    ]);
  });

  it("dep-hoisted-root: a root dep imported only by a member is kept alive; an unused root dep is claimed", async () => {
    expect(await dependencyClaims("dep-hoisted-root")).toEqual([
      {
        name: "truly-unused",
        file: "package.json",
        span: [7, 7], // the `"truly-unused"` line inside the root dependencies
        confidence: "high",
        verdict: "unused",
        package: "@h/root",
      },
    ]);
  });
});
