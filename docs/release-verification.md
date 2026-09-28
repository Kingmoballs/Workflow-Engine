# Release verification

The agreed portfolio release scope is implemented: explicit failed-run retries with audit history, pinned workflow versions, shared-key API authentication, execution listing and worker monitoring, tracked migrations, container deployment, an integration client, and CI configuration.

Verified locally:
- TypeScript build passed.
- Full suite: 55 tests passed, zero failed.
- Fresh-schema migrations and repeat migration runs passed.
- Existing tutorial database adopted migrations 001–008 and applied 009 without deleting records.
- Container images built successfully; fresh deployment migrations and readiness checks passed.
- Live authenticated client passed on 2026-09-28 against localhost:3001: two identical submissions returned execution 6100c783-d92b-4b28-856e-db85e0b4124a, which completed with three payment-step attempts.
- Metrics showed one completed execution, a healthy worker, and zero overdue executions awaiting reconciliation.

The temporary workflow-release deployment was stopped after verification; its database volume is retained. Start it again using the README commands. The tutorial database and separately running local API were not stopped.

CI configuration is included but has not run on a remote repository. Public production deployment, load tests, operational alerts, and backup/restore verification remain deployment-specific work.
