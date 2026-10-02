/**
 * Concurrency test verifying overbooking prevention under simultaneous hold requests.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'crypto';
import app  from '../../src/app.js';
import pool from '../../src/config/db.js';

const WORKSHOP_ID  = '00000000-0000-0000-0000-000000000001';
const NUM_USERS    = 25;
const WORKSHOP_CAP = 20;

let users = [];

async function makeUser(n) {
  const email = `conc-${Date.now()}-${n}@example.com`;
  await request(app).post('/api/auth/register')
    .send({ name: `Concurrency User ${n}`, email, password: 'testpassword123' });
  const login = await request(app).post('/api/auth/login')
    .send({ email, password: 'testpassword123' });
  return { email, token: login.body.token };
}

beforeAll(async () => {
  // Clear all reservations for this workshop so we start from a clean state
  await pool.query(
    `UPDATE reservations SET status = 'CANCELLED'
     WHERE workshop_id = $1 AND status IN ('HELD', 'CONFIRMED')`,
    [WORKSHOP_ID]
  );

  // Create all test users in parallel (setup, not the test itself)
  users = await Promise.all(
    Array.from({ length: NUM_USERS }, (_, i) => makeUser(i))
  );
}, 120_000);

afterAll(async () => {
  await pool.query(
    `UPDATE reservations SET status = 'CANCELLED'
     WHERE workshop_id = $1 AND status IN ('HELD', 'CONFIRMED')`,
    [WORKSHOP_ID]
  );
  await pool.query(`DELETE FROM users WHERE email LIKE 'conc-%@example.com'`);
  await pool.end();
});

describe('SELECT FOR UPDATE — overbooking prevention', () => {
  it(
    `${NUM_USERS} simultaneous hold requests — at most ${WORKSHOP_CAP} succeed`,
    async () => {
      // Fire all requests at exactly the same time
      const results = await Promise.all(
        users.map(u =>
          request(app)
            .post(`/api/workshops/${WORKSHOP_ID}/holds`)
            .set('Authorization', `Bearer ${u.token}`)
            .set('Idempotency-Key', randomUUID())
            .send()
        )
      );

      const successes     = results.filter(r => r.status === 201);
      const noSeats       = results.filter(r => r.status === 409 && r.body.error?.code === 'NO_SEATS_AVAILABLE');
      const alreadyHasRes = results.filter(r => r.status === 409 && r.body.error?.code === 'ALREADY_HAS_RESERVATION');
      const otherErrors   = results.filter(r => ![201, 409].includes(r.status));

      console.log(`\n  ✅ Holds created:          ${successes.length}`);
      console.log(`  ❌ NO_SEATS_AVAILABLE:     ${noSeats.length}`);
      console.log(`  ⚠️  ALREADY_HAS_RESERVATION: ${alreadyHasRes.length}`);
      console.log(`  💥 Other errors:           ${otherErrors.length}\n`);

      // Each user is unique → no ALREADY_HAS_RESERVATION expected
      expect(alreadyHasRes.length).toBe(0);

      // No unexpected errors
      expect(otherErrors.length).toBe(0);

      // All requests must resolve to either success or NO_SEATS_AVAILABLE
      expect(successes.length + noSeats.length).toBe(NUM_USERS);

      // CRITICAL: Total successes MUST NOT exceed workshop capacity
      expect(successes.length).toBeLessThanOrEqual(WORKSHOP_CAP);

      // CRITICAL: Verify in the database — active count must not exceed capacity
      const dbCheck = await pool.query(`
        SELECT
          w.capacity::INT,
          COUNT(r.id) FILTER (
            WHERE r.status = 'CONFIRMED'
               OR (r.status = 'HELD' AND r.expires_at > NOW())
          )::INT AS active
        FROM workshops w
        LEFT JOIN reservations r ON r.workshop_id = w.id
        WHERE w.id = $1
        GROUP BY w.capacity
      `, [WORKSHOP_ID]);

      const { capacity, active } = dbCheck.rows[0];
      expect(active).toBeLessThanOrEqual(capacity);

      console.log(`  DB verification: ${active} active / ${capacity} capacity — SAFE ✅`);
    },
    60_000
  );
});
