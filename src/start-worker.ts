import { pool } from "./database.js";
import { getWorkflow } from "./workflow-registry.js";
import { runWorker, type WorkerOptions } from "./worker.js";

async function main(): Promise<void> {
  const shutdown = new AbortController();
  const options: WorkerOptions = { signal: shutdown.signal };
  const args = process.argv.slice(2);
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--once") options.once = true;
    else if (arg === "--lease-ms") options.leaseMs = Number(args[++index]);
    else if (arg === "--poll-ms") options.pollIntervalMs = Number(args[++index]);
    else if (arg === "--workflow") {
      const name = args[++index];
      if (!name) throw new Error("--workflow requires a name.");
      options.workflows = [getWorkflow(name)];
    }
    else if (arg === "--worker-id") {
      const id = args[++index];
      if (!id) throw new Error("--worker-id requires a value.");
      options.workerId = id;
    } else throw new Error(`Unknown worker argument: ${arg}`);
  }

  const stop = () => {
    if (shutdown.signal.aborted) process.exit(130);
    console.log("Stopping worker; press Ctrl+C again to force termination.");
    shutdown.abort(new Error("Worker shutdown requested."));
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  try {
    await runWorker(options);
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error("Worker failed:", error);
  process.exitCode = 1;
});
