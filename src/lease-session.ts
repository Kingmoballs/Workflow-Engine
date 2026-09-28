import { ExecutionCancelledError } from "./cancellation-error.js";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { LeaseLostError } from "./errors.js";
import { renewLease, type ExecutionLease } from "./leases.js";

/** Owns heartbeats and a conservative watchdog; does not abandon a running handler. */
export function startLeaseSession(lease: ExecutionLease, externalSignal?: AbortSignal) {
  const lost = new AbortController();
  const stopped = new AbortController();
  const signal = externalSignal
    ? AbortSignal.any([lost.signal, externalSignal])
    : lost.signal;
  let watchdog: ReturnType<typeof setTimeout> | undefined;

  function arm(deadline: number): void {
    if (watchdog) clearTimeout(watchdog);
    if (deadline <= performance.now()) {
      lost.abort(new LeaseLostError("Lease expired before the worker could confirm ownership."));
      return;
    }
    watchdog = setTimeout(() => {
      lost.abort(new LeaseLostError("Lease heartbeat was not confirmed before its deadline."));
    }, Math.max(1, deadline - performance.now()));
    watchdog.unref();
  }

  arm(lease.localDeadline);
  const heartbeat = (async () => {
    try {
      while (!stopped.signal.aborted && !lost.signal.aborted) {
        await delay(Math.max(25, Math.min(250, Math.floor(lease.durationMs / 3))), undefined, { signal: stopped.signal });
        if (stopped.signal.aborted || lost.signal.aborted) break;
        const deadline = await renewLease(lease);
        if (deadline === undefined) {
          lost.abort(new LeaseLostError());
          break;
        }
        arm(deadline);
      }
    } catch (error) {
      if (!stopped.signal.aborted) {
        lost.abort(error instanceof ExecutionCancelledError ? error : new LeaseLostError("Could not renew execution ownership.", { cause: error }));
      }
    }
  })();

  return {
    signal,
    async stop(): Promise<void> {
      stopped.abort();
      if (watchdog) clearTimeout(watchdog);
      await heartbeat;
      // An in-flight renewal may have completed while stop was waiting.
      if (watchdog) clearTimeout(watchdog);
    },
  };
}
