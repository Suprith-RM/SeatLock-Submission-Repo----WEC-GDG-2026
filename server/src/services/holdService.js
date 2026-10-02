/**
 * Reservation service handling hold creation, confirmation, and cancellation.
 */
import { createHash } from 'crypto';
import { getClient }          from '../config/db.js';
import * as workshopRepo      from '../repositories/workshopRepository.js';
import * as reservationRepo   from '../repositories/reservationRepository.js';
import * as idempotencyRepo   from '../repositories/idempotencyRepository.js';
import * as eventRepo         from '../repositories/eventRepository.js';
import * as workshopService   from './workshopService.js';
import * as sseManager        from '../realtime/sseManager.js';
import { promoteNext }        from './waitlistService.js';
import { AppError, ErrorCode } from '../utils/errors.js';
import { logger }             from '../utils/logger.js';

const HOLD_DURATION_SECONDS = () =>
  parseInt(process.env.HOLD_DURATION_SECONDS || '300', 10);

// ── BROADCAST HELPER ──────────────────────────────────────────────────────────

async function broadcastWorkshopUpdate(workshopId) {
  if (sseManager.getSubscriberCount(workshopId) === 0) return;
  try {
    const workshop = await workshopService.getWorkshop(workshopId);
    sseManager.broadcast(workshopId, { type: 'workshop_update', workshop });
  } catch (_) {
    // Non-fatal — broadcast failure must never crash the request
  }
}

// ── CREATE HOLD ───────────────────────────────────────────────────────────────

export async function createHold({ userId, workshopId, idempotencyKey, requestPath, requestBody }) {
  // Check idempotency key BEFORE opening a transaction
  if (idempotencyKey) {
    const requestHash = hashBody(requestBody);
    const cached = await idempotencyRepo.findKey(idempotencyKey, userId);
    if (cached) {
      if (cached.request_hash !== requestHash) {
        throw AppError.conflict(
          ErrorCode.IDEMPOTENCY_KEY_CONFLICT,
          'Idempotency-Key was previously used with a different request body.'
        );
      }
      return { cached: true, ...cached.response_body };
    }
  }

  const client = await getClient();
  try {
    await client.query('BEGIN');

    // Lock workshop row — serialization point
    const workshop = await workshopRepo.lockForUpdate(client, workshopId);
    if (!workshop) {
      throw AppError.notFound(ErrorCode.WORKSHOP_NOT_FOUND, 'Workshop not found.');
    }

    // Expire the user's own stale holds so the unique index doesn't block re-hold
    const stale = await reservationRepo.expireStaleHolds(client, userId, workshopId);
    for (const s of stale) {
      await eventRepo.insertEvent(client, {
        reservationId: s.id, userId, workshopId,
        eventType: 'HOLD_EXPIRED', prevStatus: 'HELD', newStatus: 'EXPIRED',
        reason: 'Expired during new hold creation.',
      });
    }

    // Count truly active seats (excluding logically expired holds)
    const activeCount = await workshopRepo.countActive(client, workshopId);
    if (activeCount >= workshop.capacity) {
      throw AppError.conflict(
        ErrorCode.NO_SEATS_AVAILABLE,
        'No seats available. Consider joining the waitlist.'
      );
    }

    // Application-level duplicate check (DB unique index is the final guard)
    const existing = await client.query(`
      SELECT id, status FROM reservations
      WHERE user_id = $1 AND workshop_id = $2 AND status IN ('HELD', 'CONFIRMED')
    `, [userId, workshopId]);
    if (existing.rows.length > 0) {
      const s = existing.rows[0].status;
      throw AppError.conflict(
        ErrorCode.ALREADY_HAS_RESERVATION,
        s === 'HELD'
          ? 'You already have an active hold. Confirm or cancel it first.'
          : 'You already have a confirmed reservation for this workshop.'
      );
    }

    const reservation = await reservationRepo.createHold(client, {
      userId, workshopId, holdDurationSeconds: HOLD_DURATION_SECONDS(),
    });

    await eventRepo.insertEvent(client, {
      reservationId: reservation.id, userId, workshopId,
      eventType: 'HOLD_CREATED', prevStatus: null, newStatus: 'HELD',
      reason: `Hold created. Expires in ${HOLD_DURATION_SECONDS()} seconds.`,
      metadata: { expiresAt: reservation.expires_at },
    });

    const responseBody = { reservation: formatReservation(reservation) };
    if (idempotencyKey) {
      await idempotencyRepo.saveKey(client, {
        key: idempotencyKey, userId, requestPath,
        requestHash: hashBody(requestBody), responseStatus: 201, responseBody,
      });
    }

    await client.query('COMMIT');
    logger.info('Hold created', { reservationId: reservation.id, userId, workshopId });

    // Broadcast after commit — fire and forget
    broadcastWorkshopUpdate(workshopId).catch(() => {});

    return { cached: false, ...responseBody };

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

// ── CONFIRM HOLD ──────────────────────────────────────────────────────────────

export async function confirmHold({ reservationId, userId }) {
  const client = await getClient();
  try {
    await client.query('BEGIN');

    const confirmed = await reservationRepo.confirmHold(client, { reservationId, userId });

    if (!confirmed) {
      const check = await client.query(
        `SELECT id, user_id, status, expires_at FROM reservations WHERE id = $1`,
        [reservationId]
      );
      let appErr;
      if (check.rows.length === 0) {
        appErr = AppError.notFound(ErrorCode.RESERVATION_NOT_FOUND, 'Reservation not found.');
      } else {
        const r = check.rows[0];
        if (r.user_id !== userId)       appErr = AppError.forbidden('You do not own this reservation.');
        else if (r.status === 'CONFIRMED') appErr = AppError.conflict(ErrorCode.ALREADY_CONFIRMED, 'Already confirmed.');
        else if (r.status === 'CANCELLED') appErr = AppError.conflict(ErrorCode.ALREADY_CANCELLED, 'Already cancelled.');
        else if (r.status === 'EXPIRED')   appErr = AppError.conflict(ErrorCode.HOLD_EXPIRED, 'Hold has expired.');
        else appErr = AppError.conflict(ErrorCode.HOLD_EXPIRED, 'The hold has expired. Please create a new hold.');
      }
      await client.query('ROLLBACK');
      throw appErr;
    }

    await eventRepo.insertEvent(client, {
      reservationId: confirmed.id, userId, workshopId: confirmed.workshop_id,
      eventType: 'HOLD_CONFIRMED', prevStatus: 'HELD', newStatus: 'CONFIRMED',
      reason: 'User confirmed the hold.',
    });

    await client.query('COMMIT');
    logger.info('Hold confirmed', { reservationId: confirmed.id, userId });
    // Confirming does NOT change seat count — no broadcast needed
    return { reservation: formatReservation(confirmed) };

  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw err;
  } finally {
    client.release();
  }
}

// ── CANCEL RESERVATION ────────────────────────────────────────────────────────

export async function cancelReservation({ reservationId, userId }) {
  const client = await getClient();
  let workshopId;

  try {
    await client.query('BEGIN');

    const current = await reservationRepo.lockById(client, reservationId);
    if (!current) {
      await client.query('ROLLBACK');
      throw AppError.notFound(ErrorCode.RESERVATION_NOT_FOUND, 'Reservation not found.');
    }
    if (current.user_id !== userId) {
      await client.query('ROLLBACK');
      throw AppError.forbidden('You do not own this reservation.');
    }
    if (current.status === 'CANCELLED') {
      await client.query('ROLLBACK');
      throw AppError.conflict(ErrorCode.ALREADY_CANCELLED, 'Already cancelled.');
    }
    if (current.status === 'EXPIRED') {
      await client.query('ROLLBACK');
      throw AppError.conflict(ErrorCode.INVALID_STATUS_TRANSITION, 'An expired hold cannot be cancelled.');
    }

    workshopId = current.workshop_id;
    const prevStatus = current.status;

    const result = await client.query(`
      UPDATE reservations SET status = 'CANCELLED', updated_at = NOW()
      WHERE id = $1 RETURNING *
    `, [reservationId]);
    const cancelled = result.rows[0];

    await eventRepo.insertEvent(client, {
      reservationId: cancelled.id, userId, workshopId,
      eventType:  prevStatus === 'CONFIRMED' ? 'RESERVATION_CANCELLED' : 'HOLD_CANCELLED',
      prevStatus,
      newStatus:  'CANCELLED',
      reason:     'User cancelled.',
    });

    await client.query('COMMIT');
    logger.info('Reservation cancelled', { reservationId: cancelled.id, userId, prevStatus });

    // After commit: offer the freed seat to the next person on the waitlist,
    // then broadcast the updated seat count to all live clients.
    if (workshopId) {
      promoteNext(workshopId)
        .then(() => broadcastWorkshopUpdate(workshopId))
        .catch(() => {});
    }

    return { reservation: formatReservation(cancelled) };

  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw err;
  } finally {
    client.release();
  }
}

// ── GET RESERVATION ───────────────────────────────────────────────────────────

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

// ── GET USER'S ACTIVE RESERVATION ────────────────────────────────────────────

export async function getUserReservation({ userId, workshopId }) {
  const reservation = await reservationRepo.findActiveByUserAndWorkshop(userId, workshopId);
  return reservation ? formatReservation(reservation) : null;
}

// ── HELPERS ───────────────────────────────────────────────────────────────────

export function formatReservation(r) {
  const now       = Date.now();
  const expiresAt = r.expires_at ? new Date(r.expires_at) : null;
  const isLogicallyExpired = r.status === 'HELD' && expiresAt && expiresAt <= now;

  return {
    id:          r.id,
    userId:      r.user_id,
    workshopId:  r.workshop_id,
    status:      isLogicallyExpired ? 'EXPIRED' : r.status,
    expiresAt:   r.expires_at,
    createdAt:   r.created_at,
    updatedAt:   r.updated_at,
    isExpired:   isLogicallyExpired,
    secondsUntilExpiry: r.status === 'HELD' && expiresAt
      ? Math.max(0, Math.floor((expiresAt - now) / 1000))
      : null,
  };
}

function hashBody(body) {
  return createHash('sha256').update(JSON.stringify(body ?? {})).digest('hex');
}
