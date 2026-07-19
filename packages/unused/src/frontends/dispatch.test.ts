import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isMixAvailable } from "../testing/corpus/elixir-corpus.js";
import { analyzeProjectAuto } from "./dispatch.js";

const elixirFixture = fileURLToPath(
  new URL("../../../../fixtures/elixir/test-only-zombie", import.meta.url),
);
const temporaryProjects: string[] = [];
const MIX_AVAILABLE = isMixAvailable();

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    temporaryProjects.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe.skipIf(!MIX_AVAILABLE)("mixed-language dispatch policy", () => {
  it("uses union config diagnostics and preserves configured zombie-test cost", async () => {
    const root = await mkdtemp(join(tmpdir(), "unused-mixed-policy-"));
    temporaryProjects.push(root);
    await cp(elixirFixture, root, { recursive: true });
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ name: "mixed-policy", type: "module", main: "src/index.ts" }),
    );
    await writeFile(join(root, "src", "index.ts"), "export const live = true;\n");
    await writeFile(join(root, "src", "orphan.ts"), "export const orphan = true;\n");
    await writeFile(
      join(root, "unused.config.jsonc"),
      JSON.stringify({
        entry: ["src/index.ts", "absent-entry/**/*.ts"],
        suppressions: [
          {
            files: ["src/orphan.ts"],
            kinds: ["file"],
            reason: "retained during migration",
          },
          {
            files: ["absent-suppression/**/*.ts"],
            kinds: ["file"],
            reason: "retained if generated",
          },
        ],
        ciSecondsPerTestFile: 12,
      }),
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const run = await analyzeProjectAuto(root, { now: new Date(0) });

    expect(run.summary.zombieTests).toMatchObject({
      avgSecondsPerTestFile: 12,
      estCiSecondsPerRun: 12,
    });
    expect(
      run.claims.find(
        (claim) => claim.subject.kind === "file" && claim.subject.loc.file === "src/orphan.ts",
      )?.suppression,
    ).toMatchObject({ reason: "retained during migration", source: "config" });
    const warnings = warn.mock.calls.map(([message]) => String(message));
    expect(warnings.some((message) => message.includes("src/index.ts"))).toBe(false);
    expect(warnings.some((message) => message.includes('"suppressions[0]"'))).toBe(false);
    expect(warnings.filter((message) => message.includes("absent-entry"))).toHaveLength(1);
    expect(warnings.filter((message) => message.includes('"suppressions[1]"'))).toHaveLength(1);
    expect(warnings).toHaveLength(2);
  }, 30_000);
});
