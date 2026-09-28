import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { after, before, beforeEach, test } from "node:test";
import pg from "pg";
import type { RetryPolicy, WorkflowDefinition, WorkflowExecution } from "../src/types.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const schema = "retry_test_" + randomUUID().replaceAll("-", "");
const originalUrl = process.env.DATABASE_URL;
if (!originalUrl) throw new Error("Tests require the local DATABASE_URL from .env.");
const admin = new pg.Pool({ connectionString: originalUrl, max: 1 });
let schemaCreated = false;
let pool: pg.Pool;
let runWorkflow: typeof import("../src/engine.js").runWorkflow;
let saveExecution: typeof import("../src/execution-store.js").saveExecution;
let loadExecution: typeof import("../src/execution-store.js").loadExecution;
let RetryableError: typeof import("../src/errors.js").RetryableError;
let createSimulatedPayment: typeof import("../src/simulated-payments.js").createSimulatedPayment;
const fast: RetryPolicy = { maxAttempts: 3, initialDelayMs: 5, maxDelayMs: 10 };

before(async () => {
  await admin.query(`CREATE SCHEMA "${schema}"`);
  schemaCreated = true;
  const scoped = new URL(originalUrl);
  // Exclude public: a missing test table must never fall through to user data.
  scoped.searchParams.set("options", "-c search_path=" + schema);
  process.env.DATABASE_URL = scoped.toString();
  ({ pool } = await import("../src/database.js"));
  const schemaCheck = await pool.query("SELECT current_schema() AS name");
  assert.equal(schemaCheck.rows[0].name, schema, "Test connection must use its isolated schema");
  for (const filename of [
    "001_create_execution_tables.sql",
    "002_create_simulated_payments.sql",
    "003_add_retry_schedule.sql",
    "004_worker_leases.sql",
    "005_execution_data.sql",
    "006_submission_idempotency.sql",
    "007_cancellation.sql",
    "008_execution_timeouts.sql",
    "009_release.sql",
  ]) {
    await pool.query(await readFile(new URL("../migrations/" + filename, import.meta.url), "utf8"));
  }
  ({ runWorkflow } = await import("../src/engine.js"));
  ({ saveExecution, loadExecution } = await import("../src/execution-store.js"));
  ({ RetryableError } = await import("../src/errors.js"));
  ({ createSimulatedPayment } = await import("../src/simulated-payments.js"));
});

beforeEach(async () => {
  const schemaCheck = await pool.query("SELECT current_schema() AS name");
  assert.equal(schemaCheck.rows[0].name, schema);
  await pool.query("TRUNCATE execution_retries, worker_presence, simulated_payments, step_executions, workflow_executions");
});

after(async () => {
  try {
    if (pool) await pool.end();
  } finally {
    try {
      if (schemaCreated && /^retry_test_[a-f0-9]{32}$/.test(schema)) {
        await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
      }
    } finally {
      await admin.end();
      process.env.DATABASE_URL = originalUrl;
    }
  }
});

function saved(
  name: string,
  steps: WorkflowExecution["steps"],
  status: WorkflowExecution["status"] = "running",
): WorkflowExecution {
  return { id: randomUUID(), workflowName: name, status, steps };
}

test("transient failures retry with capped backoff, stable keys and clean success", async () => {
  const keys: string[] = [];
  const times: number[] = [];
  let reserveCalls = 0;
  let deliveryCalls = 0;
  const workflow: WorkflowDefinition = {
    name: "retry-success",
    steps: [
      { name: "reserve", execute: async () => { reserveCalls++; } },
      {
        name: "pay",
        retry: { maxAttempts: 4, initialDelayMs: 10, maxDelayMs: 15 },
        execute: async (context) => {
          keys.push(context.idempotencyKey);
          times.push(Date.now());
          const checkpoint = await loadExecution(context.executionId);
          assert.equal(checkpoint?.steps[1]?.attempts, context.attempt);
          assert.equal(checkpoint?.steps[1]?.status, "running");
          assert.equal(checkpoint?.steps[1]?.nextAttemptAt, undefined);
          assert.equal(checkpoint?.steps[1]?.error, undefined);
          if (context.attempt < 4) throw new RetryableError("temporary");
        },
      },
      { name: "deliver", execute: async () => { deliveryCalls++; } },
    ],
  };
  const result = await runWorkflow(workflow);
  assert.equal(result.status, "completed");
  assert.equal(reserveCalls, 1);
  assert.equal(deliveryCalls, 1);
  assert.equal(keys.length, 4);
  assert.equal(new Set(keys).size, 1);
  assert.equal(keys[0], result.id + ":1");
  assert.ok(times[1]! - times[0]! >= 10);
  assert.ok(times[2]! - times[1]! >= 15);
  assert.ok(times[3]! - times[2]! >= 15);
  const loaded = await loadExecution(result.id);
  assert.deepEqual(loaded?.steps.map((step) => step.attempts), [1, 4, 1]);
  assert.equal(loaded?.steps[1]?.error, undefined);
  assert.equal(loaded?.steps[1]?.nextAttemptAt, undefined);
});

test("ordinary errors stop immediately and leave following steps pending", async () => {
  let calls = 0;
  const result = await runWorkflow({
    name: "permanent",
    steps: [
      { name: "fail", retry: fast, execute: async () => { calls++; throw new Error("invalid input"); } },
      { name: "later", execute: async () => { assert.fail("must not run"); } },
    ],
  });
  assert.equal(calls, 1);
  assert.equal(result.status, "failed");
  assert.equal(result.steps[0]?.error, "invalid input");
  assert.equal(result.steps[0]?.nextAttemptAt, undefined);
  assert.equal(result.steps[1]?.status, "pending");
});

test("exhausted attempt budgets survive a later resume", async () => {
  let calls = 0;
  const workflow: WorkflowDefinition = {
    name: "exhausted",
    steps: [{
      name: "fail",
      retry: { ...fast, maxAttempts: 2 },
      execute: async () => { calls++; throw new RetryableError("still unavailable"); },
    }],
  };
  const result = await runWorkflow(workflow);
  assert.equal(result.status, "failed");
  assert.equal(calls, 2);
  const loaded = await loadExecution(result.id);
  assert.ok(loaded);
  await runWorkflow(workflow, loaded);
  assert.equal(calls, 2);
  assert.equal(loaded.steps[0]?.attempts, 2);
  assert.equal(loaded.steps[0]?.nextAttemptAt, undefined);
});

test("an interrupted final attempt is not executed beyond its budget", async () => {
  const execution = saved("interrupted-cap", [{ name: "pay", status: "running", attempts: 3 }]);
  await saveExecution(execution);
  const result = await runWorkflow({
    name: execution.workflowName,
    steps: [{ name: "pay", retry: fast, execute: async () => { assert.fail("attempt cap"); } }],
  }, execution);
  assert.equal(result.status, "failed");
  assert.match(result.steps[0]?.error ?? "", /interrupted attempt/);
  assert.equal(result.steps[0]?.attempts, 3);
});

test("resume waits for the stored deadline and skips completed steps at their cap", async () => {
  const deadline = Date.now() + 100;
  const execution = saved("resume-future", [
    { name: "done", status: "completed", attempts: 3 },
    { name: "pay", status: "pending", attempts: 1, error: "temporary", nextAttemptAt: new Date(deadline).toISOString() },
  ]);
  await saveExecution(execution);
  const loaded = await loadExecution(execution.id);
  assert.ok(loaded);
  const result = await runWorkflow({
    name: execution.workflowName,
    steps: [
      { name: "done", retry: fast, execute: async () => { assert.fail("completed step repeated"); } },
      { name: "pay", retry: fast, execute: async (context) => {
        assert.ok(Date.now() >= deadline, "retry started before its deadline");
        assert.equal(context.attempt, 2);
        assert.equal(context.idempotencyKey, execution.id + ":1");
      } },
    ],
  }, loaded);
  assert.equal(result.id, execution.id);
  assert.equal(result.status, "completed");
  assert.equal(result.steps[1]?.error, undefined);
  assert.equal(result.steps[1]?.nextAttemptAt, undefined);
});

test("invalid retry policies are rejected before any execution or step is saved", async () => {
  for (const retry of [
    { ...fast, maxAttempts: 0 },
    { ...fast, maxAttempts: 1.5 },
    { ...fast, initialDelayMs: 0 },
    { ...fast, maxDelayMs: 1 },
    { ...fast, maxDelayMs: 2_147_483_648 },
  ]) {
    await assert.rejects(runWorkflow({
      name: "invalid",
      steps: [{ name: "never", retry, execute: async () => { assert.fail("must not run"); } }],
    }), /Invalid retry policy/);
  }
  const count = await pool.query("SELECT COUNT(*)::integer AS count FROM workflow_executions");
  assert.equal(count.rows[0].count, 0);
});

test("checkpoint failure after an effect propagates without retrying the effect", async () => {
  await pool.query(`
    CREATE FUNCTION reject_completed_checkpoint() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.status = 'completed' THEN
        RAISE EXCEPTION 'test checkpoint failure';
      END IF;
      RETURN NEW;
    END;
    $$;
    CREATE TRIGGER reject_completed BEFORE INSERT OR UPDATE ON step_executions
    FOR EACH ROW EXECUTE FUNCTION reject_completed_checkpoint();
  `);
  let calls = 0;
  try {
    await assert.rejects(runWorkflow({
      name: "checkpoint-error",
      steps: [{ name: "effect", retry: fast, execute: async () => { calls++; } }],
    }), /test checkpoint failure/);
    assert.equal(calls, 1);
    const rows = await pool.query("SELECT status, attempts, error FROM step_executions");
    assert.deepEqual(rows.rows, [{ status: "running", attempts: 1, error: null }]);
  } finally {
    await pool.query("DROP TRIGGER reject_completed ON step_executions");
    await pool.query("DROP FUNCTION reject_completed_checkpoint()");
  }
});

test("an invalid step save rolls back its parent workflow row", async () => {
  const execution = saved("rollback", [{ name: "bad", status: "pending", attempts: -1 }]);
  await assert.rejects(saveExecution(execution));
  assert.equal(await loadExecution(execution.id), undefined);
});

test("concurrent requests for one simulated payment return one payment ID", async () => {
  const key = randomUUID() + ":1";
  const ids = await Promise.all(Array.from({ length: 8 }, () => createSimulatedPayment(key)));
  assert.equal(new Set(ids).size, 1);
  const rows = await pool.query("SELECT id FROM simulated_payments WHERE idempotency_key = $1", [key]);
  assert.equal(rows.rowCount, 1);
  assert.equal(rows.rows[0].id, ids[0]);
});

test("already completed executions are not executed again", async () => {
  const execution = saved("completed", [{ name: "done", status: "completed", attempts: 1 }], "completed");
  await saveExecution(execution);
  const result = await runWorkflow({
    name: execution.workflowName,
    steps: [{ name: "done", execute: async () => { assert.fail("already complete"); } }],
  }, execution);
  assert.equal(result.status, "completed");
  assert.equal(result.steps[0]?.attempts, 1);
});

test("a changed workflow definition is rejected before resuming", async () => {
  const execution = saved("mismatch", [{ name: "original", status: "running", attempts: 1 }]);
  await saveExecution(execution);
  await assert.rejects(runWorkflow({
    name: execution.workflowName,
    steps: [{ name: "changed", execute: async () => { assert.fail("mismatched"); } }],
  }, execution), /does not match step/);
});

function startFixture(mode: string, executionId?: string) {
  const args = ["--import", "tsx", "tests/fixtures/retry-worker.ts", mode];
  if (executionId) args.push(executionId);
  const child = spawn(process.execPath, args, {
    cwd: root, env: { ...process.env }, windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const state = { output: "", exited: false };
  child.stdout.on("data", (data) => { state.output += data.toString(); });
  child.stderr.on("data", (data) => { state.output += data.toString(); });
  const exited = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => { state.exited = true; resolve(code); });
  });
  return { child, state, exited };
}

async function waitForOutput(fixture: ReturnType<typeof startFixture>, marker: string) {
  const deadline = Date.now() + 10_000;
  while (!fixture.state.output.includes(marker)) {
    if (fixture.state.exited || Date.now() > deadline) {
      throw new Error("Fixture did not reach " + marker + ": " + fixture.state.output);
    }
    await delay(10);
  }
}

for (const mode of ["retry", "effect"]) {
  test("process restart preserves " + (mode === "retry" ? "the scheduled retry" : "the committed payment"), { timeout: 20_000 }, async () => {
    const first = startFixture(mode);
    let second: ReturnType<typeof startFixture> | undefined;
    try {
      await waitForOutput(first, mode === "retry" ? "Retry scheduled" : "TEST_EFFECT_COMMITTED");
      first.child.kill("SIGKILL");
      await first.exited;

      const id = /Execution ID: ([a-f0-9-]{36})/.exec(first.state.output)?.[1];
      assert.ok(id, first.state.output);
      const paymentId = /PAYMENT_ID ([a-f0-9-]{36})/.exec(first.state.output)?.[1];
      assert.ok(paymentId);
      const checkpoint = await loadExecution(id);
      assert.ok(checkpoint);
      assert.equal(checkpoint.steps[0]?.status, "completed");
      assert.equal(checkpoint.steps[1]?.attempts, 1);
      assert.equal(checkpoint.steps[1]?.status, mode === "retry" ? "pending" : "running");
      const deadline = checkpoint.steps[1]?.nextAttemptAt;
      if (mode === "retry") assert.ok(deadline);

      await waitForLeaseExpiry(id);
      second = startFixture(mode, id);
      const exitCode = await second.exited;
      assert.equal(exitCode, 0, second.state.output);
      assert.ok(second.state.output.includes("Skipping completed step: reserve"));
      assert.ok(!second.state.output.includes("RESERVE_EXECUTED"));
      assert.ok(second.state.output.includes("Reusing simulated payment: " + paymentId));
      assert.ok(second.state.output.includes("FIXTURE_DONE " + id + " completed"));
      if (deadline) {
        const started = Number(/ATTEMPT_START 2 (\d+)/.exec(second.state.output)?.[1]);
        assert.ok(started >= Date.parse(deadline), "retry began before persisted deadline");
      }
      const result = await loadExecution(id);
      assert.equal(result?.status, "completed");
      assert.equal(result?.steps[1]?.attempts, 2);
      assert.equal(result?.steps[1]?.nextAttemptAt, undefined);
      const payments = await pool.query("SELECT id FROM simulated_payments WHERE idempotency_key = $1", [id + ":1"]);
      assert.deepEqual(payments.rows, [{ id: paymentId }]);
    } finally {
      if (!first.state.exited) { first.child.kill("SIGKILL"); await first.exited; }
      if (second && !second.state.exited) { second.child.kill("SIGKILL"); await second.exited; }
    }
  });
}


// Queue and ownership tests share the isolated schema above.
async function queueRecord(name = "queue-test", stepName = "work") {
  const execution = saved(name, [{ name: stepName, status: "pending", attempts: 0 }], "pending");
  await saveExecution(execution);
  return execution;
}

async function expireLease(id: string) {
  await pool.query("UPDATE workflow_executions SET lease_expires_at = clock_timestamp() - INTERVAL '1 second' WHERE id = $1", [id]);
}

async function waitForLeaseExpiry(id: string) {
  const timeout = Date.now() + 5_000;
  while (true) {
    const check = await pool.query(
      "SELECT lease_expires_at IS NOT NULL AND lease_expires_at > clock_timestamp() AS active FROM workflow_executions WHERE id = $1",
      [id],
    );
    if (!check.rows[0]?.active) return;
    if (Date.now() > timeout) throw new Error("Test lease did not expire.");
    await delay(20);
  }
}

test("enqueue persists pending work and does not execute payment", async () => {
  const { enqueueWorkflow } = await import("../src/enqueue-workflow.js");
  const execution = await enqueueWorkflow("retry-demo");
  assert.equal(execution.status, "pending");
  assert.ok(execution.steps.every((step) => step.status === "pending" && step.attempts === 0));
  assert.deepEqual(await loadExecution(execution.id), execution);
  const payments = await pool.query("SELECT COUNT(*)::integer AS count FROM simulated_payments");
  assert.equal(payments.rows[0].count, 0);
});

test("enqueue rejects unknown workflow names without creating records", async () => {
  const { enqueueWorkflow } = await import("../src/enqueue-workflow.js");
  await assert.rejects(enqueueWorkflow("unknown-workflow"), /Unknown workflow/);
  const result = await pool.query("SELECT COUNT(*)::integer AS count FROM workflow_executions");
  assert.equal(result.rows[0].count, 0);
});

test("competing claimers have one winner for a single queued execution", async () => {
  const { claimNextExecution, releaseLease } = await import("../src/leases.js");
  const execution = await queueRecord();
  const claims = await Promise.all(Array.from({ length: 8 }, (_, index) =>
    claimNextExecution("worker-" + index, ["queue-test"]),
  ));
  const winners = claims.filter((lease) => lease !== undefined);
  assert.equal(winners.length, 1);
  assert.equal(winners[0]?.executionId, execution.id);
  await releaseLease(winners[0]!);
});

test("workers claim distinct jobs and skip a parent row locked by another transaction", async () => {
  const { claimNextExecution, releaseLease } = await import("../src/leases.js");
  const first = await queueRecord();
  const second = await queueRecord();
  const locker = await pool.connect();
  let lease: Awaited<ReturnType<typeof claimNextExecution>>;
  try {
    await locker.query("BEGIN");
    await locker.query("SELECT id FROM workflow_executions WHERE id = $1 FOR UPDATE", [first.id]);
    lease = await claimNextExecution("other", ["queue-test"]);
    assert.equal(lease?.executionId, second.id);
    await locker.query("COMMIT");
    const next = await claimNextExecution("next", ["queue-test"]);
    assert.equal(next?.executionId, first.id);
    if (next) await releaseLease(next);
  } finally {
    await locker.query("ROLLBACK");
    locker.release();
    if (lease) await releaseLease(lease);
  }
});

test("expired owner cannot renew, release or checkpoint after a new generation", async () => {
  const { claimExecution, renewLease, releaseLease } = await import("../src/leases.js");
  const execution = await queueRecord();
  await pool.query("UPDATE workflow_executions SET lease_generation = 9007199254740993 WHERE id = $1", [execution.id]);
  const old = await claimExecution(execution.id, "same-owner");
  assert.ok(old);
  assert.equal(old.token, "9007199254740994");
  await expireLease(execution.id);
  assert.equal(await renewLease(old), undefined);
  const next = await claimExecution(execution.id, "same-owner");
  assert.ok(next);
  assert.equal(next.token, "9007199254740995");
  execution.status = "completed";
  execution.steps[0]!.status = "completed";
  execution.steps[0]!.attempts = 99;
  await assert.rejects(saveExecution(execution, old), { name: "LeaseLostError" });
  assert.equal(await renewLease(old), undefined);
  assert.equal(await releaseLease(old), false);
  const actual = await loadExecution(execution.id);
  assert.equal(actual?.status, "running");
  assert.equal(actual?.steps[0]?.status, "pending");
  assert.equal(actual?.steps[0]?.attempts, 0);
  assert.equal(await releaseLease(next), true);
});

test("save and renew recheck expiry after waiting for a locked row", async () => {
  const { claimExecution, renewLease } = await import("../src/leases.js");
  const execution = await queueRecord();
  const lease = await claimExecution(execution.id, "expired-in-lock-wait", 400);
  assert.ok(lease);
  const locker = await pool.connect();
  try {
    await locker.query("BEGIN");
    await locker.query("SELECT id FROM workflow_executions WHERE id = $1 FOR UPDATE", [execution.id]);
    const update = saveExecution(execution, lease).then(() => undefined, (error: unknown) => error);
    const renewal = renewLease(lease);
    await delay(500);
    await locker.query("COMMIT");
    const error = await update;
    assert.equal((error as Error).name, "LeaseLostError");
    assert.equal(await renewal, undefined);
  } finally {
    await locker.query("ROLLBACK");
    locker.release();
  }
});

test("unfenced saves cannot overwrite an existing execution", async () => {
  const execution = await queueRecord();
  execution.status = "completed";
  await assert.rejects(saveExecution(execution));
  assert.equal((await loadExecution(execution.id))?.status, "pending");
});

test("automatic claims exclude terminal, unknown and not-yet-due executions", async () => {
  const { claimNextExecution, releaseLease } = await import("../src/leases.js");
  const delayed = saved("queue-test", [{
    name: "wait", status: "pending", attempts: 1,
    nextAttemptAt: new Date(Date.now() + 60_000).toISOString(),
  }]);
  await saveExecution(delayed);
  await saveExecution(saved("queue-test", [], "failed"));
  await saveExecution(saved("queue-test", [], "completed"));
  await queueRecord("unknown");
  const ready = await queueRecord();
  const lease = await claimNextExecution("selector", ["queue-test"]);
  assert.equal(lease?.executionId, ready.id);
  assert.equal(await claimNextExecution("second-selector", ["queue-test"]), undefined);
  if (lease) await releaseLease(lease);
});

test("heartbeats retain ownership throughout a handler longer than its lease", async () => {
  const { claimExecution } = await import("../src/leases.js");
  let start!: () => void;
  const started = new Promise<void>((resolve) => { start = resolve; });
  let executionId = "";
  const running = runWorkflow({
    name: "heartbeat",
    steps: [{ name: "long", execute: async ({ executionId: id, signal }) => {
      executionId = id;
      start();
      await delay(1_400, undefined, { signal });
    } }],
  }, undefined, { leaseMs: 800 });
  await started;
  await delay(1_000);
  assert.equal(await claimExecution(executionId, "thief", 800), undefined);
  assert.equal((await running).status, "completed");
  const row = await pool.query("SELECT lease_owner FROM workflow_executions WHERE id = $1", [executionId]);
  assert.equal(row.rows[0].lease_owner, null);
});

test("two direct runners cannot execute the same live job", async () => {
  const execution = await queueRecord("direct-race");
  let enter!: () => void;
  let finish!: () => void;
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  const blocked = new Promise<void>((resolve) => { finish = resolve; });
  let calls = 0;
  const workflow: WorkflowDefinition = {
    name: "direct-race", steps: [{ name: "work", execute: async () => { calls++; enter(); await blocked; } }],
  };
  const first = runWorkflow(workflow, execution);
  try {
    await entered;
    await assert.rejects(runWorkflow(workflow, execution), { name: "ExecutionBusyError" });
  } finally {
    finish();
  }
  assert.equal((await first).status, "completed");
  assert.equal(calls, 1);
});

test("a stale handler cannot publish success or release the new owner's lease", async () => {
  const { claimExecution, releaseLease } = await import("../src/leases.js");
  const { runClaimedWorkflow } = await import("../src/engine.js");
  const execution = await queueRecord("stale-handler");
  const old = await claimExecution(execution.id, "old", 5_000);
  assert.ok(old);
  let enter!: () => void;
  let finish!: () => void;
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  const blocked = new Promise<void>((resolve) => { finish = resolve; });
  const result = runClaimedWorkflow({
    name: "stale-handler", steps: [{ name: "work", execute: async () => { enter(); await blocked; } }],
  }, old).then(() => undefined, (error: unknown) => error);
  await entered;
  await expireLease(execution.id);
  const next = await claimExecution(execution.id, "new", 5_000);
  assert.ok(next);
  finish();
  const error = await result;
  assert.equal((error as Error).name, "LeaseLostError");
  assert.equal((await loadExecution(execution.id))?.steps[0]?.status, "running");
  const row = await pool.query("SELECT lease_owner FROM workflow_executions WHERE id = $1", [execution.id]);
  assert.equal(row.rows[0].lease_owner, "new");
  await releaseLease(next);
});

test("cooperative shutdown releases ownership and leaves work recoverable", async () => {
  const shutdown = new AbortController();
  let enter!: () => void;
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  let id = "";
  const running = runWorkflow({
    name: "shutdown",
    steps: [{ name: "wait", execute: async (context) => {
      id = context.executionId;
      enter();
      await delay(60_000, undefined, { signal: context.signal });
    } }],
  }, undefined, { signal: shutdown.signal }).then(() => undefined, (error: unknown) => error);
  await entered;
  shutdown.abort(new Error("test shutdown"));
  assert.match((await running as Error).message, /test shutdown/);
  const execution = await loadExecution(id);
  assert.equal(execution?.status, "running");
  assert.equal(execution?.steps[0]?.status, "running");
  assert.equal(execution?.steps[0]?.error, undefined);
  const row = await pool.query("SELECT lease_owner FROM workflow_executions WHERE id = $1", [id]);
  assert.equal(row.rows[0].lease_owner, null);
});

test("worker yields delayed retries, processes another job, then resumes the original", async () => {
  const { runWorker } = await import("../src/worker.js");
  let calls = 0;
  const workflow: WorkflowDefinition = {
    name: "yield-test",
    steps: [{
      name: "work",
      retry: { maxAttempts: 3, initialDelayMs: 5_000, maxDelayMs: 5_000 },
      execute: async ({ attempt }) => { calls++; if (attempt === 1) throw new RetryableError("wait"); },
    }],
  };
  const first = await queueRecord("yield-test");
  await runWorker({ once: true, workflows: [workflow] });
  const waiting = await loadExecution(first.id);
  assert.equal(waiting?.steps[0]?.status, "pending");
  assert.ok(waiting?.steps[0]?.nextAttemptAt);
  const owner = await pool.query("SELECT lease_owner FROM workflow_executions WHERE id = $1", [first.id]);
  assert.equal(owner.rows[0].lease_owner, null);
  const second = await queueRecord("other-job");
  const other: WorkflowDefinition = { name: "other-job", steps: [{ name: "work", execute: async () => {} }] };
  await runWorker({ once: true, workflows: [workflow, other] });
  assert.equal((await loadExecution(second.id))?.status, "completed");
  assert.equal(calls, 1);
  await pool.query("UPDATE step_executions SET next_attempt_at = clock_timestamp() - INTERVAL '1 second' WHERE workflow_execution_id = $1", [first.id]);
  await runWorker({ once: true, workflows: [workflow, other] });
  assert.equal((await loadExecution(first.id))?.status, "completed");
  assert.equal(calls, 2);
});

function startQueueFixture(mode: string) {
  const child = spawn(process.execPath, ["--import", "tsx", "tests/fixtures/queue-worker.ts", mode], {
    cwd: root, env: { ...process.env }, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
  });
  const state = { output: "", exited: false };
  child.stdout.on("data", (data) => { state.output += data.toString(); });
  child.stderr.on("data", (data) => { state.output += data.toString(); });
  const exited = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => { state.exited = true; resolve(code); });
  });
  return { child, state, exited };
}

test("two worker processes process one queue job without a duplicate attempt", { timeout: 20_000 }, async () => {
  const execution = await queueRecord("queue-fixture", "pay");
  const first = startQueueFixture("once");
  const second = startQueueFixture("once");
  try {
    assert.deepEqual(await Promise.all([first.exited, second.exited]), [0, 0], first.state.output + second.state.output);
    const record = await loadExecution(execution.id);
    assert.equal(record?.status, "completed");
    assert.equal(record?.steps[0]?.attempts, 1);
    const result = await pool.query("SELECT COUNT(*)::integer AS count FROM simulated_payments");
    assert.equal(result.rows[0].count, 1);
  } finally {
    for (const fixture of [first, second]) {
      if (!fixture.state.exited) { fixture.child.kill("SIGKILL"); await fixture.exited; }
    }
  }
});

test("a new worker reclaims a killed worker's job and reuses its payment", { timeout: 20_000 }, async () => {
  const execution = await queueRecord("queue-fixture", "pay");
  const first = startQueueFixture("crash");
  let second: ReturnType<typeof startQueueFixture> | undefined;
  try {
    await waitForOutput(first, "QUEUE_EFFECT");
    first.child.kill("SIGKILL");
    await first.exited;
    const paymentId = /QUEUE_EFFECT ([a-f0-9-]{36})/.exec(first.state.output)?.[1];
    assert.ok(paymentId);
    await waitForLeaseExpiry(execution.id);
    second = startQueueFixture("once");
    assert.equal(await second.exited, 0, second.state.output);
    assert.ok(second.state.output.includes("Reusing simulated payment: " + paymentId));
    const record = await loadExecution(execution.id);
    assert.equal(record?.status, "completed");
    assert.equal(record?.steps[0]?.attempts, 2);
    const payments = await pool.query("SELECT id FROM simulated_payments");
    assert.deepEqual(payments.rows, [{ id: paymentId }]);
  } finally {
    for (const fixture of [first, second]) {
      if (fixture && !fixture.state.exited) { fixture.child.kill("SIGKILL"); await fixture.exited; }
    }
  }
});

test("HTTP submission persists a job that the engine completes and HTTP can inspect", async () => {
  const { createApiServer } = await import("../src/api.js");
  const { enqueueWorkflow } = await import("../src/enqueue-workflow.js");
  const { getWorkflow, listWorkflows } = await import("../src/workflow-registry.js");
  const server = createApiServer({
    workflowNames: () => listWorkflows().map(workflow => workflow.name),
    enqueue: enqueueWorkflow,
    load: loadExecution,
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = "http://127.0.0.1:" + address.port;
  try {
    const response = await fetch(base + "/executions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workflowName: "retry-demo" }),
    });
    assert.equal(response.status, 202);
    const queued = await response.json() as WorkflowExecution;
    assert.equal(queued.status, "pending");
    assert.equal((await pool.query("SELECT count(*)::int AS count FROM simulated_payments")).rows[0].count, 0);
    await runWorkflow(getWorkflow("retry-demo"), queued);
    const result = await fetch(base + response.headers.get("location"));
    assert.equal(result.status, 200);
    const completed = await result.json() as WorkflowExecution;
    assert.equal(completed.status, "completed");
    assert.equal(completed.steps[1]?.attempts, 3);
    assert.equal((await pool.query("SELECT count(*)::int AS count FROM simulated_payments")).rows[0].count, 1);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});

test("saved inputs and outputs survive yielding and isolate handler mutations", async () => {
  const { createPendingExecution } = await import("../src/workflow-definition.js");
  const { claimExecution } = await import("../src/leases.js");
  const { runClaimedWorkflow } = await import("../src/engine.js");
  const { jsonSnapshot } = await import("../src/json-data.js");
  let firstCalls = 0;
  const workflow: WorkflowDefinition = { name: "data-recovery", steps: [
    { name: "first", execute: async ({ input }) => {
      firstCalls++;
      assert.deepEqual(input, { orderId: "O-1" });
      (input as { orderId: string }).orderId = "mutated";
      return { paymentId: "P-1" };
    }},
    { name: "second", retry: fast, execute: async ({ input, outputs, attempt }) => {
      assert.deepEqual(input, { orderId: "O-1" });
      assert.deepEqual(outputs.first, { paymentId: "P-1" });
      (outputs.first as { paymentId: string }).paymentId = "mutated";
      if (attempt === 1) throw new RetryableError("retry");
      return [null, false, 0, "done"];
    }},
  ]};
  const submitted = { orderId: "O-1" };
  const pending = createPendingExecution(workflow, submitted);
  submitted.orderId = "changed-after-submit";
  await saveExecution(pending);
  const lease = await claimExecution(pending.id, "data-test", 30000);
  assert.ok(lease);
  await runClaimedWorkflow(workflow, lease, { yieldOnRetry: true });
  const saved = await loadExecution(pending.id);
  assert.ok(saved);
  assert.deepEqual(saved.steps[0]?.output, { paymentId: "P-1" });
  assert.equal(saved.steps[1]?.output, undefined);
  const result = await runWorkflow(workflow, saved);
  assert.equal(firstCalls, 1);
  assert.deepEqual(result.steps[1]?.output, [null, false, 0, "done"]);
  assert.deepEqual((await loadExecution(pending.id))?.input, { orderId: "O-1" });
  for (const invalid of [NaN, Infinity, new Date(), { missing: undefined }, 1n]) {
    assert.throws(() => jsonSnapshot(invalid));
  }
});

test("invalid output fails the step without publishing success", async () => {
  const result = await runWorkflow({ name: "bad-output", steps: [
    { name: "invalid", execute: async () => NaN },
    { name: "never", execute: async () => { assert.fail("must not execute"); } },
  ]});
  assert.equal(result.status, "failed");
  assert.equal((await loadExecution(result.id))?.steps[0]?.output, undefined);
});

test("JSON null output remains distinct from no output", async () => {
  const result = await runWorkflow({ name: "null-output", steps: [
    { name: "null", execute: async () => null },
    { name: "void", execute: async () => {} },
  ]});
  const loaded = await loadExecution(result.id);
  assert.equal(loaded?.steps[0]?.output, null);
  assert.equal(loaded?.steps[1]?.output, undefined);
});

test("order input validation rejects invalid orders before persistence", async () => {
  const { enqueueWorkflow } = await import("../src/enqueue-workflow.js");
  await assert.rejects(enqueueWorkflow("fulfil-order", { orderId: "O-1", amount: -1, currency: "NGN" }));
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM workflow_executions")).rows[0].count, 0);
});

test("concurrent keyed submissions create one complete execution and ignore object key order", async () => {
  const { enqueueWorkflow } = await import("../src/enqueue-workflow.js");
  const results = await Promise.all(Array.from({ length: 12 }, (_, index) =>
    enqueueWorkflow("retry-demo", index % 2 ? { a: 1, nested: { b: 2, c: 3 } } : { nested: { c: 3, b: 2 }, a: 1 }, "same-request")));
  assert.equal(new Set(results.map(result => result.id)).size, 1);
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM workflow_executions")).rows[0].count, 1);
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM step_executions")).rows[0].count, 3);
  assert.ok(results.every(result => result.steps.length === 3));
});

test("key reuse conflicts on changed input or workflow; omitted keys remain independent", async () => {
  const { enqueueWorkflow } = await import("../src/enqueue-workflow.js");
  const { IdempotencyConflictError } = await import("../src/submission-key.js");
  const original = await enqueueWorkflow("retry-demo", null, "request-1");
  assert.equal((await enqueueWorkflow("retry-demo", undefined, "request-1")).id, original.id);
  await assert.rejects(enqueueWorkflow("retry-demo", {}, "request-1"), IdempotencyConflictError);
  await assert.rejects(enqueueWorkflow("fulfil-order", null, "request-1"), IdempotencyConflictError);
  const first = await enqueueWorkflow("retry-demo");
  const second = await enqueueWorkflow("retry-demo");
  assert.notEqual(first.id, second.id);
  for (const key of ["", "bad key", "x".repeat(129)]) {
    await assert.rejects(enqueueWorkflow("retry-demo", null, key));
  }
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM workflow_executions")).rows[0].count, 3);
});

test("failed submission rolls back its key and allows a successful retry", async () => {
  const invalid = saved("retry-demo", [{ name: "invalid", status: "pending", attempts: -1 }], "pending");
  // Force a step write failure after the parent and key have been inserted.
  invalid.steps[0]!.name = null as unknown as string;
  await assert.rejects(saveExecution(invalid, undefined, "rolled-back"));
  const { enqueueWorkflow } = await import("../src/enqueue-workflow.js");
  const valid = await enqueueWorkflow("retry-demo", null, "rolled-back");
  assert.equal(valid.status, "pending");
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM workflow_executions")).rows[0].count, 1);
});

test("HTTP retry returns the completed execution, and conflicting reuse returns 409", async () => {
  const { createApiServer } = await import("../src/api.js");
  const { enqueueWorkflow } = await import("../src/enqueue-workflow.js");
  const { getWorkflow, listWorkflows } = await import("../src/workflow-registry.js");
  const server = createApiServer({ workflowNames: () => listWorkflows().map(w => w.name), enqueue: enqueueWorkflow, load: loadExecution });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const url = "http://127.0.0.1:" + address.port + "/executions";
  const post = (input: unknown, key = "http-request") => fetch(url, {
    method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": key },
    body: JSON.stringify({ workflowName: "retry-demo", input }),
  });
  try {
    assert.equal((await post(null, "bad key")).status, 400);
    const first = await post({ orderId: "O-1" });
    assert.equal(first.status, 202);
    const execution = await first.json() as WorkflowExecution;
    await runWorkflow(getWorkflow("retry-demo"), execution);
    const repeated = await post({ orderId: "O-1" });
    assert.equal(repeated.status, 202);
    assert.equal(repeated.headers.get("location"), first.headers.get("location"));
    const current = await repeated.json() as WorkflowExecution;
    assert.equal(current.id, execution.id);
    assert.equal(current.status, "completed");
    assert.equal((await post({ orderId: "O-2" })).status, 409);
    assert.equal((await pool.query("SELECT count(*)::int AS count FROM workflow_executions")).rows[0].count, 1);
    assert.equal((await pool.query("SELECT count(*)::int AS count FROM simulated_payments")).rows[0].count, 1);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});

test("queued cancellation is repeatable, cannot be claimed, and preserves submission identity", async () => {
  const { enqueueWorkflow } = await import("../src/enqueue-workflow.js");
  const { cancelExecution } = await import("../src/cancellation.js");
  const { claimExecution, claimNextExecution } = await import("../src/leases.js");
  const pending = await enqueueWorkflow("retry-demo", null, "cancel-key");
  const cancelled = await cancelExecution(pending.id);
  assert.equal(cancelled?.status, "cancelled");
  assert.ok(cancelled?.steps.every(step => step.status === "cancelled" && step.attempts === 0));
  assert.deepEqual(await cancelExecution(pending.id), cancelled);
  assert.equal(await claimExecution(pending.id, "manual"), undefined);
  assert.equal(await claimNextExecution("worker", ["retry-demo"]), undefined);
  assert.equal((await enqueueWorkflow("retry-demo", null, "cancel-key")).id, pending.id);
  assert.equal(await cancelExecution(randomUUID()), undefined);
});

test("running cancellation aborts cooperative handlers and preserves completed outputs", async () => {
  const { cancelExecution } = await import("../src/cancellation.js");
  const { createPendingExecution } = await import("../src/workflow-definition.js");
  let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const workflow: WorkflowDefinition = { name: "cancel-active", steps: [
    { name: "done", execute: async () => ({ receipt: "saved" }) },
    { name: "active", execute: async ({ signal }) => { started(); await delay(10000, undefined, { signal }); } },
    { name: "never", execute: async () => { assert.fail("cancelled workflow must not advance"); } },
  ]};
  const pending = createPendingExecution(workflow);
  await saveExecution(pending);
  const running = runWorkflow(workflow, pending);
  await ready;
  await cancelExecution(pending.id);
  const result = await running;
  assert.equal(result.status, "cancelled");
  assert.deepEqual(result.steps[0]?.output, { receipt: "saved" });
  assert.equal(result.steps[0]?.status, "completed");
  assert.equal(result.steps[1]?.status, "cancelled");
  assert.equal(result.steps[1]?.attempts, 1);
  assert.equal((await pool.query("SELECT lease_owner FROM workflow_executions WHERE id=$1", [pending.id])).rows[0].lease_owner, null);
  assert.equal((await runWorkflow(workflow, result)).status, "cancelled");
});

test("handler returning after cancellation cannot publish output or completion", async () => {
  const { cancelExecution } = await import("../src/cancellation.js");
  const { createPendingExecution } = await import("../src/workflow-definition.js");
  let started!: () => void;
  let finish!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const release = new Promise<void>(resolve => { finish = resolve; });
  const workflow: WorkflowDefinition = { name: "cancel-race", steps: [
    { name: "ignores-signal", execute: async () => { started(); await release; return { late: true }; } },
  ]};
  const pending = createPendingExecution(workflow);
  await saveExecution(pending);
  const running = runWorkflow(workflow, pending);
  await ready;
  try { await cancelExecution(pending.id); } finally { finish(); }
  assert.equal((await running).status, "cancelled");
  assert.equal((await loadExecution(pending.id))?.steps[0]?.output, undefined);
});

test("cancellation API validates IDs and protects completed or failed executions", async () => {
  const { cancelExecution } = await import("../src/cancellation.js");
  const { createApiServer } = await import("../src/api.js");
  const { enqueueWorkflow } = await import("../src/enqueue-workflow.js");
  const pending = await enqueueWorkflow("retry-demo");
  const completed = await runWorkflow({ name: "complete-cancel-test", steps: [] });
  const failed = await runWorkflow({ name: "failed-cancel-test", steps: [{ name: "fail", execute: async () => { throw new Error("expected"); } }] });
  const server = createApiServer({ workflowNames: () => ["retry-demo"], enqueue: enqueueWorkflow, load: loadExecution, cancel: cancelExecution });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = "http://127.0.0.1:" + address.port + "/executions/";
  const cancel = (id: string) => fetch(base + id + "/cancel", { method: "POST" });
  try {
    assert.equal((await cancel("bad-id")).status, 400);
    assert.equal((await cancel(randomUUID())).status, 404);
    assert.equal((await fetch(base + pending.id + "/cancel")).status, 405);
    assert.equal((await cancel(completed.id)).status, 409);
    assert.equal((await cancel(failed.id)).status, 409);
    const response = await cancel(pending.id);
    assert.equal(response.status, 200);
    assert.equal((await response.json() as WorkflowExecution).status, "cancelled");
    assert.equal((await cancel(pending.id)).status, 200);
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});

test("cancellation interrupts a scheduled retry without another attempt", async () => {
  const { cancelExecution } = await import("../src/cancellation.js");
  const { createPendingExecution } = await import("../src/workflow-definition.js");
  let attempts = 0;
  const workflow: WorkflowDefinition = { name: "cancel-retry", steps: [
    { name: "retry", retry: { maxAttempts: 3, initialDelayMs: 10000, maxDelayMs: 10000 },
      execute: async () => { attempts++; throw new RetryableError("wait"); } },
  ]};
  const pending = createPendingExecution(workflow);
  await saveExecution(pending);
  const running = runWorkflow(workflow, pending);
  try {
    const deadline = Date.now() + 10000;
    while (!(await loadExecution(pending.id))?.steps[0]?.nextAttemptAt) {
      if (Date.now() > deadline) throw new Error("Retry was not scheduled.");
      await delay(20);
    }
    await cancelExecution(pending.id);
    assert.equal((await running).status, "cancelled");
    assert.equal(attempts, 1);
    assert.equal((await loadExecution(pending.id))?.steps[0]?.nextAttemptAt, undefined);
  } finally {
    await cancelExecution(pending.id);
    await running;
  }
});

test("timeout identity survives replay and queued expiration prevents claims", async () => {
  const { enqueueWorkflow } = await import("../src/enqueue-workflow.js");
  const { claimNextExecution } = await import("../src/leases.js");
  const execution = await enqueueWorkflow("retry-demo", null, "timeout-request", 60000);
  assert.ok(execution.deadlineAt);
  assert.equal((await enqueueWorkflow("retry-demo", null, "timeout-request", 60000)).deadlineAt, execution.deadlineAt);
  await assert.rejects(enqueueWorkflow("retry-demo", null, "timeout-request", 30000));
  await pool.query("UPDATE workflow_executions SET deadline_at=clock_timestamp()-INTERVAL '1 second' WHERE id=$1", [execution.id]);
  assert.equal(await claimNextExecution("timeout-worker", ["retry-demo"]), undefined);
  const expired = await loadExecution(execution.id);
  assert.equal(expired?.status, "timed_out");
  assert.ok(expired?.steps.every(step => step.status === "timed_out" && step.attempts === 0));
});

for (const cooperative of [true, false]) {
  test("deadline prevents late results; cooperative=" + cooperative, async () => {
    const { createPendingExecution } = await import("../src/workflow-definition.js");
    let entered!: () => void;
    let finish!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; });
    const released = new Promise<void>(resolve => { finish = resolve; });
    const workflow: WorkflowDefinition = { name: "deadline-running", steps: [
      { name: "done", execute: async () => ({ receipt: 1 }) },
      { name: "waiting", execute: async ({ signal }) => {
        entered();
        if (cooperative) await delay(10000, undefined, { signal });
        else await released;
        return "late";
      }},
    ]};
    const pending = createPendingExecution(workflow, null, 60000);
    await saveExecution(pending);
    const running = runWorkflow(workflow, pending);
    await ready;
    try { await pool.query("UPDATE workflow_executions SET deadline_at=clock_timestamp()-INTERVAL '1 second' WHERE id=$1", [pending.id]); }
    finally { finish(); }
    const result = await running;
    assert.equal(result.status, "timed_out");
    assert.deepEqual(result.steps[0]?.output, { receipt: 1 });
    assert.equal(result.steps[1]?.output, undefined);
    assert.equal((await runWorkflow(workflow, result)).status, "timed_out");
  });
}

test("HTTP validates timeout and expires an execution on inspection", async () => {
  const { createApiServer } = await import("../src/api.js");
  const { enqueueWorkflow } = await import("../src/enqueue-workflow.js");
  const server = createApiServer({ workflowNames: () => ["retry-demo"], enqueue: enqueueWorkflow, load: loadExecution });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = "http://127.0.0.1:" + address.port;
  const post = (timeoutMs: unknown) => fetch(base + "/executions", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ workflowName: "retry-demo", timeoutMs }) });
  try {
    for (const invalid of [0, -1, 1.5, null, "500", 2147483648]) assert.equal((await post(invalid)).status, 400);
    const response = await post(100);
    assert.equal(response.status, 202);
    const execution = await response.json() as WorkflowExecution;
    assert.equal(execution.timeoutMs, 100);
    assert.ok(execution.deadlineAt);
    await delay(150);
    const result = await (await fetch(base + response.headers.get("location"))).json() as WorkflowExecution;
    assert.equal(result.status, "timed_out");
    assert.equal((await enqueueWorkflow("retry-demo")).deadlineAt, undefined);
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});

test("workers run pinned versions and leave unsupported versions queued", async () => {
  const { createPendingExecution } = await import("../src/workflow-definition.js");
  const { runWorker } = await import("../src/worker.js");
  const first: WorkflowDefinition = { name: "version-test", version: 1, steps: [{ name: "result", execute: async () => "v1" }] };
  const second: WorkflowDefinition = { name: "version-test", version: 2, steps: [{ name: "result", execute: async () => "v2" }] };
  const unsupported: WorkflowDefinition = { ...first, version: 3 };
  const queued = [first, second, unsupported].map(item => createPendingExecution(item));
  for (const execution of queued) await saveExecution(execution);
  await assert.rejects(runWorkflow(second, queued[0]), /does not match/);
  await runWorker({ workflows: [first, second], once: true });
  await runWorker({ workflows: [first, second], once: true });
  assert.equal((await loadExecution(queued[0]!.id))?.steps[0]?.output, "v1");
  assert.equal((await loadExecution(queued[1]!.id))?.steps[0]?.output, "v2");
  assert.equal((await loadExecution(queued[2]!.id))?.status, "pending");
});

test("explicit retry preserves completed results, audits attempts and reuses payment keys", async () => {
  const { enqueueWorkflow } = await import("../src/enqueue-workflow.js");
  const { retryExecution, retryHistory } = await import("../src/execution-management.js");
  const { getWorkflow } = await import("../src/workflow-registry.js");
  const queued = await enqueueWorkflow("retry-demo", { orderId: "recover" }, "submit-recover", 60000);
  const payment = await createSimulatedPayment(queued.id + ":1");
  await pool.query("UPDATE workflow_executions SET status='failed',error='test failure' WHERE id=$1", [queued.id]);
  await pool.query("UPDATE step_executions SET status='completed',attempts=1,output=$2::jsonb WHERE workflow_execution_id=$1 AND step_index=0", [queued.id, '{"reservation":"kept"}']);
  await pool.query("UPDATE step_executions SET status='failed',attempts=3,error='lost response' WHERE workflow_execution_id=$1 AND step_index=1", [queued.id]);
  const results = await Promise.all(Array.from({ length: 8 }, () => retryExecution(queued.id, "retry-1")));
  assert.ok(results.every(result => result?.id === queued.id && result.retryCount === 1));
  const history = await retryHistory(queued.id);
  assert.equal(history?.length, 1);
  assert.equal(history?.[0].previousState.steps[1].attempts, 3);
  const retried = results[0]!;
  assert.deepEqual(retried.steps[0]?.output, { reservation: "kept" });
  assert.equal(retried.steps[1]?.attempts, 0);
  const done = await runWorkflow(getWorkflow("retry-demo", 1), retried);
  assert.equal(done.status, "completed");
  assert.equal(done.steps[0]?.attempts, 1);
  assert.equal(await createSimulatedPayment(queued.id + ":1"), payment);
  assert.equal((await retryExecution(queued.id, "retry-1"))?.status, "completed");
  await assert.rejects(retryExecution(queued.id, "retry-2"), /Only failed/);
  assert.equal((await pool.query("SELECT count(*)::integer AS count FROM simulated_payments")).rows[0].count, 1);
});

test("retry rejects live ownership, cancelled and timed-out executions", async () => {
  const { enqueueWorkflow } = await import("../src/enqueue-workflow.js");
  const { retryExecution } = await import("../src/execution-management.js");
  const { claimExecution, releaseLease } = await import("../src/leases.js");
  const queued = await enqueueWorkflow("retry-demo");
  const lease = await claimExecution(queued.id, "retry-owner");
  assert.ok(lease);
  const failed = await loadExecution(queued.id);
  assert.ok(failed);
  failed.status = "failed";
  await saveExecution(failed, lease);
  await assert.rejects(retryExecution(queued.id, "live"), /ownership/);
  await releaseLease(lease);
  for (const status of ["cancelled", "timed_out"]) {
    await pool.query("UPDATE workflow_executions SET status=$2 WHERE id=$1", [queued.id, status]);
    await assert.rejects(retryExecution(queued.id, "terminal"), /Only failed/);
  }
  assert.equal(await retryExecution(randomUUID(), "missing"), undefined);
});

test("monitoring provides stable pagination, status filters and worker presence", async () => {
  const { enqueueWorkflow } = await import("../src/enqueue-workflow.js");
  const { listExecutions, metrics, health } = await import("../src/execution-management.js");
  const { startWorkerPresence } = await import("../src/worker-presence.js");
  for (let index = 0; index < 3; index++) await enqueueWorkflow("retry-demo");
  await pool.query("UPDATE workflow_executions SET created_at='2026-01-01T00:00:00.123456Z'");
  const first = await listExecutions(new URLSearchParams({ limit: "2", status: "pending" }));
  assert.equal(first.executions.length, 2);
  assert.ok(first.nextCursor);
  const second = await listExecutions(new URLSearchParams({ limit: "2", status: "pending", cursor: first.nextCursor! }));
  assert.equal(second.executions.length, 1);
  assert.equal(new Set([...first.executions, ...second.executions].map(row => row.id)).size, 3);
  assert.equal(second.nextCursor, null);
  for (const params of ["limit=0", "limit=101", "cursor=bad", "status=unknown", "limit=1&limit=2"]) {
    await assert.rejects(listExecutions(new URLSearchParams(params)));
  }
  assert.deepEqual(await health(), { status: "ready" });
  const stop = await startWorkerPresence("monitor-test");
  try { assert.ok((await metrics()).workers.some(row => row.workerId === "monitor-test" && row.healthy)); }
  finally { await stop(); }
  assert.ok((await metrics()).workers.every(row => !row.healthy));
});

test("authenticated management API lists executions and retries failures with history", async () => {
  const { createApiServer } = await import("../src/api.js");
  const { enqueueWorkflow } = await import("../src/enqueue-workflow.js");
  const { retryExecution, retryHistory, listExecutions, metrics, health } = await import("../src/execution-management.js");
  const queued = await enqueueWorkflow("retry-demo");
  await pool.query("UPDATE workflow_executions SET status='failed' WHERE id=$1", [queued.id]);
  const key = "b".repeat(64);
  const server = createApiServer({ workflowNames: () => ["retry-demo"], enqueue: enqueueWorkflow, load: loadExecution,
    retry: retryExecution, history: retryHistory, list: listExecutions, metrics, health }, { apiKey: key });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const base = "http://127.0.0.1:" + address.port;
  const headers = { Authorization: "Bearer " + key };
  try {
    assert.equal((await fetch(base + "/executions/" + queued.id + "/retry", { method: "POST", headers })).status, 400);
    const retried = await fetch(base + "/executions/" + queued.id + "/retry", { method: "POST", headers: { ...headers, "Idempotency-Key": "http-retry" } });
    assert.equal(retried.status, 202);
    assert.equal((await retried.json() as WorkflowExecution).retryCount, 1);
    const history = await (await fetch(base + "/executions/" + queued.id + "/retries", { headers })).json() as { retries: unknown[] };
    assert.equal(history.retries.length, 1);
    for (const path of ["/executions?status=pending", "/metrics", "/health/ready"]) assert.equal((await fetch(base + path, { headers })).status, 200);
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});

test("migration runner installs a fresh schema and is repeatable", async () => {
  const migrationSchema = "migration_test_" + randomUUID().replaceAll("-", "");
  await admin.query('CREATE SCHEMA "' + migrationSchema + '"');
  const scoped = new URL(originalUrl!);
  scoped.searchParams.set("options", "-c search_path=" + migrationSchema);
  async function migrate(): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ["--import", "tsx", "src/migrate.ts"], { cwd: root, env: { ...process.env, DATABASE_URL: scoped.toString() }, windowsHide: true });
      let output = "";
      child.stdout.on("data", chunk => { output += String(chunk); });
      child.stderr.on("data", chunk => { output += String(chunk); });
      child.on("error", reject);
      child.on("exit", code => code === 0 ? resolve(output) : reject(new Error(output)));
    });
  }
  try {
    assert.match(await migrate(), /009_release/);
    assert.match(await migrate(), /are current/);
    const count = await admin.query('SELECT count(*)::integer AS count FROM "' + migrationSchema + '".schema_migrations');
    assert.equal(count.rows[0].count, 9);
  } finally {
    if (/^migration_test_[a-f0-9]{32}$/.test(migrationSchema)) await admin.query('DROP SCHEMA "' + migrationSchema + '" CASCADE');
  }
});

test("inspection of a nonexpired execution does not wait for an unrelated parent lock", async () => {
  const { enqueueWorkflow } = await import("../src/enqueue-workflow.js");
  const pending = await enqueueWorkflow("retry-demo");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT id FROM workflow_executions WHERE id=$1 FOR UPDATE", [pending.id]);
    assert.equal((await loadExecution(pending.id))?.id, pending.id);
  } finally { await client.query("ROLLBACK"); client.release(); }
});
