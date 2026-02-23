import { describe, it, expect, vi } from "vitest";

describe("MCP Server", () => {
  it("should export main function", async () => {
    const { main } = await import("../../src/mcp/server.js");
    expect(typeof main).toBe("function");
  });

  it("should initialize server and engine", async () => {
    vi.mock("../../src/mcp/config.js", () => ({
      createEngineFromEnv: vi.fn(),
    }));

    // This is a simple sanity check that the module can be imported
    // Full integration tests would require a real MCP server setup
    const serverModule = await import("../../src/mcp/server.js");
    expect(serverModule.main).toBeDefined();
  });
});
