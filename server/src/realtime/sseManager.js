/**
 * SSE Manager — Server-Sent Events broadcast hub.
 * Broadcasts only aggregated public data: { id, name, capacity, availableSeats, isFull }.
 */
import { query } from '../config/db.js';
import { logger } from '../utils/logger.js';

// Map<workshopId, Set<Response>>
const connections = new Map();

export function subscribe(workshopId, res) {
  if (!connections.has(workshopId)) {
    connections.set(workshopId, new Set());
  }
  connections.get(workshopId).add(res);
  logger.debug('SSE client subscribed', {
    workshopId,
    clients: connections.get(workshopId).size,
  });
}

export function unsubscribe(workshopId, res) {
  const clients = connections.get(workshopId);
  if (!clients) return;
  clients.delete(res);
  if (clients.size === 0) connections.delete(workshopId);
  logger.debug('SSE client unsubscribed', { workshopId });
}

export function getSubscriberCount(workshopId) {
  return connections.get(workshopId)?.size ?? 0;
}

export async function fetchPublicWorkshopState(workshopId) {
  const result = await query(`
    SELECT
      w.id,
      w.name,
      w.capacity,
      COUNT(r.id) FILTER (
        WHERE r.status IN ('HELD', 'CONFIRMED')
          AND (r.status = 'CONFIRMED' OR r.expires_at > NOW())
      )::INT AS active_count
    FROM  workshops w
    LEFT JOIN reservations r ON r.workshop_id = w.id
    WHERE w.id = $1
    GROUP BY w.id
  `, [workshopId]);

  if (!result.rows[0]) return null;

  const ws = result.rows[0];
  const availableSeats = Math.max(0, ws.capacity - ws.active_count);

  return {
    id:             ws.id,
    name:           ws.name,
    capacity:       ws.capacity,
    availableSeats,
    isFull:         availableSeats === 0,
  };
}

export async function broadcastWorkshopUpdate(workshopId) {
  const clients = connections.get(workshopId);
  if (!clients || clients.size === 0) {
    return;
  }

  const workshop = await fetchPublicWorkshopState(workshopId);
  if (!workshop) {
    logger.warn('broadcastWorkshopUpdate: workshop not found', { workshopId });
    return;
  }

  const payload = `data: ${JSON.stringify({ type: 'workshop_update', workshop })}\n\n`;
  const dead    = new Set();

  for (const res of clients) {
    try {
      res.write(payload);
    } catch (_) {
      dead.add(res);
      logger.debug('SSE write failed — client disconnected', { workshopId });
    }
  }

  for (const res of dead) clients.delete(res);
  if (clients.size === 0) connections.delete(workshopId);
}

export async function sendConnectedEvent(workshopId, res) {
  const workshop = await fetchPublicWorkshopState(workshopId);
  if (!workshop) return;

  const payload = `data: ${JSON.stringify({ type: 'connected', workshop })}\n\n`;
  try {
    res.write(payload);
  } catch (_) {
    // Client disconnected immediately
  }
}

export function broadcast(workshopId, data) {
  const clients = connections.get(workshopId);
  if (!clients || clients.size === 0) return;

  const payload = `data: ${JSON.stringify(data)}\n\n`;
  const dead = [];

  for (const res of clients) {
    try {
      res.write(payload);
    } catch (_) {
      dead.push(res);
    }
  }

  for (const res of dead) clients.delete(res);
  if (clients.size === 0) connections.delete(workshopId);
}
