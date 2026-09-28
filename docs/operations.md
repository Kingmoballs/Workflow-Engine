# Operations

The API key grants full access within one trusted application environment. Rotate it by updating API_KEY and restarting the API and clients; never put it in a browser frontend or commit .env. Older tutorial requests must now include Authorization: Bearer <API_KEY>.

GET /health/live checks only process liveness. GET /health/ready checks database connectivity and release schema. GET /metrics returns execution counts, at most 100 recent worker instances, and the number of overdue records still awaiting reconciliation. A worker is healthy when its heartbeat is less than 20 seconds old and it has not stopped. This proves recent connectivity, not business progress. Each process has a distinct instance ID, even when worker labels match.

Use GET /executions?status=failed to find failures. Inspect /executions/:id and /executions/:id/retries before requesting recovery. Retry after the underlying fault is resolved. If a handler performed an external effect, reconcile it or rely on its idempotency key before another attempt.

A worker checks expiry in batches of up to 100 queued executions per polling iteration; reads and checkpoints also enforce deadlines. Investigate a growing pending queue, stale workers, repeated failures, or overdue rows. Worker/engine console output provides execution IDs, steps, retries and failures. Central log shipping and alerts are deployment-specific.

Each manual retry preserves an audit snapshot. Current attempt counts reset for unfinished steps, so use the history endpoint for lifetime analysis. Retry history and worker presence are retained; add a deliberate retention policy before sustained high-volume use.

Migrations are serialized using a database advisory lock. Their checksums reject changed or missing migration files. The baseline option is only for the tutorial's existing 001–008 schema, and verifies required columns/status checks before adoption. Back up any real data before deploying schema changes.

Use PostgreSQL pg_dump for backups in your target environment and verify pg_restore into a separate database before relying on them. Keep credentials outside shell history. Container down preserves the release volume by default.

Graceful worker shutdown waits for the current handler to settle; a second interrupt force-terminates the process. Recovery waits for its lease to expire. Noncooperative handlers cannot be forcibly stopped safely by the engine. A provider's idempotency support remains essential.
