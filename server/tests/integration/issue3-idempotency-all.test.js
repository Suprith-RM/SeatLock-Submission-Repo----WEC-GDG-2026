/**
 * Issue 3 integration tests: Idempotency on all mutating endpoints.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request    from 'supertest';
import { randomUUID } from 'crypto';
import app  from '../../src/app.js';
import pool from '../../src/config/db.js';

const WORKSHOP_ID = '00000000-0000-0000-0000-000000000001';
const TS = Date.now();

async function registerLogin(suffix) {
  const email = `i3-${TS}-${suffix}@test.local`;
  await request(app).post('/api/auth/register')
    .send({ name: `I3 ${suffix}`, email, password: 'testpassword123' });
  const res = await request(app).post('/api/auth/login')
    .send({ email, password: 'testpassword123' });
  return { token: res.body.token, userId: res.body.user.id };
}

async function clearUser(userId) {
  await pool.query(`UPDATE reservations SET status='CANCELLED' WHERE user_id=$1 AND status IN ('HELD','CONFIRMED')`, [userId]);
  await pool.query(`UPDATE waitlist_entries SET status='REMOVED' WHERE user_id=$1 AND status='WAITING'`, [userId]);
  await pool.query(`DELETE FROM idempotency_keys WHERE user_id=$1`, [userId]);
}

async function clearWorkshop() {
  await pool.query(`UPDATE reservations SET status='CANCELLED' WHERE workshop_id=$1 AND status IN ('HELD','CONFIRMED')`, [WORKSHOP_ID]);
  await pool.query(`UPDATE waitlist_entries SET status='REMOVED' WHERE workshop_id=$1 AND status='WAITING'`, [WORKSHOP_ID]);
}

describe('Issue 3 — Idempotency on All State-Changing Endpoints', () => {
  let user;

  beforeAll(async () => {
    user = await registerLogin('U');
  }, 30_000);

  afterAll(async () => {
    await clearUser(user.userId);
    await clearWorkshop();
    await pool.query(`DELETE FROM users WHERE email LIKE 'i3-${TS}%'`);
    await pool.query(`DELETE FROM users WHERE email LIKE 'fi3-${TS}%'`);
    await pool.query(`DELETE FROM users WHERE email LIKE 'wi3-${TS}%'`);
  });

  beforeEach(async () => {
    await clearUser(user.userId);
    await clearWorkshop();
  });

  it('TEST 1 — duplicate hold: 1 reservation, not 2', async () => {
    const key = randomUUID();
    const r1  = await request(app)
      .post(`/api/workshops/${WORKSHOP_ID}/holds`)
      .set('Authorization', `Bearer ${user.token}`)
      .set('Idempotency-Key', key);
    expect(r1.status).toBe(201);

    const r2 = await request(app)
      .post(`/api/workshops/${WORKSHOP_ID}/holds`)
      .set('Authorization', `Bearer ${user.token}`)
      .set('Idempotency-Key', key);
    expect(r2.status).toBe(201);
    expect(r2.body.reservation.id).toBe(r1.body.reservation.id);

    const count = await pool.query(
      `SELECT COUNT(*)::INT AS c FROM reservations WHERE user_id=$1 AND workshop_id=$2 AND status='HELD'`,
      [user.userId, WORKSHOP_ID],
    );
    expect(count.rows[0].c).toBe(1);
  });

  it('TEST 2 — duplicate confirm: 1 state transition, 1 audit event', async () => {
    const holdKey    = randomUUID();
    const confirmKey = randomUUID();

    const holdRes = await request(app)
      .post(`/api/workshops/${WORKSHOP_ID}/holds`)
      .set('Authorization', `Bearer ${user.token}`)
      .set('Idempotency-Key', holdKey);
    const reservationId = holdRes.body.reservation.id;

    const c1 = await request(app)
      .post(`/api/reservations/${reservationId}/confirm`)
      .set('Authorization', `Bearer ${user.token}`)
      .set('Idempotency-Key', confirmKey);
    expect(c1.status).toBe(200);

    const c2 = await request(app)
      .post(`/api/reservations/${reservationId}/confirm`)
      .set('Authorization', `Bearer ${user.token}`)
      .set('Idempotency-Key', confirmKey);
    expect(c2.status).toBe(200);
    expect(c2.body.reservation.status).toBe('CONFIRMED');

    const events = await pool.query(
      `SELECT COUNT(*)::INT AS c FROM reservation_events WHERE reservation_id=$1 AND event_type='HOLD_CONFIRMED'`,
      [reservationId],
    );
    expect(events.rows[0].c).toBe(1);
  });

  it('TEST 3 — duplicate cancel: 1 cancellation, 1 promotion (not 2)', async () => {
    const wsId = randomUUID();
    await pool.query(`INSERT INTO workshops (id,name,description,capacity) VALUES ($1,'Cancel Idem','T',1)`, [wsId]);

    const holdRes = await request(app)
      .post(`/api/workshops/${wsId}/holds`)
      .set('Authorization', `Bearer ${user.token}`)
      .set('Idempotency-Key', randomUUID());
    const reservationId = holdRes.body.reservation.id;

    const waiterId = randomUUID();
    await pool.query(`INSERT INTO users (id,email,password_hash,name) VALUES ($1,$2,'hash','W')`, [waiterId, `wi3-${TS}@t.local`]);
    await pool.query(`INSERT INTO waitlist_entries (user_id,workshop_id,status,position) VALUES ($1,$2,'WAITING',1)`, [waiterId, wsId]);

    const cancelKey = randomUUID();
    const ca1 = await request(app)
      .delete(`/api/reservations/${reservationId}`)
      .set('Authorization', `Bearer ${user.token}`)
      .set('Idempotency-Key', cancelKey);
    expect(ca1.status).toBe(200);

    const ca2 = await request(app)
      .delete(`/api/reservations/${reservationId}`)
      .set('Authorization', `Bearer ${user.token}`)
      .set('Idempotency-Key', cancelKey);
    expect(ca2.status).toBe(200);

    const events = await pool.query(
      `SELECT COUNT(*)::INT AS c FROM reservation_events WHERE reservation_id=$1 AND event_type='RESERVATION_CANCELLED'`,
      [reservationId],
    );
    expect(events.rows[0].c).toBe(1);

    const promotions = await pool.query(
      `SELECT COUNT(*)::INT AS c FROM reservations WHERE workshop_id=$1 AND user_id=$2 AND status='HELD'`,
      [wsId, waiterId],
    );
    expect(promotions.rows[0].c).toBe(1);
  });

  it('TEST 4 — duplicate waitlist join: 1 entry, not 2', async () => {
    for (let i = 0; i < 20; i++) {
      const uid = randomUUID();
      await pool.query(`INSERT INTO users (id,email,password_hash,name) VALUES ($1,$2,'hash','F') ON CONFLICT DO NOTHING`, [uid, `fi3-${TS}-${i}@t.local`]);
      await pool.query(`INSERT INTO reservations (user_id,workshop_id,status) VALUES ($1,$2,'CONFIRMED')`, [uid, WORKSHOP_ID]);
    }

    const key = randomUUID();
    const j1 = await request(app)
      .post(`/api/workshops/${WORKSHOP_ID}/waitlist`)
      .set('Authorization', `Bearer ${user.token}`)
      .set('Idempotency-Key', key);
    expect(j1.status).toBe(201);

    const j2 = await request(app)
      .post(`/api/workshops/${WORKSHOP_ID}/waitlist`)
      .set('Authorization', `Bearer ${user.token}`)
      .set('Idempotency-Key', key);
    expect(j2.status).toBe(201);
    expect(j2.body.entry.position).toBe(j1.body.entry.position);

    const count = await pool.query(
      `SELECT COUNT(*)::INT AS c FROM waitlist_entries WHERE user_id=$1 AND workshop_id=$2 AND status='WAITING'`,
      [user.userId, WORKSHOP_ID],
    );
    expect(count.rows[0].c).toBe(1);
  });

  it('TEST 5 — concurrent identical requests: exactly one side effect', async () => {
    const key = randomUUID();
    const [r1, r2] = await Promise.all([
      request(app)
        .post(`/api/workshops/${WORKSHOP_ID}/holds`)
        .set('Authorization', `Bearer ${user.token}`)
        .set('Idempotency-Key', key),
      request(app)
        .post(`/api/workshops/${WORKSHOP_ID}/holds`)
        .set('Authorization', `Bearer ${user.token}`)
        .set('Idempotency-Key', key),
    ]);

    const count = await pool.query(
      `SELECT COUNT(*)::INT AS c FROM reservations WHERE user_id=$1 AND workshop_id=$2 AND status='HELD'`,
      [user.userId, WORKSHOP_ID],
    );
    expect(count.rows[0].c).toBe(1);
  });

  it('TEST 6 — same key, different operation is rejected', async () => {
    const key = randomUUID();

    const holdRes = await request(app)
      .post(`/api/workshops/${WORKSHOP_ID}/holds`)
      .set('Authorization', `Bearer ${user.token}`)
      .set('Idempotency-Key', key);
    expect(holdRes.status).toBe(201);

    const otherWsId = randomUUID();
    await pool.query(`INSERT INTO workshops (id,name,description,capacity) VALUES ($1,'Other','T',20)`, [otherWsId]);

    const otherRes = await request(app)
      .post(`/api/workshops/${otherWsId}/holds`)
      .set('Authorization', `Bearer ${user.token}`)
      .set('Idempotency-Key', key);
    expect(otherRes.status).toBe(409);
    expect(otherRes.body.error.code).toBe('IDEMPOTENCY_KEY_CONFLICT');
  });
});
