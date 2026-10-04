# SeatLock — Concurrency Strategy

## The Problem

With 100 concurrent users trying to book 20 seats, naive implementations fail:

```
Thread A: SELECT count(*) → 19 taken (1 free) ┐
Thread B: SELECT count(*) → 19 taken (1 free) ┘ Both see a free seat
Thread A: INSERT reservation ← succeeds → 20 taken
Thread B: INSERT reservation ← succeeds → 21 taken  ← OVERBOOKING
```

---

## The Serialization Point

SeatLock uses the **workshop row** as the single serialization point for all
capacity-affecting operations:

```sql
SELECT id, capacity FROM workshops WHERE id = $1 FOR UPDATE;
```

`FOR UPDATE` places an **exclusive row lock** on the workshop row. Any other
transaction trying to lock the same row will **block** until the first
transaction commits or rolls back.

```
Thread A: FOR UPDATE on workshop row ← acquires lock
Thread B: FOR UPDATE on workshop row ← BLOCKS (waits)
Thread A: Check capacity → 1 seat free → INSERT reservation → COMMIT
Thread B: FOR UPDATE ← lock released, acquired
Thread B: Check capacity → 0 seats free → throw NO_SEATS_AVAILABLE → ROLLBACK
```

Exactly one transaction proceeds through the critical section at a time.

---

## Lock Acquisition Order (Deadlock Prevention)

All operations that lock both the workshop row AND a reservation row must
always lock them in the same order:

```
ALWAYS:
  1. LOCK workshop row (FOR UPDATE)
  2. LOCK reservation row (FOR UPDATE)
```

Consistent lock ordering prevents deadlocks. If Thread A locks workshop then
reservation, and Thread B locks reservation then workshop, they can deadlock
(A waits for B's reservation lock, B waits for A's workshop lock). With a
consistent order, one always completes first.

---

## Operations and Their Locking

### Create Hold

```
BEGIN
  LOCK workshop (FOR UPDATE)          ← serializes all capacity decisions
  CHECK: user not on waitlist (WAITING)
  COUNT: held + confirmed < capacity
  INSERT INTO reservations
  UPDATE idempotency key
COMMIT
```

### Cancel Reservation

```
BEGIN
  Lookup reservation (no lock)        ← get workshop_id
  LOCK workshop (FOR UPDATE)          ← serializes cancel + promotion
  LOCK reservation (FOR UPDATE)       ← prevent concurrent cancel
  UPDATE reservation status → CANCELLED
  promoteEligibleWaiters (loop)       ← still inside same transaction
COMMIT
```

Critical: The workshop lock is held **through the entire cancel + promote
sequence**. A concurrent `POST /holds` for this workshop will block until
after the waitlisted user's promotion reservation is committed.

### Expiration Sweep

```
For each workshop with expired holds:
  BEGIN
    LOCK workshop (FOR UPDATE)
    UPDATE expired holds → EXPIRED
    promoteEligibleWaiters (loop)
  COMMIT
```

Each workshop is processed in its own transaction. Failure in one workshop
does not block others.

---

## Waitlist Promotion Loop

```js
while (true) {
  activeCount = COUNT held + confirmed
  if (activeCount >= capacity) break;        // Workshop full

  nextWaiter = SELECT ... ORDER BY position ASC FOR UPDATE SKIP LOCKED
  if (!nextWaiter) break;                    // No one waiting

  if (nextWaiter already has active reservation) {
    // SKIP — prevents WAITING + HELD state (Issue 1 fix)
    REMOVE ineligible entry
    continue;                                // Try next in queue
  }

  PROMOTE nextWaiter → new HELD reservation
  promoted++
}
```

`SKIP LOCKED` on the waitlist entry prevents two concurrent promotion calls
(e.g., two simultaneous cancellations) from both trying to promote the same
entry. The first gets the lock, the second skips to the next eligible entry.

---

## Database as Final Safety Net

Even if all application-level checks fail due to a bug, the database enforces:

**Partial unique index:**
```sql
CREATE UNIQUE INDEX idx_one_active_reservation_per_user
  ON reservations (user_id, workshop_id)
  WHERE status IN ('HELD', 'CONFIRMED');
```

If two transactions both slip through the workshop-level check and try to
insert HELD reservations for the same user, the second INSERT gets:

```
ERROR 23505: duplicate key value violates unique constraint
"idx_one_active_reservation_per_user"
```

The application catches this and returns `409 ALREADY_HAS_RESERVATION`.

---

## What Is NOT Used

| Mechanism | Reason Not Used |
|-----------|-----------------|
| Redis / Redlock | Adds infrastructure complexity; PostgreSQL locks are sufficient |
| Application-level mutexes (`async-mutex`) | Don't work across multiple server processes |
| Advisory locks | Workshop row lock is simpler and sufficient |
| Optimistic concurrency (version counters) | Requires client retry loops; pessimistic locking is cleaner here |
| SERIALIZABLE isolation | Causes more aborts; READ COMMITTED with explicit FOR UPDATE achieves the same result with fewer retries |

---

## Isolation Level

All transactions use **PostgreSQL's default: READ COMMITTED**.

This means a transaction sees committed data from other transactions as
they commit, not a frozen snapshot from when `BEGIN` was issued.

This is correct for SeatLock because:
- The `FOR UPDATE` lock prevents concurrent writes to the rows we care about.
- We re-read locked rows after acquiring the lock, so we always see the
  most current committed state.
- There is no risk of phantom reads in capacity checks because the workshop
  row lock blocks concurrent insertions that would affect the count.
