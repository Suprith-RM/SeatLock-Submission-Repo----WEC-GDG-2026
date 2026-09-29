-- Reservations table schema
DO $$ BEGIN
    CREATE TYPE reservation_status AS ENUM (
        'HELD', 'CONFIRMED', 'CANCELLED', 'EXPIRED'
    );
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS reservations (
    id          UUID                NOT NULL DEFAULT gen_random_uuid(),
    user_id     UUID                NOT NULL,
    workshop_id UUID                NOT NULL,
    status      reservation_status  NOT NULL DEFAULT 'HELD',
    expires_at  TIMESTAMPTZ,
    created_at  TIMESTAMPTZ         NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ         NOT NULL DEFAULT NOW(),
    CONSTRAINT reservations_pkey        PRIMARY KEY (id),
    CONSTRAINT reservations_user_fk     FOREIGN KEY (user_id)
        REFERENCES users(id) ON DELETE CASCADE,
    CONSTRAINT reservations_workshop_fk FOREIGN KEY (workshop_id)
        REFERENCES workshops(id) ON DELETE CASCADE,
    CONSTRAINT reservations_held_requires_expiry
        CHECK (status != 'HELD' OR expires_at IS NOT NULL)
);

-- Enforce at most one active reservation (HELD or CONFIRMED) per user per workshop
CREATE UNIQUE INDEX IF NOT EXISTS idx_one_active_reservation_per_user
    ON reservations (user_id, workshop_id)
    WHERE status IN ('HELD', 'CONFIRMED');

-- Workshop capacity tracking
CREATE INDEX IF NOT EXISTS idx_reservations_workshop_status
    ON reservations (workshop_id, status);

-- Expired hold cleanup queries
CREATE INDEX IF NOT EXISTS idx_reservations_expired_holds
    ON reservations (expires_at)
    WHERE status = 'HELD';

CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER reservations_updated_at
    BEFORE UPDATE ON reservations
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();
