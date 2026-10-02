/**
 * Inserts an entry into the append-only reservation_events audit log.
 *
 * @param {import('pg').PoolClient} client
 * @param {object} params
 */
export async function insertEvent(client, {
  reservationId = null,
  userId,
  workshopId,
  eventType,
  prevStatus = null,
  newStatus,
  reason = null,
  metadata = {},
}) {
  await client.query(`
    INSERT INTO reservation_events
      (reservation_id, user_id, workshop_id, event_type, prev_status, new_status, reason, metadata)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
  `, [
    reservationId, userId, workshopId,
    eventType, prevStatus, newStatus,
    reason, JSON.stringify(metadata),
  ]);
}
