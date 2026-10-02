/**
 * Background hold expiration job.
 *
 * Runs sweepExpiredHolds() every 60 seconds to:
 * 1. Set status='EXPIRED' for HELD rows where expires_at < NOW()
 * 2. Promote the next waitlist person into the freed seat
 *
 * STARTUP RECOVERY:
 * On server start, startExpiryJob() immediately runs the sweep BEFORE scheduling
 * the interval. This catches holds that expired during downtime (crash, deploy, restart).
 * No in-memory hold timers are lost — everything is stored in PostgreSQL with timestamps.
 *
 * CRASH SAFETY:
 * If the sweep throws, we log the error but DO NOT crash the process.
 * The next scheduled sweep will retry. This is acceptable because Tier 1 (logical expiry
 * at confirm-time) already prevents confirming expired holds. The sweep is cleanup.
 */
import { sweepExpiredHolds } from '../services/expirationService.js';
import { logger }            from '../utils/logger.js';

const SWEEP_INTERVAL_MS = 60_000; // 60 seconds
let jobInterval = null;

export function startExpiryJob() {
  // Immediate sweep on startup (recovery from downtime)
  runSweep('startup');

  // Recurring sweep
  jobInterval = setInterval(() => runSweep('scheduled'), SWEEP_INTERVAL_MS);

  // .unref() allows Node.js to exit if this is the only thing left running
  // (important for graceful shutdown — the interval doesn't block process.exit)
  if (jobInterval.unref) jobInterval.unref();

  logger.info('Hold expiry job started', { intervalMs: SWEEP_INTERVAL_MS });
}

export function stopExpiryJob() {
  if (jobInterval) {
    clearInterval(jobInterval);
    jobInterval = null;
    logger.info('Hold expiry job stopped');
  }
}

async function runSweep(trigger) {
  try {
    const result = await sweepExpiredHolds();
    if (result.expired > 0 || result.promoted > 0) {
      logger.info('Expiry sweep complete', { trigger, ...result });
    }
  } catch (err) {
    // Log error but DO NOT rethrow — keeps the server running
    logger.error('Expiry sweep failed', { trigger, message: err.message });
  }
}
