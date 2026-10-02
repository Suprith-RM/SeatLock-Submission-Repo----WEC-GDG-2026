/**
 * Repository for waitlist entries and queue ordering.
 */
import { query } from '../config/db.js';

/**
 * Get active WAITING entry for a user and workshop.
 *
 * @param {string} userId
 * @param {string} workshopId
 * @returns {Promise<object|null>}
 */
export async function findActiveByUserAndWorkshop(userId, workshopId) {
  const result = await query(`
    SELECT id, user_id, workshop_id, status, position, created_at, updated_at
    FROM   waitlist_entries
    WHERE  user_id = $1 AND workshop_id = $2 AND status = 'WAITING'
  `, [userId, workshopId]);
  return result.rows[0] ?? null;
}

/**
 * Get user's effective rank among currently WAITING entries.
 *
 * @param {string} userId
 * @param {string} workshopId
 * @returns {Promise<number|null>}
 */
export async function getEffectiveRank(userId, workshopId) {
  const result = await query(`
    WITH ranked AS (
      SELECT
        user_id,
        ROW_NUMBER() OVER (ORDER BY position ASC) AS rank
      FROM waitlist_entries
      WHERE workshop_id = $1 AND status = 'WAITING'
    )
    SELECT rank FROM ranked WHERE user_id = $2
  `, [workshopId, userId]);
  return result.rows[0]?.rank ? parseInt(result.rows[0].rank, 10) : null;
}

/**
 * Count total WAITING entries for a workshop.
 *
 * @param {string} workshopId
 * @returns {Promise<number>}
 */
export async function countWaiting(workshopId) {
  const result = await query(`
    SELECT COUNT(*)::INT AS count
    FROM waitlist_entries
    WHERE workshop_id = $1 AND status = 'WAITING'
  `, [workshopId]);
  return result.rows[0].count;
}

/**
 * Append user to the waitlist with monotonic sequence position.
 *
 * @param {import('pg').PoolClient} client
 * @param {string} userId
 * @param {string} workshopId
 * @returns {Promise<object>}
 */
export async function join(client, userId, workshopId) {
  const result = await client.query(`
    INSERT INTO waitlist_entries (user_id, workshop_id, status, position)
    VALUES (
      $1, $2, 'WAITING',
      COALESCE(
        (SELECT MAX(position) FROM waitlist_entries WHERE workshop_id = $2),
        0
      ) + 1
    )
    RETURNING *
  `, [userId, workshopId]);
  return result.rows[0];
}

/**
 * Update waitlist entry status to REMOVED.
 *
 * @param {import('pg').PoolClient} client
 * @param {string} entryId
 * @returns {Promise<object>}
 */
export async function remove(client, entryId) {
  const result = await client.query(`
    UPDATE waitlist_entries
    SET    status = 'REMOVED', updated_at = NOW()
    WHERE  id = $1
    RETURNING *
  `, [entryId]);
  return result.rows[0];
}

/**
 * Lock and retrieve next FIFO waiter using SKIP LOCKED for concurrent safety.
 *
 * @param {import('pg').PoolClient} client
 * @param {string} workshopId
 * @returns {Promise<object|null>}
 */
export async function lockNextWaiter(client, workshopId) {
  const result = await client.query(`
    SELECT id, user_id
    FROM   waitlist_entries
    WHERE  workshop_id = $1 AND status = 'WAITING'
    ORDER  BY position ASC
    LIMIT  1
    FOR UPDATE SKIP LOCKED
  `, [workshopId]);
  return result.rows[0] ?? null;
}

/**
 * Mark a waitlist entry as PROMOTED.
 *
 * @param {import('pg').PoolClient} client
 * @param {string} entryId
 */
export async function markPromoted(client, entryId) {
  await client.query(
    `UPDATE waitlist_entries SET status = 'PROMOTED', updated_at = NOW() WHERE id = $1`,
    [entryId]
  );
}
