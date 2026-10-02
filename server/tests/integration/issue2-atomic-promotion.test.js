/**
 * Issue 2 integration tests: Atomic cancellation, expiration, and waitlist promotion.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request    from 'supertest';
import { randomUUID } from 'crypto';
import app  from '../../src/app.js';
import pool from '../../src/config/db.js';

const WORKSHOP_ID = '00000000-0000-0000-0000-000000000001';
const TS = Date.now();

async function registerLogin(suffix) {
  const email = `i2-${TS}-${suffix}@test.local`;
  await request(app).post('/api/auth/register')
    .send({ name: `I2 ${suffix}`, email, password: 'testpassword123' });
  const res = await request(app).post('/api/auth/login')
    .send({ email, password: 'testpassword123' });
  return { token: res.body.token, userId: res.body.user.id };
}

async function clearAll() {
  await pool.query(`UPDATE reservations SET status='CANCELLED' WHERE workshop_id=$1 AND status IN ('HELD','CONFIRMED')`, [WORKSHOP_ID]);
  await pool.query(`UPDATE waitlist_entries SET status='REMOVED' WHERE workshop_id=$1 AND status='WAITING'`, [WORKSHOP_ID]);
}

describe('Issue 2 — Atomic Cancellation + Promotion', () => {
  let userA, userB;

  beforeAll(async () => {
    userA = await registerLogin('A');
    userB = await registerLogin('B');
  }, 30_000);

  afterAll(async () => {
    await clearAll();
    await pool.query(`DELETE FROM users WHERE email LIKE 'i2-${TS}%'`);
    await pool.query(`DELETE FROM users WHERE email LIKE 'holder-${TS}%'`);
    await pool.query(`DELETE FROM users WHERE email LIKE 'waiter-${TS}%'`);
    await pool.query(`DELETE FROM users WHERE email LIKE 'crash-%'`);
  });

  beforeEach(async () => {
    await clearAll();
    await pool.query(
      `DELETE FROM idempotency_keys WHERE user_id IN ($1, $2)`,
      [userA.userId, userB.userId],
    );
  });

  it('TEST 1 — cancel 1 seat when 1 person waiting: exactly 1 promotion', async () => {
    const customWsId = randomUUID();
    await pool.query(
      `INSERT INTO workshops (id, name, description, capacity) VALUES ($1,'Atomic Test','Test',1)`,
      [customWsId],
    );

    const holdRes = await request(app)
      .post(`/api/workshops/${customWsId}/holds`)
      .set('Authorization', `Bearer ${userA.token}`)
      .set('Idempotency-Key', randomUUID());
    expect(holdRes.status).toBe(201);
    const reservationId = holdRes.body.reservation.id;

    await pool.query(
      `INSERT INTO waitlist_entries (user_id, workshop_id, status, position) VALUES ($1,$2,'WAITING',1)`,
      [userB.userId, customWsId],
    );

    const cancelRes = await request(app)
      .delete(`/api/reservations/${reservationId}`)
      .set('Authorization', `Bearer ${userA.token}`)
      .set('Idempotency-Key', randomUUID());
    expect(cancelRes.status).toBe(200);

    const aCheck = await pool.query(`SELECT status FROM reservations WHERE id=$1`, [reservationId]);
    expect(aCheck.rows[0].status).toBe('CANCELLED');

    const bWl = await pool.query(
      `SELECT status FROM waitlist_entries WHERE workshop_id=$1 AND user_id=$2`,
      [customWsId, userB.userId],
    );
    expect(bWl.rows[0].status).toBe('PROMOTED');

    const bRes = await pool.query(
      `SELECT status FROM reservations WHERE workshop_id=$1 AND user_id=$2`,
      [customWsId, userB.userId],
    );
    expect(bRes.rows[0].status).toBe('HELD');

    const total = await pool.query(
      `SELECT COUNT(*)::INT AS c FROM reservations WHERE workshop_id=$1 AND status IN ('HELD','CONFIRMED')`,
      [customWsId],
    );
    expect(total.rows[0].c).toBe(1);
  });

  it('TEST 3 — 5 expired holds with 3 waiters: all 3 are promoted', async () => {
    const wsId = randomUUID();
    await pool.query(
      `INSERT INTO workshops (id, name, description, capacity) VALUES ($1,'Multi Expire','Test',5)`,
      [wsId],
    );

    const holders = [];
    for (let i = 0; i < 5; i++) {
      const uid = randomUUID();
      const em  = `holder-${TS}-${i}@t.local`;
      await pool.query(
        `INSERT INTO users (id,email,password_hash,name) VALUES ($1,$2,'hash','H')`,
        [uid, em],
      );
      const expiredAt = new Date(Date.now() - 1000);
      await pool.query(
        `INSERT INTO reservations (user_id, workshop_id, status, expires_at) VALUES ($1,$2,'HELD',$3)`,
        [uid, wsId, expiredAt],
      );
      holders.push(uid);
    }

    const waiters = [];
    for (let i = 0; i < 3; i++) {
      const uid = randomUUID();
      await pool.query(
        `INSERT INTO users (id,email,password_hash,name) VALUES ($1,$2,'hash','W')`,
        [uid, `waiter-${TS}-${i}@t.local`],
      );
      await pool.query(
        `INSERT INTO waitlist_entries (user_id, workshop_id, status, position) VALUES ($1,$2,'WAITING',$3)`,
        [uid, wsId, i + 1],
      );
      waiters.push(uid);
    }

    const { sweepExpiredHolds } = await import('../../src/services/expirationService.js');
    const { expired, promoted } = await sweepExpiredHolds();

    expect(expired).toBeGreaterThanOrEqual(5);
    expect(promoted).toBeGreaterThanOrEqual(3);

    for (const uid of waiters) {
      const entry = await pool.query(
        `SELECT status FROM waitlist_entries WHERE workshop_id=$1 AND user_id=$2`,
        [wsId, uid],
      );
      expect(entry.rows[0].status).toBe('PROMOTED');

      const res = await pool.query(
        `SELECT status FROM reservations WHERE workshop_id=$1 AND user_id=$2`,
        [wsId, uid],
      );
      expect(res.rows[0].status).toBe('HELD');
    }

    const activeCount = await pool.query(
      `SELECT COUNT(*)::INT AS c FROM reservations WHERE workshop_id=$1 AND status IN ('HELD','CONFIRMED')`,
      [wsId],
    );
    expect(activeCount.rows[0].c).toBe(3);
  });

  it('TEST 4 — crash recovery: sweepExpiredHolds promotes waiters on restart', async () => {
    const wsId = randomUUID();
    await pool.query(
      `INSERT INTO workshops (id,name,description,capacity) VALUES ($1,'Crash Recovery','Test',1)`,
      [wsId],
    );

    const holderId = randomUUID();
    await pool.query(
      `INSERT INTO users (id,email,password_hash,name) VALUES ($1,$2,'hash','H')`,
      [holderId, `crash-hold-${TS}@t.local`],
    );
    const expiredAt = new Date(Date.now() - 60_000);
    await pool.query(
      `INSERT INTO reservations (user_id, workshop_id, status, expires_at) VALUES ($1,$2,'HELD',$3)`,
      [holderId, wsId, expiredAt],
    );

    const waiterId = randomUUID();
    await pool.query(
      `INSERT INTO users (id,email,password_hash,name) VALUES ($1,$2,'hash','W')`,
      [waiterId, `crash-wait-${TS}@t.local`],
    );
    await pool.query(
      `INSERT INTO waitlist_entries (user_id, workshop_id, status, position) VALUES ($1,$2,'WAITING',1)`,
      [waiterId, wsId],
    );

    const { sweepExpiredHolds } = await import('../../src/services/expirationService.js');
    const result = await sweepExpiredHolds();

    expect(result.expired).toBeGreaterThanOrEqual(1);
    expect(result.promoted).toBeGreaterThanOrEqual(1);

    const waiterRes = await pool.query(
      `SELECT status FROM reservations WHERE workshop_id=$1 AND user_id=$2`,
      [wsId, waiterId],
    );
    expect(waiterRes.rows[0]?.status).toBe('HELD');
  });
});
