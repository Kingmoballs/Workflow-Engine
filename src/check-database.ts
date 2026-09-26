import { pool } from "./database.js";

async function checkDatabase(): Promise<void> {
  try {
    const result = await pool.query(`
      SELECT
        current_database() AS database_name,
        NOW() AS database_time
    `);

    console.log("Database connection successful.");
    console.table(result.rows);
  } finally {
    await pool.end();
  }
}

checkDatabase().catch((error: unknown) => {
  console.error("Database connection failed:", error);
  process.exitCode = 1;
});