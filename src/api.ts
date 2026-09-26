import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { WorkflowExecution } from "./types.js";

export interface ApiDependencies {
  workflowNames: () => string[];
  enqueue: (name: string) => Promise<WorkflowExecution>;
  load: (id: string) => Promise<WorkflowExecution | undefined>;
}

class HttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const maxBodyBytes = 16 * 1024;

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  response.end(JSON.stringify(body));
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  if (request.headers["content-type"]?.split(";")[0]?.trim().toLowerCase() !== "application/json") {
    request.resume();
    throw new HttpError(415, "Use Content-Type: application/json.");
  }
  // Drain oversized requests without retaining their remaining bytes.
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > maxBodyBytes) {
      request.resume();
      throw new HttpError(413, "Request body exceeds 16 KiB.");
    }
    chunks.push(Buffer.from(chunk));
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown; }
  catch { throw new HttpError(400, "Request body must be valid JSON."); }
}

export function createApiServer(dependencies: ApiDependencies) {
  const server = createServer(async (request, response) => {
    try {
      const path = new URL(request.url ?? "/", "http://localhost").pathname;
      if (path === "/workflows") {
        if (request.method !== "GET") {
          response.setHeader("Allow", "GET");
          throw new HttpError(405, "Method not allowed.");
        }
        json(response, 200, { workflows: dependencies.workflowNames() });
        return;
      }
      if (path === "/executions") {
        if (request.method !== "POST") {
          response.setHeader("Allow", "POST");
          throw new HttpError(405, "Method not allowed.");
        }
        const body = await readBody(request);
        if (!body || typeof body !== "object" || Array.isArray(body) ||
            !("workflowName" in body) || typeof body.workflowName !== "string" ||
            !body.workflowName.trim() || Object.keys(body).some(key => key !== "workflowName")) {
          throw new HttpError(400, "Provide only a nonempty workflowName string.");
        }
        if (!dependencies.workflowNames().includes(body.workflowName)) {
          throw new HttpError(404, "Unknown workflow.");
        }
        const execution = await dependencies.enqueue(body.workflowName);
        response.setHeader("Location", "/executions/" + execution.id);
        json(response, 202, execution);
        return;
      }
      const match = /^\/executions\/([^/]+)$/.exec(path);
      if (match) {
        if (request.method !== "GET") {
          response.setHeader("Allow", "GET");
          throw new HttpError(405, "Method not allowed.");
        }
        const id = match[1]!;
        if (!uuid.test(id)) throw new HttpError(400, "Execution ID must be a UUID.");
        const execution = await dependencies.load(id);
        if (!execution) throw new HttpError(404, "Execution not found.");
        json(response, 200, execution);
        return;
      }
      throw new HttpError(404, "Route not found.");
    } catch (error) {
      if (response.destroyed) return;
      if (error instanceof HttpError) json(response, error.status, { error: error.message });
      else {
        console.error("API request failed:", error);
        json(response, 500, { error: "Internal server error." });
      }
    }
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  return server;
}
