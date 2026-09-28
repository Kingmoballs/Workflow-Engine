import { authorized, validateApiKey } from "./auth.js";
import { RetryConflictError } from "./control-errors.js";
import { validateVersion } from "./versioning.js";
import { validateTimeout } from "./timeout-options.js";
import { CancellationConflictError } from "./cancellation-error.js";
import { IdempotencyConflictError, validateSubmissionKey } from "./submission-key.js";
import { InvalidInputError, jsonSnapshot, type JsonValue } from "./json-data.js";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { WorkflowExecution } from "./types.js";

export interface ApiDependencies {
  workflowNames: () => string[];
  workflowVersions?: () => { name: string; version: number }[];
  list?: (params: URLSearchParams) => Promise<unknown>;
  retry?: (id: string, key: string) => Promise<WorkflowExecution | undefined>;
  history?: (id: string) => Promise<unknown | undefined>;
  health?: () => Promise<unknown>;
  metrics?: () => Promise<unknown>;
  enqueue: (name: string, input?: JsonValue, submissionKey?: string, timeoutMs?: number, workflowVersion?: number) => Promise<WorkflowExecution>;
  cancel?: (id: string) => Promise<WorkflowExecution | undefined>;
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

export function createApiServer(dependencies: ApiDependencies, options: { apiKey?: string } = {}) {
  if (options.apiKey !== undefined) validateApiKey(options.apiKey);
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://localhost");
      const path = url.pathname;
      if (path === "/health/live" && request.method === "GET") { json(response, 200, { status: "alive" }); return; }
      if (options.apiKey && (request.headersDistinct.authorization?.length !== 1 || !authorized(request.headers.authorization, options.apiKey))) {
        request.resume();
        response.setHeader("WWW-Authenticate", "Bearer");
        throw new HttpError(401, "Valid Bearer authentication is required.");
      }
      if (path === "/health/ready" || path === "/metrics") {
        if (request.method !== "GET") { response.setHeader("Allow", "GET"); throw new HttpError(405, "Method not allowed."); }
        const handler = path === "/metrics" ? dependencies.metrics : dependencies.health;
        if (!handler) throw new HttpError(501, "Monitoring is unavailable.");
        try { json(response, 200, await handler()); }
        catch { json(response, 503, { error: "Database or schema is unavailable." }); }
        return;
      }
      const control = /^\/executions\/([^/]+)\/(retry|retries)$/.exec(path);
      if (control) {
        const id = control[1]!;
        if (!uuid.test(id)) throw new HttpError(400, "Execution ID must be a UUID.");
        const history = control[2] === "retries";
        const method = history ? "GET" : "POST";
        if (request.method !== method) { response.setHeader("Allow", method); throw new HttpError(405, "Method not allowed."); }
        request.resume();
        let result;
        if (history) {
          if (!dependencies.history) throw new HttpError(501, "Retry history is unavailable.");
          result = await dependencies.history(id);
        } else {
          const keys = request.headersDistinct["idempotency-key"];
          if (!keys || keys.length !== 1) throw new HttpError(400, "Retry requires one Idempotency-Key.");
          const key = keys[0];
          validateSubmissionKey(key);
          if (!key) throw new HttpError(400, "Retry requires an Idempotency-Key.");
          if (!dependencies.retry) throw new HttpError(501, "Retry is unavailable.");
          result = await dependencies.retry(id, key);
        }
        if (result === undefined) throw new HttpError(404, "Execution not found.");
        json(response, history ? 200 : 202, history ? { retries: result } : result);
        return;
      }
      if (path === "/workflows") {
        if (request.method !== "GET") {
          response.setHeader("Allow", "GET");
          throw new HttpError(405, "Method not allowed.");
        }
        json(response, 200, { workflows: dependencies.workflowNames(), ...(dependencies.workflowVersions ? { definitions: dependencies.workflowVersions() } : {}) });
        return;
      }
      if (path === "/executions") {
        if (request.method === "GET" && dependencies.list) { json(response, 200, await dependencies.list(url.searchParams)); return; }
        if (request.method !== "POST") {
          response.setHeader("Allow", "POST");
          throw new HttpError(405, "Method not allowed.");
        }
        const keys = request.headersDistinct["idempotency-key"];
        if (keys && keys.length !== 1) throw new HttpError(400, "Send exactly one Idempotency-Key header.");
        const submissionKey = keys?.[0];
        validateSubmissionKey(submissionKey);
        const body = await readBody(request);
        if (!body || typeof body !== "object" || Array.isArray(body) ||
            !("workflowName" in body) || typeof body.workflowName !== "string" ||
            !body.workflowName.trim() || Object.keys(body).some(key => key !== "workflowName" && key !== "input" && key !== "timeoutMs" && key !== "workflowVersion")) {
          throw new HttpError(400, "Provide a nonempty workflowName and optional JSON input.");
        }
        if (!dependencies.workflowNames().includes(body.workflowName)) {
          throw new HttpError(404, "Unknown workflow.");
        }
        const workflowVersion = "workflowVersion" in body ? body.workflowVersion : undefined;
        validateVersion(workflowVersion);
        if (workflowVersion !== undefined && dependencies.workflowVersions && !dependencies.workflowVersions().some(item => item.name === body.workflowName && item.version === workflowVersion)) throw new HttpError(404, "Unknown workflow version.");
        const timeoutMs = "timeoutMs" in body ? body.timeoutMs : undefined;
        validateTimeout(timeoutMs);
        const execution = await dependencies.enqueue(body.workflowName, jsonSnapshot("input" in body ? body.input : null), submissionKey, timeoutMs, workflowVersion);
        response.setHeader("Location", "/executions/" + execution.id);
        json(response, 202, execution);
        return;
      }
      const cancellation = /^\/executions\/([^/]+)\/cancel$/.exec(path);
      if (cancellation) {
        if (request.method !== "POST") {
          response.setHeader("Allow", "POST");
          throw new HttpError(405, "Method not allowed.");
        }
        const id = cancellation[1]!;
        if (!uuid.test(id)) throw new HttpError(400, "Execution ID must be a UUID.");
        request.resume();
        if (!dependencies.cancel) throw new HttpError(501, "Cancellation is unavailable.");
        const execution = await dependencies.cancel(id);
        if (!execution) throw new HttpError(404, "Execution not found.");
        json(response, 200, execution);
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
      if (error instanceof IdempotencyConflictError || error instanceof CancellationConflictError || error instanceof RetryConflictError) json(response, 409, { error: error.message });
      else if (error instanceof InvalidInputError) json(response, 400, { error: error.message });
      else if (error instanceof HttpError) json(response, error.status, { error: error.message });
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
