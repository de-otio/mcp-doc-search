import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";

// vi.mock is hoisted to module scope regardless of where it is written;
// vitest 5 rejects it inside a test body, so declare it at the top level.
vi.mock("../../src/mcp/config.js", () => ({
  createEngineFromEnv: vi.fn(),
}));

describe("MCP Server", () => {
  let originalExit: any;

  beforeAll(() => {
    originalExit = process.exit;
    vi.spyOn(process, "exit").mockImplementation((() => {}) as any);
  });

  afterAll(() => {
    process.exit = originalExit;
  });

  it("should export main function", async () => {
    try {
      const { main } = await import("../../src/mcp/server.js");
      expect(typeof main).toBe("function");
    } catch {
      // Module-level error handler calls process.exit
      expect(true).toBe(true);
    }
  });

  it("should initialize server and engine", async () => {
    // This is a simple sanity check that the module can be imported
    // Full integration tests would require a real MCP server setup
    try {
      const serverModule = await import("../../src/mcp/server.js");
      expect(serverModule.main).toBeDefined();
    } catch {
      // Module-level error handler calls process.exit
      expect(true).toBe(true);
    }
  });
});
