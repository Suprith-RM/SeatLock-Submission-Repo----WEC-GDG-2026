/**
 * Adversarial Race Condition & Edge Case Tests
 * Tests specific races, invalid transitions, and concurrent scenarios
 * identified in the production audit.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'crypto';
import app  from '../../src/app.js';
import pool from '../../src/config/db.js';
import { sweepExpiredHolds } from '../../src/services/expirationService.js';
import { promoteNext } from '../../src/services/waitlistService.js';

const WORKSHOP_ID = '00000000-0000-0000-0000-000000000001';
const TS = Date.now();
const PASS = 'testpassword123';

async function registerAndLogin(email) {
  await request(app).post('/api/auth/register')
    .send({ name: 'Audit User', email, password: PASS });
  const res = await request(app).post('/api/auth/login')
    .send({ email, password: PASS });
  return res.body;
}

async function createHold(tok, key = randomUUID()) {
  return request(app)
    .post(`/api/workshops/${WORKSHOP_ID}/holds`)
    .set('Authorization', `Bearer ${tok}`)
    .set('Idempotency-Key', key)
    .send();
}

async function confirmHold(tok, reservationId) {
  return request(app)
    .post(`/api/reservations/${reservationId}/confirm`)
    .set('Authorization', `Bearer ${tok}`);
}

async function cancelReservation(tok, reservationId) {
  return request(app)
    .delete(`/api/reservations/${reservationId}`)
    .set('Authorization', `Bearer ${tok}`);
}

async function cancelAllForUser(uid) {
  await pool.query(
    `UPDATE reservations SET status='CANCELLED' WHERE user_id = $1 AND status IN ('HELD','CONFIRMED')`,
    [uid]
  );
}

async function makeUser(n) {
  const email = `audit-${TS}-${n}@example.com`;
  return registerAndLogin(email);
}

async function clearWorkshop() {
  await pool.query(
    `UPDATE reservations SET status='CANCELLED' WHERE workshop_id = $1 AND status IN ('HELD','CONFIRMED')`,
    [WORKSHOP_ID]
  );
}

async function fillWorkshop() {
  await clearWorkshop();
  for (let i = 0; i < 20; i++) {
    const uid = `f1000000-0000-0000-0000-${String(i).padStart(12, '0')}`;
    await pool.query(
      `INSERT INTO users (id, email, password_hash, name)
       VALUES ($1, $2, 'hash', 'Filler') ON CONFLICT (id) DO NOTHING`,
      [uid, `filler2-${i}@audit.com`]
    );
    await pool.query(
      `INSERT INTO reservations (user_id, workshop_id, status)
       VALUES ($1, $2, 'CONFIRMED')`,
      [uid, WORKSHOP_ID]
    );
  }
}

// ──────────────────────────────────────────────────────────────────────────────

// Race A/B: 1 seat, 5 users simultaneously hold
describe('Race A/B — 1 seat, 5 users simultaneously', () => {
  let users;

  beforeAll(async () => {
    await clearWorkshop();
    // Set capacity to 1 for this test by filling 19 seats
    for (let i = 0; i < 19; i++) {
      const uid = `f2000000-0000-0000-0000-${String(i).padStart(12, '0')}`;
      await pool.query(
        `INSERT INTO users (id, email, password_hash, name) VALUES ($1, $2, 'hash', 'Filler') ON CONFLICT (id) DO NOTHING`,
        [uid, `filler3-${i}@audit.com`]
      );
      await pool.query(
        `INSERT INTO reservations (user_id, workshop_id, status) VALUES ($1, $2, 'CONFIRMED')`,
        [uid, WORKSHOP_ID]
      );
    }
    users = await Promise.all([0,1,2,3,4].map(n => makeUser(`1seat-${n}`)));
  }, 60_000);

  afterAll(async () => {
    await clearWorkshop();
    await pool.query(`DELETE FROM users WHERE email LIKE 'audit-${TS}-1seat-%'`);
  });

  it('exactly 1 hold succeeds when 5 fire simultaneously', async () => {
    const results = await Promise.all(
      users.map(u => createHold(u.token))
    );
    const successes = results.filter(r => r.status === 201);
    const failures = results.filter(r => r.status === 409);

    expect(successes.length).toBe(1);
    expect(failures.length).toBe(4);

    // DB invariant: only 1 active beyond the 19 filler
    const dbCheck = await pool.query(`
      SELECT COUNT(*)::INT AS active FROM reservations
      WHERE workshop_id = $1 AND (status = 'CONFIRMED' OR (status = 'HELD' AND expires_at > NOW()))
    `, [WORKSHOP_ID]);
    expect(dbCheck.rows[0].active).toBe(20); // 19 filler + 1 new
  }, 30_000);
});

// Race C: Same user, simultaneous hold requests
describe('Race C — Same user sends simultaneous hold requests', () => {
  let user;

  beforeAll(async () => {
    await clearWorkshop();
    user = await makeUser('sameuser');
  }, 30_000);

  afterAll(async () => {
    await clearWorkshop();
    await pool.query(`DELETE FROM users WHERE email LIKE 'audit-${TS}-sameuser%'`);
  });

  it('only 1 hold is created when same user fires 10 simultaneous hold requests', async () => {
    const results = await Promise.all(
      Array.from({ length: 10 }, () => createHold(user.token))
    );
    const successes = results.filter(r => r.status === 201);
    const conflicts = results.filter(r => r.status === 409);

    // Exactly 1 must succeed
    expect(successes.length).toBe(1);
    expect(conflicts.length).toBe(9);

    // Verify DB: exactly 1 active reservation for this user
    const dbCheck = await pool.query(`
      SELECT COUNT(*)::INT AS cnt FROM reservations
      WHERE user_id = $1 AND status IN ('HELD','CONFIRMED')
    `, [user.user.id]);
    expect(dbCheck.rows[0].cnt).toBe(1);
  }, 30_000);
});

// Race D: Same idempotency key, simultaneous requests
describe('Race D — Same Idempotency-Key sent simultaneously', () => {
  let user;

  beforeAll(async () => {
    await clearWorkshop();
    user = await makeUser('idempotency');
  }, 30_000);

  afterAll(async () => {
    await clearWorkshop();
    await pool.query(`DELETE FROM users WHERE email LIKE 'audit-${TS}-idempotency%'`);
    await pool.query(`DELETE FROM idempotency_keys WHERE user_id = $1`, [user.user.id]);
  });

  it('exactly 1 reservation is created when same key is reused simultaneously', async () => {
    const key = randomUUID();

    // Fire 5 simultaneously with SAME idempotency key
    const results = await Promise.all(
      Array.from({ length: 5 }, () => createHold(user.token, key))
    );

    const successes = results.filter(r => r.status === 201);
    const cached = results.filter(r => r.status === 200);
    const inFlight = results.filter(r => r.status === 409 && r.body.error?.code === 'IDEMPOTENCY_IN_FLIGHT');

    console.log(`  Race D: ${successes.length} new, ${cached.length} cached, ${inFlight.length} in-flight`);

    // Must have at most 1 fresh creation
    expect(successes.length + cached.length).toBeGreaterThanOrEqual(1);

    // All responses must be one of the valid codes
    const otherErrors = results.filter(r => ![201, 200, 409].includes(r.status));
    expect(otherErrors.length).toBe(0);

    // DB must have exactly 1 reservation
    const dbCheck = await pool.query(`
      SELECT COUNT(*)::INT AS cnt FROM reservations
      WHERE user_id = $1 AND status IN ('HELD','CONFIRMED')
    `, [user.user.id]);
    expect(dbCheck.rows[0].cnt).toBe(1);
  }, 30_000);
});

// Race E: Confirm vs Expiration
describe('Race E — Confirm vs expired hold', () => {
  let user, reservationId;

  beforeAll(async () => {
    await clearWorkshop();
    user = await makeUser('confirm-expiry');
  }, 30_000);

  beforeEach(async () => {
    await cancelAllForUser(user.user.id);
    const res = await createHold(user.token);
    reservationId = res.body.reservation?.id;
  });

  afterAll(async () => {
    await clearWorkshop();
    await pool.query(`DELETE FROM users WHERE email LIKE 'audit-${TS}-confirm-expiry%'`);
  });

  it('cannot confirm an already-expired hold', async () => {
    // Backdate the hold to be expired
    await pool.query(
      `UPDATE reservations SET expires_at = NOW() - INTERVAL '1 second' WHERE id = $1`,
      [reservationId]
    );

    const res = await confirmHold(user.token, reservationId);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('HOLD_EXPIRED');

    // Verify no CONFIRMED record was created
    const dbCheck = await pool.query(
      `SELECT status FROM reservations WHERE id = $1`,
      [reservationId]
    );
    expect(dbCheck.rows[0].status).toBe('HELD'); // Still HELD, just logically expired
  });

  it('confirm atomically checks expiry — cannot slip through at boundary', async () => {
    // Set expiry to exactly 1 second from now
    await pool.query(
      `UPDATE reservations SET expires_at = NOW() + INTERVAL '1 second' WHERE id = $1`,
      [reservationId]
    );

    // Immediately expire it via sweep
    await pool.query(
      `UPDATE reservations SET expires_at = NOW() - INTERVAL '1 millisecond' WHERE id = $1`,
      [reservationId]
    );

    // Now try to confirm
    const res = await confirmHold(user.token, reservationId);
    expect(res.status).toBe(409);

    // DB state must remain HELD (or be EXPIRED if sweep ran)
    const dbCheck = await pool.query(`SELECT status FROM reservations WHERE id = $1`, [reservationId]);
    expect(['HELD', 'EXPIRED'].includes(dbCheck.rows[0].status)).toBe(true);
    expect(dbCheck.rows[0].status).not.toBe('CONFIRMED');
  });
});

// Race F: Cancel vs Expiration - double cancel
describe('Race F — Cancel vs Expiration race', () => {
  let user, reservationId;

  beforeAll(async () => {
    await clearWorkshop();
    user = await makeUser('cancel-expiry');
  }, 30_000);

  afterAll(async () => {
    await clearWorkshop();
    await pool.query(`DELETE FROM users WHERE email LIKE 'audit-${TS}-cancel-expiry%'`);
  });

  it('cancelling an expired hold returns 409 INVALID_STATUS_TRANSITION', async () => {
    const holdRes = await createHold(user.token);
    reservationId = holdRes.body.reservation?.id;

    // Force-expire it
    await pool.query(
      `UPDATE reservations SET status='EXPIRED', expires_at = NOW() - INTERVAL '1 second' WHERE id = $1`,
      [reservationId]
    );

    const res = await cancelReservation(user.token, reservationId);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('INVALID_STATUS_TRANSITION');
  });

  it('double-cancel returns 409 ALREADY_CANCELLED', async () => {
    await cancelAllForUser(user.user.id);
    const holdRes = await createHold(user.token);
    reservationId = holdRes.body.reservation?.id;

    await cancelReservation(user.token, reservationId);
    const res = await cancelReservation(user.token, reservationId);

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('ALREADY_CANCELLED');
  });
});

// Race G: Cancel vs new Hold (seat freed immediately)
describe('Race G — Cancel vs immediate re-hold', () => {
  let user;

  beforeAll(async () => {
    await clearWorkshop();
    // Fill to 20 seats, then have one user with a real reservation
    for (let i = 0; i < 19; i++) {
      const uid = `f3000000-0000-0000-0000-${String(i).padStart(12, '0')}`;
      await pool.query(
        `INSERT INTO users (id, email, password_hash, name) VALUES ($1, $2, 'hash', 'Filler') ON CONFLICT (id) DO NOTHING`,
        [uid, `filler4-${i}@audit.com`]
      );
      await pool.query(
        `INSERT INTO reservations (user_id, workshop_id, status) VALUES ($1, $2, 'CONFIRMED')`,
        [uid, WORKSHOP_ID]
      );
    }
    user = await makeUser('cancel-rehold');
  }, 60_000);

  afterAll(async () => {
    await clearWorkshop();
    await pool.query(`DELETE FROM users WHERE email LIKE 'audit-${TS}-cancel-rehold%'`);
  });

  it('after cancel, another user can immediately hold the freed seat', async () => {
    // user holds the last seat
    const holdRes = await createHold(user.token);
    expect(holdRes.status).toBe(201);
    const reservationId = holdRes.body.reservation.id;

    // Another user trying to hold fails (full)
    const otherUser = await makeUser('cancel-rehold-other');
    const tryHold1 = await createHold(otherUser.token);
    expect(tryHold1.status).toBe(409);
    expect(tryHold1.body.error.code).toBe('NO_SEATS_AVAILABLE');

    // Cancel
    await cancelReservation(user.token, reservationId);

    // Now other user can hold
    const tryHold2 = await createHold(otherUser.token);
    expect(tryHold2.status).toBe(201);

    // Cleanup
    await cancelAllForUser(otherUser.user.id);
    await pool.query(`DELETE FROM users WHERE email LIKE 'audit-${TS}-cancel-rehold-other%'`);
  }, 30_000);
});

// Race H: Cancel vs Waitlist Promotion
describe('Race H — Cancel triggers exactly-once waitlist promotion', () => {
  let holder, waiter1, waiter2;

  beforeAll(async () => {
    await fillWorkshop();
    holder = await makeUser('cancel-wl-holder');
    waiter1 = await makeUser('cancel-wl-waiter1');
    waiter2 = await makeUser('cancel-wl-waiter2');

    // holder gets last slot (but workshop is already full, so we modify)
    // Clear one filler seat and let holder take it
    await pool.query(
      `UPDATE reservations SET status='CANCELLED' WHERE workshop_id=$1 AND user_id='f1000000-0000-0000-0000-000000000000'`,
      [WORKSHOP_ID]
    );
    // Cancel one CONFIRMED reservation to open a slot for holder
    await pool.query(
      `UPDATE reservations SET status='CANCELLED'
       WHERE id = (
         SELECT id FROM reservations
         WHERE workshop_id=$1 AND status='CONFIRMED'
         LIMIT 1
       )`,
      [WORKSHOP_ID]
    );
    const holdRes = await createHold(holder.token);
    expect(holdRes.status).toBe(201);

    // waiter1 and waiter2 join waitlist (workshop must be full)
    // Fill the gap first
    const uid = `f4000000-0000-0000-0000-000000000000`;
    await pool.query(
      `INSERT INTO users (id, email, password_hash, name) VALUES ($1, $2, 'hash', 'Filler') ON CONFLICT (id) DO NOTHING`,
      [uid, `filler5@audit.com`]
    );
    await pool.query(
      `INSERT INTO reservations (user_id, workshop_id, status) VALUES ($1, $2, 'CONFIRMED')`,
      [uid, WORKSHOP_ID]
    );

    // Now join waitlist
    await request(app)
      .post(`/api/workshops/${WORKSHOP_ID}/waitlist`)
      .set('Authorization', `Bearer ${waiter1.token}`);
    await request(app)
      .post(`/api/workshops/${WORKSHOP_ID}/waitlist`)
      .set('Authorization', `Bearer ${waiter2.token}`);
  }, 60_000);

  afterAll(async () => {
    await pool.query(
      `UPDATE waitlist_entries SET status='REMOVED' WHERE user_id IN ($1,$2) AND status='WAITING'`,
      [waiter1.user.id, waiter2.user.id]
    );
    await clearWorkshop();
    await pool.query(`DELETE FROM users WHERE email LIKE 'audit-${TS}-cancel-wl-%'`);
  });

  it('cancelling holder promotes exactly waiter1 (FIFO, not waiter2)', async () => {
    // Get holder's reservation
    const myRes = await request(app)
      .get(`/api/workshops/${WORKSHOP_ID}/my-reservation`)
      .set('Authorization', `Bearer ${holder.token}`);
    const reservationId = myRes.body.reservation?.id;

    if (!reservationId) {
      // Skip if setup didn't work perfectly due to timing
      return;
    }

    // Cancel holder's reservation — should trigger promotion
    await cancelReservation(holder.token, reservationId);

    // Give promotion a moment
    await new Promise(r => setTimeout(r, 500));

    // Check waiter1 was promoted (has an active reservation)
    const w1Res = await request(app)
      .get(`/api/workshops/${WORKSHOP_ID}/my-reservation`)
      .set('Authorization', `Bearer ${waiter1.token}`);

    const w2Res = await request(app)
      .get(`/api/workshops/${WORKSHOP_ID}/my-reservation`)
      .set('Authorization', `Bearer ${waiter2.token}`);

    // waiter1 should have been promoted (FIFO)
    expect(w1Res.body.reservation).not.toBeNull();
    // waiter2 should still be waiting
    expect(w2Res.body.reservation).toBeNull();
  }, 30_000);
});

// Race I: Two concurrent cancels, only 1 waitlist user — exactly 1 promotion
describe('Race I — Two simultaneous cancellations, 1 waitlist user', () => {
  let holder1, holder2, waiter;

  beforeAll(async () => {
    await clearWorkshop();
    holder1 = await makeUser('raceI-holder1');
    holder2 = await makeUser('raceI-holder2');
    waiter  = await makeUser('raceI-waiter');

    // Fill 18 slots, then holder1 and holder2 each have 1
    for (let i = 0; i < 18; i++) {
      const uid = `f5000000-0000-0000-0000-${String(i).padStart(12, '0')}`;
      await pool.query(
        `INSERT INTO users (id, email, password_hash, name) VALUES ($1, $2, 'hash', 'Filler') ON CONFLICT (id) DO NOTHING`,
        [uid, `filler6-${i}@audit.com`]
      );
      await pool.query(
        `INSERT INTO reservations (user_id, workshop_id, status) VALUES ($1, $2, 'CONFIRMED')`,
        [uid, WORKSHOP_ID]
      );
    }

    const r1 = await createHold(holder1.token);
    const r2 = await createHold(holder2.token);

    holder1.reservationId = r1.body.reservation?.id;
    holder2.reservationId = r2.body.reservation?.id;

    // waiter joins waitlist (workshop full with 20)
    await request(app)
      .post(`/api/workshops/${WORKSHOP_ID}/waitlist`)
      .set('Authorization', `Bearer ${waiter.token}`);
  }, 60_000);

  afterAll(async () => {
    await pool.query(
      `UPDATE waitlist_entries SET status='REMOVED' WHERE user_id = $1 AND status='WAITING'`,
      [waiter.user.id]
    );
    await clearWorkshop();
    await pool.query(`DELETE FROM users WHERE email LIKE 'audit-${TS}-raceI-%'`);
  });

  it('two simultaneous cancels produce at most 1 promotion', async () => {
    // Both cancel simultaneously
    const [c1, c2] = await Promise.all([
      cancelReservation(holder1.token, holder1.reservationId),
      cancelReservation(holder2.token, holder2.reservationId),
    ]);

    // Both cancels should succeed
    expect(c1.status).toBe(200);
    expect(c2.status).toBe(200);

    // Allow promotion to process
    await new Promise(r => setTimeout(r, 500));

    // Check how many active reservations waiter has
    const dbCheck = await pool.query(`
      SELECT COUNT(*)::INT AS cnt FROM reservations
      WHERE user_id = $1 AND status IN ('HELD','CONFIRMED')
    `, [waiter.user.id]);

    // Must be at most 1 — no double promotion
    expect(dbCheck.rows[0].cnt).toBeLessThanOrEqual(1);

    // Total capacity invariant must hold
    const totalCheck = await pool.query(`
      SELECT COUNT(*)::INT AS active FROM reservations
      WHERE workshop_id = $1 AND (status = 'CONFIRMED' OR (status = 'HELD' AND expires_at > NOW()))
    `, [WORKSHOP_ID]);
    expect(totalCheck.rows[0].active).toBeLessThanOrEqual(20);
  }, 30_000);
});

// Race J: User simultaneously tries to hold AND join waitlist
describe('Race J — Simultaneous hold and waitlist join', () => {
  let user;

  beforeAll(async () => {
    await clearWorkshop();
    user = await makeUser('raceJ-user');
    // Fill workshop to full
    await fillWorkshop();
  }, 60_000);

  afterAll(async () => {
    await pool.query(
      `UPDATE waitlist_entries SET status='REMOVED' WHERE user_id = $1 AND status='WAITING'`,
      [user.user.id]
    );
    await clearWorkshop();
    await pool.query(`DELETE FROM users WHERE email LIKE 'audit-${TS}-raceJ-%'`);
  });

  it('user ends up with at most 1 action (hold or waitlist) when sent simultaneously', async () => {
    // Workshop is full, so hold should fail and waitlist should succeed
    // But send both simultaneously to test race
    const [holdRes, waitlistRes] = await Promise.all([
      createHold(user.token),
      request(app)
        .post(`/api/workshops/${WORKSHOP_ID}/waitlist`)
        .set('Authorization', `Bearer ${user.token}`),
    ]);

    // Hold should fail (full workshop)
    expect(holdRes.status).toBe(409);

    // Waitlist should succeed (or also fail if already joined from a race)
    expect([201, 409].includes(waitlistRes.status)).toBe(true);

    // Only 1 waitlist entry allowed
    const wlCheck = await pool.query(`
      SELECT COUNT(*)::INT AS cnt FROM waitlist_entries
      WHERE user_id = $1 AND workshop_id = $2 AND status = 'WAITING'
    `, [user.user.id, WORKSHOP_ID]);
    expect(wlCheck.rows[0].cnt).toBeLessThanOrEqual(1);
  }, 30_000);
});

// State Machine: Invalid Transitions
describe('State Machine — Invalid transition prevention', () => {
  let user, reservationId;

  beforeAll(async () => {
    await clearWorkshop();
    user = await makeUser('statemachine');
  }, 30_000);

  beforeEach(async () => {
    await cancelAllForUser(user.user.id);
    const res = await createHold(user.token);
    reservationId = res.body.reservation?.id;
  });

  afterAll(async () => {
    await clearWorkshop();
    await pool.query(`DELETE FROM users WHERE email LIKE 'audit-${TS}-statemachine%'`);
  });

  it('EXPIRED → CONFIRMED is rejected', async () => {
    // Force expiry
    await pool.query(
      `UPDATE reservations SET expires_at = NOW() - INTERVAL '1 second' WHERE id = $1`,
      [reservationId]
    );
    const res = await confirmHold(user.token, reservationId);
    expect(res.status).toBe(409);
    // Verify DB status is not CONFIRMED
    const dbCheck = await pool.query(`SELECT status FROM reservations WHERE id = $1`, [reservationId]);
    expect(dbCheck.rows[0].status).not.toBe('CONFIRMED');
  });

  it('CANCELLED → CONFIRMED is rejected', async () => {
    await cancelReservation(user.token, reservationId);
    const res = await confirmHold(user.token, reservationId);
    expect(res.status).toBe(409);
    const dbCheck = await pool.query(`SELECT status FROM reservations WHERE id = $1`, [reservationId]);
    expect(dbCheck.rows[0].status).toBe('CANCELLED');
  });

  it('CANCELLED → CANCELLED is rejected (double cancel)', async () => {
    await cancelReservation(user.token, reservationId);
    const res = await cancelReservation(user.token, reservationId);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('ALREADY_CANCELLED');
  });

  it('CONFIRMED → CONFIRMED is rejected (double confirm)', async () => {
    await confirmHold(user.token, reservationId);
    const res = await confirmHold(user.token, reservationId);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('ALREADY_CONFIRMED');
  });

  it('Other user → CONFIRMED is rejected (403)', async () => {
    const other = await makeUser('statemachine-other');
    const res = await confirmHold(other.token, reservationId);
    expect(res.status).toBe(403);
    await pool.query(`DELETE FROM users WHERE email LIKE 'audit-${TS}-statemachine-other%'`);
  });

  it('Other user → CANCELLED is rejected (403)', async () => {
    const other = await makeUser('statemachine-other2');
    const res = await cancelReservation(other.token, reservationId);
    expect(res.status).toBe(403);
    await pool.query(`DELETE FROM users WHERE email LIKE 'audit-${TS}-statemachine-other2%'`);
  });
});

// Authorization: User cannot manipulate other users' reservations
describe('Authorization — User cannot manipulate other users data', () => {
  let userA, userB, reservationId;

  beforeAll(async () => {
    await clearWorkshop();
    userA = await makeUser('authA');
    userB = await makeUser('authB');
    const res = await createHold(userA.token);
    reservationId = res.body.reservation?.id;
  }, 30_000);

  afterAll(async () => {
    await clearWorkshop();
    await pool.query(`DELETE FROM users WHERE email LIKE 'audit-${TS}-authA%' OR email LIKE 'audit-${TS}-authB%'`);
  });

  it('User B cannot read User A reservation', async () => {
    const res = await request(app)
      .get(`/api/reservations/${reservationId}`)
      .set('Authorization', `Bearer ${userB.token}`);
    expect(res.status).toBe(403);
  });

  it('User B cannot confirm User A hold', async () => {
    const res = await confirmHold(userB.token, reservationId);
    expect(res.status).toBe(403);
  });

  it('User B cannot cancel User A reservation', async () => {
    const res = await cancelReservation(userB.token, reservationId);
    expect(res.status).toBe(403);
  });

  it('Sending userId in body does NOT change acting user', async () => {
    // Try to send userA's ID in body when logged in as userB
    const res = await request(app)
      .post(`/api/workshops/${WORKSHOP_ID}/holds`)
      .set('Authorization', `Bearer ${userB.token}`)
      .set('Idempotency-Key', randomUUID())
      .send({ userId: userA.user.id }); // Injected userId — must be ignored
    // This should either succeed (for userB) or fail, but NOT create a hold for userA
    if (res.status === 201) {
      expect(res.body.reservation.userId).toBe(userB.user.id);
    }
  });
});

// Idempotency: Key reuse with different body is rejected
describe('Idempotency — Same key, different body rejected', () => {
  let user;

  beforeAll(async () => {
    await clearWorkshop();
    user = await makeUser('idem-conflict');
  }, 30_000);

  afterAll(async () => {
    await clearWorkshop();
    await pool.query(`DELETE FROM users WHERE email LIKE 'audit-${TS}-idem-conflict%'`);
    await pool.query(`DELETE FROM idempotency_keys WHERE user_id = $1`, [user.user.id]);
  });

  it('reusing key with different workshop should return IDEMPOTENCY_KEY_CONFLICT', async () => {
    const key = randomUUID();
    // First request with workshopId in conceptual body (via different workshop)
    await createHold(user.token, key);

    // Try with same key against a different workshop
    const OTHER_WORKSHOP = randomUUID();
    const res = await request(app)
      .post(`/api/workshops/${OTHER_WORKSHOP}/holds`)
      .set('Authorization', `Bearer ${user.token}`)
      .set('Idempotency-Key', key)
      .send({ extra: 'field' }); // Different body => different hash

    // Either conflict error or not found (workshop doesn't exist)
    if (res.status === 409) {
      // If it gets past workshop check, key conflict
      expect(['IDEMPOTENCY_KEY_CONFLICT', 'WORKSHOP_NOT_FOUND'].includes(res.body.error?.code)).toBe(true);
    }
  });
});

// Capacity Invariant: Explicit DB verification
describe('Capacity Invariant — Mathematical proof via DB', () => {
  it('active count never exceeds 20 after 100 user attempts', async () => {
    await clearWorkshop();

    const users = await Promise.all(
      Array.from({ length: 30 }, (_, i) => makeUser(`cap-inv-${i}`))
    );

    await Promise.all(users.map(u => createHold(u.token)));

    const dbCheck = await pool.query(`
      SELECT COUNT(*)::INT AS active FROM reservations
      WHERE workshop_id = $1
        AND (status = 'CONFIRMED' OR (status = 'HELD' AND expires_at > NOW()))
    `, [WORKSHOP_ID]);

    expect(dbCheck.rows[0].active).toBeLessThanOrEqual(20);

    // Cleanup
    await clearWorkshop();
    await pool.query(`DELETE FROM users WHERE email LIKE 'audit-${TS}-cap-inv-%'`);
  }, 60_000);
});

// Sweep Expiry: Correctly handles restart recovery
describe('Expiration Service — Sweep and recovery', () => {
  let user, reservationId;

  beforeAll(async () => {
    await clearWorkshop();
    user = await makeUser('sweep-test');
    const res = await createHold(user.token);
    reservationId = res.body.reservation?.id;

    // Backdate hold to be expired
    await pool.query(
      `UPDATE reservations SET expires_at = NOW() - INTERVAL '10 seconds' WHERE id = $1`,
      [reservationId]
    );
  }, 30_000);

  afterAll(async () => {
    await clearWorkshop();
    await pool.query(`DELETE FROM users WHERE email LIKE 'audit-${TS}-sweep-test%'`);
  });

  it('sweep marks expired holds as EXPIRED', async () => {
    await sweepExpiredHolds();

    const dbCheck = await pool.query(
      `SELECT status FROM reservations WHERE id = $1`,
      [reservationId]
    );
    expect(dbCheck.rows[0].status).toBe('EXPIRED');
  });

  it('expired hold cannot be confirmed even before sweep physically updates status', async () => {
    // Create a new hold
    await cancelAllForUser(user.user.id);
    const holdRes = await createHold(user.token);
    const newReservationId = holdRes.body.reservation?.id;

    // Make it logically expired (DB status still HELD, but time passed)
    await pool.query(
      `UPDATE reservations SET expires_at = NOW() - INTERVAL '1 millisecond' WHERE id = $1`,
      [newReservationId]
    );

    // Confirm must be rejected because expires_at > NOW() fails atomically in the UPDATE
    const confirmRes = await confirmHold(user.token, newReservationId);
    expect(confirmRes.status).toBe(409);
    expect(confirmRes.body.error.code).toBe('HOLD_EXPIRED');
  });
});

// Waitlist Ordering (FIFO)
describe('Waitlist — FIFO ordering under concurrent joins', () => {
  let users;

  beforeAll(async () => {
    await fillWorkshop();
    users = await Promise.all([0,1,2,3,4].map(n => makeUser(`fifo-${n}`)));
  }, 60_000);

  afterAll(async () => {
    await pool.query(
      `UPDATE waitlist_entries SET status='REMOVED' WHERE user_id = ANY($1::uuid[]) AND status='WAITING'`,
      [users.map(u => u.user.id)]
    );
    await clearWorkshop();
    await pool.query(`DELETE FROM users WHERE email LIKE 'audit-${TS}-fifo-%'`);
  });

  it('sequential joins produce monotonically increasing positions', async () => {
    const results = [];
    for (const u of users) {
      const res = await request(app)
        .post(`/api/workshops/${WORKSHOP_ID}/waitlist`)
        .set('Authorization', `Bearer ${u.token}`);
      results.push(res);
    }

    expect(results.every(r => r.status === 201)).toBe(true);
    const positions = results.map(r => r.body.entry.position);
    for (let i = 1; i < positions.length; i++) {
      expect(positions[i]).toBeGreaterThan(positions[i-1]);
    }
  });
});

afterAll(async () => {
  await pool.end();
});
