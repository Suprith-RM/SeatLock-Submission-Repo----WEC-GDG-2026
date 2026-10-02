/**
 * Expiration service managing background sweep of expired holds and waitlist promotions.
 */
import { query, getClient }        from '../config/db.js';
import { promoteEligibleWaiters }  from './waitlistService.js';
import { broadcastWorkshopUpdate } from '../realtime/sseManager.js';
import { logger }                  from '../utils/logger.js';

const SWEEP_INTERVAL_MS = parseInt(process.env.SWEEP_INTERVAL_MS || '60000', 10);

export async function sweepExpiredHolds() {
  const workshopsResult = await query(`
    SELECT DISTINCT workshop_id
    FROM   reservations
    WHERE  status = 'HELD' AND expires_at <= NOW()
  `);

  if (workshopsResult.rows.length === 0) return { expired: 0, promoted: 0 };

  let totalExpired  = 0;
  let totalPromoted = 0;

  for (const { workshop_id: workshopId } of workshopsResult.rows) {
    const client = await getClient();
    try {
      await client.query('BEGIN');

      await client.query(
        'SELECT id FROM workshops WHERE id = $1 FOR UPDATE',
        [workshopId],
      );

      const expired = await client.query(`
        UPDATE reservations
        SET    status = 'EXPIRED', updated_at = NOW()
        WHERE  workshop_id = $1 AND status = 'HELD' AND expires_at <= NOW()
        RETURNING id, user_id
      `, [workshopId]);

      for (const r of expired.rows) {
        await client.query(`
          INSERT INTO reservation_events
            (reservation_id, user_id, workshop_id, event_type, prev_status, new_status)
          VALUES ($1, $2, $3, 'HOLD_EXPIRED', 'HELD', 'EXPIRED')
        `, [r.id, r.user_id, workshopId]);
      }

      totalExpired += expired.rowCount;

      const promoted = await promoteEligibleWaiters(workshopId, client);
      totalPromoted += promoted;

      await client.query('COMMIT');

      broadcastWorkshopUpdate(workshopId).catch(err =>
        logger.warn('SSE broadcast failed after expiry', { workshopId, err: err?.message }),
      );

      if (expired.rowCount > 0) {
        logger.info('Workshop expiry complete', {
          workshopId,
          expired: expired.rowCount,
          promoted,
        });
      }

    } catch (err) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      logger.error('Workshop expiry failed', { workshopId, message: err?.message });
    } finally {
      client.release();
    }
  }

  if (totalExpired > 0) {
    logger.info('Expiry sweep complete', { expired: totalExpired, promoted: totalPromoted });
  }

  return { expired: totalExpired, promoted: totalPromoted };
}

export function startExpiryJob() {
  logger.info('Expiry job started', { intervalMs: SWEEP_INTERVAL_MS });
  const id = setInterval(() => {
    sweepExpiredHolds().catch(err =>
      logger.error('Expiry sweep uncaught error', { message: err?.message }),
    );
  }, SWEEP_INTERVAL_MS);
  return id;
}
