import { existsSync } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CargoCompileError,
  type CargoExecutionContext,
  CargoMetadataError,
  createCargoExecutionContext,
  disposeCargoExecutionContext,
  runCargo,
  validateCargoExecutionContext,
} from "./runner.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Cargo execution context", () => {
  it("creates an external target and disposes it idempotently", async () => {
    const project = await temporary("unused-cargo-context-project-");
    const parent = await temporary("unused-cargo-context-parent-");
    const context = createCargoExecutionContext(project, parent);

    expect(context.targetDir.startsWith(`${await realpath(parent)}/`)).toBe(true);
    expect(existsSync(context.targetDir)).toBe(true);
    context.dispose();
    context.dispose();
    expect(existsSync(context.targetDir)).toBe(false);
    expect(await readdir(parent)).toEqual([]);
  });

  it("rejects a temporary parent inside the consumer before touching its mtime", async () => {
    const project = await temporary("unused-cargo-context-contained-");
    const contained = join(project, "temporary");
    await mkdir(contained);
    const fixed = new Date("2002-03-04T05:06:07.000Z");
    await utimes(project, fixed, fixed);
    const before = await lstat(project, { bigint: true });
    const entries = await readdir(project);

    expect(() => createCargoExecutionContext(project, contained)).toThrow(CargoCompileError);
    expect(() => createCargoExecutionContext(project, contained, "metadata")).toThrow(
      CargoMetadataError,
    );

    expect(await readdir(project)).toEqual(entries);
    expect((await lstat(project, { bigint: true })).mtimeNs).toBe(before.mtimeNs);
  });

  it("binds an opaque execution context to exactly one project", async () => {
    const project = await temporary("unused-cargo-context-project-a-");
    const otherProject = await temporary("unused-cargo-context-project-b-");
    const parent = await temporary("unused-cargo-context-bound-parent-");
    const context = createCargoExecutionContext(project, parent);

    expect(() => validateCargoExecutionContext(otherProject, context)).toThrow(
      /belongs to a different project/,
    );
    expect(() =>
      runCargo(otherProject, ["metadata"], context, "unused-cargo-does-not-exist"),
    ).toThrow(/belongs to a different project/);

    const fabricated = {
      targetDir: context.targetDir,
      projectRoot: await realpath(project),
      dispose() {},
    } as unknown as CargoExecutionContext;
    expect(() =>
      runCargo(project, ["metadata"], fabricated, "unused-cargo-does-not-exist"),
    ).toThrow(/invalid execution context/);
  });

  it("preserves a primary failure when cleanup also fails", async () => {
    const primary = new CargoCompileError("compiler refusal");
    const project = await temporary("unused-cargo-cleanup-primary-project-");
    const parent = await temporary("unused-cargo-cleanup-primary-parent-");
    const context = createCargoExecutionContext(project, parent);
    vi.spyOn(context, "dispose").mockImplementation(() => {
      throw new Error("cleanup refusal");
    });

    expect(() => disposeCargoExecutionContext(context, primary)).not.toThrow();
    expect(primary.message).toContain("compiler refusal");
    expect(primary.message).toContain("also failed to remove its temporary build output");
  });

  it("fails explicitly when cleanup is the only failure", async () => {
    const project = await temporary("unused-cargo-cleanup-only-project-");
    const parent = await temporary("unused-cargo-cleanup-only-parent-");
    const context = createCargoExecutionContext(project, parent);
    vi.spyOn(context, "dispose").mockImplementation(() => {
      throw new Error("cleanup refusal");
    });

    expect(() => disposeCargoExecutionContext(context)).toThrow(CargoCompileError);
    expect(() => disposeCargoExecutionContext(context, undefined, "metadata")).toThrow(
      CargoMetadataError,
    );
  });

  it.each(["metadata", "compile"] as const)(
    "sanitizes arbitrary %s stderr and configured-command paths",
    async (operation) => {
      const project = await temporary(`unused-cargo-sanitize-${operation}-project-`);
      const parent = await temporary(`unused-cargo-sanitize-${operation}-parent-`);
      const wrapperRoot = await temporary(`unused-cargo-sanitize-${operation}-wrapper-`);
      const wrapper = join(wrapperRoot, "configured-command.mjs");
      await writeFile(
        wrapper,
        [
          "#!/usr/bin/env node",
          `process.stderr.write(${JSON.stringify(
            `sensitive path ${join(project, "opaque.rs")} symbol NeutralOpaqueSentinel generated diagnostic must not escape\\n`,
          )});`,
          "process.exit(23);",
          "",
        ].join("\n"),
      );
      await chmod(wrapper, 0o755);
      const context = createCargoExecutionContext(project, parent, operation);

      let failure: unknown;
      try {
        runCargo(project, [operation], context, wrapper, operation);
      } catch (error) {
        failure = error;
      } finally {
        context.dispose();
      }
      expect(failure).toBeInstanceOf(
        operation === "metadata" ? CargoMetadataError : CargoCompileError,
      );
      const message = failure instanceof Error ? failure.message : "";
      const guidance =
        operation === "metadata"
          ? "run `cargo metadata --frozen --format-version 1 --no-deps` directly for local diagnostics"
          : "run `cargo check --frozen --workspace --all-targets` and its `--all-features` pass directly for local diagnostics";
      expect(message).toBe(
        `Cargo ${operation} failed (exit 23): Cargo reported an error; ${guidance}`,
      );
      expect(message).not.toContain(project);
      expect(message).not.toContain(wrapper);
      expect(message).not.toContain("NeutralOpaqueSentinel");
      expect(message).not.toContain("must not escape");
    },
  );
});

async function temporary(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}
