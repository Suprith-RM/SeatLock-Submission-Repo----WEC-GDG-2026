/**
 * Issue 1 integration tests: Waitlist and active reservation conflicts.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request    from 'supertest';
import { randomUUID } from 'crypto';
import app  from '../../src/app.js';
import pool, { getClient } from '../../src/config/db.js';

const WORKSHOP_ID = '00000000-0000-0000-0000-000000000001';
const TS = Date.now();

async function registerLogin(suffix) {
  const email = `i1-${Date.now()}-${randomUUID().slice(0, 8)}-${suffix}@test.local`;
  await request(app).post('/api/auth/register')
    .send({ name: `I1 ${suffix}`, email, password: 'testpassword123' });
  const res = await request(app).post('/api/auth/login')
    .send({ email, password: 'testpassword123' });
  return { token: res.body.token, user: res.body.user, userId: res.body.user.id };
}

async function fillWorkshop() {
  await pool.query(
    `UPDATE reservations SET status='CANCELLED' WHERE workshop_id=$1 AND status IN ('HELD','CONFIRMED')`,
    [WORKSHOP_ID],
  );
  for (let i = 0; i < 20; i++) {
    const uid = `f0000000-0000-0000-1111-${String(i).padStart(12,'0')}`;
    await pool.query(
      `INSERT INTO users (id, email, password_hash, name) VALUES ($1,$2,'hash','F') ON CONFLICT (id) DO NOTHING`,
      [uid, `fill-${TS}-${i}@t.local`],
    );
    await pool.query(
      `INSERT INTO reservations (user_id, workshop_id, status) VALUES ($1,$2,'CONFIRMED')`,
      [uid, WORKSHOP_ID],
    );
  }
}

async function clearWorkshop() {
  await pool.query(
    `UPDATE reservations SET status='CANCELLED' WHERE workshop_id=$1 AND status IN ('HELD','CONFIRMED')`,
    [WORKSHOP_ID],
  );
  await pool.query(
    `UPDATE waitlist_entries SET status='REMOVED' WHERE workshop_id=$1 AND status='WAITING'`,
    [WORKSHOP_ID],
  );
}

describe('Issue 1 — Waitlist + Hold Conflict', () => {
  let userA;

  beforeAll(async () => {
    userA = await registerLogin('A');
    await fillWorkshop();
  }, 30_000);

  afterAll(async () => {
    await clearWorkshop();
    await pool.query(`DELETE FROM users WHERE email LIKE 'i1-%'`);
    await pool.query(`DELETE FROM users WHERE email LIKE 'fill-${TS}%'`);
  });

  beforeEach(async () => {
    await clearWorkshop();
    await fillWorkshop();
    await pool.query(
      `DELETE FROM idempotency_keys WHERE user_id = $1`,
      [userA.userId],
    );
  });

  it('TEST 1 — user on waitlist cannot create a direct hold', async () => {
    const joinRes = await request(app)
      .post(`/api/workshops/${WORKSHOP_ID}/waitlist`)
      .set('Authorization', `Bearer ${userA.token}`)
      .set('Idempotency-Key', randomUUID());
    expect(joinRes.status).toBe(201);

    const holdRes = await request(app)
      .post(`/api/workshops/${WORKSHOP_ID}/holds`)
      .set('Authorization', `Bearer ${userA.token}`)
      .set('Idempotency-Key', randomUUID());
    expect(holdRes.status).toBe(409);
    expect(holdRes.body.error.code).toBe('ON_WAITLIST_CANNOT_HOLD');

    const check = await pool.query(`
      SELECT
        (SELECT COUNT(*)::INT FROM waitlist_entries WHERE workshop_id=$1 AND user_id=$2 AND status='WAITING') AS waiting,
        (SELECT COUNT(*)::INT FROM reservations WHERE workshop_id=$1 AND user_id=$2 AND status='HELD') AS held
    `, [WORKSHOP_ID, userA.userId]);
    expect(check.rows[0].waiting).toBe(1);
    expect(check.rows[0].held).toBe(0);
  });

  it('TEST 2 — concurrent waitlist-join + hold attempt never yields WAITING + HELD', async () => {
    const [joinRes, holdRes] = await Promise.all([
      request(app)
        .post(`/api/workshops/${WORKSHOP_ID}/waitlist`)
        .set('Authorization', `Bearer ${userA.token}`)
        .set('Idempotency-Key', randomUUID()),
      request(app)
        .post(`/api/workshops/${WORKSHOP_ID}/holds`)
        .set('Authorization', `Bearer ${userA.token}`)
        .set('Idempotency-Key', randomUUID()),
    ]);

    const state = await pool.query(`
      SELECT
        (SELECT COUNT(*)::INT FROM waitlist_entries WHERE workshop_id=$1 AND user_id=$2 AND status='WAITING') AS waiting,
        (SELECT COUNT(*)::INT FROM reservations WHERE workshop_id=$1 AND user_id=$2 AND status='HELD') AS held
    `, [WORKSHOP_ID, userA.userId]);

    const bothActive = state.rows[0].waiting === 1 && state.rows[0].held === 1;
    expect(bothActive).toBe(false);
  });

  it('TEST 3 — promotion skips ineligible (already-reserved) head-of-queue, promotes User B', async () => {
    const userB = await registerLogin('B');
    const userAId = userA.userId;
    const userBId = userB.userId;

    await pool.query(
      `INSERT INTO waitlist_entries (user_id, workshop_id, status, position) VALUES ($1,$2,'WAITING',1)`,
      [userAId, WORKSHOP_ID],
    );
    await pool.query(
      `INSERT INTO waitlist_entries (user_id, workshop_id, status, position) VALUES ($1,$2,'WAITING',2)`,
      [userBId, WORKSHOP_ID],
    );

    const fillerA = await pool.query(
      `SELECT id FROM reservations WHERE workshop_id=$1 AND status='CONFIRMED' LIMIT 1`,
      [WORKSHOP_ID],
    );
    await pool.query(
      `UPDATE reservations SET user_id = $1 WHERE id = $2`,
      [userAId, fillerA.rows[0].id],
    );

    const fillerB = await pool.query(
      `SELECT id FROM reservations WHERE workshop_id=$1 AND status='CONFIRMED' AND user_id != $2 LIMIT 1`,
      [WORKSHOP_ID, userAId],
    );
    await pool.query(
      `UPDATE reservations SET status='CANCELLED' WHERE id=$1`,
      [fillerB.rows[0].id],
    );

    const { promoteEligibleWaiters } = await import('../../src/services/waitlistService.js');
    const client = await getClient();
    try {
      await client.query('BEGIN');
      await client.query('SELECT id FROM workshops WHERE id=$1 FOR UPDATE', [WORKSHOP_ID]);
      const promoted = await promoteEligibleWaiters(WORKSHOP_ID, client);
      await client.query('COMMIT');
      expect(promoted).toBe(1);
    } finally {
      client.release();
    }

    const aEntry = await pool.query(
      `SELECT status FROM waitlist_entries WHERE workshop_id=$1 AND user_id=$2 ORDER BY created_at DESC LIMIT 1`,
      [WORKSHOP_ID, userAId],
    );
    expect(aEntry.rows[0].status).toBe('REMOVED');

    const bEntry = await pool.query(
      `SELECT status FROM waitlist_entries WHERE workshop_id=$1 AND user_id=$2`,
      [WORKSHOP_ID, userBId],
    );
    expect(bEntry.rows[0].status).toBe('PROMOTED');

    const bRes = await pool.query(
      `SELECT status FROM reservations WHERE workshop_id=$1 AND user_id=$2 AND status='HELD'`,
      [WORKSHOP_ID, userBId],
    );
    expect(bRes.rows.length).toBe(1);
  });
});
