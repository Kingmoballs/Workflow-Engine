> Release update: API requests require Authorization: Bearer <API_KEY>. Run npm run setup and see [the release guide](../README.md) for authenticated examples, versions, and retry controls.

# Cancelling executions

POST /executions/:id/cancel cancels a pending or running execution. No request body is required.

```powershell
Invoke-RestMethod -Method Post "http://127.0.0.1:3000/executions/$($execution.id)/cancel" |
  ConvertTo-Json -Depth 10
```

A successful request returns HTTP 200 with status cancelled. Repeating cancellation returns the same cancelled execution. Unknown IDs return 404, malformed IDs return 400, and already completed or failed executions return 409.

Cancellation preserves completed steps and their outputs. Unfinished steps become cancelled and lose scheduled retry deadlines. Cancelled executions cannot be automatically claimed or manually resumed. Reusing their submission key returns the cancelled execution; a new intended run needs a new key.

The cancellation transaction locks the parent execution row, just like worker checkpoints. If completion commits first, cancellation returns 409. If cancellation commits first, subsequent worker checkpoints cannot overwrite the cancelled status or publish late results.

Workers check through their lease heartbeat at most every 250 ms under normal conditions; database latency can extend this. They abort the handler's context.signal. Handlers should pass this signal to supported I/O and timers and check it before external actions.

Cancelled means further engine progress is prevented. It does not guarantee an external request has stopped or undo payments, reservations, or other effects. A handler that ignores its signal can continue running until it returns, but cannot publish success. Its worker waits for it to settle before releasing ownership. Completed effects may need reconciliation or compensation.

Migration 007_cancellation.sql expands workflow and step status constraints. It preserves existing records and has been applied to the local database. Restart existing API and worker processes to use cancellation. A full installation applies migrations 001 through 007 in order.

This step implements cancellation only; execution timeouts and explicit failed-workflow retry controls are now available in the release.
