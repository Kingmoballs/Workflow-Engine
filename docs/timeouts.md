> Release update: API requests require Authorization: Bearer <API_KEY>. Run npm run setup and see [the release guide](../README.md) for authenticated examples, versions, and retry controls.

# Execution timeouts

POST /executions accepts optional timeoutMs, an integer from 1 to 2147483647. Omission means no deadline and preserves existing behavior.

Example request:

```json
{
  "workflowName": "fulfil-order",
  "input": { "orderId": "ORD-123", "amount": 2500000, "currency": "NGN" },
  "timeoutMs": 60000
}
```

The timeout starts when PostgreSQL inserts the execution, including queue time, handler time, retry waits, and downtime. GET /executions/:id returns timeoutMs and deadlineAt. Replaying a keyed submission preserves its original deadline; changing timeoutMs with the same key returns 409.

At expiry, the execution and unfinished steps become timed_out. Completed steps and outputs remain intact. Timed-out executions cannot resume. Submit a new request with a new key if another run is intended.

Workers expire overdue queued work during polling and check active deadlines during heartbeats and checkpoints. Reading an execution also reconciles an overdue deadline. With no workers or requests, a stored status can remain pending/running until the next check, but the deadline does not move. Checks use database time after acquiring the parent row lock.

Handlers receive an aborted signal when the worker detects expiry. A handler that ignores its signal may continue, but cannot save a late result. Timeouts cannot undo external effects or forcibly interrupt synchronous JavaScript; use idempotent external operations and signal-aware I/O.

TypeScript: enqueueWorkflow(name, input, submissionKey, timeoutMs), or runWorkflow(workflow, undefined, { timeoutMs: 60000 }).

Migration 008_execution_timeouts.sql adds deadline fields and timed_out status. Restart API and worker processes after applying it. Existing executions keep no timeout. Full installations apply migrations 001 through 008 in order.
