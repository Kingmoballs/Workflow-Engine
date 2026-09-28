import "dotenv/config";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import pg from "pg";

const baseline = process.argv.slice(2);
if (baseline.some(arg => arg !== "--baseline-existing")) throw new Error("Only --baseline-existing is supported.");
const root = new URL("../migrations/", import.meta.url);
const names = (await readdir(root)).filter(name => /^\d{3}_.+\.sql$/.test(name)).sort();
const migrations = await Promise.all(names.map(async name => {
  const sql = await readFile(new URL(name, root), "utf8");
  return { name, sql, checksum: createHash("sha256").update(sql.replaceAll("\r\n", "\n")).digest("hex") };
}));
const client = new pg.Client({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 5000, statement_timeout: 60000 });
await client.connect();
try {
  await client.query("SELECT pg_advisory_lock(78124391)");
  const existing = (await client.query("SELECT to_regclass('workflow_executions') AS present")).rows[0].present;
  await client.query("CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp())");
  let applied = (await client.query<{ name: string; checksum: string }>("SELECT name,checksum FROM schema_migrations")).rows;
  if (existing && applied.length === 0) {
    if (!baseline.includes("--baseline-existing")) throw new Error("Existing unmanaged database: run migrations with --baseline-existing once to adopt migrations 001–008.");
    // This project previously applied 001–008 manually. Verify their schema before adoption.
    await client.query("SELECT id,workflow_name,status,created_at,updated_at,lease_owner,lease_generation,lease_expires_at,error,input,submission_key,timeout_ms,deadline_at FROM workflow_executions LIMIT 0");
    await client.query("SELECT workflow_execution_id,step_index,name,status,attempts,error,next_attempt_at,output FROM step_executions LIMIT 0");
    await client.query("SELECT id,idempotency_key,created_at FROM simulated_payments LIMIT 0");
    const checks = (await client.query("SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid IN ('workflow_executions'::regclass,'step_executions'::regclass) AND contype='c'")).rows;
    if (checks.filter(row => row.definition.includes("timed_out")).length !== 2) throw new Error("Baseline requires migration 008 status constraints.");
    const unique = (await client.query("SELECT 1 FROM pg_index WHERE indexrelid=to_regclass('workflow_submission_key_unique') AND indisunique")).rowCount;
    if (!unique) throw new Error("Baseline requires the submission-key unique index.");
    const newer = (await client.query("SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='workflow_executions' AND column_name='workflow_version'")).rowCount;
    if (newer) throw new Error("Untracked release schema detected; reconcile migration history explicitly.");
    await client.query("BEGIN");
    try {
      for (const migration of migrations.filter(item => item.name < "009")) {
        await client.query("INSERT INTO schema_migrations(name,checksum) VALUES ($1,$2)", [migration.name, migration.checksum]);
      }
      await client.query("COMMIT");
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    applied = (await client.query("SELECT name,checksum FROM schema_migrations")).rows;
    console.log("Adopted verified migrations 001–008.");
  }
  for (const row of applied) {
    if (migrations.find(item => item.name === row.name)?.checksum !== row.checksum) throw new Error("Migration missing or changed: " + row.name);
  }
  for (const migration of migrations) {
    if (applied.some(row => row.name === migration.name)) continue;
    await client.query("BEGIN");
    try {
      const sql = migration.sql.trim().replace(/^BEGIN;\s*/i, "").replace(/\s*COMMIT;$/i, "");
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations(name,checksum) VALUES ($1,$2)", [migration.name, migration.checksum]);
      await client.query("COMMIT");
      console.log("Applied " + migration.name);
    } catch (error) { await client.query("ROLLBACK"); throw error; }
  }
  console.log("Database migrations are current.");
} finally { await client.end(); }
