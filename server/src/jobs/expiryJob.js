/**
 * Background worker to sweep expired holds and auto-promote waitlist entries.
 */
import { sweepExpiredHolds } from '../services/expirationService.js';
import { logger }            from '../utils/logger.js';

const SWEEP_INTERVAL_MS = 60_000;
let jobInterval = null;

export function startExpiryJob() {
  // Run immediate recovery sweep on startup
  runSweep('startup');

  // Recurring sweep interval
  jobInterval = setInterval(() => runSweep('scheduled'), SWEEP_INTERVAL_MS);

  // Allow graceful shutdown without being blocked by active interval timer
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
    logger.error('Expiry sweep failed', { trigger, message: err.message });
  }
}
