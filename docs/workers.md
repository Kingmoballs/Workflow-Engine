# Queue and background workers

## Run it

From the project folder, start PostgreSQL if needed:

```powershell
docker compose up -d
```

In terminal 1, start a worker:

```powershell
npm.cmd run worker
```

In terminal 2, submit work and inspect it:

```powershell
npm.cmd run executions:enqueue -- retry-demo
npm.cmd run executions:latest
```

Submission saves a pending execution without calling its handlers. The worker polls for eligible work and executes it. The retry demo creates one simulated payment, retries twice, and finishes on its third payment attempt.

You can start another worker in another terminal. Each process has a different worker ID and claims separate jobs.

## Commands

- `npm.cmd run worker`: poll continuously, processing one execution at a time per process.
- `npm.cmd run worker -- --once`: process at most one claim and exit. A transient failure can schedule a retry; this does not wait for the entire workflow to finish.
- `npm.cmd run worker -- --workflow retry-demo`: process only that registered workflow.
- `npm.cmd run worker -- --lease-ms 10000 --poll-ms 250`: customize lease and polling intervals.
- `npm.cmd run worker -- --worker-id local-worker-a`: supply an identifiable owner name.
- `npm.cmd run executions:enqueue -- fulfil-order`: queue the original order example with its 30-second payment pause.
- `npm.cmd run executions:resume`: manually claim and resume the latest execution. It refuses to take a currently owned execution.
- `npm.cmd run demo:retry`: the direct-run retry demo, which now uses the same ownership checks.

## Ownership

A short PostgreSQL transaction claims the oldest eligible execution using FOR UPDATE SKIP LOCKED. Eligibility includes pending or running state, a registered workflow name, no current unexpired lease, and a due retry deadline on the first unfinished step.

Each claim assigns an owner, an expiry time, and a monotonically increasing generation. Generations remain strings in JavaScript so PostgreSQL BIGINT values do not lose precision.

The worker renews ownership approximately every third of the lease duration. Checkpoints acquire the parent row lock, then check the owner, generation and current database time before saving the workflow and all steps in one transaction. An expired or replaced owner cannot publish a result. Saving an existing execution without a lease is prohibited.

Heartbeats cannot revive an expired lease. The conservative local watchdog also cancels cooperative work if timely renewal cannot be confirmed. The default lease is 30 seconds, and default polling is 500 ms. Database statements have a 5-second server timeout and a 6-second client query timeout.

## Retries and recovery

Background workers save retry deadlines and release ownership instead of occupying a worker while waiting. They can process another eligible job. Once the deadline arrives, any worker may claim the waiting execution. Attempt counts and idempotency keys are preserved.

If a process is killed, its lease eventually expires. A replacement claims a new generation, reloads the saved execution, skips completed steps and resumes unfinished work within its remaining attempt budget. A running status alone does not prove a process is still alive.

Automatic workers do not pick completed or failed executions. Manual resume may retry a failed execution if it still has attempt budget. Unknown workflow names are excluded. If a registered definition is incompatible with saved steps, the worker marks that execution failed with an error rather than repeatedly claiming it.

## Shutdown and handler obligations

Ctrl+C requests cooperative shutdown. The engine passes an AbortSignal in StepContext and the example order delays respect it. An interrupted step stays recoverable; cancellation is not recorded as a business failure.

For a wait, use:

```typescript
await delay(30_000, undefined, { signal: context.signal });
```

For supported HTTP clients, pass the same signal. Check it before initiating external work. A second Ctrl+C forces termination; recovery then waits for lease expiry.

A handler that ignores cancellation is awaited before voluntary release. Lease expiry can still allow another worker to start while an old uncooperative handler continues externally. Database fencing does not undo external actions: retain provider-side idempotency. This remains at-least-once execution, not an exactly-once external-effect guarantee.

Keep workflow code and step order stable for resumable executions. Definition versioning is not implemented yet.

## Migration and tests

Migration 004 adds lease metadata, workflow-level error text and a queue index. It is additive and retains existing records. For another existing database:

```powershell
Get-Content -Raw .\migrations\004_worker_leases.sql | docker compose exec -T postgres psql -U workflow -d workflow_engine -v ON_ERROR_STOP=1
```

```powershell
npm.cmd run typecheck
npm.cmd run build
npm.cmd test
```

Tests create and verify an isolated random schema, use their own worker subprocesses, and remove only that schema afterward. They cover competing claims, expired/stale workers, row-lock expiry races, heartbeat renewal, cancellation, nonblocking retries, and recovery after a real process termination.
