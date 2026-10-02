/**
 * Server-Sent Events (SSE) controller for real-time workshop updates.
 */
import * as workshopService from '../services/workshopService.js';
import * as sseManager      from '../realtime/sseManager.js';
import { logger }           from '../utils/logger.js';

export async function subscribe(req, res) {
  const { workshopId } = req.params;

  let workshop;
  try {
    workshop = await workshopService.getWorkshop(workshopId);
  } catch (_) {
    return res.status(404).json({
      error: { code: 'WORKSHOP_NOT_FOUND', message: 'Workshop not found.' },
    });
  }

  res.setHeader('Content-Type',     'text/event-stream');
  res.setHeader('Cache-Control',    'no-cache');
  res.setHeader('Connection',       'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  // Flush headers immediately to establish stream
  res.flushHeaders();

  // Send initial workshop state on connection
  res.write(`data: ${JSON.stringify({ type: 'connected', workshop })}\n\n`);

  sseManager.subscribe(workshopId, res);
  logger.debug('SSE client connected', {
    workshopId,
    userId:      req.user?.id,
    subscribers: sseManager.getSubscriberCount(workshopId),
  });

  // Keep-alive ping to prevent proxy connection timeouts
  const pingInterval = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch (_) {
      clearInterval(pingInterval);
    }
  }, 25_000);

  req.on('close', () => {
    clearInterval(pingInterval);
    sseManager.unsubscribe(workshopId, res);
    logger.debug('SSE client disconnected', { workshopId });
  });
}
