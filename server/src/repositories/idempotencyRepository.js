/**
 * Repository for idempotency key persistence and lookup.
 */
import { query } from '../config/db.js';

/**
 * Look up an unexpired idempotency record by key and user ID.
 *
 * @param {string} key
 * @param {string} userId
 * @returns {Promise<object|null>}
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
 * Persist idempotency record within an active transaction.
 *
 * @param {import('pg').PoolClient} client
 * @param {object} params
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
