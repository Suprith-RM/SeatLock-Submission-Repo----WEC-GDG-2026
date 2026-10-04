# SeatLock — Database Design

## Overview

SeatLock uses **PostgreSQL 15+** as the single source of truth for all
reservation state. No caches, no external state stores. The database
enforces correctness guarantees that the application layer cannot override.

---

## Entity-Relationship Diagram

```
┌──────────────────────────────────────────────────────────────────────┐
│                         users                                        │
│  id (UUID PK)  email (UNIQUE)  password_hash  name  created_at      │
└──────────────────────────────────────────────────────────────────────┘
          │ 1                                          │ 1
          │                                            │
          │ N                                          │ N
┌─────────────────────────────┐        ┌──────────────────────────────┐
│       reservations          │        │      waitlist_entries         │
│  id (UUID PK)               │        │  id (UUID PK)                │
│  user_id  → users.id        │        │  user_id  → users.id         │
│  workshop_id → workshops.id │        │  workshop_id → workshops.id  │
│  status: HELD|CONFIRMED     │        │  status: WAITING|PROMOTED    │
│          CANCELLED|EXPIRED  │        │         |REMOVED             │
│  expires_at (nullable)      │        │  position (INT, monotonic)   │
│  created_at  updated_at     │        │  created_at  updated_at      │
└─────────────────────────────┘        └──────────────────────────────┘
          │                                            │
          │ N                                          │
          │                                    ┌───────────────────────┐
          │                                    │      workshops         │
          └────────────────────────────────────│  id (UUID PK)         │
                                               │  name  description    │
                                               │  capacity (INT)       │
                                               │  created_at updated_at│
                                               └───────────────────────┘
          │ 1
          │ N
┌──────────────────────────────────────────────────────────────────────┐
│                    reservation_events                                 │
│  id (UUID PK)  reservation_id → reservations.id (nullable)          │
│  user_id → users.id           workshop_id → workshops.id            │
│  event_type (TEXT)            prev_status   new_status              │
│  reason (TEXT)                metadata (JSONB)                       │
│  created_at (TIMESTAMPTZ)  ← append-only, never updated             │
└──────────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────────┐
│                    idempotency_keys                                   │
│  PRIMARY KEY (key, user_id)  ← scoped per user                      │
│  request_hash (TEXT)  request_path (TEXT)                            │
│  response_status (INT)  response_body (JSONB)                        │
│  expires_at (TIMESTAMPTZ)  created_at                                │
└──────────────────────────────────────────────────────────────────────┘
```

---

## Tables

### `users`

| Column | Type | Constraints | Purpose |
|--------|------|-------------|---------|
| `id` | UUID | PK, DEFAULT gen_random_uuid() | Globally unique, generation-safe |
| `email` | TEXT | NOT NULL, UNIQUE | Login identity, case-normalised before storage |
| `password_hash` | TEXT | NOT NULL | bcrypt hash (cost 10), never plaintext |
| `name` | TEXT | NOT NULL | Display name |
| `created_at` | TIMESTAMPTZ | NOT NULL, DEFAULT NOW() | Always UTC |
| `updated_at` | TIMESTAMPTZ | NOT NULL, DEFAULT NOW() | Updated by application |

### `workshops`

| Column | Type | Constraints | Purpose |
|--------|------|-------------|---------|
| `id` | UUID | PK | |
| `name` | TEXT | NOT NULL | Workshop title |
| `description` | TEXT | — | Optional detail |
| `capacity` | INT | NOT NULL, CHECK > 0 | Maximum simultaneous active reservations |

### `reservations`

| Column | Type | Constraints | Purpose |
|--------|------|-------------|---------|
| `id` | UUID | PK | |
| `user_id` | UUID | NOT NULL, FK → users | Owner |
| `workshop_id` | UUID | NOT NULL, FK → workshops | Target workshop |
| `status` | TEXT | CHECK IN ('HELD','CONFIRMED','CANCELLED','EXPIRED') | Current state |
| `expires_at` | TIMESTAMPTZ | nullable | Set only for HELD; NULL for CONFIRMED |

### `waitlist_entries`

| Column | Type | Constraints | Purpose |
|--------|------|-------------|---------|
| `position` | INT | NOT NULL | Monotonically increasing integer, assigned inside lock |

> **Why an integer position instead of a timestamp?**
> Two users can join the waitlist at the exact same millisecond under high
> concurrency. An integer assigned by `MAX(position) + 1` inside a
> `FOR UPDATE` workshop lock is always unique and always ordered correctly.

### `reservation_events`

Append-only audit table. Rows are **never updated or deleted** during
normal operation. Every state transition writes a new row.

| Column | Type | Purpose |
|--------|------|---------|
| `event_type` | TEXT | `HOLD_CREATED`, `HOLD_CONFIRMED`, `HOLD_EXPIRED`, `RESERVATION_CANCELLED`, `PROMOTED_FROM_WAITLIST`, `WAITLIST_JOINED`, `WAITLIST_LEFT`, `WAITLIST_ENTRY_INVALIDATED` |
| `prev_status` | TEXT | Previous reservation status (null for creation events) |
| `new_status` | TEXT | New reservation status |
| `metadata` | JSONB | Event-specific extras (e.g., `{ expiresAt, holdDurationSeconds }`) |

### `idempotency_keys`

| Column | Type | Purpose |
|--------|------|---------|
| `key` | TEXT | UUID provided by the client |
| `user_id` | UUID | Scopes the key per user (same key from two users = two separate records) |
| `request_hash` | TEXT | SHA-256 of `{ path, body }` — detects reuse of a key for a different operation |
| `response_status` | INT | `0` = in-flight placeholder; real status after commit |
| `response_body` | JSONB | Cached response body returned on retry |
| `expires_at` | TIMESTAMPTZ | Keys are self-expiring (24 hours) |

---

## Critical Constraints

### 1 — Partial Unique Index (most important constraint in the project)

```sql
CREATE UNIQUE INDEX idx_one_active_reservation_per_user
  ON reservations (user_id, workshop_id)
  WHERE status IN ('HELD', 'CONFIRMED');
```

**What it enforces:** A user can hold or confirm at most one seat per workshop
simultaneously. CANCELLED and EXPIRED rows are excluded from the index, so
users can re-book after cancelling without hitting a conflict.

**Why partial and not a full unique index?** A full unique index on
`(user_id, workshop_id)` would prevent re-booking entirely — a user who
cancelled could never create a new reservation.

### 2 — Capacity `CHECK` constraint

```sql
capacity INT NOT NULL CHECK (capacity > 0)
```

PostgreSQL rejects workshops with zero or negative capacity at the engine
level, regardless of application code.

### 3 — Status `CHECK` constraints

```sql
status TEXT NOT NULL CHECK (status IN ('HELD','CONFIRMED','CANCELLED','EXPIRED'))
```

Invalid status strings are rejected by the database.

### 4 — Idempotency Key Primary Key

```sql
PRIMARY KEY (key, user_id)
```

Scopes idempotency keys per user. The same key string from two different
users creates two separate records and does not conflict.

---

## Indexes

| Index | Table | Columns | Type | Purpose |
|-------|-------|---------|------|---------|
| `idx_one_active_reservation_per_user` | reservations | (user_id, workshop_id) WHERE HELD/CONFIRMED | Unique Partial | Prevent double-booking |
| PK on id | All tables | id | B-tree | Fast lookup by ID |
| UNIQUE on email | users | email | B-tree | Prevent duplicate accounts |
| FK indexes | reservations, waitlist_entries, events | user_id, workshop_id | B-tree | Fast joins |

---

## Migration Strategy

Six sequential migration files in `server/db/migrations/`:

```
001_users.sql
002_workshops.sql
003_reservations.sql          ← critical partial unique index
004_waitlist_entries.sql
005_reservation_events.sql
006_idempotency_keys.sql
```

A `schema_migrations` table tracks which files have been applied.
Running `npm run migrate` is safe to call multiple times — already-applied
migrations are skipped.

---

## Authoritative Seat Count Query

The canonical query used by all capacity checks, SSE broadcasts, and the
workshop availability API:

```sql
SELECT
  w.id, w.name, w.capacity,
  COUNT(r.id) FILTER (
    WHERE r.status = 'HELD' AND r.expires_at > NOW()
  )::INT AS held_count,
  COUNT(r.id) FILTER (
    WHERE r.status = 'CONFIRMED'
  )::INT AS confirmed_count
FROM workshops w
LEFT JOIN reservations r ON r.workshop_id = w.id
WHERE w.id = $1
GROUP BY w.id;
```

`available = capacity - held_count - confirmed_count`

A HELD reservation past its `expires_at` is **not counted** — the seat is
logically free even before the background sweep physically marks it EXPIRED.
