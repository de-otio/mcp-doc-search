/**
 * HTTP transport setup for the MCP server.
 * Provides Streamable HTTP transport with health endpoint.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { registerTools } from "./tools.js";
import type { EngineDeps } from "./config.js";

const startTime = Date.now();

/** Idle timeout before disposing the embed pipeline (5 minutes). */
const IDLE_DISPOSE_MS = 5 * 60 * 1000;

function handleHealth(res: ServerResponse): void {
  const body = JSON.stringify({ status: "ok", uptime: (Date.now() - startTime) / 1000 });
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(body);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/**
 * Start an HTTP server that wraps the MCP server with Streamable HTTP transport.
 *
 * Each POST /mcp request gets its own stateless transport + Server instance,
 * but shares the expensive deps (embedProvider, store, indexer).
 *
 * @param deps - Shared engine dependencies (embed provider, vector store, indexer)
 * @param port - TCP port to listen on (default 8181)
 * @returns Promise that resolves when the server is listening
 */
export async function startHttpServer(
  deps: EngineDeps,
  port: number,
  idleDisposalMs = IDLE_DISPOSE_MS,
): Promise<void> {
  // Idle disposal timer: disposes the embed pipeline after N ms with no MCP requests.
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  function resetIdleTimer(): void {
    if (idleTimer !== null) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      deps.embedProvider.dispose?.();
      idleTimer = null;
    }, idleDisposalMs);
  }

  /**
   * Factory: create a fresh MCP Server for each request (stateless pattern).
   * The expensive deps are captured via closure and shared across requests.
   */
  function createMcpServer(): Server {
    const server = new Server(
      { name: "doc-search", version: "0.1.0" },
      { capabilities: { tools: {} } },
    );
    registerTools(server, deps);
    return server;
  }

  const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? "/";
    const method = req.method ?? "GET";

    if (method === "GET" && url === "/health") {
      handleHealth(res);
      return;
    }

    if (url === "/mcp") {
      resetIdleTimer();

      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      const mcpServer = createMcpServer();

      try {
        let parsedBody: unknown;
        if (method === "POST") {
          const raw = await readBody(req);
          try {
            parsedBody = JSON.parse(raw);
          } catch {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Invalid JSON" }));
            return;
          }
        } else if (method !== "GET" && method !== "DELETE") {
          res.writeHead(405, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Method not allowed" }));
          return;
        }

        await mcpServer.connect(transport);
        await transport.handleRequest(req, res, parsedBody);

        res.on("close", () => {
          transport.close().catch(() => undefined);
          mcpServer.close().catch(() => undefined);
        });
      } catch (err) {
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              jsonrpc: "2.0",
              error: { code: -32603, message: String(err) },
              id: null,
            }),
          );
        }
      }
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  });

  return new Promise((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(port, "127.0.0.1", () => {
      process.stderr.write(`MCP HTTP server listening on http://127.0.0.1:${port}\n`);
      resolve();
    });
  });
}
