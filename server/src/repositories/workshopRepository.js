/**
 * Workshop repository for persistence and seat availability queries.
 */
import { query } from '../config/db.js';

function formatWorkshop(row) {
  const heldCount      = row.held_count      ?? 0;
  const confirmedCount = row.confirmed_count ?? 0;
  const availableSeats = Math.max(0, row.capacity - heldCount - confirmedCount);
  return {
    id:             row.id,
    name:           row.name,
    description:    row.description,
    capacity:       row.capacity,
    heldCount,
    confirmedCount,
    availableSeats,
    isFull:         availableSeats === 0,
    createdAt:      row.created_at,
    updatedAt:      row.updated_at,
  };
}

const COUNTS_SQL = `
  COUNT(r.id) FILTER (
    WHERE r.status = 'HELD' AND r.expires_at > NOW()
  )::INT AS held_count,
  COUNT(r.id) FILTER (
    WHERE r.status = 'CONFIRMED'
  )::INT AS confirmed_count
`;

export async function findAll() {
  const result = await query(`
    SELECT
      w.id, w.name, w.description, w.capacity, w.created_at,
      ${COUNTS_SQL}
    FROM workshops w
    LEFT JOIN reservations r ON r.workshop_id = w.id
    GROUP BY w.id
    ORDER BY w.created_at ASC
  `);
  return result.rows.map(formatWorkshop);
}

export async function findById(workshopId) {
  const result = await query(`
    SELECT
      w.id, w.name, w.description, w.capacity, w.created_at,
      ${COUNTS_SQL}
    FROM workshops w
    LEFT JOIN reservations r ON r.workshop_id = w.id
    WHERE w.id = $1
    GROUP BY w.id
  `, [workshopId]);
  return result.rows[0] ? formatWorkshop(result.rows[0]) : null;
}

/**
 * Acquire exclusive row lock within an active transaction client.
 */
export async function findByIdForUpdate(workshopId, client) {
  const result = await client.query(`
    SELECT id, name, capacity FROM workshops WHERE id = $1 FOR UPDATE
  `, [workshopId]);
  return result.rows[0] ?? null;
}

export async function lockForUpdate(client, id) {
  return findByIdForUpdate(id, client);
}

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
  return result.rows[0]?.count ?? 0;
}
