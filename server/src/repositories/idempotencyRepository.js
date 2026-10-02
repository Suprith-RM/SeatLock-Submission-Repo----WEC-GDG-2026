/**
 * All SQL for the idempotency_keys table.
 *
 * HOW IDEMPOTENCY WORKS IN THIS SYSTEM:
 *
 * CLIENT sends:  POST /api/workshops/:id/holds
 *                Idempotency-Key: <uuid>
 *
 * SERVER checks: SELECT ... FROM idempotency_keys WHERE key=$1 AND user_id=$2
 *
 * CASE A — Key NOT found:
 *   Execute business logic. On success, INSERT key + response IN THE SAME TRANSACTION.
 *   If the transaction commits → key is stored. Next retry returns cached response.
 *   If the transaction rolls back (e.g., no seats) → key is NOT stored. Next retry tries again.
 *
 * CASE B — Key found:
 *   Return stored response_status + response_body immediately. Business logic does NOT run.
 *   This guarantees exactly-once semantics for the client.
 *
 * CASE C — Key found but request_hash differs:
 *   Same key, different body = client error. Return 409 IDEMPOTENCY_KEY_CONFLICT.
 */
import { query } from '../config/db.js';

/**
 * Look up a key. Called BEFORE starting the business transaction.
 * Returns the stored record, or null if not found or expired.
 */
export async function findKey(key, userId) {
  const result = await query(`
    SELECT key, user_id, request_path, request_hash, response_status, response_body
    FROM   idempotency_keys
    WHERE  key = $1 AND user_id = $2 AND expires_at > NOW()
  `, [key, userId]);
  return result.rows[0] ?? null;
}

/**
 * Save a key with the response. MUST be called INSIDE the business transaction.
 * If the transaction rolls back, this INSERT also rolls back.
 * ON CONFLICT DO NOTHING: safe if the same key arrives before the first
 * transaction commits (extremely rare race — second request is blocked
 * by the first transaction's row lock, then finds it stored after commit).
 */
export async function saveKey(client, {
  key, userId, requestPath, requestHash, responseStatus, responseBody,
}) {
  await client.query(`
    INSERT INTO idempotency_keys
      (key, user_id, request_path, request_hash, response_status, response_body)
    VALUES ($1, $2, $3, $4, $5, $6::jsonb)
    ON CONFLICT (key, user_id) DO NOTHING
  `, [key, userId, requestPath, requestHash, responseStatus, JSON.stringify(responseBody)]);
}
