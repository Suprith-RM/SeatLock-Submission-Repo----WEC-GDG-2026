/**
 * Repository for workshop persistence, availability calculations, and row locks.
 */
import { query } from '../config/db.js';

/**
 * Get all workshops with real-time seat availability.
 *
 * @returns {Promise<Array<object>>}
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
 * Get single workshop by ID with real-time availability.
 *
 * @param {string} id
 * @returns {Promise<object|null>}
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
 * Acquire exclusive row lock on workshop within an active transaction.
 *
 * @param {import('pg').PoolClient} client
 * @param {string} id
 * @returns {Promise<{ id: string, capacity: number }|null>}
 */
export async function lockForUpdate(client, id) {
  const result = await client.query(
    `SELECT id, capacity FROM workshops WHERE id = $1 FOR UPDATE`,
    [id]
  );
  return result.rows[0] ?? null;
}

/**
 * Count active reservations for a workshop within a transaction.
 * Excludes logically expired holds.
 *
 * @param {import('pg').PoolClient} client
 * @param {string} workshopId
 * @returns {Promise<number>}
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
