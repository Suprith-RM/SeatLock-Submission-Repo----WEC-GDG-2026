-- Append-only audit log for reservation lifecycle events
CREATE TABLE IF NOT EXISTS reservation_events (
    id              UUID        NOT NULL DEFAULT gen_random_uuid(),
    reservation_id  UUID        REFERENCES reservations(id) ON DELETE SET NULL,
    user_id         UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    workshop_id     UUID        NOT NULL REFERENCES workshops(id) ON DELETE CASCADE,
    event_type      TEXT        NOT NULL,
    prev_status     TEXT,
    new_status      TEXT        NOT NULL,
    reason          TEXT,
    metadata        JSONB       NOT NULL DEFAULT '{}',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT reservation_events_pkey             PRIMARY KEY (id),
    CONSTRAINT reservation_events_type_not_empty   CHECK (event_type != ''),
    CONSTRAINT reservation_events_status_not_empty CHECK (new_status != '')
);

CREATE INDEX IF NOT EXISTS idx_events_reservation_id
    ON reservation_events (reservation_id, created_at ASC);

CREATE INDEX IF NOT EXISTS idx_events_workshop_timeline
    ON reservation_events (workshop_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_events_user_id
    ON reservation_events (user_id, created_at DESC);
