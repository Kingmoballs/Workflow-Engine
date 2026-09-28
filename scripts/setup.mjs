import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
const key = () => randomBytes(32).toString("hex");
if (!existsSync(".env")) {
  const password = key();
  writeFileSync(".env", [
    "POSTGRES_USER=workflow", "POSTGRES_PASSWORD=" + password, "POSTGRES_DB=workflow_engine",
    "DATABASE_URL=postgresql://workflow:" + password + "@127.0.0.1:5433/workflow_engine",
    "API_KEY=" + key(), "API_PORT=3000", ""
  ].join("\n"), { mode: 0o600 });
} else {
  const current = readFileSync(".env", "utf8");
  if (!/^API_KEY=.+$/m.test(current)) {
    mkdirSync("work/backups", { recursive: true });
    copyFileSync(".env", "work/backups/env-before-auth-" + Date.now());
    writeFileSync(".env", current.replace(/^API_KEY=.*\r?\n?/gm, "").trimEnd() + "\nAPI_KEY=" + key() + "\n", { mode: 0o600 });
  }
}
console.log("Local .env is ready. Secrets were not printed. Existing database settings were preserved.");
