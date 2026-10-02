/**
 * Integration tests for the Reservation Engine.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'crypto';
import app  from '../../src/app.js';
import pool from '../../src/config/db.js';

const WORKSHOP_ID = '00000000-0000-0000-0000-000000000001';
const TS          = Date.now();
const EMAIL       = `res-${TS}@example.com`;
const PASS        = 'testpassword123';

let token;
let userId;

// ── Helpers ───────────────────────────────────────────────────────────────────

async function registerAndLogin(email, password = PASS) {
  await request(app).post('/api/auth/register')
    .send({ name: 'Test User', email, password });
  const res = await request(app).post('/api/auth/login').send({ email, password });
  return res.body; // { user, token }
}

async function createHold(tok, key = randomUUID()) {
  return request(app)
    .post(`/api/workshops/${WORKSHOP_ID}/holds`)
    .set('Authorization', `Bearer ${tok}`)
    .set('Idempotency-Key', key)
    .send();
}

async function cancelAll(uid) {
  await pool.query(
    `UPDATE reservations SET status='CANCELLED'
     WHERE user_id = $1 AND status IN ('HELD','CONFIRMED')`,
    [uid]
  );
}

// ── Setup / Teardown ──────────────────────────────────────────────────────────

beforeAll(async () => {
  const auth = await registerAndLogin(EMAIL, PASS);
  token  = auth.token;
  userId = auth.user.id;
});

// Cancel any active reservations before each test so tests don't bleed into each other
beforeEach(async () => {
  await cancelAll(userId);
});

afterAll(async () => {
  // Delete all data created by this test run
  await pool.query(
    `DELETE FROM idempotency_keys WHERE user_id IN (SELECT id FROM users WHERE email LIKE $1)`,
    [`res-${TS}%`]
  );
  await pool.query(
    `DELETE FROM reservation_events WHERE user_id IN (SELECT id FROM users WHERE email LIKE $1)`,
    [`res-${TS}%`]
  );
  await pool.query(
    `DELETE FROM reservations WHERE user_id IN (SELECT id FROM users WHERE email LIKE $1)`,
    [`res-${TS}%`]
  );
  await pool.query(`DELETE FROM users WHERE email LIKE $1`, [`res-${TS}%`]);
  await pool.end();
});

// ── Workshop Endpoints ────────────────────────────────────────────────────────

describe('GET /api/workshops', () => {
  it('returns list of workshops with seat counts', async () => {
    const res = await request(app).get('/api/workshops');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.workshops)).toBe(true);
    expect(res.body.workshops.length).toBeGreaterThan(0);

    const ws = res.body.workshops[0];
    expect(ws).toHaveProperty('id');
    expect(ws).toHaveProperty('capacity');
    expect(ws).toHaveProperty('availableSeats');
    expect(ws).toHaveProperty('isFull');
  });
});

describe('GET /api/workshops/:id', () => {
  it('returns a single workshop', async () => {
    const res = await request(app).get(`/api/workshops/${WORKSHOP_ID}`);
    expect(res.status).toBe(200);
    expect(res.body.workshop.id).toBe(WORKSHOP_ID);
    expect(res.body.workshop.capacity).toBe(20);
  });

  it('returns 404 for nonexistent workshop', async () => {
    const res = await request(app).get(`/api/workshops/${randomUUID()}`);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('WORKSHOP_NOT_FOUND');
  });
});

// ── Hold Creation ─────────────────────────────────────────────────────────────

describe('POST /api/workshops/:id/holds', () => {
  it('creates a HELD reservation with expires_at set', async () => {
    const res = await createHold(token);

    expect(res.status).toBe(201);
    expect(res.body.reservation.status).toBe('HELD');
    expect(res.body.reservation.workshopId).toBe(WORKSHOP_ID);
    expect(res.body.reservation.expiresAt).not.toBeNull();
    expect(res.body.reservation.secondsUntilExpiry).toBeGreaterThan(0);
    expect(res.body.reservation.isExpired).toBe(false);
  });

  it('returns 400 when Idempotency-Key header is missing', async () => {
    const res = await request(app)
      .post(`/api/workshops/${WORKSHOP_ID}/holds`)
      .set('Authorization', `Bearer ${token}`)
      .send();
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
  });

  it('returns 401 without authentication', async () => {
    const res = await request(app)
      .post(`/api/workshops/${WORKSHOP_ID}/holds`)
      .set('Idempotency-Key', randomUUID())
      .send();
    expect(res.status).toBe(401);
  });

  it('returns 404 for nonexistent workshop', async () => {
    const res = await request(app)
      .post(`/api/workshops/${randomUUID()}/holds`)
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', randomUUID())
      .send();
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('WORKSHOP_NOT_FOUND');
  });

  it('returns 409 ALREADY_HAS_RESERVATION when user already holds a seat', async () => {
    await createHold(token); // First hold

    const second = await createHold(token); // Different idempotency key
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('ALREADY_HAS_RESERVATION');
  });

  it('returns CACHED 200 response when same Idempotency-Key is reused', async () => {
    const key   = randomUUID();
    const first  = await createHold(token, key);
    expect(first.status).toBe(201);
    const firstId = first.body.reservation.id;

    // Cancel so business logic wouldn't block a second attempt
    await cancelAll(userId);

    const second = await createHold(token, key); // Same key
    expect([200, 201]).toContain(second.status); // cached response
    expect(second.body.reservation.id).toBe(firstId); // Same reservation ID as cached
  });
});

// ── Confirm Hold ──────────────────────────────────────────────────────────────

describe('POST /api/reservations/:id/confirm', () => {
  let reservationId;

  beforeEach(async () => {
    const res = await createHold(token);
    reservationId = res.body.reservation?.id;
  });

  it('confirms a HELD reservation → status becomes CONFIRMED', async () => {
    const res = await request(app)
      .post(`/api/reservations/${reservationId}/confirm`)
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', randomUUID());

    expect(res.status).toBe(200);
    expect(res.body.reservation.status).toBe('CONFIRMED');
    expect(res.body.reservation.expiresAt).toBeNull(); // Cleared on confirm
  });

  it('returns 409 ALREADY_CONFIRMED on double-confirm', async () => {
    await request(app)
      .post(`/api/reservations/${reservationId}/confirm`)
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', randomUUID());

    const res = await request(app)
      .post(`/api/reservations/${reservationId}/confirm`)
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', randomUUID());

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('ALREADY_CONFIRMED');
  });

  it('returns 409 HOLD_EXPIRED when expires_at is in the past', async () => {
    // Manually backdate the expiry to simulate an expired hold
    await pool.query(
      `UPDATE reservations SET expires_at = NOW() - INTERVAL '1 second' WHERE id = $1`,
      [reservationId]
    );

    const res = await request(app)
      .post(`/api/reservations/${reservationId}/confirm`)
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', randomUUID());

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('HOLD_EXPIRED');
  });

  it('returns 403 when another user tries to confirm', async () => {
    const other = await registerAndLogin(`other-${TS}@example.com`);

    const res = await request(app)
      .post(`/api/reservations/${reservationId}/confirm`)
      .set('Authorization', `Bearer ${other.token}`)
      .set('Idempotency-Key', randomUUID());

    expect(res.status).toBe(403);
  });

  it('returns 401 without authentication', async () => {
    const res = await request(app)
      .post(`/api/reservations/${reservationId}/confirm`)
      .set('Idempotency-Key', randomUUID());
    expect(res.status).toBe(401);
  });
});

// ── Cancel Reservation ────────────────────────────────────────────────────────

describe('DELETE /api/reservations/:id', () => {
  let reservationId;

  beforeEach(async () => {
    const res = await createHold(token);
    reservationId = res.body.reservation?.id;
  });

  it('cancels a HELD reservation → status becomes CANCELLED', async () => {
    const res = await request(app)
      .delete(`/api/reservations/${reservationId}`)
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', randomUUID());

    expect(res.status).toBe(200);
    expect(res.body.reservation.status).toBe('CANCELLED');
  });

  it('cancels a CONFIRMED reservation → status becomes CANCELLED', async () => {
    await request(app)
      .post(`/api/reservations/${reservationId}/confirm`)
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', randomUUID());

    const res = await request(app)
      .delete(`/api/reservations/${reservationId}`)
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', randomUUID());

    expect(res.status).toBe(200);
    expect(res.body.reservation.status).toBe('CANCELLED');
  });

  it('returns 409 ALREADY_CANCELLED on double-cancel', async () => {
    await request(app)
      .delete(`/api/reservations/${reservationId}`)
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', randomUUID());

    const res = await request(app)
      .delete(`/api/reservations/${reservationId}`)
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', randomUUID());

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('ALREADY_CANCELLED');
  });

  it('returns 403 when another user tries to cancel', async () => {
    const other = await registerAndLogin(`cancel-other-${TS}@example.com`);

    const res = await request(app)
      .delete(`/api/reservations/${reservationId}`)
      .set('Authorization', `Bearer ${other.token}`)
      .set('Idempotency-Key', randomUUID());

    expect(res.status).toBe(403);
  });

  it('after cancellation, user can hold again (partial unique index allows it)', async () => {
    // Cancel the hold
    await request(app)
      .delete(`/api/reservations/${reservationId}`)
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', randomUUID());

    // Hold again — should succeed
    const second = await createHold(token);
    expect(second.status).toBe(201);
    expect(second.body.reservation.status).toBe('HELD');
  });
});

// ── Get Reservation ───────────────────────────────────────────────────────────

describe('GET /api/reservations/:id', () => {
  it('returns reservation for the owner', async () => {
    const holdRes = await createHold(token);
    const id = holdRes.body.reservation.id;

    const res = await request(app)
      .get(`/api/reservations/${id}`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.reservation.id).toBe(id);
  });

  it('returns 403 for non-owner', async () => {
    const holdRes = await createHold(token);
    const id = holdRes.body.reservation.id;

    const other = await registerAndLogin(`get-other-${TS}@example.com`);
    const res = await request(app)
      .get(`/api/reservations/${id}`)
      .set('Authorization', `Bearer ${other.token}`);

    expect(res.status).toBe(403);
  });

  it('returns 404 for nonexistent reservation', async () => {
    const res = await request(app)
      .get(`/api/reservations/${randomUUID()}`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(404);
  });
});

// ── My Reservation ────────────────────────────────────────────────────────────

describe('GET /api/workshops/:id/my-reservation', () => {
  it('returns null when no active reservation', async () => {
    const res = await request(app)
      .get(`/api/workshops/${WORKSHOP_ID}/my-reservation`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.reservation).toBeNull();
  });

  it('returns active HELD reservation', async () => {
    const holdRes = await createHold(token);
    const id = holdRes.body.reservation.id;

    const res = await request(app)
      .get(`/api/workshops/${WORKSHOP_ID}/my-reservation`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.reservation.id).toBe(id);
    expect(res.body.reservation.status).toBe('HELD');
  });

  it('returns null after cancellation', async () => {
    const holdRes = await createHold(token);
    const id = holdRes.body.reservation.id;

    await request(app)
      .delete(`/api/reservations/${id}`)
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', randomUUID());

    const res = await request(app)
      .get(`/api/workshops/${WORKSHOP_ID}/my-reservation`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.reservation).toBeNull();
  });
});
