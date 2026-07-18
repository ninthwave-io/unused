/**
 * Anti-drift test for the generated assumption set (T3.3): the committed
 * `docs/generated/assumption-set.md` must equal `renderAssumptionSet()`, so a
 * change to the globals constant or the hazard registry that is not regenerated
 * fails CI. Same guarantee as the scoreboard's committed-artifact test.
 */
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  ASSUMPTION_SET_VERSION,
  HAZARD_REGISTRY,
  renderAssumptionSet,
} from "../core/analysis/index.js";
import { assumptionSetDocPath } from "./assumption-set-doc.js";

describe("assumption set — generated-from-code, in sync with the registry", () => {
  it("the committed docs/generated/assumption-set.md matches renderAssumptionSet() (regenerating is a no-op)", async () => {
    const committed = await readFile(assumptionSetDocPath(), "utf8");
    expect(committed).toBe(renderAssumptionSet());
  });

  it("renders a clause for every hazard registry class (no class silently undocumented)", () => {
    const rendered = renderAssumptionSet();
    for (const cls of Object.keys(HAZARD_REGISTRY)) {
      expect(rendered, cls).toContain(`### ${cls}`);
    }
  });

  it("is deterministic (same output across calls) and stamped with the version", () => {
    expect(renderAssumptionSet()).toBe(renderAssumptionSet());
    expect(renderAssumptionSet()).toContain(`v${ASSUMPTION_SET_VERSION}`);
  });
});
