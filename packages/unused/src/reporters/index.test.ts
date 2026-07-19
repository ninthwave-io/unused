import { describe, expect, it } from "vitest";
import {
  applyClaimFilters,
  buildSarifLog,
  computeBadge,
  REPORTERS_MODULE,
  renderBadgeJson,
  renderHelp,
  renderReportHtml,
  renderReportMarkdown,
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
    expect(typeof renderReportMarkdown).toBe("function");
    expect(typeof renderReportHtml).toBe("function");
    expect(typeof computeBadge).toBe("function");
    expect(typeof renderBadgeJson).toBe("function");
  });
});
