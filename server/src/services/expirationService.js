/**
 * Hold expiration service.
 *
 * TWO-TIER EXPIRY STRATEGY:
 * ─────────────────────────
 * TIER 1 — Logical (zero-latency):
 *   The CONFIRM endpoint checks expires_at > NOW() in the UPDATE WHERE clause.
 *   A hold cannot be confirmed the instant it expires, even before the sweep runs.
 *   The hold creation endpoint also expires stale holds before attempting a new insert.
 *
 * TIER 2 — Physical (sweep job):
 *   This service updates status='EXPIRED' for all overdue holds.
 *   The sweep removes them from the partial unique index, allowing re-holds.
 *   The sweep also promotes the next person on the waitlist for each freed seat.
 *
 * STARTUP RECOVERY:
 *   sweepExpiredHolds() is called at server startup BEFORE the HTTP server binds.
 *   This catches holds that expired while the server was offline (crash, deploy).
 *   No in-memory state is lost — the database is the only source of truth.
 *
 * PROMOTION ARCHITECTURE:
 *   Phase 1 (single transaction): Expire all overdue holds + log events.
 *   Phase 2 (per-seat transactions): Promote next waiter for each freed seat.
 *   Separation limits rollback scope: if Phase 2 fails for one workshop,
 *   Phase 1 (expiry) still committed successfully.
 */
import { getClient } from '../config/db.js';
import * as reservationRepo from '../repositories/reservationRepository.js';
import * as eventRepo       from '../repositories/eventRepository.js';
import { logger }           from '../utils/logger.js';

const HOLD_DURATION_SECONDS = () =>
  parseInt(process.env.HOLD_DURATION_SECONDS || '300', 10);

export async function sweepExpiredHolds() {
  const { expired, byWorkshop } = await phaseOneExpire();

  let promoted = 0;
  for (const [workshopId, freedCount] of Object.entries(byWorkshop)) {
    for (let i = 0; i < freedCount; i++) {
      const ok = await phaseTwoPromote(workshopId);
      if (!ok) break; // No more waiters for this workshop
      promoted++;
    }
  }

  return { expired, promoted };
}

// ── Phase 1: Expire overdue holds ──────────────────────────────────────────

async function phaseOneExpire() {
  const client = await getClient();
  try {
    await client.query('BEGIN');

    const expired = await reservationRepo.expireAllOverdueHolds(client);

    if (expired.length > 0) {
      for (const row of expired) {
        await eventRepo.insertEvent(client, {
          reservationId: row.id,
          userId:        row.user_id,
          workshopId:    row.workshop_id,
          eventType:     'HOLD_EXPIRED',
          prevStatus:    'HELD',
          newStatus:     'EXPIRED',
          reason:        `Hold expired after ${HOLD_DURATION_SECONDS()} seconds.`,
        });
      }
      logger.info('Holds expired by sweep', { count: expired.length });
    }

    await client.query('COMMIT');

    // Count freed seats per workshop for Phase 2
    const byWorkshop = {};
    for (const row of expired) {
      byWorkshop[row.workshop_id] = (byWorkshop[row.workshop_id] || 0) + 1;
    }

    return { expired: expired.length, byWorkshop };
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    logger.error('Phase 1 expiry failed', { message: err.message });
    throw err;
  } finally {
    client.release();
  }
}

// ── Phase 2: Promote next waitlister for a freed seat ───────────────────────
// Returns true if someone was promoted, false if waitlist is empty or seat refilled.

async function phaseTwoPromote(workshopId) {
  const client = await getClient();
  try {
    await client.query('BEGIN');

    // Lock the workshop row — ensures capacity check is accurate
    const workshop = await client.query(
      `SELECT id, capacity FROM workshops WHERE id = $1 FOR UPDATE`,
      [workshopId]
    );
    if (!workshop.rows[0]) {
      await client.query('ROLLBACK');
      return false;
    }

    // Re-verify there is actually a free seat (could have been taken by direct hold)
    const countRes = await client.query(`
      SELECT COUNT(*)::INT AS count FROM reservations
      WHERE workshop_id = $1
        AND (status = 'CONFIRMED' OR (status = 'HELD' AND expires_at > NOW()))
    `, [workshopId]);

    if (countRes.rows[0].count >= workshop.rows[0].capacity) {
      await client.query('ROLLBACK');
      return false; // Still full — nothing to promote into
    }

    // Find and lock the next WAITING waitlist entry.
    // FOR UPDATE SKIP LOCKED: if another promotion transaction is already working
    // on this entry, skip it and pick the next one. Prevents promotion deadlocks.
    const next = await client.query(`
      SELECT id, user_id FROM waitlist_entries
      WHERE workshop_id = $1 AND status = 'WAITING'
      ORDER BY position ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    `, [workshopId]);

    if (next.rows.length === 0) {
      await client.query('ROLLBACK');
      return false; // Waitlist is empty
    }

    const waiter = next.rows[0];

    // Mark waitlist entry as promoted
    await client.query(
      `UPDATE waitlist_entries SET status = 'PROMOTED', updated_at = NOW() WHERE id = $1`,
      [waiter.id]
    );

    // Create a HELD reservation for the promoted user
    const holdSecs = HOLD_DURATION_SECONDS();
    const newRes = await client.query(`
      INSERT INTO reservations (user_id, workshop_id, status, expires_at)
      VALUES ($1, $2, 'HELD', NOW() + ($3 || ' seconds')::INTERVAL)
      RETURNING *
    `, [waiter.user_id, workshopId, holdSecs]);

    await eventRepo.insertEvent(client, {
      reservationId: newRes.rows[0].id,
      userId:        waiter.user_id,
      workshopId,
      eventType:     'WAITLIST_PROMOTED',
      prevStatus:    'WAITING',
      newStatus:     'HELD',
      reason:        'Promoted from waitlist after hold expiry.',
      metadata:      { waitlistEntryId: waiter.id },
    });

    await client.query('COMMIT');
    logger.info('Waitlist promotion after expiry', {
      userId: waiter.user_id, workshopId, reservationId: newRes.rows[0].id,
    });
    return true;

  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) {}

    if (err.code === '23505') {
      // Unique index: promoted user somehow already has an active reservation.
      // Skip them gracefully.
      logger.warn('Promotion skipped — user already has active reservation', { workshopId });
      return false;
    }

    logger.error('Phase 2 promotion failed', { workshopId, message: err.message });
    return false;
  } finally {
    client.release();
  }
}
