# SeatLock — Reservation Lifecycle

## State Machine

```
                ┌─────────────────────────────┐
                │         [NO STATE]          │
                │   User has no reservation   │
                └──────────────┬──────────────┘
                               │
                    POST /workshops/:id/holds
                    (seat is available)
                               │
                               ▼
                ┌──────────────────────────────┐
                │            HELD              │
                │  5-minute countdown active   │
                │  expires_at set              │
                └──────┬───────────┬───────────┘
                       │           │
          POST /confirm │           │ expires_at passes (2 ways)
                       │           │
                       ▼           ▼
           ┌───────────────┐  ┌──────────────┐
           │   CONFIRMED   │  │   EXPIRED    │
           │  Permanent    │  │  Background  │
           │  seat owner   │  │  sweep or    │
           └──────┬────────┘  │  inline check│
                  │           └──────────────┘
     DELETE /reservations/:id │
     (cancel)                 │ (both EXPIRED and CANCELLED
                  │           │  free the seat and trigger
                  ▼           │  waitlist promotion)
           ┌───────────────┐  │
           │   CANCELLED   │◄─┘
           │  Seat freed   │
           └──────────────┘
```

### Valid Transitions

| From | To | Trigger | Who |
|------|----|---------|-----|
| (none) | HELD | `POST /holds` (capacity > 0) | Any authenticated user |
| (none) | HELD | Promotion from waitlist | System (after cancel/expiry) |
| HELD | CONFIRMED | `POST /confirm` (before expiry) | Reservation owner |
| HELD | EXPIRED | `expires_at` elapses | Background sweep + inline check |
| HELD | CANCELLED | `DELETE /reservations/:id` | Reservation owner |
| CONFIRMED | CANCELLED | `DELETE /reservations/:id` | Reservation owner |

### Invalid Transitions (rejected with 409)

| Attempt | Reason |
|---------|--------|
| EXPIRED → CONFIRMED | `expires_at` is in the past; hold no longer valid |
| CANCELLED → CONFIRMED | Reservation no longer exists in an active state |
| CONFIRMED → CONFIRMED | Already confirmed |
| HELD (expired) → CONFIRMED | Inline expiry check rejects it before DB touch |

---

## Waitlist State Machine

```
                ┌──────────────────────────────────┐
                │           WAITING                │
                │  Assigned monotonic position     │
                │  No active reservation exists    │
                └──────┬─────────────┬─────────────┘
                       │             │
          Seat opens   │             │  User calls
          (cancel/     │             │  DELETE /waitlist
          expiry)      │             │
                       ▼             ▼
              ┌──────────────┐  ┌──────────────┐
              │   PROMOTED   │  │   REMOVED    │
              │  New HELD    │  │  Voluntarily │
              │  reservation │  │  left queue  │
              │  created     │  └──────────────┘
              └──────────────┘
```

An entry is also set to REMOVED (by the system) if `promoteEligibleWaiters`
finds the user at the head of the queue already has an active reservation.
This prevents head-of-line blocking.

---

## Hold Expiration: Two-Tier Architecture

### Tier 1 — Logical Expiry (Instant, Zero-Latency)

Every capacity count query and every confirmation attempt checks:

```sql
AND (status = 'CONFIRMED' OR expires_at > NOW())
```

A hold past `expires_at` is treated as non-existent for capacity purposes
even before the physical status update. This prevents a race where:

```
T=0:  Hold expires (expires_at passes)
T=1:  Background sweep hasn't run yet
T=2:  User tries to confirm expired hold → REJECTED (inline check)
T=3:  Another user creates a hold → ALLOWED (seat logically free)
```

### Tier 2 — Physical Expiry (Background Sweep)

`expirationService.sweepExpiredHolds()` runs every 60 seconds:

```
For each workshop with expired holds:
  BEGIN
    LOCK workshop FOR UPDATE
    UPDATE reservations SET status = 'EXPIRED' WHERE ... expires_at <= NOW()
    promoteEligibleWaiters (loop until full or no waiters)
  COMMIT
  → broadcast SSE update
```

The sweep also runs on **server startup** (`cold-start recovery`) to process
holds that expired while the server was offline.

---

## Audit Trail

Every transition writes to `reservation_events`:

| Event Type | Trigger |
|------------|---------|
| `HOLD_CREATED` | New hold created by user or waitlist promotion |
| `HOLD_CONFIRMED` | User confirms their hold |
| `HOLD_EXPIRED` | Background sweep physically expires the hold |
| `RESERVATION_CANCELLED` | User cancels a HELD or CONFIRMED reservation |
| `PROMOTED_FROM_WAITLIST` | System creates a hold for a waitlisted user |
| `WAITLIST_JOINED` | User joins the waitlist |
| `WAITLIST_LEFT` | User voluntarily removes themselves |
| `WAITLIST_ENTRY_INVALIDATED` | System removes an ineligible entry during promotion |
