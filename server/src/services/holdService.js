/**
 * Reservation service handling hold creation, confirmation, and cancellation.
 */
import { query, getClient }            from '../config/db.js';
import { executeWithIdempotency }      from './idempotencyService.js';
import { promoteEligibleWaiters }      from './waitlistService.js';
import { broadcastWorkshopUpdate }     from '../realtime/sseManager.js';
import { AppError, ErrorCode }         from '../utils/errors.js';
import { logger }                      from '../utils/logger.js';
import * as reservationRepo            from '../repositories/reservationRepository.js';

const HOLD_DURATION_SECONDS = parseInt(process.env.HOLD_DURATION_SECONDS || '300', 10);

export async function createHold({ userId, workshopId, idempotencyKey, requestBody }) {
  const result = await executeWithIdempotency({
    idempotencyKey,
    userId,
    requestPath:    `/workshops/${workshopId}/holds`,
    requestBody:    requestBody ?? {},
    responseStatus: 201,
    work: async (client) => {
      const ws = await client.query(
        'SELECT id, name, capacity FROM workshops WHERE id = $1 FOR UPDATE',
        [workshopId],
      );
      if (!ws.rows[0]) {
        throw AppError.notFound(ErrorCode.WORKSHOP_NOT_FOUND, 'Workshop not found.');
      }

      const waitlistCheck = await client.query(`
        SELECT 1 FROM waitlist_entries
        WHERE  workshop_id = $1 AND user_id = $2 AND status = 'WAITING'
      `, [workshopId, userId]);
      if (waitlistCheck.rows.length > 0) {
        throw AppError.conflict(
          ErrorCode.ON_WAITLIST_CANNOT_HOLD,
          'You are currently on the waitlist for this workshop. ' +
          'Leave the waitlist before creating a direct hold.',
        );
      }

      const counts = await client.query(`
        SELECT
          COUNT(*) FILTER (WHERE status = 'HELD' AND expires_at > NOW())::INT AS held,
          COUNT(*) FILTER (WHERE status = 'CONFIRMED')::INT AS confirmed
        FROM reservations WHERE workshop_id = $1
      `, [workshopId]);
      const { held, confirmed } = counts.rows[0];
      if (held + confirmed >= ws.rows[0].capacity) {
        throw AppError.conflict(
          ErrorCode.NO_SEATS_AVAILABLE,
          'No seats available for this workshop.',
        );
      }

      const expiresAt = new Date(Date.now() + HOLD_DURATION_SECONDS * 1000);
      const reservation = await client.query(`
        INSERT INTO reservations (user_id, workshop_id, status, expires_at)
        VALUES ($1, $2, 'HELD', $3)
        RETURNING *
      `, [userId, workshopId, expiresAt]).catch(err => {
        if (err.code === '23505') {
          throw AppError.conflict(
            ErrorCode.ALREADY_HAS_RESERVATION,
            'You already have an active reservation for this workshop.',
          );
        }
        throw err;
      });

      await client.query(`
        INSERT INTO reservation_events
          (reservation_id, user_id, workshop_id, event_type, new_status, metadata)
        VALUES ($1, $2, $3, 'HOLD_CREATED', 'HELD', $4)
      `, [reservation.rows[0].id, userId, workshopId,
          JSON.stringify({ expiresAt, holdDurationSeconds: HOLD_DURATION_SECONDS })]);

      const r = reservation.rows[0];
      return {
        reservation: {
          id:                  r.id,
          userId:              r.user_id,
          workshopId:          r.workshop_id,
          status:              r.status,
          expiresAt:           r.expires_at,
          secondsUntilExpiry:  HOLD_DURATION_SECONDS,
          isExpired:           false,
          createdAt:           r.created_at,
          updatedAt:           r.updated_at,
        },
      };
    },
  });

  if (!result.fromCache) {
    broadcastWorkshopUpdate(workshopId).catch(err =>
      logger.warn('SSE broadcast failed after createHold', { workshopId, err: err?.message }),
    );
  }

  return result;
}

export async function confirmHold({ reservationId, userId, idempotencyKey, requestBody }) {
  const result = await executeWithIdempotency({
    idempotencyKey,
    userId,
    requestPath:    `/reservations/${reservationId}/confirm`,
    requestBody:    requestBody ?? {},
    responseStatus: 200,
    work: async (client) => {
      const resResult = await client.query(`
        SELECT * FROM reservations WHERE id = $1 FOR UPDATE
      `, [reservationId]);

      if (!resResult.rows[0]) {
        throw AppError.notFound(ErrorCode.RESERVATION_NOT_FOUND, 'Reservation not found.');
      }
      const res = resResult.rows[0];
      if (res.user_id !== userId) throw AppError.forbidden();
      if (res.status === 'CONFIRMED')  throw AppError.conflict(ErrorCode.ALREADY_CONFIRMED,  'Reservation is already confirmed.');
      if (res.status === 'CANCELLED')  throw AppError.conflict(ErrorCode.ALREADY_CANCELLED,  'Reservation has been cancelled.');
      if (res.status === 'EXPIRED')    throw AppError.conflict(ErrorCode.HOLD_EXPIRED,        'Hold has expired.');
      if (new Date(res.expires_at) <= new Date()) {
        throw AppError.conflict(ErrorCode.HOLD_EXPIRED, 'Hold has expired. Please create a new hold.');
      }

      const updated = await client.query(`
        UPDATE reservations SET status = 'CONFIRMED', expires_at = NULL, updated_at = NOW()
        WHERE  id = $1 RETURNING *
      `, [reservationId]);

      await client.query(`
        INSERT INTO reservation_events
          (reservation_id, user_id, workshop_id, event_type, prev_status, new_status)
        VALUES ($1, $2, $3, 'HOLD_CONFIRMED', 'HELD', 'CONFIRMED')
      `, [reservationId, userId, res.workshop_id]);

      const r = updated.rows[0];
      return {
        reservation: {
          id:         r.id,
          userId:     r.user_id,
          workshopId: r.workshop_id,
          status:     r.status,
          expiresAt:  r.expires_at,
          createdAt:  r.created_at,
          updatedAt:  r.updated_at,
        },
      };
    },
  });

  return result;
}

export async function cancelReservation({ reservationId, userId, idempotencyKey, requestBody }) {
  let workshopIdForBroadcast = null;

  const result = await executeWithIdempotency({
    idempotencyKey,
    userId,
    requestPath:    `/reservations/${reservationId}/cancel`,
    requestBody:    requestBody ?? {},
    responseStatus: 200,
    work: async (client) => {
      const lookup = await client.query(
        'SELECT workshop_id, user_id, status FROM reservations WHERE id = $1',
        [reservationId],
      );
      if (!lookup.rows[0]) {
        throw AppError.notFound(ErrorCode.RESERVATION_NOT_FOUND, 'Reservation not found.');
      }
      if (lookup.rows[0].user_id !== userId) {
        throw AppError.forbidden('You do not own this reservation.');
      }

      const workshopId = lookup.rows[0].workshop_id;
      workshopIdForBroadcast = workshopId;

      await client.query('SELECT id FROM workshops WHERE id = $1 FOR UPDATE', [workshopId]);

      const resResult = await client.query(
        'SELECT * FROM reservations WHERE id = $1 FOR UPDATE',
        [reservationId],
      );
      const res = resResult.rows[0];
      if (res.status === 'CANCELLED') {
        throw AppError.conflict(
          ErrorCode.ALREADY_CANCELLED,
          'Reservation is already cancelled.',
        );
      }
      if (res.status === 'EXPIRED' || (res.status === 'HELD' && new Date(res.expires_at) <= new Date())) {
        throw AppError.conflict(
          ErrorCode.INVALID_STATUS_TRANSITION,
          'An expired hold cannot be cancelled.',
        );
      }
      if (!['HELD', 'CONFIRMED'].includes(res.status)) {
        throw AppError.conflict(
          ErrorCode.INVALID_STATUS_TRANSITION,
          'Reservation cannot be cancelled in its current state.',
        );
      }

      const updated = await client.query(`
        UPDATE reservations SET status = 'CANCELLED', updated_at = NOW()
        WHERE  id = $1 RETURNING *
      `, [reservationId]);

      await client.query(`
        INSERT INTO reservation_events
          (reservation_id, user_id, workshop_id, event_type, prev_status, new_status)
        VALUES ($1, $2, $3, 'RESERVATION_CANCELLED', $4, 'CANCELLED')
      `, [reservationId, userId, workshopId, res.status]);

      const promoted = await promoteEligibleWaiters(workshopId, client);
      logger.info('Cancel and promote complete', { reservationId, workshopId, promoted });

      const r = updated.rows[0];
      return {
        message: 'Reservation cancelled.',
        reservation: {
          id:         r.id,
          userId:     r.user_id,
          workshopId: r.workshop_id,
          status:     r.status,
          createdAt:  r.created_at,
          updatedAt:  r.updated_at,
        },
      };
    },
  });

  if (!result.fromCache && workshopIdForBroadcast) {
    broadcastWorkshopUpdate(workshopIdForBroadcast).catch(err =>
      logger.warn('SSE broadcast failed after cancelReservation', { err: err?.message }),
    );
  }

  return result;
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
    id:                 r.id,
    userId:             r.user_id,
    workshopId:         r.workshop_id,
    status:             isLogicallyExpired ? 'EXPIRED' : r.status,
    expiresAt:          r.expires_at,
    createdAt:          r.created_at,
    updatedAt:          r.updated_at,
    isExpired:          isLogicallyExpired,
    secondsUntilExpiry: r.status === 'HELD' && expiresAt
      ? Math.max(0, Math.floor((expiresAt.getTime() - now) / 1000))
      : null,
  };
}
