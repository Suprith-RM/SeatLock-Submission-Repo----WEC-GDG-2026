https://github.com/user-attachments/assets/28d05da8-35a4-4b3d-99fd-252f594bca3e

# SeatLock

A real-time seat reservation system for campus workshops. Built to handle
100+ simultaneous booking attempts for 20 seats with correct concurrency,
atomic idempotency, and live seat-count updates via Server-Sent Events.

---

## Features

- **Real-time availability** — Live held / confirmed / available counts via SSE
- **5-minute holds** — Temporary seat holds with countdown timers
- **Waitlist** — FIFO queue with automatic promotion when seats open
- **Concurrency-safe** — PostgreSQL row locking prevents overbooking under load
- **Idempotent API** — Every state-changing request accepts an idempotency key; retries are safe
- **Audit trail** — Append-only event log captures every state transition
- **JWT authentication** — Stateless, standard Bearer token auth
- **Restart recovery** — Expired holds are swept on server cold-start

---

## Technology Stack

| Layer | Choice | Reason |
|-------|--------|--------|
| **Database** | PostgreSQL 15+ | Transactions, row-level locking, partial unique indexes |
| **Backend** | Node.js + Express | Familiar, async-friendly |
| **DB Driver** | `pg` (raw SQL) | Locking semantics visible in code; no ORM abstraction |
| **Frontend** | React 18 + Vite | Minimal, fast dev server |
| **Real-time** | Server-Sent Events | Server → client push; simpler than WebSockets for this use case |
| **Auth** | JWT (HS256) | Stateless; no session store needed |
| **Validation** | Zod | Schema-first validation with typed output |
| **Testing** | Vitest + Supertest | In-process integration tests against real PostgreSQL |
| **Load testing** | k6 | External HTTP load tests — concurrency, idempotency, smoke |

---

## Project Structure

```
seatlock/
├── client/                   React frontend (Vite)
│   └── src/
│       ├── components/       WorkshopList, WorkshopDetail, Auth, ...
│       ├── hooks/            useSSE, useAuth
│       └── api.js            Fetch wrapper
│
├── server/                   Node.js + Express backend
│   ├── db/
│   │   ├── migrations/       001–006 SQL migration files
│   │   └── seeds/            seed.js (dev data)
│   ├── scripts/              migrate.js, seed.js, reset.js
│   ├── src/
│   │   ├── config/           db.js (pg Pool), env.js (startup validation)
│   │   ├── controllers/      Thin HTTP handlers
│   │   ├── middleware/       authenticate, validate, requireIdempotencyKey, errorHandler
│   │   ├── realtime/         sseManager.js
│   │   ├── repositories/     workshopRepository.js, userRepository.js
│   │   ├── routes/           auth.js, workshops.js, reservations.js, events.js
│   │   ├── services/         authService.js, holdService.js, waitlistService.js
│   │   │                     expirationService.js, idempotencyService.js
│   │   ├── utils/            errors.js, logger.js
│   │   ├── validators/       authValidator.js, reservationValidator.js
│   │   └── jobs/             expiryJob.js
│   ├── tests/
│   │   ├── integration/      auth, reservations, waitlist, idempotency, issue1–3
│   │   └── concurrency/      hold, waitlist-race, hundred-users
│   ├── app.js
│   └── server.js
│
├── docs/
│   ├── database-design.md
│   ├── reservation-lifecycle.md
│   ├── idempotency-strategy.md
│   └── concurrency-strategy.md
│
└── README.md
```

---

## Quick Start

### Prerequisites

- Node.js 20+
- PostgreSQL 15+
- npm

### 1 — Clone and install

```bash
git clone https://github.com/your-username/seatlock.git
cd seatlock
npm install        # installs root scripts (if any)
cd server && npm install
cd ../client && npm install
cd ..
```

### 2 — Create databases

```sql
-- In psql:
CREATE DATABASE seatlock;
CREATE DATABASE seatlock_test;
```

### 3 — Configure environment

```bash
cd server
cp .env.example .env
# Edit .env — fill in DATABASE_URL, JWT_SECRET, etc.
```

```env
# server/.env
NODE_ENV=development
PORT=3001
DATABASE_URL=postgresql://postgres:yourpassword@localhost:5432/seatlock
DATABASE_URL_TEST=postgresql://postgres:yourpassword@localhost:5432/seatlock_test
JWT_SECRET=replace-this-with-a-random-64-char-string-generated-by-openssl
JWT_EXPIRES_IN=7d
HOLD_DURATION_SECONDS=300
SWEEP_INTERVAL_MS=60000
CLIENT_URL=http://localhost:5173
DB_POOL_MAX=10
```

Generate a secure `JWT_SECRET`:
```bash
openssl rand -base64 48
```

### 4 — Run migrations and seed

```bash
cd server
npm run migrate    # applies 001–006 migration files
npm run seed       # inserts dev users and a 20-seat workshop
```

### 5 — Start the development servers

```bash
# Terminal 1 — backend
cd server && npm run dev

# Terminal 2 — frontend
cd client && npm run dev
```

Open **http://localhost:5173**.

Dev login credentials (from seed):
- `alice@seatlock.dev` / `password123`
- `bob@seatlock.dev` / `password123`
- (+ 18 more users in seed)

---

## Available npm Scripts

### Backend (`server/`)

| Script | Action |
|--------|--------|
| `npm run dev` | Start Express with `--watch` (hot reload) |
| `npm start` | Start Express in production mode |
| `npm run migrate` | Apply pending database migrations |
| `npm run seed` | Insert development data |
| `npm run reset` | Drop all tables, re-migrate, re-seed |
| `npm test` | Run all Vitest integration + concurrency tests |
| `npm run test:watch` | Vitest in watch mode |

### Load Testing with k6 (requires running server + k6 installed)

**Install k6:** https://grafana.com/docs/k6/latest/set-up/install-k6/

```bash
# 1. Start the server
cd server && npm run dev

# 2. Pre-create 100 test users and save their JWT tokens
node load-tests/setup.js

# 3. Run the tests (from the seatlock/ root)
k6 run load-tests/smoke.js          # Happy-path: register → hold → confirm → cancel
k6 run load-tests/concurrency.js    # 100 VUs → 20 seats: verifies no overbooking
k6 run load-tests/idempotency.js    # Same key retried 5x: verifies no duplicate holds
```

#### What each test proves

| Script | VUs | What it checks |
|--------|-----|----------------|
| `smoke.js` | 1 | Full happy path works end-to-end |
| `concurrency.js` | 100 | ≤ 20 holds succeed, 0 server errors, no overbooking |
| `idempotency.js` | 10 × 5 retries | Same key returns cached response, no duplicates |

Results are saved to `load-tests/results/` as JSON.

---

## API Reference

All routes are prefixed with `/api`. All protected routes require:
```
Authorization: Bearer <jwt>
```

State-changing routes also require:
```
Idempotency-Key: <uuid-v4>
```

### Authentication

#### `POST /api/auth/register`
```json
// Request
{ "name": "Alice", "email": "alice@example.com", "password": "password123" }

// Response 201
{ "token": "eyJ...", "user": { "id": "...", "email": "...", "name": "..." } }
```

#### `POST /api/auth/login`
```json
// Request
{ "email": "alice@example.com", "password": "password123" }

// Response 200
{ "token": "eyJ...", "user": { "id": "...", "email": "...", "name": "..." } }
```

#### `GET /api/auth/me`
```json
// Response 200
{ "user": { "id": "...", "email": "...", "name": "..." } }
```

---

### Workshops

#### `GET /api/workshops`
```json
// Response 200
{
  "workshops": [
    {
      "id": "00000000-...",
      "name": "Docker & Containers",
      "description": "...",
      "capacity": 20,
      "heldCount": 3,
      "confirmedCount": 12,
      "availableSeats": 5,
      "isFull": false
    }
  ]
}
```

#### `GET /api/workshops/:workshopId`
Same shape as a single workshop object.

#### `GET /api/workshops/:workshopId/my-reservation`
```json
// 200 — active reservation exists
{
  "reservation": {
    "id": "...",
    "status": "HELD",
    "expiresAt": "2024-10-01T12:05:00Z",
    "secondsUntilExpiry": 243
  }
}

// 404 — no active reservation
{ "error": { "code": "RESERVATION_NOT_FOUND", "message": "..." } }
```

---

### Reservations

#### `POST /api/workshops/:workshopId/holds`

Creates a 5-minute temporary hold on a seat.

```json
// Request (body can be empty {})
{}

// Response 201
{
  "reservation": {
    "id": "res-uuid",
    "status": "HELD",
    "expiresAt": "2024-10-01T12:05:00Z",
    "secondsUntilExpiry": 300
  }
}

// 409 NO_SEATS_AVAILABLE    — workshop is full
// 409 ON_WAITLIST_CANNOT_HOLD — user is currently WAITING on the waitlist
// 409 ALREADY_HAS_RESERVATION — user already has a HELD or CONFIRMED seat
```

#### `POST /api/reservations/:reservationId/confirm`

Confirms a HELD reservation before it expires.

```json
// Response 200
{ "reservation": { "id": "...", "status": "CONFIRMED", ... } }

// 409 HOLD_EXPIRED  — expires_at is in the past
// 403              — not the reservation owner
```

#### `DELETE /api/reservations/:reservationId`

Cancels a HELD or CONFIRMED reservation. Atomically promotes the next
eligible waitlist user in the same transaction.

```json
// Response 200
{ "reservation": { "id": "...", "status": "CANCELLED", ... } }
```

---

### Waitlist

#### `POST /api/workshops/:workshopId/waitlist`

Joins the waitlist. Only allowed when the workshop is at full capacity.

```json
// Response 201
{
  "message": "You have joined the waitlist at position 3.",
  "entry": { "id": "...", "position": 3, "status": "WAITING" }
}

// 409 SEATS_AVAILABLE_USE_HOLD  — workshop is not full, use /holds instead
// 409 ALREADY_ON_WAITLIST       — already in the queue
// 409 ALREADY_HAS_RESERVATION   — already has an active reservation
```

#### `DELETE /api/workshops/:workshopId/waitlist`

Voluntarily leaves the waitlist.

```json
// Response 200
{ "message": "You have left the waitlist.", "entry": { "status": "REMOVED" } }
```

#### `GET /api/workshops/:workshopId/waitlist/position`

```json
// Response 200
{ "position": 3, "totalWaiting": 5, "workshopId": "..." }
```

---

### Real-time Events

#### `GET /api/events/workshop/:workshopId`

Opens a Server-Sent Events stream. Requires `Authorization: Bearer` header
(use `@microsoft/fetch-event-source` in the browser — native `EventSource`
does not support custom headers).

```
Content-Type: text/event-stream

data: {"type":"connected","workshop":{"id":"...","capacity":20,"heldCount":3,"confirmedCount":12,"availableSeats":5,"isFull":false}}

data: {"type":"workshop_update","workshop":{"capacity":20,"heldCount":2,"confirmedCount":12,"availableSeats":6,"isFull":false}}
```

Events fire after every hold, cancel, and expiration. The payload contains
only **public, aggregated data** — no user IDs, reservation IDs, or expiry
times (which are private and fetched via `GET /my-reservation`).

---

## Error Response Format

All errors follow a consistent structure:

```json
{
  "error": {
    "code": "NO_SEATS_AVAILABLE",
    "message": "No seats available for this workshop."
  }
}
```

Common codes:

| Code | HTTP | Meaning |
|------|------|---------|
| `NO_SEATS_AVAILABLE` | 409 | Workshop is at capacity |
| `ON_WAITLIST_CANNOT_HOLD` | 409 | User is WAITING on the waitlist |
| `ALREADY_HAS_RESERVATION` | 409 | User already has HELD or CONFIRMED seat |
| `HOLD_EXPIRED` | 409 | Hold's `expires_at` has passed |
| `ALREADY_CONFIRMED` | 409 | Reservation is already confirmed |
| `ALREADY_CANCELLED` | 409 | Reservation is already cancelled |
| `IDEMPOTENCY_KEY_REQUIRED` | 400 | Missing or malformed Idempotency-Key header |
| `IDEMPOTENCY_KEY_CONFLICT` | 409 | Key reused with a different request |
| `IDEMPOTENCY_IN_FLIGHT` | 409 | Concurrent request with same key in progress |
| `TOKEN_EXPIRED` | 401 | JWT has expired |
| `UNAUTHORIZED` | 401 | No or invalid token |

---

## Running Tests

```bash
cd server

# Run all 57 tests (integration + concurrency)
npm test

# Individual test files
npx vitest run tests/integration/auth.test.js
npx vitest run tests/concurrency/hundred-users.test.js
```

### Test Database Setup

Tests automatically use `DATABASE_URL_TEST` from `.env`. The test suite
cleans up after itself but uses a dedicated database to avoid corrupting
development data.

```bash
# Create the test database once:
createdb seatlock_test
cd server
DATABASE_URL=$DATABASE_URL_TEST npm run migrate
```

### Test Suite Summary

| File | Tests | What it covers |
|------|-------|----------------|
| `auth.test.js` | 8 | Registration, login, JWT, profile |
| `reservations.test.js` | 18 | Hold, confirm, cancel, expiry, access control |
| `waitlist.test.js` | 8 | Join, leave, position, auto-promotion |
| `idempotency.test.js` | 4 | Retry safety, hash mismatch, missing header |
| `issue1-waitlist-hold.test.js` | 3 | WAITING + HELD invariant |
| `issue2-atomic-promotion.test.js` | 4 | Atomic cancel/expiry + promotion |
| `issue3-idempotency-all.test.js` | 6 | Idempotency on all 5 mutation endpoints |
| `hold.test.js` | 1 | Concurrent 25-user hold test |
| `waitlist-race.test.js` | 1 | Concurrent waitlist join race |
| `hundred-users.test.js` | 4 | 100-user load test (4 scenarios) |

---

## Concurrency & Correctness Guarantees

| Guarantee | Mechanism |
|-----------|-----------|
| No overbooking | `FOR UPDATE` on workshop row serializes all capacity decisions |
| No double-booking | Partial unique index on `(user_id, workshop_id) WHERE HELD/CONFIRMED` |
| Waitlist FIFO | Monotonic integer position assigned inside workshop lock |
| Atomic cancel + promote | Both operations in one transaction under workshop lock |
| Idempotent retries | `INSERT ON CONFLICT DO NOTHING` inside business transaction |
| Expired hold cannot confirm | `expires_at > NOW()` checked inline before any state change |
| Crash recovery | `sweepExpiredHolds()` runs on every server startup |

---

## Documentation

- [Database Design](docs/database-design.md)
- [Reservation Lifecycle](docs/reservation-lifecycle.md)
- [Idempotency Strategy](docs/idempotency-strategy.md)
- [Concurrency Strategy](docs/concurrency-strategy.md)
