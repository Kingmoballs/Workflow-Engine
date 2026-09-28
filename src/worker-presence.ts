import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { pool } from "./database.js";

export async function startWorkerPresence(workerId: string) {
  const instanceId = randomUUID();
  await pool.query("INSERT INTO worker_presence(instance_id, worker_id) VALUES ($1,$2)", [instanceId, workerId]);
  const stopped = new AbortController();
  const heartbeat = (async () => {
    while (!stopped.signal.aborted) {
      try {
        await delay(5000, undefined, { signal: stopped.signal });
        await pool.query("UPDATE worker_presence SET last_seen_at=clock_timestamp() WHERE instance_id=$1", [instanceId]);
      } catch (error) {
        if (!stopped.signal.aborted) console.error("Worker presence update failed:", error);
      }
    }
  })();
  return async () => {
    stopped.abort();
    await heartbeat;
    await pool.query("UPDATE worker_presence SET stopped_at=clock_timestamp() WHERE instance_id=$1", [instanceId]);
  };
}
