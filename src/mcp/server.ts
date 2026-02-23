import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerTools } from "./tools.js";
import { createEngineFromEnv } from "./config.js";

async function main() {
  const deps = await createEngineFromEnv();

  const server = new Server(
    { name: "doc-search", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  registerTools(server, deps);

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  process.stderr.write(
    `Doc Search MCP server error: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
});
