> Release update: API requests require Authorization: Bearer <API_KEY>. Run npm run setup and see [the release guide](../README.md) for authenticated examples, versions, and retry controls.

# Integrating an application

Start PostgreSQL with docker compose up -d, then use separate terminals in the project folder:

```powershell
npm.cmd run api
npm.cmd run worker
```

The API listens on http://127.0.0.1:3000. Set API_PORT to change its port. The API requires a shared Bearer key and binds to loopback by default.

In a third PowerShell terminal, list workflows and submit one:

```powershell
Invoke-RestMethod http://127.0.0.1:3000/workflows
$execution = Invoke-RestMethod -Method Post -Uri http://127.0.0.1:3000/executions -ContentType 'application/json' -Body '{"workflowName":"retry-demo"}'
$execution
Invoke-RestMethod "http://127.0.0.1:3000/executions/$($execution.id)" | ConvertTo-Json -Depth 5
```

POST /executions returns HTTP 202 and a Location header after the execution is saved. The worker executes it independently. Without a running worker, the execution stays queued. GET /executions/:id returns current status and individual step attempts, errors and retry times.

The request accepts workflowName and optional JSON input; see [Workflow data](workflow-data.md). Send an optional Idempotency-Key header to safely retry a POST; see [Request idempotency](idempotency.md). Without a key, repeating a POST creates another execution. The existing payment idempotency prevents duplicate simulated payments within one execution, not between separate executions.

Responses use JSON. Invalid bodies or UUIDs return 400, unknown workflows/executions/routes return 404, wrong methods return 405, bodies over 16 KiB return 413, and unsupported content types return 415. Internal errors return 500 without exposing database details.

Run npm.cmd run test:api for the HTTP contract tests, or npm.cmd test for all tests. The engine integration tests require PostgreSQL and use their own temporary schema.

Cancel a pending or running execution with POST /executions/:id/cancel. See [Cancellation](cancellation.md) for cooperative stopping and response codes.

Optional timeoutMs sets a durable execution deadline; see [Execution timeouts](timeouts.md). It is part of the idempotent request identity.
