import { describe, expect, it } from "vitest";
import { type DeletionPlanView, renderDeletionPlan } from "./deletion-plan.js";

const PLAN: DeletionPlanView = {
  selected: { kind: "export", file: "src/origin.ts", name: "thing", line: 2 },
  supported: true,
  reExportEdits: [
    {
      kind: "remove-re-export",
      file: "src/api.ts",
      line: 7,
      exportedName: "thing",
      targetFile: "src/mid.ts",
      targetName: "thing",
    },
  ],
  stages: [
    { stage: 1, newlyDead: [{ kind: "file", file: "src/mid.ts" }] },
    {
      stage: 2,
      newlyDead: [{ kind: "export", file: "src/leaf.ts", name: "leaf", line: 4 }],
    },
  ],
};

describe("renderDeletionPlan", () => {
  it("renders edits and deterministic consequence stages", () => {
    expect(renderDeletionPlan(PLAN, false)).toMatchInlineSnapshot(`
      "deletion plan — src/origin.ts:2 thing

        required re-export edits:
          - src/api.ts:7 remove re-export \`thing\` → src/mid.ts:thing

        newly dead after deletion:
          stage 1:
            - src/mid.ts
          stage 2:
            - src/leaf.ts:4 leaf

        consequence plan only — claim verdicts and gates are unchanged.
      "
    `);
  });

  it("renders unsupported dependency planning conservatively", () => {
    expect(
      renderDeletionPlan(
        {
          selected: { kind: "dependency", file: "package.json", name: "some-package" },
          supported: false,
          unsupportedReason: "dependency deletion has no graph cascade model",
          reExportEdits: [],
          stages: [],
        },
        true,
      ),
    ).toBe(
      "deletion plan -- some-package (package.json)\n\n" +
        "  no graph cascade: dependency deletion has no graph cascade model\n",
    );
  });

  it("keeps unsupported and dependency states out of consequence rendering", () => {
    // @ts-expect-error A dependency has no supported graph cascade rendering.
    const supportedDependency: DeletionPlanView = {
      selected: { kind: "dependency", file: "package.json", name: "some-package" },
      supported: true,
      reExportEdits: [],
      stages: [],
    };
    // @ts-expect-error Unsupported views cannot carry stages the renderer would silently ignore.
    const unsupportedWithStage: DeletionPlanView = {
      selected: { kind: "file", file: "src/origin.ts" },
      supported: false,
      unsupportedReason: "not modeled",
      reExportEdits: [],
      stages: [{ stage: 1, newlyDead: [{ kind: "file" as const, file: "src/orphan.ts" }] }],
    };
    expect(supportedDependency.supported).toBe(true);
    expect(unsupportedWithStage.stages).toHaveLength(1);
  });
});
