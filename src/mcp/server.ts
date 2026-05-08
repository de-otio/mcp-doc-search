import { spawn } from "node:child_process";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerTools } from "./tools.js";
import { createEngineFromEnv } from "./config.js";
import { startHttpServer } from "./http.js";
import { stopDaemon, writePidFile } from "./daemon.js";

export function parseArgs(argv: string[]): {
  http: boolean;
  port: number;
  daemon: boolean;
  stop: boolean;
} {
  const args = argv.slice(2); // drop 'node' and script path
  const result = { http: false, port: 8181, daemon: false, stop: false };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--http") {
      result.http = true;
    } else if (arg === "--daemon") {
      result.daemon = true;
    } else if (arg === "--stop" || arg === "stop") {
      result.stop = true;
    } else if (arg === "--port" && i + 1 < args.length) {
      const n = parseInt(args[++i], 10);
      if (!isNaN(n) && n > 0 && n < 65536) result.port = n;
    }
  }

  return result;
}

async function main() {
  const { http, port, daemon, stop } = parseArgs(process.argv);

  // Handle stop subcommand
  if (stop) {
    await stopDaemon();
    return;
  }

  // Daemon: fork a detached child and exit parent
  if (http && daemon) {
    const child = spawn(process.execPath, [process.argv[1], "--http", "--port", String(port)], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
    const pid = child.pid!;
    writePidFile(pid);
    process.stdout.write(`MCP daemon started (PID: ${pid}, port: ${port})\n`);
    return;
  }

  const deps = await createEngineFromEnv();

  if (http) {
    // HTTP transport mode
    await startHttpServer(deps, port);

    // Keep the process alive and handle graceful shutdown
    const shutdown = () => {
      process.stderr.write("MCP HTTP server shutting down\n");
      process.exit(0);
    };
    process.on("SIGTERM", shutdown);
    process.on("SIGINT", shutdown);
  } else {
    // Default: stdio transport
    const server = new Server(
      { name: "doc-search", version: "0.1.0" },
      { capabilities: { tools: {} } },
    );
    registerTools(server, deps);
    const transport = new StdioServerTransport();
    await server.connect(transport);
  }
}

main().catch((err) => {
  process.stderr.write(
    `Doc Search MCP server error: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
});
