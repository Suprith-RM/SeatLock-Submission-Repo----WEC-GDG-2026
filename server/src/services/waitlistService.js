/**
 * Waitlist service managing queue join/leave operations and automatic promotion.
 */
import { getClient }         from '../config/db.js';
import * as workshopRepo      from '../repositories/workshopRepository.js';
import * as waitlistRepo      from '../repositories/waitlistRepository.js';
import * as eventRepo         from '../repositories/eventRepository.js';
import { AppError, ErrorCode } from '../utils/errors.js';
import { logger }             from '../utils/logger.js';

const HOLD_DURATION_SECONDS = () =>
  parseInt(process.env.HOLD_DURATION_SECONDS || '300', 10);

// ── JOIN ─────────────────────────────────────────────────────────────────────

export async function joinWaitlist({ userId, workshopId }) {
  const client = await getClient();
  try {
    await client.query('BEGIN');

    // Lock workshop row — serializes all concurrent join attempts
    const workshop = await workshopRepo.lockForUpdate(client, workshopId);
    if (!workshop) {
      throw AppError.notFound(ErrorCode.WORKSHOP_NOT_FOUND, 'Workshop not found.');
    }

    // ── Guard 1: Seats must be full ──────────────────────────────────────────
    const activeCount = await workshopRepo.countActive(client, workshopId);
    if (activeCount < workshop.capacity) {
      throw AppError.conflict(
        ErrorCode.SEATS_AVAILABLE_USE_HOLD,
        `${workshop.capacity - activeCount} seat(s) are still available. Create a hold instead of joining the waitlist.`
      );
    }

    // ── Guard 2: User must not have an active reservation ────────────────────
    const activeRes = await client.query(`
      SELECT id FROM reservations
      WHERE user_id = $1 AND workshop_id = $2 AND status IN ('HELD', 'CONFIRMED')
    `, [userId, workshopId]);
    if (activeRes.rows.length > 0) {
      throw AppError.conflict(
        ErrorCode.ALREADY_HAS_RESERVATION,
        'You already have an active reservation. Cancel it first if you want to join the waitlist.'
      );
    }

    // ── Guard 3: User must not already be WAITING ───────────────────────────
    const existing = await client.query(`
      SELECT id FROM waitlist_entries
      WHERE user_id = $1 AND workshop_id = $2 AND status = 'WAITING'
    `, [userId, workshopId]);
    if (existing.rows.length > 0) {
      throw AppError.conflict(
        ErrorCode.ALREADY_ON_WAITLIST,
        'You are already on the waitlist for this workshop.'
      );
    }

    // ── Insert ───────────────────────────────────────────────────────────────
    const entry = await waitlistRepo.join(client, userId, workshopId);

    await eventRepo.insertEvent(client, {
      userId,
      workshopId,
      eventType:  'WAITLIST_JOINED',
      prevStatus: null,
      newStatus:  'WAITING',
      reason:     'User joined waitlist.',
      metadata:   { position: entry.position },
    });

    await client.query('COMMIT');
    logger.info('Waitlist joined', { userId, workshopId, position: entry.position });
    return formatEntry(entry);

  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    // DB-level unique index guard (idx_one_active_waitlist_per_user)
    if (err.code === '23505') {
      throw AppError.conflict(ErrorCode.ALREADY_ON_WAITLIST, 'You are already on the waitlist.');
    }
    throw err;
  } finally {
    client.release();
  }
}

// ── LEAVE ────────────────────────────────────────────────────────────────────

export async function leaveWaitlist({ userId, workshopId }) {
  const client = await getClient();
  try {
    await client.query('BEGIN');

    // Lock the entry to prevent concurrent removal
    const entry = await client.query(`
      SELECT id FROM waitlist_entries
      WHERE  user_id = $1 AND workshop_id = $2 AND status = 'WAITING'
      FOR UPDATE
    `, [userId, workshopId]);

    if (entry.rows.length === 0) {
      await client.query('ROLLBACK');
      throw AppError.notFound(
        ErrorCode.NOT_ON_WAITLIST,
        'You are not on the waitlist for this workshop.'
      );
    }

    const removed = await waitlistRepo.remove(client, entry.rows[0].id);

    await eventRepo.insertEvent(client, {
      userId,
      workshopId,
      eventType:  'WAITLIST_LEFT',
      prevStatus: 'WAITING',
      newStatus:  'REMOVED',
      reason:     'User voluntarily left waitlist.',
    });

    await client.query('COMMIT');
    logger.info('Waitlist left', { userId, workshopId });
    return formatEntry(removed);

  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw err;
  } finally {
    client.release();
  }
}

// ── GET POSITION ─────────────────────────────────────────────────────────────

export async function getWaitlistPosition({ userId, workshopId }) {
  const workshop = await workshopRepo.findById(workshopId);
  if (!workshop) {
    throw AppError.notFound(ErrorCode.WORKSHOP_NOT_FOUND, 'Workshop not found.');
  }

  const rank  = await waitlistRepo.getEffectiveRank(userId, workshopId);
  const total = await waitlistRepo.countWaiting(workshopId);

  if (rank === null) {
    throw AppError.notFound(
      ErrorCode.NOT_ON_WAITLIST,
      'You are not on the waitlist for this workshop.'
    );
  }

  return { position: rank, totalWaiting: total, workshopId };
}

/**
 * Promote the next WAITING user into a HELD reservation if capacity allows.
 *
 * @param {string} workshopId
 * @returns {Promise<boolean>} True if user was promoted, false otherwise.
 */
export async function promoteNext(workshopId) {
  const client = await getClient();
  try {
    await client.query('BEGIN');

    // Lock workshop to serialize against concurrent holds and other promotions
    const workshop = await client.query(
      `SELECT id, capacity FROM workshops WHERE id = $1 FOR UPDATE`,
      [workshopId]
    );
    if (!workshop.rows[0]) {
      await client.query('ROLLBACK');
      return false;
    }

    // Verify a seat is actually available (another direct hold may have taken it)
    const countRes = await client.query(`
      SELECT COUNT(*)::INT AS count FROM reservations
      WHERE workshop_id = $1
        AND (status = 'CONFIRMED' OR (status = 'HELD' AND expires_at > NOW()))
    `, [workshopId]);

    if (countRes.rows[0].count >= workshop.rows[0].capacity) {
      await client.query('ROLLBACK');
      return false;
    }

    // Lock next WAITING entry — SKIP LOCKED handles concurrent promoters
    const next = await waitlistRepo.lockNextWaiter(client, workshopId);
    if (!next) {
      await client.query('ROLLBACK');
      return false;
    }

    await waitlistRepo.markPromoted(client, next.id);

    // Create a HELD reservation for the promoted user
    const holdSecs = HOLD_DURATION_SECONDS();
    const newRes = await client.query(`
      INSERT INTO reservations (user_id, workshop_id, status, expires_at)
      VALUES ($1, $2, 'HELD', NOW() + ($3 || ' seconds')::INTERVAL)
      RETURNING *
    `, [next.user_id, workshopId, holdSecs]);

    await eventRepo.insertEvent(client, {
      reservationId: newRes.rows[0].id,
      userId:        next.user_id,
      workshopId,
      eventType:     'WAITLIST_PROMOTED',
      prevStatus:    'WAITING',
      newStatus:     'HELD',
      reason:        'Promoted from waitlist after a seat was freed.',
      metadata:      { waitlistEntryId: next.id },
    });

    await client.query('COMMIT');
    logger.info('Waitlist promotion successful', {
      userId: next.user_id, workshopId, reservationId: newRes.rows[0].id,
    });
    return true;

  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    if (err.code === '23505') {
      // Promoted user already has an active reservation — skip them gracefully
      logger.warn('Promotion skipped: user already has active reservation', { workshopId });
      return false;
    }
    logger.error('promoteNext failed', { workshopId, message: err.message });
    return false;
  } finally {
    client.release();
  }
}

// ── Helper ────────────────────────────────────────────────────────────────────

function formatEntry(e) {
  return {
    id:         e.id,
    userId:     e.user_id,
    workshopId: e.workshop_id,
    status:     e.status,
    position:   e.position,
    createdAt:  e.created_at,
    updatedAt:  e.updated_at,
  };
}
