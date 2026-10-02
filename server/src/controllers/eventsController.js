/**
 * Events Controller — SSE stream handler.
 * Handles the long-lived SSE connection for a workshop.
 * Broadcasts only public aggregated data.
 */
import { subscribe as sseSubscribe, unsubscribe, sendConnectedEvent } from '../realtime/sseManager.js';
import { AppError, ErrorCode } from '../utils/errors.js';
import { query } from '../config/db.js';
import { logger } from '../utils/logger.js';

const KEEP_ALIVE_INTERVAL_MS = 25_000;

export async function streamWorkshopEvents(req, res, next) {
  const { workshopId } = req.params;

  const wsCheck = await query(
    'SELECT id FROM workshops WHERE id = $1',
    [workshopId],
  ).catch(() => null);

  if (!wsCheck?.rows[0]) {
    return next(AppError.notFound(ErrorCode.WORKSHOP_NOT_FOUND, 'Workshop not found.'));
  }

  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection',    'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  sseSubscribe(workshopId, res);
  logger.debug('SSE connection opened', { workshopId, userId: req.user?.id });

  await sendConnectedEvent(workshopId, res).catch(err =>
    logger.warn('Failed to send connected event', { err: err?.message }),
  );

  const keepAlive = setInterval(() => {
    try {
      res.write(': keep-alive\n\n');
    } catch (_) {
      clearInterval(keepAlive);
    }
  }, KEEP_ALIVE_INTERVAL_MS);

  req.on('close', () => {
    clearInterval(keepAlive);
    unsubscribe(workshopId, res);
    logger.debug('SSE connection closed', { workshopId, userId: req.user?.id });
  });
}

export const subscribe = streamWorkshopEvents;
