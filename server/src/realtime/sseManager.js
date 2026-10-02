/**
 * In-memory manager for Server-Sent Events (SSE) subscriptions.
 */
import { logger } from '../utils/logger.js';

// Map<workshopId (string) -> Set<Express.Response>>
const subscribers = new Map();

/** Subscribe a response to a workshop's event stream. */
export function subscribe(workshopId, res) {
  if (!subscribers.has(workshopId)) {
    subscribers.set(workshopId, new Set());
  }
  subscribers.get(workshopId).add(res);
  logger.debug('SSE client subscribed', {
    workshopId,
    subscribers: subscribers.get(workshopId).size,
  });
}

/** Remove a response from a workshop's subscriber set. */
export function unsubscribe(workshopId, res) {
  const subs = subscribers.get(workshopId);
  if (!subs) return;
  subs.delete(res);
  if (subs.size === 0) subscribers.delete(workshopId);
}

/**
 * Broadcast a JSON-serializable event to all subscribers of a workshop.
 * Format: SSE requires "data: <json>\n\n"
 * Dead connections are cleaned up during broadcast.
 */
export function broadcast(workshopId, data) {
  const subs = subscribers.get(workshopId);
  if (!subs || subs.size === 0) return;

  const message = `data: ${JSON.stringify(data)}\n\n`;
  const dead = [];

  for (const res of subs) {
    try {
      res.write(message);
    } catch (_) {
      dead.push(res); // Connection closed unexpectedly
    }
  }

  for (const res of dead) {
    subs.delete(res);
  }
  if (subs.size === 0) subscribers.delete(workshopId);
}

/** Return how many clients are currently subscribed to a workshop. */
export function getSubscriberCount(workshopId) {
  return subscribers.get(workshopId)?.size ?? 0;
}
