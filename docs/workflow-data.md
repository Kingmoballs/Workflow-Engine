> Release update: API requests require Authorization: Bearer <API_KEY>. Run npm run setup and see [the release guide](../README.md) for authenticated examples, versions, and retry controls.

# Workflow input and step results

POST /executions accepts workflowName and optional input. GET /executions/:id returns the saved input and each completed step's output.

For fulfil-order, input contains orderId (nonempty string), amount (positive integer in the currency's minor units), and currency (three uppercase letters). The payment remains simulated; it does not charge money. Omitting input preserves the original demo.

Start the API and worker in separate project terminals with npm.cmd run api and npm.cmd run worker. Restart existing processes after upgrading.

```powershell
$body = @{
  workflowName = 'fulfil-order'
  input = @{ orderId = 'ORD-123'; amount = 2500000; currency = 'NGN' }
} | ConvertTo-Json -Depth 5

$execution = Invoke-RestMethod -Method Post -Uri http://127.0.0.1:3000/executions -ContentType 'application/json' -Body $body
Invoke-RestMethod "http://127.0.0.1:3000/executions/$($execution.id)" | ConvertTo-Json -Depth 10
```

The example amount is NGN 25,000 expressed in kobo. The payment demo retains its 30-second delay, so poll after it finishes.

A handler receives context.input and context.outputs, keyed by earlier completed step names. Return a JSON value from execute to persist an output. Returning nothing leaves output absent; returning null saves explicit JSON null. Completed steps are skipped on recovery and their saved outputs remain available.

Each handler gets detached data. Mutating its context cannot alter persisted input or earlier outputs. Output is committed together with step completion under the worker's ownership checks. External effects still need idempotency if a crash happens before the checkpoint.

JSON values must be finite and acyclic, with plain objects or arrays. Each input or output is limited to 64 KiB and 64 nesting levels; the HTTP request body still has its stricter 16 KiB limit. Invalid order input is rejected before enqueueing; invalid handler output fails the step.

Migration 005_execution_data.sql adds nullable JSONB columns without changing old records. This migration has been applied to the local development database. New installations must apply migrations 001 through 005 in order.

Request idempotency is available through the Idempotency-Key header; see [Safe repeated submissions](idempotency.md). Workflow versioning is available in the release; payment/delivery integrations remain simulated.
