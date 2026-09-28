> Release update: API requests require Authorization: Bearer <API_KEY>. Run npm run setup and see [the release guide](../README.md) for authenticated examples, versions, and retry controls.

# Safe repeated submissions

Send an optional Idempotency-Key header with POST /executions. Generate one key per intended execution and reuse that key when retrying after a timeout or lost response.

- Same key, workflow, and JSON input: returns the original execution with its current status and the same Location header (HTTP 202).
- Same key with different workflow or input: HTTP 409.
- No key: each POST creates another execution.
- Malformed or repeated key headers: HTTP 400.

Keys contain 1–128 ASCII letters, digits, dots, underscores, colons, or hyphens. Keys are case-sensitive and global within this engine database, across workflows. They have no expiry; a failed or completed execution still owns its key. Use a new key only when you intend to create a separate execution.

Object property order does not affect matching. Array order does. Omitted input and explicit null are equivalent.

## PowerShell example

Run the API and worker in separate terminals. In another terminal:

```powershell
$headers = @{ 'Idempotency-Key' = [guid]::NewGuid().ToString() }
$body = @{ workflowName = 'retry-demo'; input = @{ orderId = 'ORD-123' } } | ConvertTo-Json -Depth 5

$first = Invoke-RestMethod -Method Post -Uri http://127.0.0.1:3000/executions -Headers $headers -ContentType 'application/json' -Body $body
$retry = Invoke-RestMethod -Method Post -Uri http://127.0.0.1:3000/executions -Headers $headers -ContentType 'application/json' -Body $body
$first.id -eq $retry.id
```

The result is True. Keep the same headers and body when retrying; generating a fresh key for every HTTP attempt defeats deduplication. GET /executions/:id remains the normal way to poll progress.

TypeScript callers can use enqueueWorkflow(name, input, submissionKey).

## Durability

Migration 006_submission_idempotency.sql adds a nullable key and unique index. The key, execution, and initial steps are committed in one transaction. Concurrent callers wait on the unique constraint; a rolled-back submission does not reserve a key. Workers never change submission keys. The replay loads saved progress without resetting attempts or rerunning handlers.

If a busy database causes a timeout, retry with the same key. This also handles an uncertain response after a successful commit. Definitions and input validation must still be available; workflow versions are pinned in the release.

This prevents duplicate executions for keyed submissions. External effects still require their own idempotency (as simulated payments already use). The API uses one shared key for a single trusted environment; idempotency keys are global in that environment.
