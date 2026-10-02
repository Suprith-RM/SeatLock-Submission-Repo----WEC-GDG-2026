/**
 * Waitlist service managing waitlist entry lifecycles and queue promotions.
 */
import { query, getClient }        from '../config/db.js';
import { executeWithIdempotency }  from './idempotencyService.js';
import { AppError, ErrorCode }     from '../utils/errors.js';
import { logger }                  from '../utils/logger.js';

const HOLD_DURATION_SECONDS = parseInt(process.env.HOLD_DURATION_SECONDS || '300', 10);

/**
 * Promote eligible waiters into active holds while caller holds the workshop lock.
 *
 * @param {string} workshopId
 * @param {import('pg').PoolClient} client
 * @returns {Promise<number>} Number of promoted waiters
 */
export async function promoteEligibleWaiters(workshopId, client) {
  let promoted = 0;

  const ws = await client.query(
    'SELECT capacity FROM workshops WHERE id = $1',
    [workshopId],
  );
  if (!ws.rows[0]) return 0;
  const maxIterations = ws.rows[0].capacity;

  for (let i = 0; i < maxIterations; i++) {
    const counts = await client.query(`
      SELECT
        COUNT(*) FILTER (WHERE status = 'HELD' AND expires_at > NOW())::INT AS held,
        COUNT(*) FILTER (WHERE status = 'CONFIRMED')::INT AS confirmed
      FROM reservations
      WHERE workshop_id = $1
    `, [workshopId]);
    const { held, confirmed } = counts.rows[0];
    if (held + confirmed >= ws.rows[0].capacity) break;

    const nextEntry = await client.query(`
      SELECT id, user_id
      FROM   waitlist_entries
      WHERE  workshop_id = $1 AND status = 'WAITING'
      ORDER  BY position ASC
      LIMIT  1
      FOR UPDATE SKIP LOCKED
    `, [workshopId]);

    if (!nextEntry.rows[0]) break;

    const { id: entryId, user_id: candidateId } = nextEntry.rows[0];

    const hasActive = await client.query(`
      SELECT 1 FROM reservations
      WHERE  workshop_id = $1 AND user_id = $2
        AND  status IN ('HELD', 'CONFIRMED')
        AND  (status = 'CONFIRMED' OR expires_at > NOW())
    `, [workshopId, candidateId]);

    if (hasActive.rows.length > 0) {
      await client.query(`
        UPDATE waitlist_entries SET status = 'REMOVED', updated_at = NOW()
        WHERE  id = $1
      `, [entryId]);
      await client.query(`
        INSERT INTO reservation_events
          (user_id, workshop_id, event_type, new_status, metadata)
        VALUES ($1, $2, 'WAITLIST_ENTRY_INVALIDATED', 'REMOVED', $3)
      `, [candidateId, workshopId,
          JSON.stringify({ reason: 'user_already_has_reservation', entryId })]);
      logger.debug('Skipped ineligible waitlist entry', { entryId, candidateId, workshopId });
      continue;
    }

    await client.query(`
      UPDATE waitlist_entries SET status = 'PROMOTED', updated_at = NOW()
      WHERE  id = $1
    `, [entryId]);

    const expiresAt = new Date(Date.now() + HOLD_DURATION_SECONDS * 1000);
    const newRes = await client.query(`
      INSERT INTO reservations (user_id, workshop_id, status, expires_at)
      VALUES ($1, $2, 'HELD', $3)
      RETURNING *
    `, [candidateId, workshopId, expiresAt]);

    await client.query(`
      INSERT INTO reservation_events
        (reservation_id, user_id, workshop_id, event_type, new_status, metadata)
      VALUES ($1, $2, $3, 'PROMOTED_FROM_WAITLIST', 'HELD', $4)
    `, [newRes.rows[0].id, candidateId, workshopId,
        JSON.stringify({ promotedFromEntryId: entryId, expiresAt })]);

    logger.info('Waitlist promotion', {
      workshopId,
      promotedUserId: candidateId,
      reservationId:  newRes.rows[0].id,
      totalPromoted:  promoted + 1,
    });
    promoted++;
  }

  return promoted;
}

export async function promoteNext(workshopId) {
  const client = await getClient();
  try {
    await client.query('BEGIN');
    await client.query('SELECT id FROM workshops WHERE id = $1 FOR UPDATE', [workshopId]);
    const promoted = await promoteEligibleWaiters(workshopId, client);
    await client.query('COMMIT');
    return promoted > 0;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw err;
  } finally {
    client.release();
  }
}

export async function joinWaitlist({ userId, workshopId, idempotencyKey, requestBody }) {
  const result = await executeWithIdempotency({
    idempotencyKey,
    userId,
    requestPath:    `/workshops/${workshopId}/waitlist/join`,
    requestBody:    requestBody ?? {},
    responseStatus: 201,
    work: async (client) => {
      const ws = await client.query(
        'SELECT id, capacity FROM workshops WHERE id = $1 FOR UPDATE',
        [workshopId],
      );
      if (!ws.rows[0]) {
        throw AppError.notFound(ErrorCode.WORKSHOP_NOT_FOUND, 'Workshop not found.');
      }

      const hasReservation = await client.query(`
        SELECT 1 FROM reservations
        WHERE  workshop_id = $1 AND user_id = $2
          AND  status IN ('HELD', 'CONFIRMED')
          AND  (status = 'CONFIRMED' OR expires_at > NOW())
      `, [workshopId, userId]);
      if (hasReservation.rows.length > 0) {
        throw AppError.conflict(
          ErrorCode.ALREADY_HAS_RESERVATION,
          'You already have an active reservation. Cancel it before joining the waitlist.',
        );
      }

      const counts = await client.query(`
        SELECT
          COUNT(*) FILTER (WHERE status = 'HELD' AND expires_at > NOW())::INT AS held,
          COUNT(*) FILTER (WHERE status = 'CONFIRMED')::INT AS confirmed
        FROM reservations WHERE workshop_id = $1
      `, [workshopId]);
      const { held, confirmed } = counts.rows[0];
      if (held + confirmed < ws.rows[0].capacity) {
        throw AppError.conflict(
          ErrorCode.SEATS_AVAILABLE_USE_HOLD,
          'Seats are available. Use the hold endpoint instead of joining the waitlist.',
        );
      }

      const alreadyWaiting = await client.query(`
        SELECT 1 FROM waitlist_entries
        WHERE workshop_id = $1 AND user_id = $2 AND status = 'WAITING'
      `, [workshopId, userId]);
      if (alreadyWaiting.rows.length > 0) {
        throw AppError.conflict(
          ErrorCode.ALREADY_ON_WAITLIST,
          'You are already on the waitlist for this workshop.',
        );
      }

      const posResult = await client.query(`
        SELECT COALESCE(MAX(position), 0) + 1 AS next_pos
        FROM   waitlist_entries
        WHERE  workshop_id = $1 AND status = 'WAITING'
      `, [workshopId]);
      const position = posResult.rows[0].next_pos;

      const entryResult = await client.query(`
        INSERT INTO waitlist_entries (user_id, workshop_id, status, position)
        VALUES ($1, $2, 'WAITING', $3)
        RETURNING *
      `, [userId, workshopId, position]);

      await client.query(`
        INSERT INTO reservation_events (user_id, workshop_id, event_type, new_status, metadata)
        VALUES ($1, $2, 'WAITLIST_JOINED', 'WAITING', $3)
      `, [userId, workshopId, JSON.stringify({ position })]);

      const entry = entryResult.rows[0];
      return {
        message: `You have joined the waitlist at position ${position}.`,
        entry: {
          id:         entry.id,
          userId:     entry.user_id,
          workshopId: entry.workshop_id,
          status:     entry.status,
          position:   entry.position,
          createdAt:  entry.created_at,
        },
      };
    },
  });

  return result;
}

export async function leaveWaitlist({ userId, workshopId, idempotencyKey, requestBody }) {
  const result = await executeWithIdempotency({
    idempotencyKey,
    userId,
    requestPath:    `/workshops/${workshopId}/waitlist/leave`,
    requestBody:    requestBody ?? {},
    responseStatus: 200,
    work: async (client) => {
      const entryResult = await client.query(`
        UPDATE waitlist_entries
        SET    status = 'REMOVED', updated_at = NOW()
        WHERE  workshop_id = $1 AND user_id = $2 AND status = 'WAITING'
        RETURNING *
      `, [workshopId, userId]);

      if (!entryResult.rows[0]) {
        throw AppError.notFound(
          ErrorCode.NOT_ON_WAITLIST,
          'You are not currently on the waitlist for this workshop.',
        );
      }

      const entry = entryResult.rows[0];
      await client.query(`
        INSERT INTO reservation_events (user_id, workshop_id, event_type, new_status, metadata)
        VALUES ($1, $2, 'WAITLIST_LEFT', 'REMOVED', $3)
      `, [userId, workshopId, JSON.stringify({ entryId: entry.id })]);

      return {
        message: 'You have left the waitlist.',
        entry: {
          id:         entry.id,
          userId:     entry.user_id,
          workshopId: entry.workshop_id,
          status:     entry.status,
          updatedAt:  entry.updated_at,
        },
      };
    },
  });

  return result;
}

export async function getWaitlistPosition({ userId, workshopId }) {
  const result = await query(`
    SELECT we.id, we.position, we.status,
      (SELECT COUNT(*)::INT FROM waitlist_entries
       WHERE workshop_id = $1 AND status = 'WAITING') AS total_waiting
    FROM waitlist_entries we
    WHERE we.workshop_id = $1 AND we.user_id = $2 AND we.status = 'WAITING'
  `, [workshopId, userId]);

  if (!result.rows[0]) {
    throw AppError.notFound(
      ErrorCode.NOT_ON_WAITLIST,
      'You are not currently on the waitlist for this workshop.',
    );
  }

  const row = result.rows[0];
  return {
    position:     row.position,
    totalWaiting: row.total_waiting,
    workshopId,
  };
}
