import { describe, expect, it } from "vitest";
import { MCP_MODULE } from "./index.js";

describe("mcp", () => {
  it("exposes the placeholder module marker", () => {
    expect(MCP_MODULE).toBe("mcp");
  });
});
