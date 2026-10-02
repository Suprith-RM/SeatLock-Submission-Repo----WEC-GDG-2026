/**
 * Issue 4 concurrency test: 100+ simultaneous reservation attempts.
 */
import { describe, it, expect, afterAll } from 'vitest';
import request    from 'supertest';
import jwt        from 'jsonwebtoken';
import { randomUUID } from 'crypto';
import app  from '../../src/app.js';
import pool from '../../src/config/db.js';

const TS = Date.now();
const JWT_SECRET = process.env.JWT_SECRET || 'test-secret-that-is-at-least-32-chars-long!';

async function createUsers(n) {
  const users = [];
  for (let i = 0; i < n; i++) {
    const id    = randomUUID();
    const email = `hu-${randomUUID()}@stress.local`;
    await pool.query(
      `INSERT INTO users (id, email, password_hash, name) VALUES ($1, $2, $3, $4)`,
      [id, email, '$2a$04$placeholder', `StressUser ${i}`],
    );
    const token = jwt.sign({ sub: id, email, name: `StressUser ${i}` }, JWT_SECRET, { expiresIn: '1h' });
    users.push({ id, email, token });
  }
  return users;
}

async function createWorkshop(capacity) {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO workshops (id, name, description, capacity) VALUES ($1, $2, $3, $4)`,
    [id, `Stress ${capacity}`, 'Load test workshop', capacity],
  );
  return id;
}

async function verifyInvariants(workshopId, capacity) {
  const total = await pool.query(`
    SELECT COUNT(*)::INT AS c
    FROM   reservations
    WHERE  workshop_id = $1 AND status IN ('HELD','CONFIRMED')
  `, [workshopId]);
  expect(total.rows[0].c).toBeLessThanOrEqual(capacity);

  const dups = await pool.query(`
    SELECT user_id, COUNT(*)::INT AS cnt
    FROM   reservations
    WHERE  workshop_id = $1 AND status IN ('HELD','CONFIRMED')
    GROUP  BY user_id
    HAVING COUNT(*) > 1
  `, [workshopId]);
  expect(dups.rows.length).toBe(0);

  return total.rows[0].c;
}

describe('Issue 4 — 100+ Concurrent Reservation Attempts', () => {
  afterAll(async () => {
    await pool.query(`DELETE FROM users WHERE email LIKE 'hu-${TS}%'`);
  });

  it('A) 100 unique users, 20-seat workshop: active <= 20, no double-booking', async () => {
    const CAPACITY = 20;
    const N_USERS  = 100;

    const users = await createUsers(N_USERS);
    const wsId  = await createWorkshop(CAPACITY);

    const results = await Promise.all(
      users.map(u =>
        request(app)
          .post(`/api/workshops/${wsId}/holds`)
          .set('Authorization', `Bearer ${u.token}`)
          .set('Idempotency-Key', randomUUID()),
      ),
    );

    const successes = results.filter(r => r.status === 201);
    const errors    = results.filter(r => r.status >= 500);

    expect(errors.length).toBe(0);
    expect(successes.length).toBeLessThanOrEqual(CAPACITY);

    const dbActive = await verifyInvariants(wsId, CAPACITY);
    expect(successes.length).toBe(dbActive);
  }, 120_000);

  it('B) 100 unique users, 1-seat workshop: exactly 1 active reservation', async () => {
    const N_USERS = 100;
    const users   = await createUsers(N_USERS);
    const wsId    = await createWorkshop(1);

    const results = await Promise.all(
      users.map(u =>
        request(app)
          .post(`/api/workshops/${wsId}/holds`)
          .set('Authorization', `Bearer ${u.token}`)
          .set('Idempotency-Key', randomUUID()),
      ),
    );

    const successes = results.filter(r => r.status === 201);
    const errors    = results.filter(r => r.status >= 500);

    expect(errors.length).toBe(0);

    const dbActive = await verifyInvariants(wsId, 1);
    expect(dbActive).toBe(1);
    expect(successes.length).toBe(1);
  }, 120_000);

  it('C) 1 user, 100 concurrent requests: at most 1 active reservation', async () => {
    const [user] = await createUsers(1);
    const wsId   = await createWorkshop(20);

    const results = await Promise.all(
      Array.from({ length: 100 }).map(() =>
        request(app)
          .post(`/api/workshops/${wsId}/holds`)
          .set('Authorization', `Bearer ${user.token}`)
          .set('Idempotency-Key', randomUUID()),
      ),
    );

    const errors = results.filter(r => r.status >= 500);
    expect(errors.length).toBe(0);

    const dbActive = await pool.query(`
      SELECT COUNT(*)::INT AS c
      FROM   reservations
      WHERE  workshop_id = $1 AND user_id = $2 AND status IN ('HELD','CONFIRMED')
    `, [wsId, user.id]);
    expect(dbActive.rows[0].c).toBeLessThanOrEqual(1);
  }, 120_000);

  it('D) Repeatable: second run of 100-user / 20-seat test still holds invariant', async () => {
    const users = await createUsers(100);
    const wsId  = await createWorkshop(20);

    const results = await Promise.all(
      users.map(u =>
        request(app)
          .post(`/api/workshops/${wsId}/holds`)
          .set('Authorization', `Bearer ${u.token}`)
          .set('Idempotency-Key', randomUUID()),
      ),
    );

    const errors = results.filter(r => r.status >= 500);
    expect(errors.length).toBe(0);

    const dbActive = await verifyInvariants(wsId, 20);
    expect(dbActive).toBeLessThanOrEqual(20);
  }, 120_000);
});
