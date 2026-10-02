/**
 * All SQL for the workshops table.
 *
 * CRITICAL FUNCTION: lockForUpdate()
 * This is the serialization point for all concurrent reservation transactions.
 * When Transaction A calls lockForUpdate(workshopId), PostgreSQL acquires an
 * exclusive row-level lock on that specific workshop row.
 * If Transaction B calls lockForUpdate() for the SAME workshop while A holds the lock,
 * Transaction B BLOCKS until A commits or rolls back.
 * This means capacity checks and reservation inserts are effectively serialized,
 * making overbooking impossible.
 *
 * WHY NOT a table-level lock?
 * A row-level lock only blocks other transactions for THIS specific workshop.
 * Workshop A and Workshop B can have concurrent reservations without blocking each other.
 */
import { query } from '../config/db.js';

/**
 * Get all workshops with real-time seat availability.
 * Uses logical expiry: HELD rows where expires_at <= NOW() are NOT counted as active.
 */
export async function findAll() {
  const result = await query(`
    SELECT
      w.id,
      w.name,
      w.description,
      w.capacity,
      w.created_at,
      COUNT(r.id) FILTER (
        WHERE r.status = 'CONFIRMED'
           OR (r.status = 'HELD' AND r.expires_at > NOW())
      )::INT AS active_count,
      (
        w.capacity - COUNT(r.id) FILTER (
          WHERE r.status = 'CONFIRMED'
             OR (r.status = 'HELD' AND r.expires_at > NOW())
        )
      )::INT AS available_seats
    FROM workshops w
    LEFT JOIN reservations r ON r.workshop_id = w.id
    GROUP BY w.id
    ORDER BY w.created_at ASC
  `);
  return result.rows;
}

/**
 * Get one workshop with real-time availability. No lock — read-only.
 */
export async function findById(id) {
  const result = await query(`
    SELECT
      w.id,
      w.name,
      w.description,
      w.capacity,
      w.created_at,
      COUNT(r.id) FILTER (
        WHERE r.status = 'CONFIRMED'
           OR (r.status = 'HELD' AND r.expires_at > NOW())
      )::INT AS active_count,
      (
        w.capacity - COUNT(r.id) FILTER (
          WHERE r.status = 'CONFIRMED'
             OR (r.status = 'HELD' AND r.expires_at > NOW())
        )
      )::INT AS available_seats
    FROM workshops w
    LEFT JOIN reservations r ON r.workshop_id = w.id
    WHERE w.id = $1
    GROUP BY w.id
  `, [id]);
  return result.rows[0] ?? null;
}

/**
 * Lock the workshop row for a transaction.
 * MUST be called inside an active transaction (BEGIN already issued).
 * MUST use a client obtained from getClient(), not the pool's query() helper.
 *
 * After this returns, no other transaction can modify this workshop's reservation
 * count until this transaction COMMITs or ROLLBACKs.
 */
export async function lockForUpdate(client, id) {
  const result = await client.query(
    `SELECT id, capacity FROM workshops WHERE id = $1 FOR UPDATE`,
    [id]
  );
  return result.rows[0] ?? null;
}

/**
 * Count active reservations within a transaction, AFTER the workshop row is locked.
 *
 * Uses logical expiry: does NOT count HELD rows where expires_at <= NOW().
 * This ensures users with expired holds don't block new reservations.
 */
export async function countActive(client, workshopId) {
  const result = await client.query(`
    SELECT COUNT(*)::INT AS count
    FROM reservations
    WHERE workshop_id = $1
      AND (
        status = 'CONFIRMED'
        OR (status = 'HELD' AND expires_at > NOW())
      )
  `, [workshopId]);
  return result.rows[0].count;
}
