import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { selectProjectBoundaries } from "./boundaries.js";

const MIX = { language: "ex", manifestName: "mix.exs", projectKind: "mix" } as const;

describe("selectProjectBoundaries", () => {
  it("lets a root manifest own nested same-ecosystem projects", () => {
    expect(
      selectProjectBoundaries("/repo", ["/repo", "/repo/apps/a", "/repo/apps/b"], MIX),
    ).toEqual([
      {
        id: "ex:.",
        language: "ex",
        rootDir: "/repo",
        rootRelDir: "",
        manifest: "mix.exs",
        projectKind: "mix",
      },
    ]);
  });

  it("keeps sibling nested projects and removes their deeper children", () => {
    const root = join("/repo", "root");
    expect(
      selectProjectBoundaries(
        root,
        [join(root, "services", "b"), join(root, "apps", "a", "child"), join(root, "apps", "a")],
        MIX,
      ).map((boundary) => ({ id: boundary.id, manifest: boundary.manifest })),
    ).toEqual([
      { id: "ex:apps/a", manifest: "apps/a/mix.exs" },
      { id: "ex:services/b", manifest: "services/b/mix.exs" },
    ]);
  });

  it("refuses a manifest directory outside the repository", () => {
    expect(() => selectProjectBoundaries("/repo/root", ["/repo/other"], MIX)).toThrow(
      "project boundary escapes repository root",
    );
  });
});
