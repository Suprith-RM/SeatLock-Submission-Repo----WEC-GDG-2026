/**
 * Reservation service handling hold creation, confirmation, and cancellation.
 */
import { createHash } from 'crypto';
import { getClient, query } from '../config/db.js';
import * as reservationRepo from '../repositories/reservationRepository.js';
import * as eventRepo from '../repositories/eventRepository.js';
import { broadcastWorkshopUpdate } from '../realtime/sseManager.js';
import { AppError, ErrorCode } from '../utils/errors.js';
import { logger } from '../utils/logger.js';

const HOLD_DURATION_SECONDS = () =>
  parseInt(process.env.HOLD_DURATION_SECONDS || '300', 10);

function hashBody(body) {
  return createHash('sha256')
    .update(JSON.stringify(body ?? {}))
    .digest('hex');
}

export async function createHold({ userId, workshopId, idempotencyKey, requestPath, requestBody }) {
  const requestHash = hashBody(requestBody);
  const client = await getClient();

  try {
    await client.query('BEGIN');

    // ── STEP 1: Atomically claim the idempotency key ─────────────────────────
    if (idempotencyKey) {
      const claimResult = await client.query(`
        INSERT INTO idempotency_keys
          (key, user_id, request_hash, request_path, response_status, response_body, expires_at)
        VALUES
          ($1, $2, $3, $4, 0, 'null'::jsonb, NOW() + INTERVAL '24 hours')
        ON CONFLICT (key, user_id) DO NOTHING
        RETURNING key
      `, [idempotencyKey, userId, requestHash, requestPath || '/workshops/holds']);

      if (claimResult.rows.length === 0) {
        const existing = await client.query(`
          SELECT request_hash, response_status, response_body
          FROM   idempotency_keys
          WHERE  key = $1 AND user_id = $2
        `, [idempotencyKey, userId]);

        await client.query('ROLLBACK');

        if (existing.rows.length === 0 || existing.rows[0].response_status === 0) {
          throw new AppError(
            'IDEMPOTENCY_IN_FLIGHT',
            'This request is already being processed. Please retry after 1 second.',
            409,
          );
        }

        const ex = existing.rows[0];

        if (ex.request_hash !== requestHash) {
          throw AppError.conflict(
            ErrorCode.IDEMPOTENCY_KEY_CONFLICT,
            'This Idempotency-Key was used with a different request body. Generate a new key for a new request.',
          );
        }

        logger.debug('Idempotency cache hit', { idempotencyKey, userId });
        return { fromCache: true, cachedBody: ex.response_body, cachedStatus: ex.response_status };
      }
    }

    // ── STEP 2: Lock the workshop row ────────────────────────────────────────
    const wsResult = await client.query(
      'SELECT id, name, capacity FROM workshops WHERE id = $1 FOR UPDATE',
      [workshopId],
    );

    if (!wsResult.rows[0]) {
      await client.query('ROLLBACK');
      throw AppError.notFound(ErrorCode.WORKSHOP_NOT_FOUND, 'Workshop not found.');
    }

    const workshop = wsResult.rows[0];

    // ── STEP 3: Expire user's own stale holds ────────────────────────────────
    const stale = await reservationRepo.expireStaleHolds(client, userId, workshopId);
    for (const s of stale) {
      await eventRepo.insertEvent(client, {
        reservationId: s.id, userId, workshopId,
        eventType: 'HOLD_EXPIRED', prevStatus: 'HELD', newStatus: 'EXPIRED',
        reason: 'Expired during new hold creation.',
      });
    }

    // ── STEP 4: Prevent duplicate active holds/reservations ───────────────────
    const existingRes = await client.query(`
      SELECT id, status FROM reservations
      WHERE user_id = $1 AND workshop_id = $2 AND status IN ('HELD', 'CONFIRMED')
    `, [userId, workshopId]);

    if (existingRes.rows.length > 0) {
      const s = existingRes.rows[0].status;
      await client.query('ROLLBACK');
      throw AppError.conflict(
        ErrorCode.ALREADY_HAS_RESERVATION,
        s === 'HELD'
          ? 'You already have an active hold. Confirm or cancel it first.'
          : 'You already have a confirmed reservation for this workshop.',
      );
    }

    // ── STEP 5: Count active seats (logical expiry inline) ────────────────────
    const countResult = await client.query(`
      SELECT COUNT(*)::INT AS active_count
      FROM   reservations
      WHERE  workshop_id = $1
        AND  status IN ('HELD', 'CONFIRMED')
        AND  (status = 'CONFIRMED' OR expires_at > NOW())
    `, [workshopId]);

    if (countResult.rows[0].active_count >= workshop.capacity) {
      await client.query('ROLLBACK');
      throw AppError.conflict(
        ErrorCode.NO_SEATS_AVAILABLE,
        'No seats available for this workshop.',
      );
    }

    // ── STEP 6: Insert the reservation and audit event ───────────────────────
    const holdSecs = HOLD_DURATION_SECONDS();
    const expiresAt = new Date(Date.now() + holdSecs * 1000);

    const reservationResult = await client.query(`
      INSERT INTO reservations (user_id, workshop_id, status, expires_at)
      VALUES ($1, $2, 'HELD', $3)
      RETURNING *
    `, [userId, workshopId, expiresAt]);

    const reservation = reservationResult.rows[0];

    await eventRepo.insertEvent(client, {
      reservationId: reservation.id, userId, workshopId,
      eventType: 'HOLD_CREATED', prevStatus: null, newStatus: 'HELD',
      reason: `Hold created. Expires in ${holdSecs} seconds.`,
      metadata: { expiresAt, holdDurationSeconds: holdSecs },
    });

    // ── STEP 7: Save response in idempotency key in the SAME transaction ─────
    const formatted = formatReservation(reservation);
    const responseBody = {
      message: `Hold created. You have ${holdSecs} seconds to confirm.`,
      reservation: formatted,
    };

    if (idempotencyKey) {
      await client.query(`
        UPDATE idempotency_keys
        SET    response_status = 201, response_body = $1
        WHERE  key = $2 AND user_id = $3
      `, [JSON.stringify(responseBody), idempotencyKey, userId]);
    }

    // ── STEP 8: Commit transaction ───────────────────────────────────────────
    await client.query('COMMIT');
    logger.info('Hold created', { reservationId: reservation.id, userId, workshopId });

    // ── STEP 9: Broadcast seat count update (post-commit, fire-and-forget) ───
    broadcastWorkshopUpdate(workshopId).catch(err =>
      logger.warn('SSE broadcast failed after createHold', { workshopId, err: err?.message }),
    );

    return responseBody;

  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    if (err.code === '23505' && err.constraint === 'idx_one_active_reservation_per_user') {
      throw AppError.conflict(ErrorCode.ALREADY_HAS_RESERVATION, 'You already have an active reservation.');
    }
    throw err;
  } finally {
    client.release();
  }
}

export async function confirmHold({ reservationId, userId }) {
  const result = await query(`
    UPDATE reservations
    SET    status = 'CONFIRMED', expires_at = NULL, updated_at = NOW()
    WHERE  id = $1
      AND  user_id = $2
      AND  status = 'HELD'
      AND  expires_at > NOW()
    RETURNING *
  `, [reservationId, userId]);

  if (!result.rows[0]) {
    const check = await query(
      'SELECT status, expires_at, user_id FROM reservations WHERE id = $1',
      [reservationId],
    );
    if (!check.rows[0]) throw AppError.notFound(ErrorCode.RESERVATION_NOT_FOUND, 'Reservation not found.');
    if (check.rows[0].user_id !== userId) throw AppError.forbidden('You do not own this reservation.');
    if (check.rows[0].status === 'CONFIRMED') throw AppError.conflict(ErrorCode.ALREADY_CONFIRMED, 'Already confirmed.');
    if (check.rows[0].status === 'CANCELLED') throw AppError.conflict(ErrorCode.ALREADY_CANCELLED, 'Already cancelled.');
    throw AppError.conflict(ErrorCode.HOLD_EXPIRED, 'The hold has expired. Please create a new hold.');
  }

  const reservation = result.rows[0];

  await query(`
    INSERT INTO reservation_events
      (reservation_id, user_id, workshop_id, event_type, prev_status, new_status, reason)
    VALUES ($1, $2, $3, 'HOLD_CONFIRMED', 'HELD', 'CONFIRMED', 'User confirmed the hold.')
  `, [reservation.id, userId, reservation.workshop_id]);

  logger.info('Hold confirmed', { reservationId: reservation.id, userId });
  return {
    message: 'Reservation confirmed.',
    reservation: formatReservation(reservation),
  };
}

export async function cancelReservation({ reservationId, userId }) {
  const { promoteNext } = await import('./waitlistService.js');

  const result = await query(`
    UPDATE reservations
    SET    status = 'CANCELLED', updated_at = NOW()
    WHERE  id = $1
      AND  user_id = $2
      AND  status IN ('HELD', 'CONFIRMED')
    RETURNING *
  `, [reservationId, userId]);

  if (!result.rows[0]) {
    const check = await query(
      'SELECT status, user_id FROM reservations WHERE id = $1',
      [reservationId],
    );
    if (!check.rows[0]) throw AppError.notFound(ErrorCode.RESERVATION_NOT_FOUND, 'Reservation not found.');
    if (check.rows[0].user_id !== userId) throw AppError.forbidden('You do not own this reservation.');
    if (check.rows[0].status === 'CANCELLED') throw AppError.conflict(ErrorCode.ALREADY_CANCELLED, 'Reservation is already cancelled.');
    if (check.rows[0].status === 'EXPIRED') throw AppError.conflict(ErrorCode.INVALID_STATUS_TRANSITION, 'An expired hold cannot be cancelled.');
    throw AppError.conflict(ErrorCode.ALREADY_CANCELLED, 'Reservation is already cancelled.');
  }

  const reservation = result.rows[0];
  const workshopId = reservation.workshop_id;

  await query(`
    INSERT INTO reservation_events
      (reservation_id, user_id, workshop_id, event_type, prev_status, new_status, reason)
    VALUES ($1, $2, $3, 'RESERVATION_CANCELLED', $4, 'CANCELLED', 'User cancelled.')
  `, [reservation.id, userId, workshopId, reservation.status]);

  await promoteNext(workshopId).catch(err =>
    logger.warn('promoteNext failed after cancel', { workshopId, err: err?.message }),
  );

  broadcastWorkshopUpdate(workshopId).catch(err =>
    logger.warn('SSE broadcast failed after cancel', { workshopId, err: err?.message }),
  );

  logger.info('Reservation cancelled', { reservationId, userId, workshopId });
  return {
    message: 'Reservation cancelled.',
    reservation: formatReservation(reservation),
  };
}

export async function getReservation({ reservationId, userId }) {
  const reservation = await reservationRepo.findById(reservationId);
  if (!reservation) {
    throw AppError.notFound(ErrorCode.RESERVATION_NOT_FOUND, 'Reservation not found.');
  }
  if (reservation.user_id !== userId) {
    throw AppError.forbidden('You do not own this reservation.');
  }
  return formatReservation(reservation);
}

export async function getUserReservation({ userId, workshopId }) {
  const reservation = await reservationRepo.findActiveByUserAndWorkshop(userId, workshopId);
  return reservation ? formatReservation(reservation) : null;
}

export function formatReservation(r) {
  const now = Date.now();
  const expiresAt = r.expires_at ? new Date(r.expires_at) : null;
  const isLogicallyExpired = r.status === 'HELD' && expiresAt && expiresAt <= now;

  return {
    id: r.id,
    userId: r.user_id,
    workshopId: r.workshop_id,
    status: isLogicallyExpired ? 'EXPIRED' : r.status,
    expiresAt: r.expires_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    isExpired: isLogicallyExpired,
    secondsUntilExpiry: r.status === 'HELD' && expiresAt
      ? Math.max(0, Math.floor((expiresAt - now) / 1000))
      : null,
  };
}
