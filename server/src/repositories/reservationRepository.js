/**
 * Repository for reservation persistence and state transitions.
 */
import { query } from '../config/db.js';

/**
 * Find reservation by ID.
 *
 * @param {string} id
 * @returns {Promise<object|null>}
 */
export async function findById(id) {
  const result = await query(`
    SELECT id, user_id, workshop_id, status, expires_at, created_at, updated_at
    FROM reservations WHERE id = $1
  `, [id]);
  return result.rows[0] ?? null;
}

/**
 * Find active (HELD or CONFIRMED) reservation for a user in a workshop.
 *
 * @param {string} userId
 * @param {string} workshopId
 * @returns {Promise<object|null>}
 */
export async function findActiveByUserAndWorkshop(userId, workshopId) {
  const result = await query(`
    SELECT id, user_id, workshop_id, status, expires_at, created_at, updated_at
    FROM reservations
    WHERE user_id = $1
      AND workshop_id = $2
      AND status IN ('HELD', 'CONFIRMED')
  `, [userId, workshopId]);
  return result.rows[0] ?? null;
}

/**
 * Expire user's stale holds for a workshop before attempting a new hold.
 *
 * @param {import('pg').PoolClient} client
 * @param {string} userId
 * @param {string} workshopId
 * @returns {Promise<Array<{ id: string }>>}
 */
export async function expireStaleHolds(client, userId, workshopId) {
  const result = await client.query(`
    UPDATE reservations
    SET status = 'EXPIRED', updated_at = NOW()
    WHERE user_id = $1
      AND workshop_id = $2
      AND status = 'HELD'
      AND expires_at <= NOW()
    RETURNING id
  `, [userId, workshopId]);
  return result.rows;
}

/**
 * Insert a new HELD reservation within a locked workshop transaction.
 *
 * @param {import('pg').PoolClient} client
 * @param {object} params
 * @returns {Promise<object>}
 */
export async function createHold(client, { userId, workshopId, holdDurationSeconds }) {
  const result = await client.query(`
    INSERT INTO reservations (user_id, workshop_id, status, expires_at)
    VALUES ($1, $2, 'HELD', NOW() + ($3 || ' seconds')::INTERVAL)
    RETURNING *
  `, [userId, workshopId, holdDurationSeconds]);
  return result.rows[0];
}

/**
 * Atomically confirm a HELD reservation if unexpired and owned by user.
 *
 * @param {import('pg').PoolClient} client
 * @param {object} params
 * @returns {Promise<object|null>}
 */
export async function confirmHold(client, { reservationId, userId }) {
  const result = await client.query(`
    UPDATE reservations
    SET    status = 'CONFIRMED', expires_at = NULL, updated_at = NOW()
    WHERE  id        = $1
      AND  user_id   = $2
      AND  status    = 'HELD'
      AND  expires_at > NOW()
    RETURNING *
  `, [reservationId, userId]);
  return result.rows[0] ?? null;
}

/**
 * Lock reservation row within a transaction.
 *
 * @param {import('pg').PoolClient} client
 * @param {string} id
 * @returns {Promise<object|null>}
 */
export async function lockById(client, id) {
  const result = await client.query(
    `SELECT * FROM reservations WHERE id = $1 FOR UPDATE`,
    [id]
  );
  return result.rows[0] ?? null;
}

/**
 * Expire all overdue HELD reservations across all workshops.
 *
 * @param {import('pg').PoolClient} client
 * @returns {Promise<Array<object>>}
 */
export async function expireAllOverdueHolds(client) {
  const result = await client.query(`
    UPDATE reservations
    SET    status = 'EXPIRED', updated_at = NOW()
    WHERE  status = 'HELD' AND expires_at < NOW()
    RETURNING id, user_id, workshop_id
  `);
  return result.rows;
}
