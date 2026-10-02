/**
 * Core reservation business logic.
 *
 * THE CONCURRENCY MECHANISM — SELECT FOR UPDATE:
 * ─────────────────────────────────────────────
 * Problem: Two users simultaneously request a hold on the last seat.
 * Naive code: both read activeCount=19 < 20, both insert → 21 active rows. OVERBOOKED.
 *
 * Solution: SELECT ... FROM workshops WHERE id = $1 FOR UPDATE
 *
 * PostgreSQL places an exclusive row-level lock on the workshop row.
 * - Transaction A acquires the lock → proceeds.
 * - Transaction B tries to acquire the same lock → BLOCKS (waits for A).
 * - When A commits (or rolls back), B unblocks and proceeds with the fresh count.
 * - Now B sees activeCount=20 (A succeeded) and correctly returns NO_SEATS_AVAILABLE.
 *
 * Result: Exactly as many holds as seats. Zero overbooking. Guaranteed.
 *
 * WHY Read Committed isolation level?
 * PostgreSQL's default. Works correctly with FOR UPDATE because the lock ensures
 * we see the committed state of OTHER transactions before we do our count.
 * If we used Serializable without FOR UPDATE, we'd need retry logic on SSI conflicts.
 * FOR UPDATE at Read Committed is simpler and sufficient for our use case.
 *
 * IDEMPOTENCY DESIGN:
 * ─────────────────────────────────────────────
 * The idempotency key is stored IN THE SAME TRANSACTION as the reservation insert.
 * If the transaction rolls back (no seats, duplicate), the key is not stored.
 * On retry, the business logic runs again (correct: maybe a seat opened up).
 * If the transaction commits, the key is stored. On retry, the cached response is
 * returned without running any business logic.
 */
import { createHash } from 'crypto';
import { getClient } from '../config/db.js';
import * as workshopRepo    from '../repositories/workshopRepository.js';
import * as reservationRepo from '../repositories/reservationRepository.js';
import * as idempotencyRepo from '../repositories/idempotencyRepository.js';
import * as eventRepo       from '../repositories/eventRepository.js';
import { AppError, ErrorCode } from '../utils/errors.js';
import { logger } from '../utils/logger.js';

const HOLD_DURATION_SECONDS = () =>
  parseInt(process.env.HOLD_DURATION_SECONDS || '300', 10);

// ── CREATE HOLD ──────────────────────────────────────────────────────────────

export async function createHold({ userId, workshopId, idempotencyKey, requestPath, requestBody }) {
  // ── Step 1: Check idempotency key BEFORE opening a transaction ──────────
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
      // Return the stored response — business logic does NOT run
      logger.debug('Idempotency cache hit', { key: idempotencyKey, userId });
      return { cached: true, ...cached.response_body };
    }
  }

  // ── Step 2: Open transaction ──────────────────────────────────────────────
  const client = await getClient();
  try {
    await client.query('BEGIN');

    // ── Step 3: Lock the workshop row (SERIALIZATION POINT) ────────────────
    // All concurrent hold requests for this workshop queue here.
    // Only ONE transaction proceeds at a time past this line.
    const workshop = await workshopRepo.lockForUpdate(client, workshopId);
    if (!workshop) {
      throw AppError.notFound(ErrorCode.WORKSHOP_NOT_FOUND, 'Workshop not found.');
    }

    // ── Step 4: Clean up user's own logically-expired holds ────────────────
    // If the user had a HELD reservation that expired without confirmation,
    // expire it now so the partial unique index does not block a re-hold.
    const stale = await reservationRepo.expireStaleHolds(client, userId, workshopId);
    if (stale.length > 0) {
      for (const s of stale) {
        await eventRepo.insertEvent(client, {
          reservationId: s.id,
          userId,
          workshopId,
          eventType:  'HOLD_EXPIRED',
          prevStatus: 'HELD',
          newStatus:  'EXPIRED',
          reason:     'Expired during new hold creation.',
        });
      }
    }

    // ── Step 5: Count truly active reservations ─────────────────────────────
    // Does NOT count logically-expired HELD rows (expires_at <= NOW()).
    const activeCount = await workshopRepo.countActive(client, workshopId);
    if (activeCount >= workshop.capacity) {
      throw AppError.conflict(
        ErrorCode.NO_SEATS_AVAILABLE,
        'No seats available for this workshop. Consider joining the waitlist.'
      );
    }

    // ── Step 6: Check if user already has an active reservation ────────────
    // Also enforced by the partial unique index, but we check here
    // to return a precise error message rather than a raw DB error.
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

    // ── Step 7: Insert the hold ──────────────────────────────────────────────
    const reservation = await reservationRepo.createHold(client, {
      userId,
      workshopId,
      holdDurationSeconds: HOLD_DURATION_SECONDS(),
    });

    // ── Step 8: Log the event (same transaction = atomic with the insert) ───
    await eventRepo.insertEvent(client, {
      reservationId: reservation.id,
      userId,
      workshopId,
      eventType:  'HOLD_CREATED',
      prevStatus: null,
      newStatus:  'HELD',
      reason:     `Hold created. Expires in ${HOLD_DURATION_SECONDS()} seconds.`,
      metadata:   { expiresAt: reservation.expires_at },
    });

    // ── Step 9: Store idempotency key (same transaction) ────────────────────
    const responseBody = { reservation: formatReservation(reservation) };
    if (idempotencyKey) {
      await idempotencyRepo.saveKey(client, {
        key:            idempotencyKey,
        userId,
        requestPath,
        requestHash:    hashBody(requestBody),
        responseStatus: 201,
        responseBody,
      });
    }

    // ── Step 10: Commit ──────────────────────────────────────────────────────
    await client.query('COMMIT');
    logger.info('Hold created', { reservationId: reservation.id, userId, workshopId });
    return { cached: false, ...responseBody };

  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) {}

    // Convert PostgreSQL unique violation to a readable AppError.
    // This fires if our Step 6 check somehow missed a concurrent insert
    // (extremely rare — the partial unique index is the last line of defence).
    if (err.code === '23505' && err.constraint === 'idx_one_active_reservation_per_user') {
      throw AppError.conflict(
        ErrorCode.ALREADY_HAS_RESERVATION,
        'You already have an active reservation for this workshop.'
      );
    }
    throw err;
  } finally {
    client.release();
  }
}

// ── CONFIRM HOLD ─────────────────────────────────────────────────────────────

export async function confirmHold({ reservationId, userId }) {
  const client = await getClient();
  try {
    await client.query('BEGIN');

    // Atomically attempt confirmation.
    // The WHERE clause guards ALL of: existence, ownership, status, expiry.
    // If any condition fails → 0 rows updated → null returned.
    const confirmed = await reservationRepo.confirmHold(client, { reservationId, userId });

    if (!confirmed) {
      // Diagnose the exact failure for a precise error message
      const check = await client.query(
        `SELECT id, user_id, status, expires_at FROM reservations WHERE id = $1`,
        [reservationId]
      );

      // Diagnose AFTER the failed update, BEFORE rollback
      let appErr;
      if (check.rows.length === 0) {
        appErr = AppError.notFound(ErrorCode.RESERVATION_NOT_FOUND, 'Reservation not found.');
      } else {
        const r = check.rows[0];
        if (r.user_id !== userId) {
          appErr = AppError.forbidden('You do not own this reservation.');
        } else if (r.status === 'CONFIRMED') {
          appErr = AppError.conflict(ErrorCode.ALREADY_CONFIRMED, 'This reservation is already confirmed.');
        } else if (r.status === 'CANCELLED') {
          appErr = AppError.conflict(ErrorCode.ALREADY_CANCELLED, 'This reservation has been cancelled.');
        } else if (r.status === 'EXPIRED') {
          appErr = AppError.conflict(ErrorCode.HOLD_EXPIRED, 'This hold has expired.');
        } else {
          // status='HELD' but expires_at <= NOW() (logically expired, sweep not run yet)
          appErr = AppError.conflict(ErrorCode.HOLD_EXPIRED, 'The hold has expired. Please create a new hold.');
        }
      }

      await client.query('ROLLBACK');
      throw appErr;
    }

    await eventRepo.insertEvent(client, {
      reservationId: confirmed.id,
      userId,
      workshopId:    confirmed.workshop_id,
      eventType:     'HOLD_CONFIRMED',
      prevStatus:    'HELD',
      newStatus:     'CONFIRMED',
      reason:        'User confirmed the hold.',
    });

    await client.query('COMMIT');
    logger.info('Hold confirmed', { reservationId: confirmed.id, userId });
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
  try {
    await client.query('BEGIN');

    // Lock the reservation row to get its current state and prevent concurrent changes
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
      throw AppError.conflict(ErrorCode.ALREADY_CANCELLED, 'This reservation is already cancelled.');
    }
    if (current.status === 'EXPIRED') {
      await client.query('ROLLBACK');
      throw AppError.conflict(
        ErrorCode.INVALID_STATUS_TRANSITION,
        'An expired hold cannot be cancelled.'
      );
    }

    const prevStatus = current.status; // 'HELD' or 'CONFIRMED'

    // Update to CANCELLED
    const result = await client.query(`
      UPDATE reservations
      SET    status = 'CANCELLED', updated_at = NOW()
      WHERE  id = $1
      RETURNING *
    `, [reservationId]);
    const cancelled = result.rows[0];

    const eventType = prevStatus === 'CONFIRMED' ? 'RESERVATION_CANCELLED' : 'HOLD_CANCELLED';
    await eventRepo.insertEvent(client, {
      reservationId: cancelled.id,
      userId,
      workshopId:    cancelled.workshop_id,
      eventType,
      prevStatus,
      newStatus:     'CANCELLED',
      reason:        'User cancelled.',
    });

    await client.query('COMMIT');
    logger.info('Reservation cancelled', { reservationId: cancelled.id, userId, prevStatus });
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

// ── GET USER'S ACTIVE RESERVATION FOR A WORKSHOP ─────────────────────────────

export async function getUserReservation({ userId, workshopId }) {
  const reservation = await reservationRepo.findActiveByUserAndWorkshop(userId, workshopId);
  return reservation ? formatReservation(reservation) : null;
}

// ── HELPERS ───────────────────────────────────────────────────────────────────

/**
 * Format a reservation row for API responses.
 * Computes logical expiry state and remaining time for the frontend timer.
 */
export function formatReservation(r) {
  const now = Date.now();
  const expiresAt = r.expires_at ? new Date(r.expires_at) : null;
  const isLogicallyExpired = r.status === 'HELD' && expiresAt && expiresAt <= now;

  return {
    id:          r.id,
    userId:      r.user_id,
    workshopId:  r.workshop_id,
    // Return logical state: a HELD row past expires_at is shown as EXPIRED
    status:      isLogicallyExpired ? 'EXPIRED' : r.status,
    expiresAt:   r.expires_at,
    createdAt:   r.created_at,
    updatedAt:   r.updated_at,
    // Helpful computed fields for the frontend countdown timer
    isExpired:          isLogicallyExpired,
    secondsUntilExpiry: r.status === 'HELD' && expiresAt
      ? Math.max(0, Math.floor((expiresAt - now) / 1000))
      : null,
  };
}

/**
 * SHA-256 hash of the request body for idempotency conflict detection.
 * If the same key is used with a different body, hashes will differ → 409.
 */
function hashBody(body) {
  return createHash('sha256').update(JSON.stringify(body ?? {})).digest('hex');
}
