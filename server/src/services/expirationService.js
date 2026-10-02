/**
 * Expiration Service — sweeps expired HELD reservations and promotes waitlisters.
 */
import { getClient } from '../config/db.js';
import { broadcastWorkshopUpdate } from '../realtime/sseManager.js';
import { logger } from '../utils/logger.js';

const SWEEP_INTERVAL_MS = parseInt(process.env.SWEEP_INTERVAL_MS || '60000', 10);

export async function sweepExpiredHolds() {
  const client = await getClient();
  let totalExpired = 0;
  let totalPromoted = 0;

  try {
    await client.query('BEGIN');

    const expired = await client.query(`
      UPDATE reservations
      SET    status = 'EXPIRED', updated_at = NOW()
      WHERE  status = 'HELD' AND expires_at <= NOW()
      RETURNING id, user_id, workshop_id
    `);

    if (expired.rows.length > 0) {
      for (const r of expired.rows) {
        await client.query(`
          INSERT INTO reservation_events
            (reservation_id, user_id, workshop_id, event_type, prev_status, new_status, reason)
          VALUES ($1, $2, $3, 'HOLD_EXPIRED', 'HELD', 'EXPIRED', 'Hold expired after timeout.')
        `, [r.id, r.user_id, r.workshop_id]);
      }
      totalExpired = expired.rows.length;
    }

    await client.query('COMMIT');

    const affectedWorkshops = [...new Set(expired.rows.map(r => r.workshop_id))];

    const { promoteNext } = await import('./waitlistService.js');
    for (const workshopId of affectedWorkshops) {
      const promoted = await promoteNext(workshopId).catch(err => {
        logger.warn('promoteNext failed in sweep', { workshopId, err: err?.message });
        return false;
      });
      if (promoted) totalPromoted += 1;

      broadcastWorkshopUpdate(workshopId).catch(err =>
        logger.warn('SSE broadcast failed in sweep', { workshopId, err: err?.message }),
      );
    }

  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    logger.error('Expiry sweep failed', { message: err?.message });
  } finally {
    client.release();
  }

  if (totalExpired > 0) {
    logger.info('Expiry sweep complete', { expired: totalExpired, promoted: totalPromoted });
  }

  return { expired: totalExpired, promoted: totalPromoted };
}

export function startExpiryJob() {
  logger.info('Expiry job started', { intervalMs: SWEEP_INTERVAL_MS });
  const id = setInterval(sweepExpiredHolds, SWEEP_INTERVAL_MS);
  return id;
}
