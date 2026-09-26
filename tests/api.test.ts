import assert from "node:assert/strict";
import { test } from "node:test";
import { createApiServer } from "../src/api.js";
import type { WorkflowExecution } from "../src/types.js";

test("HTTP API validates requests, queues work, and returns saved progress", async () => {
  const execution: WorkflowExecution = { id: "00000000-0000-4000-8000-000000000001", workflowName: "demo", status: "pending", steps: [] };
  let enqueues = 0;
  let loads = 0;
  let fail = false;
  const server = createApiServer({
    workflowNames: () => ["demo"],
    enqueue: async () => { if (fail) throw new Error("private database detail"); enqueues++; return execution; },
    load: async id => { loads++; return id === execution.id ? execution : undefined; },
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = "http://127.0.0.1:" + address.port;
  const post = (body: string, contentType = "application/json") =>
    fetch(base + "/executions", { method: "POST", headers: { "Content-Type": contentType }, body });
  try {
    assert.deepEqual(await (await fetch(base + "/workflows")).json(), { workflows: ["demo"] });
    for (const body of ["{", "null", "[]", "{}", '{"workflowName":7}', '{"workflowName":"demo","input":{}}']) {
      assert.equal((await post(body)).status, 400);
    }
    assert.equal((await post('{"workflowName":"missing"}')).status, 404);
    assert.equal((await post("demo", "text/plain")).status, 415);
    assert.equal((await post(JSON.stringify({ workflowName: "x".repeat(17000) }))).status, 413);
    assert.equal(enqueues, 0);
    const queued = await post('{"workflowName":"demo"}');
    assert.equal(queued.status, 202);
    assert.equal(queued.headers.get("location"), "/executions/" + execution.id);
    assert.deepEqual(await queued.json(), execution);
    assert.equal(enqueues, 1);
    assert.equal((await fetch(base + "/executions/YOUR_EXECUTION_ID")).status, 400);
    assert.equal(loads, 0);
    execution.status = "completed";
    assert.deepEqual(await (await fetch(base + queued.headers.get("location"))).json(), execution);
    assert.equal((await fetch(base + "/executions/00000000-0000-4000-8000-000000000002")).status, 404);
    const wrongMethod = await fetch(base + "/executions");
    assert.equal(wrongMethod.status, 405);
    assert.equal(wrongMethod.headers.get("allow"), "POST");
    assert.equal((await fetch(base + "/missing")).status, 404);
    fail = true;
    const failed = await post('{"workflowName":"demo"}');
    assert.equal(failed.status, 500);
    assert.deepEqual(await failed.json(), { error: "Internal server error." });
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
