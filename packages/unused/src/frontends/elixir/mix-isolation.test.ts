import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ElixirCompileError } from "./errors.js";
import { discoverRustlerLoaders, type MixLayout, prepareIsolatedBuild } from "./mix-isolation.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "unused-mix-isolation-test-"));
  roots.push(root);
  return root;
}

function write(root: string, path: string, source: string): void {
  const fullPath = join(root, path);
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, source, "utf8");
}

function layout(app = "neutral"): MixLayout {
  return { app, buildPath: "_build/dev", sourcePaths: ["lib"], dependencyArtifacts: [] };
}

describe("discoverRustlerLoaders", () => {
  it("inventories exact literal Rustler loader identities", () => {
    const root = temporaryRoot();
    write(
      root,
      "lib/neutral/native.ex",
      `defmodule Neutral.Native do
  use Rustler, otp_app: :neutral, crate: :neutral_native
end
`,
    );

    expect(discoverRustlerLoaders(root, ["lib"])).toEqual([
      { module: "Neutral.Native", otpApp: "neutral" },
    ]);
  });

  it("refuses unresolved and conflicting loader configuration", () => {
    const dynamicRoot = temporaryRoot();
    write(
      dynamicRoot,
      "lib/neutral/native.ex",
      `defmodule Neutral.Native do
  use Rustler, otp_app: configured_app()
end
`,
    );
    expect(() => discoverRustlerLoaders(dynamicRoot, ["lib"])).toThrow(ElixirCompileError);

    const duplicateRoot = temporaryRoot();
    write(
      duplicateRoot,
      "lib/neutral/first.ex",
      `defmodule Neutral.Native do
  use Rustler, otp_app: :neutral
end
`,
    );
    write(
      duplicateRoot,
      "lib/neutral/second.ex",
      `defmodule Neutral.Native do
  use Rustler, otp_app: :neutral
end
`,
    );
    expect(() => discoverRustlerLoaders(duplicateRoot, ["lib"])).toThrow(ElixirCompileError);
  });

  it("includes directly compiled test files in the phase inventory", () => {
    const root = temporaryRoot();
    write(
      root,
      "test/neutral_native_test.exs",
      `defmodule Neutral.NativeTest do
  use Rustler, otp_app: :neutral
end
`,
    );

    expect(discoverRustlerLoaders(root, ["lib"], ["test/neutral_native_test.exs"])).toEqual([
      { module: "Neutral.NativeTest", otpApp: "neutral" },
    ]);
  });

  it("follows an explicitly compiled symlinked test file and refuses a missing one", () => {
    const root = temporaryRoot();
    const external = temporaryRoot();
    write(
      external,
      "neutral_native_test.exs",
      `defmodule Neutral.LinkedNativeTest do
  use Rustler, otp_app: :neutral
end
`,
    );
    mkdirSync(join(root, "test"));
    symlinkSync(
      join(external, "neutral_native_test.exs"),
      join(root, "test/neutral_native_test.exs"),
    );

    expect(discoverRustlerLoaders(root, ["lib"], ["test/neutral_native_test.exs"])).toEqual([
      { module: "Neutral.LinkedNativeTest", otpApp: "neutral" },
    ]);
    expect(() => discoverRustlerLoaders(root, ["lib"], ["test/missing_test.exs"])).toThrow(
      ElixirCompileError,
    );
  });

  it("follows symlinked source files and directories exactly once", () => {
    const root = temporaryRoot();
    const external = temporaryRoot();
    write(
      external,
      "native.ex",
      `defmodule Neutral.LinkedNative do
  use Rustler, otp_app: :neutral
end
`,
    );
    const externalFileRoot = temporaryRoot();
    write(
      externalFileRoot,
      "native.ex",
      `defmodule Neutral.AliasNative do
  use Rustler, otp_app: :neutral
end
`,
    );
    mkdirSync(join(root, "lib"), { recursive: true });
    symlinkSync(external, join(root, "lib/linked"));
    symlinkSync(join(externalFileRoot, "native.ex"), join(root, "lib/native_alias.ex"));
    symlinkSync(join(root, "lib"), join(external, "cycle"));

    expect(discoverRustlerLoaders(root, ["lib"])).toEqual([
      { module: "Neutral.AliasNative", otpApp: "neutral" },
      { module: "Neutral.LinkedNative", otpApp: "neutral" },
    ]);
  });
});

describe("prepareIsolatedBuild", () => {
  it("mirrors priv resources and internal symlinks without write-through", () => {
    const root = temporaryRoot();
    const isolated = join(temporaryRoot(), "build");
    write(root, "priv/assets/message.txt", "source\n");
    symlinkSync("assets/message.txt", join(root, "priv/message-link.txt"));
    symlinkSync(
      join(root, "priv/assets/message.txt"),
      join(root, "priv/absolute-message-link.txt"),
    );

    prepareIsolatedBuild(layout(), isolated, root);

    const mirroredPriv = join(isolated, "lib/neutral/priv");
    expect(readFileSync(join(mirroredPriv, "message-link.txt"), "utf8")).toBe("source\n");
    expect(readFileSync(join(mirroredPriv, "absolute-message-link.txt"), "utf8")).toBe("source\n");
    expect(lstatSync(join(mirroredPriv, "message-link.txt")).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(mirroredPriv, "absolute-message-link.txt"))).toBe(
      "assets/message.txt",
    );

    writeFileSync(join(mirroredPriv, "assets/message.txt"), "isolated\n", "utf8");
    expect(readFileSync(join(root, "priv/assets/message.txt"), "utf8")).toBe("source\n");
  });

  it("refuses external priv symlinks before exposing compiler write-through", () => {
    const root = temporaryRoot();
    const isolated = join(temporaryRoot(), "build");
    mkdirSync(join(root, "priv"), { recursive: true });
    const external = join(temporaryRoot(), "external.txt");
    writeFileSync(external, "external\n", "utf8");
    symlinkSync(external, join(root, "priv/external.txt"));

    expect(() => prepareIsolatedBuild(layout(), isolated, root)).toThrow(
      "application priv contains an external symbolic link",
    );
    expect(existsSync(join(isolated, "lib/neutral/priv/external.txt"))).toBe(false);
    expect(readFileSync(external, "utf8")).toBe("external\n");
  });
});
