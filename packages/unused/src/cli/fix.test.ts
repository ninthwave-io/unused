import { chmod, mkdir, mkdtemp, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Claim } from "../core/claims/index.js";
import { applyFixes, type FixType } from "./fix.js";

function claim(
  kind: "export" | "dependency" | "file",
  name: string,
  file: string,
  line = 1,
  overrides: Partial<Claim> = {},
): Claim {
  return {
    id: `${kind}_${name}`,
    subject: { kind, name, loc: { file, span: [line, line] } },
    verdict: "unused",
    confidence: "high",
    evidence: [{ type: "static-reachability", detail: "unreachable", source: "test" }],
    provenance: { analyzer: "test", version: "0", generatedAt: "T" },
    ...overrides,
  } as Claim;
}

async function root(): Promise<string> {
  return mkdtemp(join(tmpdir(), "unused-fix-"));
}

const all = new Set<FixType>(["exports", "dependencies", "files"]);

describe("applyFixes", () => {
  it("makes a named declaration private without deleting locally useful code", async () => {
    const dir = await root();
    await writeFile(join(dir, "mod.ts"), "export function helper() { return 1; }\nhelper();\n");
    const result = await applyFixes({
      root: dir,
      claims: [claim("export", "helper", "mod.ts")],
      types: all,
      allowRemoveFiles: false,
    });
    expect(result.applied).toHaveLength(1);
    expect(await readFile(join(dir, "mod.ts"), "utf8")).toBe(
      "function helper() { return 1; }\nhelper();\n",
    );
  });

  it("removes one export-list specifier and preserves the declaration", async () => {
    const dir = await root();
    await writeFile(
      join(dir, "mod.ts"),
      "const helper = 1;\nconst live = 2;\nexport { helper, live };\n",
    );
    await applyFixes({
      root: dir,
      claims: [claim("export", "helper", "mod.ts", 3)],
      types: all,
      allowRemoveFiles: false,
    });
    const text = await readFile(join(dir, "mod.ts"), "utf8");
    expect(text).not.toMatch(/export\s*\{[^}]*helper/u);
    expect(text).toContain("export { live }");
    expect(text).toContain("const helper = 1");
  });

  it("does not consume a following statement when removing a semicolonless export list", async () => {
    const dir = await root();
    await writeFile(
      join(dir, "mod.ts"),
      "const dead = 1\nexport { dead }\nsideEffect()\nfunction sideEffect() {}\n",
    );
    const result = await applyFixes({
      root: dir,
      claims: [claim("export", "dead", "mod.ts", 2)],
      types: all,
      allowRemoveFiles: false,
    });
    expect(result.applied).toHaveLength(1);
    const text = await readFile(join(dir, "mod.ts"), "utf8");
    expect(text).toContain("sideEffect()\nfunction sideEffect() {}");
    expect(text).not.toContain("export { dead }");
  });

  it("skips an export-list rewrite when comments make the edit ambiguous", async () => {
    const dir = await root();
    const source = "const dead = 1, live = 2;\nexport { dead /* keep context */, live };\n";
    await writeFile(join(dir, "mod.ts"), source);
    const result = await applyFixes({
      root: dir,
      claims: [claim("export", "dead", "mod.ts", 2)],
      types: all,
      allowRemoveFiles: false,
    });
    expect(result.applied).toHaveLength(0);
    expect(result.skipped[0]?.reason).toContain("could not be rewritten safely");
    expect(await readFile(join(dir, "mod.ts"), "utf8")).toBe(source);
  });

  it.each(["export default function () { return 1; }\n", "export default class { value = 1; }\n"])(
    "skips anonymous default declarations: %s",
    async (source) => {
      const dir = await root();
      await writeFile(join(dir, "mod.ts"), source);
      const result = await applyFixes({
        root: dir,
        claims: [claim("export", "default", "mod.ts")],
        types: all,
        allowRemoveFiles: false,
      });
      expect(result.applied).toHaveLength(0);
      expect(result.skipped[0]?.reason).toContain("anonymous default");
      expect(await readFile(join(dir, "mod.ts"), "utf8")).toBe(source);
    },
  );

  it("skips a shared declaration when another exported binding is not eligible", async () => {
    const dir = await root();
    const source = "export const dead = 1, live = 2;\n";
    await writeFile(join(dir, "mod.ts"), source);
    const result = await applyFixes({
      root: dir,
      claims: [claim("export", "dead", "mod.ts")],
      types: all,
      allowRemoveFiles: false,
    });
    expect(result.applied).toHaveLength(0);
    expect(result.skipped[0]?.reason).toContain("also exposes");
    expect(await readFile(join(dir, "mod.ts"), "utf8")).toBe(source);
  });

  it("fixes two independent export declarations in the same file", async () => {
    const dir = await root();
    await writeFile(join(dir, "mod.ts"), "export const first = 1;\nexport const second = 2;\n");
    const result = await applyFixes({
      root: dir,
      claims: [claim("export", "first", "mod.ts", 1), claim("export", "second", "mod.ts", 2)],
      types: all,
      allowRemoveFiles: false,
    });
    expect(result.eligible).toBe(2);
    expect(result.applied).toHaveLength(2);
    expect(result.skipped).toHaveLength(0);
    expect(await readFile(join(dir, "mod.ts"), "utf8")).toBe(
      "const first = 1;\nconst second = 2;\n",
    );
  });

  it("removes multiple eligible specifiers from one export list in one validated edit", async () => {
    const dir = await root();
    await writeFile(
      join(dir, "mod.ts"),
      "const first = 1, keep = 2, second = 3;\nexport { first, keep, second };\n",
    );
    const result = await applyFixes({
      root: dir,
      claims: [claim("export", "first", "mod.ts", 2), claim("export", "second", "mod.ts", 2)],
      types: all,
      allowRemoveFiles: false,
    });
    expect(result.eligible).toBe(2);
    expect(result.applied).toHaveLength(2);
    expect(result.skipped).toHaveLength(0);
    expect(await readFile(join(dir, "mod.ts"), "utf8")).toBe(
      "const first = 1, keep = 2, second = 3;\nexport { keep };\n",
    );
  });

  it("removes required aliased re-exports before making the origin private", async () => {
    const dir = await root();
    await writeFile(join(dir, "origin.ts"), "export const dead = 1;\n");
    await writeFile(join(dir, "barrel.ts"), 'export { dead as legacy } from "./origin.js";\n');
    const dead = claim("export", "dead", "origin.ts");
    const result = await applyFixes({
      root: dir,
      claims: [dead],
      types: all,
      allowRemoveFiles: false,
      requiredReExports: [
        {
          claimId: dead.id,
          type: "exports",
          file: "barrel.ts",
          line: 1,
          exportedName: "legacy",
        },
      ],
    });
    expect(result.skipped).toHaveLength(0);
    expect(result.applied).toHaveLength(2);
    expect(await readFile(join(dir, "origin.ts"), "utf8")).toBe("const dead = 1;\n");
    expect(await readFile(join(dir, "barrel.ts"), "utf8")).toBe("\n");
  });

  it("removes one required re-export specifier and preserves its live sibling", async () => {
    const dir = await root();
    await writeFile(join(dir, "origin.ts"), "export const dead = 1;\n");
    await writeFile(
      join(dir, "barrel.ts"),
      'export { dead as legacy, live } from "./origin.js";\n',
    );
    const dead = claim("export", "dead", "origin.ts");
    const result = await applyFixes({
      root: dir,
      claims: [dead],
      types: all,
      allowRemoveFiles: false,
      requiredReExports: [
        {
          claimId: dead.id,
          type: "exports",
          file: "barrel.ts",
          line: 1,
          exportedName: "legacy",
        },
      ],
    });
    expect(result.skipped).toHaveLength(0);
    expect(await readFile(join(dir, "barrel.ts"), "utf8")).toBe(
      'export { live } from "./origin.js";\n',
    );
  });

  it("groups multiple required re-export specifiers into one exact edit", async () => {
    const dir = await root();
    await writeFile(join(dir, "origin.ts"), "export const first = 1;\nexport const second = 2;\n");
    await writeFile(join(dir, "barrel.ts"), 'export { first, keep, second } from "./origin.js";\n');
    const first = claim("export", "first", "origin.ts", 1);
    const second = claim("export", "second", "origin.ts", 2);
    const result = await applyFixes({
      root: dir,
      claims: [first, second],
      types: all,
      allowRemoveFiles: false,
      requiredReExports: [
        {
          claimId: first.id,
          type: "exports",
          file: "barrel.ts",
          line: 1,
          exportedName: "first",
        },
        {
          claimId: second.id,
          type: "exports",
          file: "barrel.ts",
          line: 1,
          exportedName: "second",
        },
      ],
    });
    expect(result.eligible).toBe(2);
    expect(result.applied).toHaveLength(4);
    expect(result.skipped).toHaveLength(0);
    expect(await readFile(join(dir, "origin.ts"), "utf8")).toBe(
      "const first = 1;\nconst second = 2;\n",
    );
    expect(await readFile(join(dir, "barrel.ts"), "utf8")).toBe(
      'export { keep } from "./origin.js";\n',
    );
  });

  it("preflights every required re-export before changing the barrel or origin", async () => {
    const dir = await root();
    const origin = "export const dead = 1;\n";
    const barrel = 'export { dead } from "./origin.js";\n';
    await writeFile(join(dir, "origin.ts"), origin);
    await writeFile(join(dir, "barrel.ts"), barrel);
    const dead = claim("export", "dead", "origin.ts");
    const result = await applyFixes({
      root: dir,
      claims: [dead],
      types: all,
      allowRemoveFiles: false,
      requiredReExports: [
        { claimId: dead.id, type: "exports", file: "barrel.ts", line: 1, exportedName: "dead" },
        { claimId: dead.id, type: "exports", file: "missing.ts", line: 1, exportedName: "dead" },
      ],
    });
    expect(result.applied).toHaveLength(0);
    expect(result.skipped[0]?.reason).toContain("preflight failed");
    expect(await readFile(join(dir, "origin.ts"), "utf8")).toBe(origin);
    expect(await readFile(join(dir, "barrel.ts"), "utf8")).toBe(barrel);
  });

  it("preserves frozen barrel line provenance across separate claim transactions", async () => {
    const dir = await root();
    await writeFile(join(dir, "a.ts"), "export const a = 1;\n");
    await writeFile(join(dir, "b.ts"), "export const b = 2;\n");
    await writeFile(
      join(dir, "barrel.ts"),
      'export { a } from "./a.js";\nexport { b } from "./b.js";\n',
    );
    const a = claim("export", "a", "a.ts");
    const b = claim("export", "b", "b.ts");
    const result = await applyFixes({
      root: dir,
      claims: [a, b],
      types: all,
      allowRemoveFiles: false,
      requiredReExports: [
        { claimId: a.id, type: "exports", file: "barrel.ts", line: 1, exportedName: "a" },
        { claimId: b.id, type: "exports", file: "barrel.ts", line: 2, exportedName: "b" },
      ],
    });
    expect(result.skipped).toHaveLength(0);
    expect(result.applied).toHaveLength(4);
    expect(await readFile(join(dir, "barrel.ts"), "utf8")).toBe("\n\n");
  });

  it("honours explicit graph blockers without touching the source", async () => {
    const dir = await root();
    const source = "export const dead = 1;\n";
    await writeFile(join(dir, "mod.ts"), source);
    const dead = claim("export", "dead", "mod.ts");
    const result = await applyFixes({
      root: dir,
      claims: [dead],
      types: all,
      allowRemoveFiles: false,
      blockedClaims: [
        {
          claimId: dead.id,
          type: "exports",
          file: "mod.ts",
          reason: "deletion plan unsupported: test invariant",
        },
      ],
    });
    expect(result.applied).toHaveLength(0);
    expect(result.skipped[0]?.reason).toContain("deletion plan unsupported");
    expect(await readFile(join(dir, "mod.ts"), "utf8")).toBe(source);
  });

  it("removes a dependency manifest line without rewriting the rest of the file", async () => {
    const dir = await root();
    const source =
      '{\n  "name": "app",\n  "dependencies": {\n    "keep": "1",\n    "dead": "2"\n  }\n}\n';
    await writeFile(join(dir, "package.json"), source);
    const result = await applyFixes({
      root: dir,
      claims: [claim("dependency", "dead", "package.json", 5)],
      types: all,
      allowRemoveFiles: false,
    });
    expect(result.applied).toHaveLength(1);
    expect(await readFile(join(dir, "package.json"), "utf8")).toBe(
      '{\n  "name": "app",\n  "dependencies": {\n    "keep": "1"\n  }\n}\n',
    );
  });

  it("removes the only dependency without touching the surrounding object comma", async () => {
    const dir = await root();
    const source =
      '{\n  "name": "app",\n  "dependencies": {\n    "only": "1"\n  },\n  "private": true\n}\n';
    await writeFile(join(dir, "package.json"), source);
    const result = await applyFixes({
      root: dir,
      claims: [claim("dependency", "only", "package.json", 4)],
      types: all,
      allowRemoveFiles: false,
    });
    expect(result.applied).toHaveLength(1);
    const text = await readFile(join(dir, "package.json"), "utf8");
    expect(JSON.parse(text)).toMatchObject({ name: "app", dependencies: {}, private: true });
    expect(text).toContain('"dependencies": {\n  },');
  });

  it("removes multiple frozen dependency claims from one manifest atomically", async () => {
    const dir = await root();
    await writeFile(
      join(dir, "package.json"),
      '{\n  "dependencies": {\n    "dead-a": "1",\n    "dead-b": "1",\n    "keep": "1"\n  }\n}\n',
      { mode: 0o640 },
    );
    const result = await applyFixes({
      root: dir,
      claims: [
        claim("dependency", "dead-a", "package.json", 3),
        claim("dependency", "dead-b", "package.json", 4),
      ],
      types: all,
      allowRemoveFiles: false,
    });
    expect(result.applied).toHaveLength(2);
    expect(result.skipped).toHaveLength(0);
    const path = join(dir, "package.json");
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ dependencies: { keep: "1" } });
    expect((await stat(path)).mode & 0o777).toBe(0o640);
  });

  it("requires explicit file-removal permission", async () => {
    const dir = await root();
    await writeFile(join(dir, "dead.ts"), "export const dead = true;\n");
    const without = await applyFixes({
      root: dir,
      claims: [claim("file", "dead.ts", "dead.ts")],
      types: all,
      allowRemoveFiles: false,
    });
    expect(without.skipped[0]?.reason).toContain("--allow-remove-files");
    expect(await readFile(join(dir, "dead.ts"), "utf8")).toContain("dead");

    const withPermission = await applyFixes({
      root: dir,
      claims: [claim("file", "dead.ts", "dead.ts")],
      types: all,
      allowRemoveFiles: true,
    });
    expect(withPermission.applied).toHaveLength(1);
    await expect(readFile(join(dir, "dead.ts"), "utf8")).rejects.toThrow();
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "rolls back an installed re-export edit when a later file deletion fails",
    async () => {
      const dir = await root();
      await mkdir(join(dir, "locked"));
      const targetPath = join(dir, "locked/dead.ts");
      const barrelPath = join(dir, "barrel.ts");
      const target = "export const dead = true;\n";
      const barrel = 'export { dead } from "./locked/dead.js";\n';
      await writeFile(targetPath, target);
      await writeFile(barrelPath, barrel);
      const dead = claim("file", "locked/dead.ts", "locked/dead.ts");
      await chmod(join(dir, "locked"), 0o555);
      try {
        const result = await applyFixes({
          root: dir,
          claims: [dead],
          types: all,
          allowRemoveFiles: true,
          requiredReExports: [
            {
              claimId: dead.id,
              type: "files",
              file: "barrel.ts",
              line: 1,
              exportedName: "dead",
            },
          ],
        });
        expect(result.applied).toHaveLength(0);
        expect(result.skipped[0]?.reason).toContain("transaction failed");
        expect(await readFile(barrelPath, "utf8")).toBe(barrel);
        expect(await readFile(targetPath, "utf8")).toBe(target);
      } finally {
        await chmod(join(dir, "locked"), 0o755);
      }
    },
  );

  it("never fixes suppressed, test-only, or non-high claims", async () => {
    const dir = await root();
    const source = "export const a = 1;\nexport const b = 2;\nexport const c = 3;\n";
    await writeFile(join(dir, "mod.ts"), source);
    const claims = [
      claim("export", "a", "mod.ts", 1, { suppression: { reason: "policy" } }),
      claim("export", "b", "mod.ts", 2, { verdict: "test-only" }),
      claim("export", "c", "mod.ts", 3, { confidence: "medium" }),
    ];
    const result = await applyFixes({ root: dir, claims, types: all, allowRemoveFiles: true });
    expect(result.eligible).toBe(0);
    expect(await readFile(join(dir, "mod.ts"), "utf8")).toBe(source);
  });

  it("refuses to follow an in-root source symlink outside the project", async () => {
    const dir = await root();
    const external = await root();
    const outside = join(external, "outside.ts");
    const source = "export const dead = 1;\n";
    await writeFile(outside, source);
    await symlink(outside, join(dir, "mod.ts"));

    const result = await applyFixes({
      root: dir,
      claims: [claim("export", "dead", "mod.ts")],
      types: all,
      allowRemoveFiles: false,
    });
    expect(result.applied).toHaveLength(0);
    expect(result.skipped[0]?.reason).toContain("escapes project root");
    expect(await readFile(outside, "utf8")).toBe(source);
  });

  it("refuses file removal through a symlinked parent outside the project", async () => {
    const dir = await root();
    const external = await root();
    await mkdir(join(external, "nested"));
    const outside = join(external, "nested/dead.ts");
    await writeFile(outside, "export const dead = true;\n");
    await symlink(join(external, "nested"), join(dir, "linked"));

    const result = await applyFixes({
      root: dir,
      claims: [claim("file", "linked/dead.ts", "linked/dead.ts")],
      types: all,
      allowRemoveFiles: true,
    });
    expect(result.applied).toHaveLength(0);
    expect(result.skipped[0]?.reason).toContain("escapes project root");
    expect(await readFile(outside, "utf8")).toContain("dead");
  });
});
