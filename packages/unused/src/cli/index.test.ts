import { describe, expect, it } from "vitest";
import { CLI_MODULE } from "./index.js";

describe("cli", () => {
  it("exposes the placeholder module marker", () => {
    expect(CLI_MODULE).toBe("cli");
  });
});
