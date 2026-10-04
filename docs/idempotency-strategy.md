# SeatLock — Idempotency Strategy

## Why Idempotency Matters

Mobile networks drop connections. Users double-click buttons. Load balancers
retry timed-out requests. Without idempotency, any of these causes a second
seat to be booked, a second confirmation to fire, or a second cancellation
to trigger a second waitlist promotion.

The official task requirement:

> *"Accept an idempotency key for every state-changing request so that
> retrying it does not create another side effect."*

---

## Which Endpoints Are Protected

| Method | Endpoint | Protected |
|--------|----------|-----------|
| POST | `/workshops/:id/holds` | ✅ |
| POST | `/reservations/:id/confirm` | ✅ |
| DELETE | `/reservations/:id` | ✅ |
| POST | `/workshops/:id/waitlist` | ✅ |
| DELETE | `/workshops/:id/waitlist` | ✅ |
| GET (any) | — | — (read-only, inherently idempotent) |

---

## Client Contract

The client must:

1. Generate a unique UUID for each **distinct logical operation**:
   ```js
   const key = crypto.randomUUID(); // Browser native
   ```
2. Send it in the `Idempotency-Key` header:
   ```http
   POST /api/workshops/abc/holds
   Authorization: Bearer <jwt>
   Idempotency-Key: 550e8400-e29b-41d4-a716-446655440000
   ```
3. On network failure, **retry with the same key** to get the cached
   response without re-executing the side effect.
4. On a new, distinct operation, **generate a new UUID**.

---

## Request Fingerprint

The idempotency key alone is not enough to detect key reuse for a different
operation. SeatLock computes a fingerprint:

```js
SHA-256({ path: requestPath, body: requestBody })
```

The `requestPath` includes the resource ID:

```
POST /workshops/abc-123/holds      ← path differs from /workshops/xyz-456/holds
POST /reservations/res-1/confirm   ← path differs from /reservations/res-2/confirm
```

If the same key is used with a **different fingerprint**, the server returns:

```
409 IDEMPOTENCY_KEY_CONFLICT
"This Idempotency-Key was used with a different request."
```

---

## Atomic Implementation (The Critical Detail)

### Why Not Middleware-Level Check?

A pre-transaction middleware check has a TOCTOU race:

```
Request A: SELECT → key not found → proceed ─────┐
Request B: SELECT → key not found → proceed ──┐   │
                                              │   │
Request B: INSERT key ← succeeds             │   │
Request A: INSERT key ← UNIQUE VIOLATION     │   │
           → 500 Internal Server Error ◄─────┘   │
```

### The Correct Approach: INSERT ON CONFLICT Inside the Transaction

```sql
-- First statement inside BEGIN:
INSERT INTO idempotency_keys
  (key, user_id, request_hash, request_path, response_status, response_body, expires_at)
VALUES
  ($1, $2, $3, $4, 0, 'null'::jsonb, NOW() + INTERVAL '24 hours')
ON CONFLICT (key, user_id) DO NOTHING
RETURNING id;
```

PostgreSQL serialises two concurrent INSERTs at the unique index level.
Exactly one transaction gets a `RETURNING` row (the winner). The other gets
nothing (the loser) and fetches the cached response.

### Full Transaction Flow

```
BEGIN
  ├─ INSERT idempotency key ON CONFLICT DO NOTHING
  │
  ├─ [RETURNING row?]
  │     YES (winner):
  │       ├─ LOCK workshop FOR UPDATE
  │       ├─ Check business rules
  │       ├─ INSERT/UPDATE reservation
  │       ├─ INSERT audit event
  │       └─ UPDATE idempotency key (status=0 → real status, body=real response)
  │
  │     NO (loser):
  │       ├─ SELECT cached key record
  │       └─ ROLLBACK (zero side effects)
  │
COMMIT (winner only)
```

### Why response_status=0 as Sentinel

The loser transaction reads the key record. If the winner hasn't committed
yet, the loser sees `response_status = 0` (the placeholder):

```
409 IDEMPOTENCY_IN_FLIGHT
"This request is already being processed. Please retry after 1 second."
```

This is correct: the operation is in progress. The client should wait
~1 second and retry. By that time, the winner will have committed and the
loser will get the real cached response.

---

## Key Expiry

Idempotency keys expire after **24 hours**. After expiry, the same UUID
can be reused for a new operation. This matches industry practice
(Stripe uses 24 hours).

A periodic cleanup job (optional for production) deletes expired keys:

```sql
DELETE FROM idempotency_keys WHERE expires_at < NOW();
```

---

## Scoping

Keys are scoped to `(key, user_id)`:

- User A and User B can both use the key string `"my-key-1"` without conflict.
- The key is only idempotent for the same user's operations.
- This matches how Stripe and most payment APIs scope idempotency keys.
