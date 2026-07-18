import { describe, expect, it } from "vitest";
import { TS_FRONTEND_MODULE } from "./index.js";

describe("frontends/ts", () => {
  it("exposes the placeholder module marker", () => {
    expect(TS_FRONTEND_MODULE).toBe("frontends/ts");
  });
});
