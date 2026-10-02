/**
 * Atomic idempotency service using database transactions.
 */
import { createHash } from 'crypto';
import { getClient }  from '../config/db.js';
import { AppError, ErrorCode } from '../utils/errors.js';

function hashRequest(requestPath, requestBody) {
  return createHash('sha256')
    .update(JSON.stringify({ path: requestPath, body: requestBody ?? {} }))
    .digest('hex');
}

/**
 * Execute an operation wrapped in an atomic idempotency key claim.
 *
 * @param {object} options
 * @param {string} options.idempotencyKey
 * @param {string} options.userId
 * @param {string} options.requestPath
 * @param {any} options.requestBody
 * @param {number} [options.responseStatus=200]
 * @param {Function} options.work - async (client) => responseBody
 */
export async function executeWithIdempotency({
  idempotencyKey,
  userId,
  requestPath,
  requestBody,
  responseStatus = 200,
  work,
}) {
  const requestHash = hashRequest(requestPath, requestBody);
  const client      = await getClient();

  try {
    await client.query('BEGIN');

    // Claim the idempotency key atomically with response_status = 0 (in-flight)
    const claim = await client.query(`
      INSERT INTO idempotency_keys
        (key, user_id, request_hash, request_path, response_status, response_body, expires_at)
      VALUES
        ($1, $2, $3, $4, 0, 'null'::jsonb, NOW() + INTERVAL '24 hours')
      ON CONFLICT (key, user_id) DO NOTHING
      RETURNING key
    `, [idempotencyKey, userId, requestHash, requestPath]);

    if (claim.rows.length === 0) {
      // Key already exists; read existing response
      const existing = await client.query(`
        SELECT request_hash, response_status, response_body
        FROM   idempotency_keys
        WHERE  key = $1 AND user_id = $2
      `, [idempotencyKey, userId]);

      await client.query('ROLLBACK');

      if (!existing.rows[0] || existing.rows[0].response_status === 0) {
        throw new AppError(
          'IDEMPOTENCY_IN_FLIGHT',
          'This request is already being processed. Please retry after 1 second.',
          409,
        );
      }

      if (existing.rows[0].request_hash !== requestHash) {
        throw AppError.conflict(
          ErrorCode.IDEMPOTENCY_KEY_CONFLICT,
          'This Idempotency-Key was used with a different request. ' +
          'Generate a new UUID for each distinct operation.',
        );
      }

      return {
        fromCache:    true,
        cachedStatus: existing.rows[0].response_status,
        cachedBody:   existing.rows[0].response_body,
      };
    }

    // Key claimed successfully; execute work within transaction
    const responseBody = await work(client);

    await client.query(`
      UPDATE idempotency_keys
      SET    response_status = $1, response_body = $2
      WHERE  key = $3 AND user_id = $4
    `, [responseStatus, JSON.stringify(responseBody), idempotencyKey, userId]);

    await client.query('COMMIT');
    return responseBody;

  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw err;
  } finally {
    client.release();
  }
}
