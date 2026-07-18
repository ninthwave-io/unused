import { describe, expect, it } from "vitest";
import { CORE_MODULE } from "./index.js";

describe("core", () => {
  it("exposes the placeholder module marker", () => {
    expect(CORE_MODULE).toBe("core");
  });
});
