/**
 * All SQL for the reservations table.
 *
 * TRANSACTION AWARENESS:
 * Functions that accept a `client` parameter MUST be called inside
 * an explicit transaction (BEGIN already issued on that client).
 * Functions that only accept a pool `query` use the pool directly (no transaction needed).
 */
import { query } from '../config/db.js';

/**
 * Find reservation by ID — simple read, no lock.
 */
export async function findById(id) {
  const result = await query(`
    SELECT id, user_id, workshop_id, status, expires_at, created_at, updated_at
    FROM reservations WHERE id = $1
  `, [id]);
  return result.rows[0] ?? null;
}

/**
 * Get the active (HELD or CONFIRMED) reservation a user has for a workshop.
 * Returns null if no active reservation.
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
 * Expire any of this user's logically-overdue holds for a workshop.
 * Called at the START of createHold to clean up before inserting,
 * so the partial unique index doesn't block a re-hold after expiry.
 * Must be called inside a transaction, after the workshop row is locked.
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
  return result.rows; // List of IDs that were expired
}

/**
 * Insert a new HELD reservation.
 * MUST be called inside a transaction, after the workshop row is locked and
 * capacity has been verified. The hold expires after holdDurationSeconds.
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
 * Atomically confirm a HELD reservation.
 * The WHERE clause is the critical guard:
 *   - status = 'HELD'          → already confirmed/cancelled fails
 *   - expires_at > NOW()        → logically expired holds fail
 *   - user_id = $2             → ownership check (cannot confirm another user's hold)
 *
 * Returns the updated row, or null if any condition failed.
 * Zero rows = one of the conditions failed. The service diagnoses which one.
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
 * Lock a reservation row for reading + modification within a transaction.
 * Used in cancel to get the current state before updating.
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
 * Called by the sweep job. Returns the expired rows.
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
