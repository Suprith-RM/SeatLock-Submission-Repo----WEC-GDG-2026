/**
 * Expiration sweep service to mark expired holds and trigger waitlist promotions.
 */
import { getClient }          from '../config/db.js';
import * as reservationRepo   from '../repositories/reservationRepository.js';
import * as eventRepo         from '../repositories/eventRepository.js';
import * as workshopService   from './workshopService.js';
import * as sseManager        from '../realtime/sseManager.js';
import { promoteNext }        from './waitlistService.js';
import { logger }             from '../utils/logger.js';

const HOLD_DURATION_SECONDS = () =>
  parseInt(process.env.HOLD_DURATION_SECONDS || '300', 10);

export async function sweepExpiredHolds() {
  const { expired, byWorkshop } = await phaseOneExpire();

  let promoted = 0;
  for (const [workshopId, freedCount] of Object.entries(byWorkshop)) {
    for (let i = 0; i < freedCount; i++) {
      const ok = await promoteNext(workshopId);
      if (!ok) break;
      promoted++;
    }
    // Broadcast updated seat count after all promotions for this workshop
    if (freedCount > 0) {
      broadcastWorkshopUpdate(workshopId).catch(() => {});
    }
  }

  return { expired, promoted };
}

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

async function broadcastWorkshopUpdate(workshopId) {
  if (sseManager.getSubscriberCount(workshopId) === 0) return;
  try {
    const workshop = await workshopService.getWorkshop(workshopId);
    sseManager.broadcast(workshopId, { type: 'workshop_update', workshop });
  } catch (_) {}
}
