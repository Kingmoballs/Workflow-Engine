import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { runClaimedWorkflow } from "./engine.js";
import { claimNextExecution, validateLeaseOptions } from "./leases.js";
import { listWorkflows } from "./workflow-registry.js";
import { validateWorkflowDefinition } from "./workflow-definition.js";
import type { WorkflowDefinition } from "./types.js";

export interface WorkerOptions {
  workerId?: string;
  leaseMs?: number;
  pollIntervalMs?: number;
  signal?: AbortSignal;
  once?: boolean;
  workflows?: readonly WorkflowDefinition[];
}

export async function runWorker(options: WorkerOptions = {}): Promise<void> {
  const workerId = options.workerId ?? randomUUID();
  const leaseMs = options.leaseMs ?? 30_000;
  const pollIntervalMs = options.pollIntervalMs ?? 500;
  validateLeaseOptions(workerId, leaseMs);
  if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 1 || pollIntervalMs > 2_147_483_647) {
    throw new Error("Polling interval must be a positive integer within the timer range.");
  }
  const definitions = options.workflows ?? listWorkflows();
  for (const workflow of definitions) validateWorkflowDefinition(workflow);
  const workflows = new Map(definitions.map((workflow) => [workflow.name, workflow]));
  if (workflows.size !== definitions.length) throw new Error("Workflow names must be unique.");
  const signal = options.signal ?? new AbortController().signal;
  console.log("Worker started:", workerId);

  while (!signal.aborted) {
    let processed = false;
    try {
      const lease = await claimNextExecution(workerId, [...workflows.keys()], leaseMs);
      if (lease) {
        processed = true;
        const workflow = workflows.get(lease.workflowName)!;
        console.log(`Worker ${workerId} claimed ${lease.executionId} (generation ${lease.token}).`);
        const result = await runClaimedWorkflow(workflow, lease, { yieldOnRetry: true, signal });
        console.log(`Worker ${workerId} saved ${result.id}: ${result.status}.`);
      }
    } catch (error) {
      if (signal.aborted) break;
      if (options.once) throw error;
      console.error("Worker could not process execution:", error);
      processed = false;
    }
    if (options.once) break;
    if (!processed && !signal.aborted) {
      try { await delay(pollIntervalMs, undefined, { signal }); }
      catch (error) { if (!signal.aborted) throw error; }
    }
  }
  console.log("Worker stopped:", workerId);
}
