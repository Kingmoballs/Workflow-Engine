import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { ExecutionBusyError, RetryableError } from "./errors.js";
import { loadExecution, saveExecution } from "./execution-store.js";
import { claimExecution, releaseLease, validateLeaseOptions, type ExecutionLease } from "./leases.js";
import { startLeaseSession } from "./lease-session.js";
import { createPendingExecution, MAX_TIMER_MS, retryPolicyFor, validateWorkflowDefinition } from "./workflow-definition.js";
import type { WorkflowDefinition, WorkflowExecution } from "./types.js";

export interface RunOptions {
  leaseMs?: number;
  signal?: AbortSignal;
}
export interface ClaimedRunOptions {
  yieldOnRetry?: boolean;
  signal?: AbortSignal;
}

function executionPlan(workflow: WorkflowDefinition, execution: WorkflowExecution) {
  validateWorkflowDefinition(workflow);
  if (execution.workflowName !== workflow.name || execution.steps.length !== workflow.steps.length) {
    throw new Error("Saved execution does not match this workflow definition.");
  }
  return workflow.steps.map((step, index) => {
    const record = execution.steps[index];
    if (!record || record.name !== step.name) throw new Error(`Saved execution does not match step ${index}.`);
    if (!Number.isSafeInteger(record.attempts) || record.attempts < 0) {
      throw new Error(`Invalid saved attempt count for step "${step.name}".`);
    }
    if (record.nextAttemptAt !== undefined && !Number.isFinite(Date.parse(record.nextAttemptAt))) {
      throw new Error(`Invalid saved retry timestamp for step "${step.name}".`);
    }
    return { step, record, index, retry: retryPolicyFor(step) };
  });
}

/** Direct runs use the same ownership protocol as background workers. */
export async function runWorkflow(
  workflow: WorkflowDefinition,
  savedExecution?: WorkflowExecution,
  options: RunOptions = {},
): Promise<WorkflowExecution> {
  validateWorkflowDefinition(workflow);
  const ownerId = randomUUID();
  const leaseMs = options.leaseMs ?? 30_000;
  validateLeaseOptions(ownerId, leaseMs);
  options.signal?.throwIfAborted();

  const initial = savedExecution ?? createPendingExecution(workflow);
  executionPlan(workflow, initial);
  if (!savedExecution) await saveExecution(initial);

  // A caller's snapshot may be stale. Never execute from it.
  const current = await loadExecution(initial.id);
  if (!current) throw new Error("Execution no longer exists.");
  executionPlan(workflow, current);
  if (current.status === "completed") {
    console.log(`Execution already completed: ${current.id}`);
    return current;
  }
  const lease = await claimExecution(current.id, ownerId, leaseMs);
  if (!lease) {
    const latest = await loadExecution(current.id);
    if (latest?.status === "completed") return latest;
    throw new ExecutionBusyError(current.id);
  }
  return runClaimedWorkflow(workflow, lease, {
    yieldOnRetry: false,
    ...(options.signal ? { signal: options.signal } : {}),
  });
}

export async function runClaimedWorkflow(
  workflow: WorkflowDefinition,
  lease: ExecutionLease,
  options: ClaimedRunOptions = {},
): Promise<WorkflowExecution> {
  const session = startLeaseSession(lease, options.signal);
  const signal = session.signal;
  try {
    signal.throwIfAborted();
    const execution = await loadExecution(lease.executionId);
    signal.throwIfAborted();
    if (!execution) throw new Error("Claimed execution no longer exists.");

    const checkpoint = async () => {
      signal.throwIfAborted();
      await saveExecution(execution, lease);
      signal.throwIfAborted();
    };

    let plan: ReturnType<typeof executionPlan>;
    try {
      plan = executionPlan(workflow, execution);
    } catch (error) {
      // Quarantine incompatible queued definitions instead of claiming them forever.
      execution.status = "failed";
      execution.error = error instanceof Error ? error.message : String(error);
      await checkpoint();
      throw error;
    }

    if (execution.status === "completed") return execution;
    execution.status = "running";
    delete execution.error;
    await checkpoint();
    console.log(`Running workflow: ${execution.workflowName}`);
    console.log(`Execution ID: ${execution.id}`);

    for (const { step, record, index, retry } of plan) {
      signal.throwIfAborted();
      if (record.status === "completed") {
        console.log(`Skipping completed step: ${step.name}`);
        continue;
      }
      while (true) {
        signal.throwIfAborted();
        if (record.attempts >= retry.maxAttempts) {
          if (record.status === "running") {
            record.error = "Attempt limit reached after an interrupted attempt; its external result may need reconciliation.";
          } else {
            record.error ??= "Attempt limit reached without a recorded success.";
          }
          record.status = "failed";
          delete record.nextAttemptAt;
          execution.status = "failed";
          await checkpoint();
          return execution;
        }

        if (record.nextAttemptAt !== undefined) {
          const deadline = Date.parse(record.nextAttemptAt);
          if (options.yieldOnRetry && deadline > Date.now()) return execution;
          console.log(`Waiting to retry ${step.name} at ${record.nextAttemptAt}`);
          while (deadline > Date.now()) {
            await delay(Math.max(1, Math.min(deadline - Date.now(), MAX_TIMER_MS)), undefined, { signal });
          }
        }

        signal.throwIfAborted();
        record.status = "running";
        record.attempts += 1;
        delete record.error;
        delete record.nextAttemptAt;
        await checkpoint();
        console.log(`Starting step: ${step.name}, attempt ${record.attempts}`);

        try {
          signal.throwIfAborted();
          await step.execute({
            executionId: execution.id, stepName: step.name,
            attempt: record.attempts, idempotencyKey: `${execution.id}:${index}`, signal,
          });
        } catch (error: unknown) {
          // Ownership loss and shutdown are not business failures or retries.
          signal.throwIfAborted();
          record.error = error instanceof Error ? error.message : String(error);
          if (error instanceof RetryableError && record.attempts < retry.maxAttempts) {
            const delayMs = Math.min(retry.maxDelayMs, retry.initialDelayMs * 2 ** (record.attempts - 1));
            record.status = "pending";
            record.nextAttemptAt = new Date(Date.now() + delayMs).toISOString();
            await checkpoint();
            console.log(`Retry scheduled for ${step.name} in ${delayMs} ms.`);
            if (options.yieldOnRetry) return execution;
            continue;
          }
          record.status = "failed";
          execution.status = "failed";
          await checkpoint();
          console.error(`Failed step: ${step.name}: ${record.error}`);
          return execution;
        }

        // A stale or cancelled handler may have returned; it must not publish success.
        signal.throwIfAborted();
        record.status = "completed";
        await checkpoint();
        console.log(`Completed step: ${step.name}`);
        break;
      }
    }
    execution.status = "completed";
    await checkpoint();
    console.log(`Completed workflow: ${execution.workflowName}`);
    return execution;
  } finally {
    // Only reached after the handler settles. Never free ownership underneath it.
    await session.stop();
    try {
      await releaseLease(lease);
    } catch (error) {
      console.error("Could not release ownership; it will expire:", error);
    }
  }
}
