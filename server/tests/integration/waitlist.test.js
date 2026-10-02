/**
 * Integration tests for the waitlist API.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'crypto';
import app  from '../../src/app.js';
import pool from '../../src/config/db.js';

const WORKSHOP_ID = '00000000-0000-0000-0000-000000000001';
const TS     = Date.now();
const EMAIL  = `wl-${TS}@example.com`;
const EMAIL2 = `wl2-${TS}@example.com`;
const PASS   = 'testpassword123';

let token, userId;
let token2, userId2;

async function registerAndLogin(email, pass = PASS) {
  await request(app).post('/api/auth/register')
    .send({ name: 'WL User', email, password: pass });
  const res = await request(app).post('/api/auth/login')
    .send({ email, password: pass });
  return res.body;
}

/** Directly insert 20 CONFIRMED reservations using synthetic filler user UUIDs. */
async function fillWorkshop() {
  await pool.query(
    `UPDATE reservations SET status='CANCELLED'
     WHERE workshop_id=$1 AND status IN ('HELD','CONFIRMED')`,
    [WORKSHOP_ID]
  );
  for (let i = 0; i < 20; i++) {
    const uid = `f0000000-0000-0000-0000-${String(i).padStart(12, '0')}`;
    await pool.query(
      `INSERT INTO users (id, email, password_hash, name)
       VALUES ($1, $2, 'hash', 'Filler')
       ON CONFLICT (id) DO NOTHING`,
      [uid, `filler-${i}@wl.com`]
    );
    await pool.query(
      `INSERT INTO reservations (user_id, workshop_id, status)
       VALUES ($1, $2, 'CONFIRMED')`,
      [uid, WORKSHOP_ID]
    );
  }
}

/** Clear workshop reservations and all test waitlist entries. */
async function cleanupWorkshop() {
  await pool.query(
    `UPDATE reservations SET status='CANCELLED'
     WHERE workshop_id=$1 AND status IN ('HELD','CONFIRMED')`,
    [WORKSHOP_ID]
  );
  await pool.query(
    `UPDATE waitlist_entries SET status='REMOVED'
     WHERE user_id IN ($1,$2) AND status='WAITING'`,
    [userId, userId2]
  );
}

/** Clean only test waitlist entries, preserving workshop reservations */
async function cleanupWaitlist() {
  await pool.query(
    `UPDATE waitlist_entries SET status='REMOVED'
     WHERE user_id IN ($1,$2) AND status='WAITING'`,
    [userId, userId2]
  );
}

beforeAll(async () => {
  const a1 = await registerAndLogin(EMAIL);
  token = a1.token; userId = a1.user.id;
  const a2 = await registerAndLogin(EMAIL2);
  token2 = a2.token; userId2 = a2.user.id;
}, 60_000);

afterAll(async () => {
  await cleanupWorkshop();
  await pool.query(`DELETE FROM users WHERE email LIKE 'wl-%@example.com'`);
  await pool.query(`DELETE FROM users WHERE email LIKE 'filler-%@wl.com'`);
  await pool.end();
});

// ── Tests: seats available ────────────────────────────────────────────────────

describe('POST /api/workshops/:id/waitlist — seats available', () => {
  beforeEach(cleanupWorkshop);

  it('returns 409 SEATS_AVAILABLE_USE_HOLD when seats are available', async () => {
    // Workshop has 20 seats and is not full — direct hold is required
    const res = await request(app)
      .post(`/api/workshops/${WORKSHOP_ID}/waitlist`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('SEATS_AVAILABLE_USE_HOLD');
  });

  it('returns 401 without auth', async () => {
    const res = await request(app).post(`/api/workshops/${WORKSHOP_ID}/waitlist`);
    expect(res.status).toBe(401);
  });
});

// ── Tests: workshop full ──────────────────────────────────────────────────────

describe('Waitlist — full workshop scenario', () => {
  beforeAll(fillWorkshop, 30_000);
  beforeEach(cleanupWaitlist);

  it('joins waitlist when workshop is full', async () => {
    const res = await request(app)
      .post(`/api/workshops/${WORKSHOP_ID}/waitlist`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(201);
    expect(res.body.entry.status).toBe('WAITING');
    expect(res.body.entry.position).toBeGreaterThan(0);
  });

  it('returns 409 ALREADY_ON_WAITLIST on duplicate join', async () => {
    await request(app)
      .post(`/api/workshops/${WORKSHOP_ID}/waitlist`)
      .set('Authorization', `Bearer ${token}`);

    const res = await request(app)
      .post(`/api/workshops/${WORKSHOP_ID}/waitlist`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('ALREADY_ON_WAITLIST');
  });

  it('two users get consecutive positions (FIFO)', async () => {
    const r1 = await request(app)
      .post(`/api/workshops/${WORKSHOP_ID}/waitlist`)
      .set('Authorization', `Bearer ${token}`);
    const r2 = await request(app)
      .post(`/api/workshops/${WORKSHOP_ID}/waitlist`)
      .set('Authorization', `Bearer ${token2}`);

    expect(r1.status).toBe(201);
    expect(r2.status).toBe(201);
    expect(r2.body.entry.position).toBeGreaterThan(r1.body.entry.position);
  });

  it('GET /waitlist/position returns correct rank', async () => {
    await request(app)
      .post(`/api/workshops/${WORKSHOP_ID}/waitlist`)
      .set('Authorization', `Bearer ${token}`);
    await request(app)
      .post(`/api/workshops/${WORKSHOP_ID}/waitlist`)
      .set('Authorization', `Bearer ${token2}`);

    const r1 = await request(app)
      .get(`/api/workshops/${WORKSHOP_ID}/waitlist/position`)
      .set('Authorization', `Bearer ${token}`);
    const r2 = await request(app)
      .get(`/api/workshops/${WORKSHOP_ID}/waitlist/position`)
      .set('Authorization', `Bearer ${token2}`);

    expect(r1.status).toBe(200);
    expect(r1.body.position).toBe(1);
    expect(r2.body.position).toBe(2);
    expect(r2.body.totalWaiting).toBe(2);
  });

  it('DELETE /waitlist removes the user', async () => {
    await request(app)
      .post(`/api/workshops/${WORKSHOP_ID}/waitlist`)
      .set('Authorization', `Bearer ${token}`);

    const leave = await request(app)
      .delete(`/api/workshops/${WORKSHOP_ID}/waitlist`)
      .set('Authorization', `Bearer ${token}`);

    expect(leave.status).toBe(200);
    expect(leave.body.entry.status).toBe('REMOVED');
  });

  it('GET /waitlist/position returns 404 after leaving', async () => {
    await request(app)
      .post(`/api/workshops/${WORKSHOP_ID}/waitlist`)
      .set('Authorization', `Bearer ${token}`);
    await request(app)
      .delete(`/api/workshops/${WORKSHOP_ID}/waitlist`)
      .set('Authorization', `Bearer ${token}`);

    const pos = await request(app)
      .get(`/api/workshops/${WORKSHOP_ID}/waitlist/position`)
      .set('Authorization', `Bearer ${token}`);

    expect(pos.status).toBe(404);
    expect(pos.body.error.code).toBe('NOT_ON_WAITLIST');
  });

  it('DELETE /waitlist returns 404 when not on waitlist', async () => {
    const res = await request(app)
      .delete(`/api/workshops/${WORKSHOP_ID}/waitlist`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_ON_WAITLIST');
  });
});
