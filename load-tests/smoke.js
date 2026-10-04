/**
 * load-tests/smoke.js  —  SMOKE TEST
 *
 * A lightweight sanity check (1 VU, a few iterations) run BEFORE the big
 * concurrency test to make sure the server is up and the workshop exists.
 *
 * Also does a complete happy-path flow:
 *   register → login → hold → confirm → cancel
 *
 * Run:
 *   k6 run load-tests/smoke.js
 */

import http from 'k6/http';
import { check, sleep } from 'k6';
import { uuidv4 } from 'https://jslib.k6.io/k6-utils/1.4.0/index.js';

const BASE_URL    = __ENV.BASE_URL    || 'http://localhost:3001';
const WORKSHOP_ID = __ENV.WORKSHOP_ID || '00000000-0000-0000-0000-000000000001';

export const options = {
  vus:        1,
  iterations: 1,
  thresholds: {
    'http_req_failed': ['rate == 0'],
    'checks':          ['rate == 1.0'],
  },
};

export default function () {
  // ── Step 1: Health check ─────────────────────────────────────────────────
  const health = http.get(`${BASE_URL}/health`);
  check(health, { 'server is up (200)': (r) => r.status === 200 });

  // ── Step 2: Register a fresh user ────────────────────────────────────────
  const email = `smoke-${Date.now()}@seatlock.test`;
  const regRes = http.post(
    `${BASE_URL}/api/auth/register`,
    JSON.stringify({ name: 'Smoke Tester', email, password: 'smoke123' }),
    { headers: { 'Content-Type': 'application/json' } },
  );
  check(regRes, { 'register 201': (r) => r.status === 201 });
  const token = regRes.json('token');

  const headers = (key) => ({
    'Content-Type':    'application/json',
    'Authorization':   `Bearer ${token}`,
    'Idempotency-Key': key,
  });

  // ── Step 3: GET workshop — check availability fields ─────────────────────
  const wsRes = http.get(`${BASE_URL}/api/workshops/${WORKSHOP_ID}`, {
    headers: { 'Authorization': `Bearer ${token}` },
  });
  check(wsRes, {
    'workshop 200':           (r) => r.status === 200,
    'has heldCount':          (r) => r.json('workshop.heldCount') !== undefined,
    'has confirmedCount':     (r) => r.json('workshop.confirmedCount') !== undefined,
    'has availableSeats':     (r) => r.json('workshop.availableSeats') !== undefined,
  });

  // Only run hold/confirm/cancel if seats are available
  const available = wsRes.json('workshop.availableSeats') ?? 0;
  if (available === 0) {
    console.log('ℹ️  Workshop full — skipping hold flow in smoke test');
    return;
  }

  // ── Step 4: Create a hold ─────────────────────────────────────────────────
  const holdRes = http.post(
    `${BASE_URL}/api/workshops/${WORKSHOP_ID}/holds`,
    JSON.stringify({}),
    { headers: headers(uuidv4()) },
  );
  check(holdRes, {
    'hold 201':                     (r) => r.status === 201,
    'hold status is HELD':          (r) => r.json('reservation.status') === 'HELD',
    'hold has expiresAt':           (r) => !!r.json('reservation.expiresAt'),
    'hold has secondsUntilExpiry':  (r) => r.json('reservation.secondsUntilExpiry') > 0,
  });
  const reservationId = holdRes.json('reservation.id');

  sleep(0.5);

  // ── Step 5: Confirm the hold ─────────────────────────────────────────────
  const confirmRes = http.post(
    `${BASE_URL}/api/reservations/${reservationId}/confirm`,
    JSON.stringify({}),
    { headers: headers(uuidv4()) },
  );
  check(confirmRes, {
    'confirm 200':               (r) => r.status === 200,
    'confirm status CONFIRMED':  (r) => r.json('reservation.status') === 'CONFIRMED',
  });

  sleep(0.5);

  // ── Step 6: Cancel the reservation ──────────────────────────────────────
  const cancelRes = http.del(
    `${BASE_URL}/api/reservations/${reservationId}`,
    null,
    { headers: headers(uuidv4()) },
  );
  check(cancelRes, {
    'cancel 200':              (r) => r.status === 200,
    'cancel status CANCELLED': (r) => r.json('reservation.status') === 'CANCELLED',
  });

  console.log('✅ Smoke test complete — full happy path passed');
}
