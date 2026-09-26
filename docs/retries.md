# Retry behavior

The original compiler errors came from two conflicting WorkflowStep interfaces and a missing WorkflowDefinition. The shared types now have one definition for each concept.

## Run the new demo

From the project root:

```powershell
npm.cmd run demo:retry
npm.cmd run executions:latest
```

The payment step deliberately loses its acknowledgement on attempts 1 and 2, waits 1 second and then 2 seconds, and succeeds on attempt 3. All attempts reuse the same simulated payment ID. Inventory and delivery each execute once.

The original order workflow retains its 30-second pause for manual interruption exercises.

## Configure a step

```typescript
import { RetryableError } from "../errors.js";

const step = {
  name: "call-service",
  retry: {
    maxAttempts: 3,
    initialDelayMs: 1_000,
    maxDelayMs: 5_000,
  },
  execute: async () => {
    throw new RetryableError("Service temporarily unavailable");
  },
};
```

Only RetryableError triggers an automatic retry. An ordinary Error stops the execution immediately. Use RetryableError only when retrying the operation is appropriate.

The defaults are 3 total attempts, a 1,000 ms initial delay, and a 30,000 ms maximum delay. Delays double after each unsuccessful attempt, capped at maxDelayMs. maxAttempts includes the first attempt and interrupted attempts; it is not an additional retry count.

A pending step with next_attempt_at is waiting for its next attempt. The worker saves this timestamp before waiting and waits for the remaining time after a restart. It saves the incremented attempt count before invoking the handler. Success clears the old error and retry timestamp.

## Resume a stopped execution

Stop the previous worker first, then run:

```powershell
npm.cmd run executions:resume
```

This selects the latest execution and resolves its saved workflow name through the registry. Completed steps are skipped. Completed workflows return without executing again. Attempt counts and scheduled deadlines are preserved.

An explicit manual resume may reattempt an ordinarily failed step if budget remains. Once the attempt limit is reached, resuming does not grant another attempt. A crash during the final attempt leaves an uncertain external outcome; the engine reports that reconciliation may be needed.

The registry currently knows fulfil-order and retry-demo. Keep the workflow definition and retry policy unchanged while an execution is resumable. Definition versioning and safe policy changes are future work.

## Database change

Migration 003 adds a nullable next_attempt_at timestamp to step_executions. It has been applied to the current development database. For another existing database, run:

```powershell
Get-Content -Raw .\migrations\003_add_retry_schedule.sql | docker compose exec -T postgres psql -U workflow -d workflow_engine -v ON_ERROR_STOP=1
```

## Verification

```powershell
npm.cmd run typecheck
npm.cmd run build
npm.cmd test
```

The integration tests require local PostgreSQL and permission to create a schema. Each run creates an isolated randomly named schema, verifies the connection points to that schema, applies the migrations, and removes only its own schema afterward. Tests also kill and restart their own worker subprocesses to verify persisted retry scheduling and payment deduplication.

## Current limits

Background workers now coordinate through leases and fenced checkpoints. They release ownership during retry waits; direct runs still wait while retaining a lease. See [workers.md](workers.md) for queue commands, crash recovery, and concurrency limits.

Idempotency keys are stable per execution and step position. Starting a new execution creates new keys. The simulated payment row is the entire simulated effect; a real remote provider must enforce its own idempotency contract. Workflow checkpoint writes are separate from effects, and their errors propagate instead of being mistaken for handler failures.
