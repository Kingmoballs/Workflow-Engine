import { randomUUID } from "node:crypto";
import { pool } from "./database.js";

export async function createSimulatedPayment(
  idempotencyKey: string,
): Promise<string> {
  const inserted = await pool.query<{ id: string }>(
    `
      INSERT INTO simulated_payments (id, idempotency_key)
      VALUES ($1, $2)
      ON CONFLICT (idempotency_key) DO NOTHING
      RETURNING id
    `,
    [randomUUID(), idempotencyKey],
  );

  const newPayment = inserted.rows[0];

  if (newPayment) {
    console.log("Created simulated payment:", newPayment.id);
    return newPayment.id;
  }

  const existing = await pool.query<{ id: string }>(
    `
      SELECT id
      FROM simulated_payments
      WHERE idempotency_key = $1
    `,
    [idempotencyKey],
  );

  const previousPayment = existing.rows[0];

  if (!previousPayment) {
    throw new Error("Could not find the existing simulated payment.");
  }

  console.log("Reusing simulated payment:", previousPayment.id);

  return previousPayment.id;
}