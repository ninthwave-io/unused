import { describe, expect, it } from "vitest";
import { REPORTERS_MODULE } from "./index.js";

describe("reporters", () => {
  it("exposes the placeholder module marker", () => {
    expect(REPORTERS_MODULE).toBe("reporters");
  });
});
