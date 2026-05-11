/**
 * HTTP transport setup for the MCP server.
 * Provides Streamable HTTP transport with health endpoint.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { registerTools } from "./tools.js";
import type { EngineDeps } from "./config.js";
import { sanitizeForClient } from "./errors.js";

const startTime = Date.now();

/** Idle timeout before disposing the embed pipeline (5 minutes). */
const IDLE_DISPOSE_MS = 5 * 60 * 1000;

/**
 * Hard cap on a single MCP request body. M2: prevents a misbehaving (or
 * adversarial) local client from buffering unbounded data into the daemon's
 * memory. Real MCP requests are JSON-RPC envelopes, typically under a few KB;
 * 10 MB is a generous ceiling that still bounds worst-case allocation.
 */
const MAX_BODY_BYTES = 10 * 1024 * 1024;

/** Sentinel thrown by readBody when the cap is exceeded. */
class BodyTooLargeError extends Error {
  constructor() {
    super("request body exceeds 10 MB limit");
    this.name = "BodyTooLargeError";
  }
}

function handleHealth(res: ServerResponse): void {
  const body = JSON.stringify({ status: "ok", uptime: (Date.now() - startTime) / 1000 });
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(body);
}

function readBody(req: IncomingMessage, maxBytes = MAX_BODY_BYTES): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let aborted = false;
    req.on("data", (chunk: Buffer) => {
      if (aborted) return;
      total += chunk.length;
      if (total > maxBytes) {
        aborted = true;
        // Stop reading further data; leave the socket open so the caller can
        // send a 413 response. The request stream will be destroyed by the
        // caller once the response is on the wire.
        req.pause();
        reject(new BodyTooLargeError());
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (aborted) return;
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", (err) => {
      if (aborted) return;
      reject(err);
    });
  });
}

export { BodyTooLargeError, MAX_BODY_BYTES };

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
          let raw: string;
          try {
            raw = await readBody(req);
          } catch (bodyErr) {
            // M2: 10 MB request body cap. readBody paused the request stream;
            // send 413, then destroy the socket so the client doesn't keep
            // pushing bytes we'll never read.
            if (bodyErr instanceof BodyTooLargeError) {
              if (!res.headersSent) {
                res.writeHead(413, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ error: "Request body too large (max 10 MB)" }));
              }
              req.destroy();
              return;
            }
            throw bodyErr;
          }
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
        // M3: never echo raw caught errors to JSON-RPC clients —
        // they often embed absolute filesystem paths. Log the full
        // error to stderr for the operator; return a sanitized message.
        const safe = sanitizeForClient(err, "/mcp");
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              jsonrpc: "2.0",
              error: { code: -32603, message: safe },
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
