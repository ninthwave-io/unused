import { describe, expect, it } from "vitest";
import {
  applyClaimFilters,
  buildSarifLog,
  REPORTERS_MODULE,
  renderHelp,
  renderSarif,
  renderTtyReport,
} from "./index.js";

describe("reporters — barrel exports", () => {
  it("exposes the module marker", () => {
    expect(REPORTERS_MODULE).toBe("reporters");
  });

  it("re-exports every reporter entry point", () => {
    expect(typeof applyClaimFilters).toBe("function");
    expect(typeof buildSarifLog).toBe("function");
    expect(typeof renderSarif).toBe("function");
    expect(typeof renderTtyReport).toBe("function");
    expect(typeof renderHelp).toBe("function");
  });
});
